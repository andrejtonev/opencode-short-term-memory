import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  evaluateProbeMode,
  normalizeExternalMessages,
  parseProbeTelemetryJsonl,
  type HostGenerateCallEvidence,
  type ProbeEvaluationResult,
  type ProbeModeEvaluationInput,
} from "./evaluator.js";
import {
  bounded,
  compactSession,
  createModeledSession,
  invokeSessionGenerate,
  observeSession,
  PROBE_HOST_TIMEOUT_MS,
  PROBE_MODEL_REF,
  PROBE_SERVICE_BINARY,
  PROBE_SERVICE_VERSION,
  startIsolatedService,
  stopIsolatedService,
  submitOrdinaryPrompt,
  type ExternalSessionObservations,
  type IsolatedServiceOptions,
  type IsolatedServiceState,
} from "./host-api.js";
import { PROBE_MODES, type ProbeMode, type ProbeTelemetryRecord } from "./telemetry.js";

const FIXTURE_DIRECTORY = import.meta.dir;
const SANDBOX_PARENT = join(tmpdir(), "opencode");
const REQUIRED_PACKAGES = ["@opencode/cli", "@opencode/client", "@opencode/plugin"] as const;
const SHUTDOWN_TIMEOUT_MS = PROBE_HOST_TIMEOUT_MS;

interface ModePaths {
  readonly sandbox: string;
  readonly project: string;
  readonly home: string;
  readonly xdgConfig: string;
  readonly xdgData: string;
  readonly xdgCache: string;
  readonly xdgState: string;
  readonly xdgRuntime: string;
  readonly temporary: string;
  readonly serviceFile: string;
  readonly telemetryPath: string;
}

interface ModeRunResult {
  readonly mode: ProbeMode;
  readonly runId: string;
  readonly sandbox: string;
  readonly evidenceFile: string;
  readonly evaluation?: ProbeEvaluationResult;
  readonly failures: string[];
  readonly records: number;
  removed: boolean;
}

interface RunResults {
  readonly runId: string;
  readonly directory: string;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined ? String(error) : serialized;
  } catch {
    return String(error);
  }
}

async function requireDirectory(path: string): Promise<void> {
  const details = await stat(path);
  if (!details.isDirectory()) throw new Error(`Expected directory: ${path}`);
}

async function prepareSandboxParent(): Promise<void> {
  const parent = dirname(SANDBOX_PARENT);
  await requireDirectory(parent);
  await mkdir(SANDBOX_PARENT, { recursive: true });
  await requireDirectory(SANDBOX_PARENT);
}

async function createRunResults(): Promise<RunResults> {
  await requireDirectory(SANDBOX_PARENT);
  const runId = crypto.randomUUID();
  const directory = join(SANDBOX_PARENT, `stm-v2-generation-results-${runId}`);
  await mkdir(directory);
  await requireDirectory(directory);
  return { runId, directory };
}

async function createModePaths(mode: ProbeMode): Promise<ModePaths> {
  await requireDirectory(SANDBOX_PARENT);
  const sandbox = await mkdtemp(join(SANDBOX_PARENT, `stm-v2-generation-${mode}-`));
  const paths = {
    sandbox,
    project: join(sandbox, "project"),
    home: join(sandbox, "home"),
    xdgConfig: join(sandbox, "xdg-config"),
    xdgData: join(sandbox, "xdg-data"),
    xdgCache: join(sandbox, "xdg-cache"),
    xdgState: join(sandbox, "xdg-state"),
    xdgRuntime: join(sandbox, "xdg-runtime"),
    temporary: join(sandbox, "tmp"),
    telemetryPath: join(sandbox, "probe-telemetry.jsonl"),
  };
  await Promise.all(
    [
      paths.project,
      paths.home,
      paths.xdgConfig,
      paths.xdgData,
      paths.xdgCache,
      paths.xdgState,
      paths.xdgRuntime,
      paths.temporary,
    ].map((path) => mkdir(path)),
  );
  await writeFile(join(paths.project, "opencode.json"), `${JSON.stringify({ plugins: [FIXTURE_DIRECTORY] })}\n`);
  return { ...paths, serviceFile: join(paths.xdgState, "opencode", "service.json") };
}

function packageVersion(value: unknown, packageName: string): string {
  if (typeof value !== "object" || value === null || !("version" in value)) {
    throw new TypeError(`${packageName} package metadata has no version`);
  }
  const version = value.version;
  if (typeof version !== "string") throw new TypeError(`${packageName} package version is not a string`);
  return version;
}

async function verifyInstalledVersions(): Promise<void> {
  for (const packageName of REQUIRED_PACKAGES) {
    const manifestPath = join(FIXTURE_DIRECTORY, "node_modules", ...packageName.split("/"), "package.json");
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    const version = packageVersion(manifest, packageName);
    if (version !== PROBE_SERVICE_VERSION) {
      throw new Error(`Installed ${packageName}@${version}; expected ${PROBE_SERVICE_VERSION}`);
    }
  }
  await realpath(PROBE_SERVICE_BINARY);
}

function isolatedEnvironment(paths: ModePaths, runId: string, mode: ProbeMode): Record<string, string> {
  return {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_STATE_HOME: paths.xdgState,
    XDG_RUNTIME_DIR: paths.xdgRuntime,
    TMPDIR: paths.temporary,
    TMP: paths.temporary,
    TEMP: paths.temporary,
    NO_COLOR: "1",
    PROBE_RUN_ID: runId,
    PROBE_MODE: mode,
    PROBE_TELEMETRY_PATH: paths.telemetryPath,
  };
}

function operationResultText(records: readonly ProbeTelemetryRecord[]): unknown {
  const results: unknown[] = [];
  for (const record of records) {
    if (record.event !== "language-model" || record.name !== "operation.result") continue;
    const details: unknown = "details" in record ? record.details : undefined;
    results.push(typeof details === "object" && details !== null && "text" in details ? details.text : undefined);
  }
  if (results.length !== 1) return undefined;
  return results[0];
}

function compactObservation(observation: ExternalSessionObservations | undefined) {
  if (observation === undefined) return undefined;
  const context = normalizeExternalMessages(observation.context).messages;
  const messages = normalizeExternalMessages(observation.messages).messages;
  const log = observation.log.map((item, position) => {
    const value = item as unknown as Record<string, unknown>;
    const nestedEvent = value.event;
    const eventType =
      typeof value.type === "string"
        ? value.type
        : typeof nestedEvent === "string"
          ? nestedEvent
          : typeof nestedEvent === "object" &&
              nestedEvent !== null &&
              "type" in nestedEvent &&
              typeof nestedEvent.type === "string"
            ? nestedEvent.type
            : "unknown";
    const sequence = typeof value.seq === "number" ? value.seq : value.sequence;
    return { position, eventType, ...(typeof sequence === "number" ? { seq: sequence } : {}) };
  });
  return { context, messages, log };
}

async function writePrettyJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function evaluationInput(
  mode: ProbeMode,
  records: readonly ProbeTelemetryRecord[],
  before: ExternalSessionObservations | undefined,
  after: ExternalSessionObservations | undefined,
  settledAfter: ExternalSessionObservations | undefined,
  hostEvidence: HostGenerateCallEvidence | undefined,
  observableOutput: unknown,
): ProbeModeEvaluationInput {
  switch (mode) {
    case "ordinary":
      return {
        mode,
        records,
        externalBefore: before,
        externalAfter: after,
        externalHistory: after,
        observableOutput,
      };
    case "session-generate-history":
      return {
        mode,
        records,
        externalBefore: before,
        externalAfter: after,
        externalSettledAfter: settledAfter,
        hostEvidence: hostEvidence ?? {
          callCount: 0,
          outcome: "failure",
          error: "direct call not reached",
        },
      };
    case "session-generate":
    case "standalone-generate":
      return {
        mode,
        records,
        externalBefore: before,
        externalAfter: after,
        returnedText: operationResultText(records),
      };
    case "compaction":
      return { mode, records, externalBefore: before, externalAfter: after };
  }
}

async function stopService(options: IsolatedServiceOptions): Promise<void> {
  await bounded(() => stopIsolatedService({ options }), SHUTDOWN_TIMEOUT_MS);
}

async function runMode(mode: ProbeMode, runResults: RunResults): Promise<ModeRunResult> {
  const paths = await createModePaths(mode);
  const runId = `${mode}-${crypto.randomUUID()}`;
  const evidenceFile = join(runResults.directory, `${mode}.json`);
  const options: IsolatedServiceOptions = {
    cwd: paths.project,
    serviceFile: paths.serviceFile,
    env: isolatedEnvironment(paths, runId, mode),
  };
  let service: IsolatedServiceState | undefined;
  let before: ExternalSessionObservations | undefined;
  let after: ExternalSessionObservations | undefined;
  let settledAfter: ExternalSessionObservations | undefined;
  let hostEvidence: HostGenerateCallEvidence | undefined =
    mode === "session-generate-history"
      ? { callCount: 0, outcome: "failure", error: "direct call not reached" }
      : undefined;
  let observableOutput: unknown;
  let records: readonly ProbeTelemetryRecord[] = [];
  const operationFailures: string[] = [];
  const shutdownFailures: string[] = [];
  const failures: string[] = [];

  try {
    service = await bounded(() => startIsolatedService(options));
    const client = service.client;
    const session = await createModeledSession(client, paths.project);

    if (mode === "session-generate-history") {
      await submitOrdinaryPrompt(client, session.id, `context-trigger:${mode}:${runId}`);
      before = await observeSession(client, session.id);
      hostEvidence = { callCount: 1, outcome: "failure", error: "direct call did not settle" };
      try {
        const generated = await invokeSessionGenerate(client, session.id, `session-generate-history:${runId}`);
        observableOutput = generated;
        hostEvidence = { callCount: 1, outcome: "success", returnedText: generated.text };
      } catch (error) {
        hostEvidence = {
          callCount: 1,
          outcome:
            error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
              ? "timeout"
              : "failure",
          error: describeError(error),
        };
      }
      await bounded((signal) => client.session.wait({ sessionID: session.id }, { signal }));
      after = await observeSession(client, session.id);
      await bounded((signal) => client.session.wait({ sessionID: session.id }, { signal }));
      settledAfter = await observeSession(client, session.id);
    } else {
      const initial = await observeSession(client, session.id);
      if (mode === "ordinary") {
        before = initial;
        observableOutput = await submitOrdinaryPrompt(client, session.id, `ordinary:${runId}`);
        after = await observeSession(client, session.id);
      } else if (mode === "session-generate" || mode === "standalone-generate") {
        await submitOrdinaryPrompt(client, session.id, `context-trigger:${mode}:${runId}`);
        const postTrigger = await observeSession(client, session.id);
        before = mode === "session-generate" ? initial : postTrigger;
        after = await observeSession(client, session.id);
      } else {
        await submitOrdinaryPrompt(client, session.id, `compaction-seed:${runId}`);
        before = await observeSession(client, session.id);
        observableOutput = await compactSession(client, session.id);
        after = await observeSession(client, session.id);
      }
    }
  } catch (error) {
    operationFailures.push(describeError(error));
    failures.push(`operation: ${operationFailures.at(-1)}`);
  } finally {
    try {
      await stopService(service?.options ?? options);
    } catch (error) {
      shutdownFailures.push(describeError(error));
      failures.push(`shutdown: ${shutdownFailures.at(-1)}`);
    }
  }

  let evaluation: ProbeEvaluationResult | undefined;
  try {
    const telemetry = await readFile(paths.telemetryPath, "utf8");
    records = parseProbeTelemetryJsonl(telemetry, { runId, mode });
    evaluation = evaluateProbeMode(
      evaluationInput(mode, records, before, after, settledAfter, hostEvidence, observableOutput),
    );
    failures.push(...evaluation.failures);
  } catch (error) {
    failures.push(`evidence: ${describeError(error)}`);
  }

  try {
    const passed = failures.length === 0 && evaluation?.passed === true;
    await writePrettyJson(evidenceFile, {
      runId,
      mode,
      verdict: passed ? "PASS" : "FAIL",
      sandbox: { path: paths.sandbox, disposition: passed ? "removed" : "retained" },
      recordCount: records.length,
      evaluator: evaluation ?? null,
      harnessFailures: { operation: operationFailures, shutdown: shutdownFailures },
      hostGenerateCall: hostEvidence,
      externalHistory: {
        before: compactObservation(before),
        after: compactObservation(after),
        settledAfter: compactObservation(settledAfter),
      },
      observedDurableEventTypes: evaluation?.evidence.durableEvents ?? [],
      expectation: {
        installedVersion: PROBE_SERVICE_VERSION,
        serviceBinaryPath: PROBE_SERVICE_BINARY,
        modelIdentifier: `${PROBE_MODEL_REF.providerID}/${PROBE_MODEL_REF.id}`,
      },
      telemetry: records,
    });
  } catch (error) {
    failures.push(`evidence write: ${describeError(error)}`);
  }

  return {
    mode,
    runId,
    sandbox: paths.sandbox,
    evidenceFile,
    evaluation,
    failures,
    records: records.length,
    removed: false,
  };
}

function printResults(results: readonly ModeRunResult[]): void {
  console.log("| Mode | Verdict | Records | Sandbox |");
  console.log("|---|---:|---:|---|");
  for (const result of results) {
    const verdict = result.failures.length === 0 && result.evaluation?.passed === true ? "PASS" : "FAIL";
    const records = result.records;
    const sandbox = result.removed ? "removed" : result.sandbox;
    console.log(`| ${result.mode} | ${verdict} | ${records} | ${sandbox} |`);
    for (const failure of result.failures) console.error(`${result.mode}: ${failure}`);
  }
}

async function main(): Promise<void> {
  await verifyInstalledVersions();
  await prepareSandboxParent();
  const runResults = await createRunResults();
  const results: ModeRunResult[] = [];
  for (const mode of PROBE_MODES) results.push(await runMode(mode, runResults));
  const overallPassed = results.every((result) => result.failures.length === 0 && result.evaluation?.passed === true);
  try {
    await writePrettyJson(join(runResults.directory, "summary.json"), {
      runId: runResults.runId,
      overallPass: overallPassed,
      modes: results.map((result) => ({
        mode: result.mode,
        evidenceFile: result.evidenceFile,
        verdict: result.failures.length === 0 && result.evaluation?.passed === true ? "PASS" : "FAIL",
      })),
    });
  } catch (error) {
    for (const result of results) {
      result.failures.push(`aggregate evidence write: ${describeError(error)}`);
    }
  }
  for (const result of results) {
    if (result.failures.length !== 0 || result.evaluation?.passed !== true) continue;
    await rm(result.sandbox, { recursive: true });
    result.removed = true;
  }
  printResults(results);
  console.log(`\nResults directory: ${runResults.directory}`);
  const failures = results.flatMap((result) => result.failures.map((failure) => `${result.mode}: ${failure}`));
  if (failures.length > 0) throw new Error(`Probe failed:\n${failures.join("\n")}`);
  console.log("\nOverall verdict: PASS");
}

await main();
