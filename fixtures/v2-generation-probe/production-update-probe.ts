import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PROBE_MEMORY_SENTINEL, PROBE_MODEL_ID, PROBE_PROVIDER_ID } from "./index.js";
import {
  bounded,
  createModeledSession,
  observeSession,
  PROBE_HOST_TIMEOUT_MS,
  startIsolatedService,
  stopIsolatedService,
  submitOrdinaryPrompt,
  type ExternalSessionObservations,
  type IsolatedServiceOptions,
  type IsolatedServiceState,
} from "./host-api.js";
import { evaluateOrdinary, normalizeExternalMessages, parseProbeTelemetryJsonl } from "./evaluator.js";

const FIXTURE_DIRECTORY = import.meta.dir;
const REPOSITORY_DIRECTORY = resolve(FIXTURE_DIRECTORY, "../..");
const SANDBOX_PARENT = join(tmpdir(), "opencode");
const OVERALL_TIMEOUT_MS = 45_000;
const OPERATION_TIMEOUT_MS = PROBE_HOST_TIMEOUT_MS;
const REQUIRED_HEADINGS = [
  "## Session Memory",
  "### User Instructions",
  "### Long Horizon Context",
  "### Decisions",
  "### Conclusions",
  "### Active References",
] as const;
const FIRST_PROMPT = "First ordinary production update probe turn.";
const SECOND_PROMPT = "Second ordinary production update probe turn.";

interface Evidence {
  readonly runId: string;
  readonly verdict: "pass" | "fail";
  readonly failures: readonly string[];
  readonly memoryPath: string;
  readonly checkpointPath: string;
  readonly productionPluginPath: string;
  readonly productionWrapperDirectory: string;
  readonly productionWrapperConfigured: boolean;
  readonly productionWrapperSetupEntered: boolean;
  readonly productionWrapperLoaded: boolean;
  readonly productionWrapperCleanupObserved: boolean;
  readonly checkpointValue: string;
  readonly durableUserAssistantCount: number;
  readonly durableUserAssistantIDs: readonly string[];
  readonly expectedCheckpointSourceMessageID: string;
  readonly requiredHeadingsPresent: boolean;
  readonly memorySentinelPresent: boolean;
  readonly telemetryRecordCount: number;
  readonly ordinaryEvaluator: { readonly passed: boolean; readonly failures: readonly string[] } | null;
  readonly injectionObservable: boolean;
  readonly sandboxDisposition: "removed" | "retained";
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function assert(condition: unknown, message: string, failures: string[]): void {
  if (!condition) failures.push(message);
}

async function withOverallTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`overall timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function findProductionPlugin(): Promise<string> {
  const candidates = [join(REPOSITORY_DIRECTORY, "dist/index.js"), join(REPOSITORY_DIRECTORY, "dist/index.mjs")];
  for (const candidate of candidates) {
    if (await exists(candidate)) return realpath(candidate);
  }
  throw new Error(`Built production plugin not found; checked ${candidates.join(", ")}`);
}

async function createProductionWrapper(sandbox: string, productionPluginPath: string) {
  const directory = join(sandbox, "production-plugin");
  const markers = join(sandbox, "production-plugin-markers");
  await mkdir(directory);
  await mkdir(markers);
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ private: true, type: "module", main: "./index.js" })}\n`,
  );
  await writeFile(
    join(directory, "index.js"),
    `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import productionDefault from ${JSON.stringify(pathToFileURL(productionPluginPath).href)};

const markers = ${JSON.stringify(markers)};
const mark = (name) => writeFile(join(markers, name), name + "\\n");

export default {
  id: productionDefault.id,
  server(...args) {
    return productionDefault.server.apply(productionDefault, args);
  },
  async setup(...args) {
    await mark("setup-entered");
    const cleanup = await productionDefault.setup.apply(productionDefault, args);
    if (typeof cleanup !== "function") throw new TypeError("production setup did not return cleanup");
    await mark("setup-loaded");
    return async (...cleanupArgs) => {
      await cleanup(...cleanupArgs);
      await mark("cleanup-complete");
    };
  },
};
`,
  );
  return { directory, markers };
}

async function run(): Promise<Evidence> {
  const runId = crypto.randomUUID();
  const failures: string[] = [];
  let sandbox = "";
  let service: IsolatedServiceState | undefined;
  let productionPluginPath = "";
  let productionWrapperDirectory = "";
  let productionWrapperMarkers = "";
  let productionWrapperConfigured = false;
  let memoryPath = "";
  let checkpointPath = "";
  let checkpointValue = "";
  let durableUserAssistantCount = 0;
  let durableUserAssistantIDs: string[] = [];
  let expectedCheckpointSourceMessageID = "";
  let requiredHeadingsPresent = false;
  let memorySentinelPresent = false;
  let telemetryRecordCount = 0;
  let ordinaryEvaluator: Evidence["ordinaryEvaluator"] = null;
  let injectionObservable = false;
  let cleanupCompleted = false;
  let initialObservation: ExternalSessionObservations | undefined;
  let finalObservation: ExternalSessionObservations | undefined;
  let observableOutput: unknown;
  let telemetryRecords: Awaited<ReturnType<typeof parseProbeTelemetryJsonl>> = [];
  let telemetryPath = "";
  try {
    productionPluginPath = await findProductionPlugin();
    await mkdir(SANDBOX_PARENT, { recursive: true });
    sandbox = await mkdtemp(join(SANDBOX_PARENT, "stm-v2-production-update-"));
    const project = join(sandbox, "project");
    const home = join(sandbox, "home");
    const xdgConfig = join(sandbox, "xdg-config");
    const xdgData = join(sandbox, "xdg-data");
    const xdgCache = join(sandbox, "xdg-cache");
    const xdgState = join(sandbox, "xdg-state");
    const xdgRuntime = join(sandbox, "xdg-runtime");
    const temporary = join(sandbox, "tmp");
    telemetryPath = join(sandbox, "telemetry.jsonl");
    const memoryDirectory = join(sandbox, "absolute-memory");
    await Promise.all(
      [project, home, xdgConfig, xdgData, xdgCache, xdgState, xdgRuntime, temporary, memoryDirectory].map((path) =>
        mkdir(path),
      ),
    );
    await mkdir(join(project, ".opencode"));
    const wrapper = await createProductionWrapper(sandbox, productionPluginPath);
    productionWrapperDirectory = wrapper.directory;
    productionWrapperMarkers = wrapper.markers;
    await writeFile(
      join(project, "opencode.json"),
      `${JSON.stringify({ plugins: [FIXTURE_DIRECTORY, productionWrapperDirectory] })}\n`,
    );
    productionWrapperConfigured = true;
    await writeFile(
      join(project, ".opencode", "stm.jsonc"),
      `${JSON.stringify({ enabled: true, memoryDir: memoryDirectory, summarizerMode: "clean", memoryModel: `${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID}` })}\n`,
    );
    const options: IsolatedServiceOptions = {
      cwd: project,
      serviceFile: join(xdgState, "opencode", "service.json"),
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_CACHE_HOME: xdgCache,
        XDG_STATE_HOME: xdgState,
        XDG_RUNTIME_DIR: xdgRuntime,
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
        NO_COLOR: "1",
        PROBE_RUN_ID: runId,
        PROBE_MODE: "ordinary",
        PROBE_TELEMETRY_PATH: telemetryPath,
      },
    };
    service = await bounded(() => startIsolatedService(options), OPERATION_TIMEOUT_MS);
    const session = await createModeledSession(service.client, project, OPERATION_TIMEOUT_MS);
    initialObservation = await observeSession(service.client, session.id, OPERATION_TIMEOUT_MS);
    await submitOrdinaryPrompt(service.client, session.id, FIRST_PROMPT, OPERATION_TIMEOUT_MS);
    observableOutput = await submitOrdinaryPrompt(service.client, session.id, SECOND_PROMPT, OPERATION_TIMEOUT_MS);
    finalObservation = await observeSession(service.client, session.id, OPERATION_TIMEOUT_MS);
    memoryPath = join(memoryDirectory, `session_${session.id.replace(/[^A-Za-z0-9._-]/g, "_")}.md`);
    checkpointPath = join(
      memoryDirectory,
      "checkpoints",
      `${session.id.replace(/[^A-Za-z0-9._-]/g, "_")}.last-message-id.txt`,
    );
    const memory = await readFile(memoryPath, "utf8");
    checkpointValue = (await readFile(checkpointPath, "utf8")).trim();
    requiredHeadingsPresent = REQUIRED_HEADINGS.every((heading) => memory.includes(heading));
    assert(requiredHeadingsPresent, "memory document is missing a required heading", failures);
    memorySentinelPresent = memory.includes(`${PROBE_MEMORY_SENTINEL}:${runId}`);
    assert(memorySentinelPresent, "generated memory sentinel missing", failures);
    assert(checkpointValue.length > 0, "checkpoint is empty", failures);
    const contextText = JSON.stringify(finalObservation.context);
    const durable = normalizeExternalMessages(finalObservation.messages).messages.filter(
      (message) => message.role === "user" || message.role === "assistant",
    );
    durableUserAssistantCount = durable.length;
    const userCount = durable.filter((message) => message.role === "user").length;
    const assistantCount = durable.filter((message) => message.role === "assistant").length;
    durableUserAssistantIDs = durable
      .map((message) => message.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    assert(
      userCount >= 2 && assistantCount >= 2,
      `expected at least two user and two assistant messages, observed ${userCount} user and ${assistantCount} assistant`,
      failures,
    );
    assert(
      durableUserAssistantIDs.length === durableUserAssistantCount &&
        new Set(durableUserAssistantIDs).size === durableUserAssistantIDs.length,
      "durable user/assistant IDs are not stable and unique",
      failures,
    );
    const secondUsers = durable.filter((message) => message.role === "user" && message.text === SECOND_PROMPT);
    expectedCheckpointSourceMessageID = secondUsers.length === 1 ? (secondUsers[0]!.id ?? "") : "";
    assert(
      secondUsers.length === 1,
      `expected exactly one second-turn user message, observed ${secondUsers.length}`,
      failures,
    );
    assert(expectedCheckpointSourceMessageID.length > 0, "second-turn user message has no stable ID", failures);
    assert(
      checkpointValue === expectedCheckpointSourceMessageID,
      "checkpoint does not match the second-turn user message ID",
      failures,
    );
    injectionObservable = contextText.includes("Session Memory") || contextText.includes(PROBE_MEMORY_SENTINEL);
    if (!injectionObservable) {
      console.warn(
        "Memory injection was not externally observable through session.context; other assertions are required.",
      );
    }
  } catch (error) {
    failures.push(errorText(error));
  } finally {
    if (service !== undefined) {
      try {
        await bounded(() => stopIsolatedService(service!), OPERATION_TIMEOUT_MS);
        cleanupCompleted = true;
      } catch (error) {
        failures.push(`service cleanup failed: ${errorText(error)}`);
      }
    }
    if (cleanupCompleted) {
      try {
        const telemetryText = await readFile(join(sandbox, "telemetry.jsonl"), "utf8");
        assert(telemetryText.includes('"phase":"complete"'), "fixture cleanup completion was not observed", failures);
      } catch (error) {
        failures.push(`cleanup evidence unavailable: ${errorText(error)}`);
      }
    }
  }
  try {
    telemetryRecords = parseProbeTelemetryJsonl(await readFile(telemetryPath, "utf8"), { runId, mode: "ordinary" });
    telemetryRecordCount = telemetryRecords.length;
    assert(
      telemetryRecords.some((record) => record.event === "setup" && record.name === "stm-v2-generation-probe"),
      "deterministic provider setup missing",
      failures,
    );
    assert(
      telemetryRecords.some((record) => record.event === "provider" && record.provider === PROBE_PROVIDER_ID),
      "deterministic provider not selected",
      failures,
    );
    if (initialObservation !== undefined && finalObservation !== undefined) {
      const evaluation = evaluateOrdinary({
        mode: "ordinary",
        records: telemetryRecords,
        externalBefore: initialObservation,
        externalAfter: finalObservation,
        externalHistory: finalObservation,
        observableOutput,
      });
      ordinaryEvaluator = { passed: evaluation.passed, failures: evaluation.failures };
      failures.push(...evaluation.failures);
    } else {
      ordinaryEvaluator = { passed: false, failures: ["ordinary evaluator observations were unavailable"] };
      failures.push(...ordinaryEvaluator.failures);
    }
  } catch (error) {
    failures.push(`telemetry/evaluator: ${errorText(error)}`);
  }
  const productionWrapperSetupEntered =
    productionWrapperMarkers !== "" && (await exists(join(productionWrapperMarkers, "setup-entered")));
  const productionWrapperLoaded =
    productionWrapperMarkers !== "" && (await exists(join(productionWrapperMarkers, "setup-loaded")));
  const productionWrapperCleanupObserved =
    productionWrapperMarkers !== "" && (await exists(join(productionWrapperMarkers, "cleanup-complete")));
  if (!productionWrapperLoaded) failures.push("production wrapper setup was not observed");
  if (service !== undefined && !cleanupCompleted) failures.push("service cleanup did not complete");
  const evidencePath = join(SANDBOX_PARENT, `production-update-probe-${runId}.json`);
  const evidence: Evidence = {
    runId,
    verdict: failures.length === 0 ? "pass" : "fail",
    failures,
    memoryPath,
    checkpointPath,
    productionPluginPath,
    productionWrapperDirectory,
    productionWrapperConfigured,
    productionWrapperSetupEntered,
    productionWrapperLoaded,
    productionWrapperCleanupObserved,
    checkpointValue,
    durableUserAssistantCount,
    durableUserAssistantIDs,
    expectedCheckpointSourceMessageID,
    requiredHeadingsPresent,
    memorySentinelPresent,
    telemetryRecordCount,
    ordinaryEvaluator,
    injectionObservable,
    sandboxDisposition: failures.length === 0 ? "removed" : "retained",
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (failures.length === 0 && sandbox) await rm(sandbox, { recursive: true, force: true });
  console.log(`run ID: ${runId}`);
  console.log(`verdict: ${evidence.verdict}`);
  console.log(`evidence: ${evidencePath}`);
  console.log(`sandbox: ${evidence.sandboxDisposition}${sandbox ? ` (${sandbox})` : ""}`);
  if (failures.length > 0) throw new Error(failures.join("; "));
  return evidence;
}

await withOverallTimeout(run(), OVERALL_TIMEOUT_MS);
