import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { captureSetupSnapshot, PROBE_MEMORY_SENTINEL, PROBE_MODEL_ID, PROBE_PROVIDER_ID } from "./index.js";
import { evaluateSetupEvidence, SETUP_CALLS } from "./setup-evidence.js";
import {
  bounded,
  captureInitializedSetupSnapshot,
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
import {
  countToolExecutionEvents,
  evaluateOrdinary,
  evaluatePrimaryMemoryToolInventory,
  normalizeExternalMessages,
  parseProbeTelemetryJsonl,
} from "./evaluator.js";
import { evaluateResetEvidence } from "./reset-evidence.js";
import {
  DIAGNOSTICS_PROMPT,
  evaluateDiagnosticsEvidence,
  expectedDiagnosticsSettings,
} from "./diagnostics-evidence.js";
import {
  evaluateManualEvidence,
  MANUAL_SEED_PROMPT,
  MANUAL_FIRST_PROMPT,
  MANUAL_POST_RESET_PROMPT,
  MANUAL_SECOND_PROMPT,
} from "./manual-evidence.js";

const FIXTURE_DIRECTORY = import.meta.dir;
const REPOSITORY_DIRECTORY = resolve(FIXTURE_DIRECTORY, "../..");
const SANDBOX_PARENT = join(tmpdir(), "opencode");
const OVERALL_TIMEOUT_MS = ["manual-update", "setup"].includes(Bun.env.PROBE_SCENARIO ?? "") ? 60_000 : 45_000;
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
const RESET_PROMPT = "Use stm_memory_reset to reset this session. Confirm only after the first refusal.";
const POST_RESET_PROMPT = "Continue after the confirmed reset with a fresh post-reset message.";
const POST_RESET_FOLLOWUP_PROMPT = "Acknowledge the post-reset continuation with one final ordinary response.";
const SCENARIO =
  Bun.env.PROBE_SCENARIO === "setup"
    ? "setup"
    : Bun.env.PROBE_SCENARIO === "manual-update"
      ? "manual-update"
      : Bun.env.PROBE_SCENARIO === "reset"
        ? "reset"
        : "ordinary";

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
  readonly observedToolNames: readonly string[];
  readonly primaryModelToolNames: readonly string[];
  readonly ordinaryEvaluator: { readonly passed: boolean; readonly failures: readonly string[] } | null;
  readonly injectionObservable: boolean;
  readonly sandboxDisposition: "removed" | "retained";
  readonly scenario: "ordinary" | "reset" | "manual-update" | "setup";
  readonly setupEvaluator: ReturnType<typeof evaluateSetupEvidence> | null;
  readonly setupEvidence: Parameters<typeof evaluateSetupEvidence>[0] | null;
  readonly automaticContextSuppressed: boolean;
  readonly manualExecutionEvents: number;
  readonly manualTelemetry?: Awaited<ReturnType<typeof parseProbeTelemetryJsonl>>;
  readonly resetBoundaryAnchor?: string;
  readonly resetExecutionEvents: number;
  readonly diagnosticsExecutionEvents: number;
  readonly diagnosticsEvaluator: ReturnType<typeof evaluateDiagnosticsEvidence> | null;
  readonly expectedDiagnosticsSettings: ReturnType<typeof expectedDiagnosticsSettings> | null;
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

function invocationToolNames(record: Awaited<ReturnType<typeof parseProbeTelemetryJsonl>>[number]): readonly string[] {
  if (record.event !== "model.invocation" || record.details === undefined) return [];
  const names = record.details.toolNames;
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
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
    ${
      SCENARIO === "manual-update" || SCENARIO === "setup"
        ? `// Suppress only production's combined automatic context callback in this isolated scenario.
    const original = args[0];
    const access = { context: 0, get: 0, sessionGenerate: 0, standaloneGenerate: 0 };
    const accessPath = join(markers, "production-access.json");
    await writeFile(accessPath, JSON.stringify(access));
    const session = new Proxy(original.session, { get(target, key) {
      if (key === "hook") return (name, callback, ...options) => {
        if (name === "context") return target.hook(name, async () => {}, ...options).then(async (registration) => {
          await mark("automatic-context-suppressed");
          return registration;
        });
        return target.hook(name, callback, ...options);
      };
      const value = Reflect.get(target, key);
      if (["context", "get", "generate"].includes(key) && typeof value === "function") return async (...params) => {
        access[key === "generate" ? "sessionGenerate" : key]++;
        await writeFile(accessPath, JSON.stringify(access));
        return value.apply(target, params);
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const generate = new Proxy(original.generate, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "text") return async (...params) => {
        access.standaloneGenerate++;
        await writeFile(accessPath, JSON.stringify(access));
        return value.apply(target, params);
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    args[0] = new Proxy(original, { get(target, key) { return key === "session" ? session : key === "generate" ? generate : Reflect.get(target, key); } });`
        : ""
    }
    const cleanup = await productionDefault.setup(...args);
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
  let observedToolNames: string[] = [];
  let primaryModelToolNames: string[] = [];
  let ordinaryEvaluator: Evidence["ordinaryEvaluator"] = null;
  let injectionObservable = false;
  let cleanupCompleted = false;
  let initialObservation: ExternalSessionObservations | undefined;
  let finalObservation: ExternalSessionObservations | undefined;
  let observableOutput: unknown;
  let telemetryRecords: Awaited<ReturnType<typeof parseProbeTelemetryJsonl>> = [];
  let telemetryPath = "";
  let resetBoundaryAnchor: string | undefined;
  let sessionID = "";
  let finalBoundary: string | undefined;
  let diagnosticsEvaluator: Evidence["diagnosticsEvaluator"] = null;
  let diagnosticsSettings: Evidence["expectedDiagnosticsSettings"] = null;
  let setupEvidence: Evidence["setupEvidence"] = null;
  let setupEvaluator: Evidence["setupEvaluator"] = null;
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
    diagnosticsSettings = expectedDiagnosticsSettings(memoryDirectory);
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
        PROBE_SCENARIO: SCENARIO,
        PROBE_MEMORY_DIR: memoryDirectory,
        PROBE_PROJECT_CONFIG_PATH: join(project, ".opencode", "stm.jsonc"),
        PROBE_PRODUCTION_ACCESS_PATH: join(productionWrapperMarkers, "production-access.json"),
        PROBE_TELEMETRY_PATH: telemetryPath,
      },
    };
    service = await bounded(() => startIsolatedService(options), OPERATION_TIMEOUT_MS);
    const session = await createModeledSession(service.client, project, OPERATION_TIMEOUT_MS);
    sessionID = session.id;
    initialObservation = await observeSession(service.client, session.id, OPERATION_TIMEOUT_MS);
    if (SCENARIO === "setup") {
      const configPath = join(project, ".opencode", "stm.jsonc");
      const snapshot = () =>
        captureSetupSnapshot(configPath, memoryDirectory, join(productionWrapperMarkers, "production-access.json"));
      const initial = await captureInitializedSetupSnapshot(service.client, session.id, snapshot, OPERATION_TIMEOUT_MS);
      let removal: NonNullable<Evidence["setupEvidence"]>["removal"] = null;
      for (const [index, call] of SETUP_CALLS.entries()) {
        if (index === 2) {
          // Only the harness-owned initial config, after both refusal prompts completed.
          const before = await snapshot();
          if (before.configs.jsonc !== initial.configs.jsonc || before.configs.json !== null)
            throw new Error("fixture config changed before removal");
          const records = parseProbeTelemetryJsonl(await readFile(telemetryPath, "utf8"), { runId, mode: "ordinary" });
          await rm(configPath);
          removal = {
            path: configPath,
            afterSeq: records.at(-1)?.seq ?? 0,
            completedPrompts: SETUP_CALLS.slice(0, 2).map((c) => c.prompt),
            before,
            after: await snapshot(),
          };
        }
        observableOutput = await submitOrdinaryPrompt(service.client, session.id, call.prompt, OPERATION_TIMEOUT_MS);
      }
      setupEvidence = {
        records: [],
        sessionID,
        configPath,
        initial,
        final: await snapshot(),
        suppressionObserved: false,
        removal,
      };
    } else if (SCENARIO === "manual-update") {
      for (const prompt of [
        MANUAL_SEED_PROMPT,
        MANUAL_FIRST_PROMPT,
        RESET_PROMPT,
        MANUAL_POST_RESET_PROMPT,
        MANUAL_SECOND_PROMPT,
        DIAGNOSTICS_PROMPT,
      ]) {
        observableOutput = await submitOrdinaryPrompt(service.client, session.id, prompt, OPERATION_TIMEOUT_MS);
      }
      finalBoundary = await readFile(
        join(memoryDirectory, "reset-boundaries", `${session.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`),
        "utf8",
      );
      const boundary = JSON.parse(finalBoundary) as { anchorID?: unknown };
      if (typeof boundary.anchorID === "string") resetBoundaryAnchor = boundary.anchorID;
    } else if (SCENARIO === "reset") {
      const boundaryPath = join(
        memoryDirectory,
        "reset-boundaries",
        `${session.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
      );
      await submitOrdinaryPrompt(service.client, session.id, FIRST_PROMPT, OPERATION_TIMEOUT_MS);
      await submitOrdinaryPrompt(service.client, session.id, SECOND_PROMPT, OPERATION_TIMEOUT_MS);
      await submitOrdinaryPrompt(service.client, session.id, RESET_PROMPT, OPERATION_TIMEOUT_MS);
      try {
        const boundary = JSON.parse(await readFile(boundaryPath, "utf8")) as { anchorID?: unknown };
        if (typeof boundary.anchorID === "string") resetBoundaryAnchor = boundary.anchorID;
      } catch (error) {
        failures.push(`reset boundary unavailable: ${errorText(error)}`);
      }
      await submitOrdinaryPrompt(service.client, session.id, POST_RESET_PROMPT, OPERATION_TIMEOUT_MS);
      observableOutput = await submitOrdinaryPrompt(
        service.client,
        session.id,
        POST_RESET_FOLLOWUP_PROMPT,
        OPERATION_TIMEOUT_MS,
      );
    } else {
      await submitOrdinaryPrompt(service.client, session.id, FIRST_PROMPT, OPERATION_TIMEOUT_MS);
      observableOutput = await submitOrdinaryPrompt(service.client, session.id, SECOND_PROMPT, OPERATION_TIMEOUT_MS);
    }
    finalObservation = await observeSession(service.client, session.id, OPERATION_TIMEOUT_MS);
    memoryPath = join(memoryDirectory, `session_${session.id.replace(/[^A-Za-z0-9._-]/g, "_")}.md`);
    checkpointPath = join(
      memoryDirectory,
      "checkpoints",
      `${session.id.replace(/[^A-Za-z0-9._-]/g, "_")}.last-message-id.txt`,
    );
    if (SCENARIO !== "setup") {
      const memory = await readFile(memoryPath, "utf8");
      checkpointValue = (await readFile(checkpointPath, "utf8")).trim();
      requiredHeadingsPresent = REQUIRED_HEADINGS.every((heading) => memory.includes(heading));
      assert(requiredHeadingsPresent, "memory document is missing a required heading", failures);
      memorySentinelPresent = memory.includes(`${PROBE_MEMORY_SENTINEL}:${runId}`);
      assert(memorySentinelPresent, "generated memory sentinel missing", failures);
      if (SCENARIO === "ordinary") assert(checkpointValue.length > 0, "checkpoint is empty", failures);
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
      if (SCENARIO === "reset") {
        for (const prompt of [
          FIRST_PROMPT,
          SECOND_PROMPT,
          RESET_PROMPT,
          POST_RESET_PROMPT,
          POST_RESET_FOLLOWUP_PROMPT,
        ]) {
          const occurrences = durable.filter((message) => message.role === "user" && message.text === prompt).length;
          assert(occurrences === 1, `expected exactly one durable reset prompt occurrence for ${prompt}`, failures);
        }
      }
      const secondUsers = durable.filter(
        (message) =>
          message.role === "user" &&
          message.text ===
            (SCENARIO === "manual-update"
              ? MANUAL_SECOND_PROMPT
              : SCENARIO === "reset"
                ? POST_RESET_FOLLOWUP_PROMPT
                : SECOND_PROMPT),
      );
      expectedCheckpointSourceMessageID = secondUsers.length === 1 ? (secondUsers[0]!.id ?? "") : "";
      assert(
        secondUsers.length === 1,
        `expected exactly one second-turn user message, observed ${secondUsers.length}`,
        failures,
      );
      assert(expectedCheckpointSourceMessageID.length > 0, "second-turn user message has no stable ID", failures);
      if (SCENARIO === "ordinary") {
        assert(
          checkpointValue === expectedCheckpointSourceMessageID,
          "checkpoint does not match the second-turn user message ID",
          failures,
        );
      } else {
        assert(
          checkpointValue === expectedCheckpointSourceMessageID,
          "post-reset message was not processed into the checkpoint",
          failures,
        );
      }
      injectionObservable = contextText.includes("Session Memory") || contextText.includes(PROBE_MEMORY_SENTINEL);
      if (!injectionObservable) {
        console.warn(
          "Memory injection was not externally observable through session.context; other assertions are required.",
        );
      }
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
    observedToolNames = [...new Set(telemetryRecords.flatMap((record) => invocationToolNames(record)))].sort();
    const primaryRequests = telemetryRecords
      .filter((record) => record.event === "model.request" && record.requestKind === "primary")
      .map((record) => record.seq);
    const primaryInvocations = telemetryRecords.filter(
      (record) =>
        record.event === "model.invocation" &&
        primaryRequests.some(
          (requestSeq) =>
            requestSeq < record.seq &&
            !telemetryRecords.some(
              (boundary) =>
                boundary.event === "model.request" && boundary.seq > requestSeq && boundary.seq < record.seq,
            ),
        ),
    );
    const primaryToolNames = [...new Set(primaryInvocations.flatMap((record) => invocationToolNames(record)))];
    primaryModelToolNames = primaryToolNames;
    failures.push(...evaluatePrimaryMemoryToolInventory(primaryToolNames));
    if (SCENARIO === "reset") {
      const invocations = telemetryRecords.filter((record) => record.event === "model.invocation");
      assert(
        invocations.some((record) => record.sentinel === "stm_memory_reset:false"),
        "refusal tool call missing",
        failures,
      );
      assert(
        invocations.some((record) => record.sentinel === "stm_memory_reset:true"),
        "confirmed tool call missing",
        failures,
      );
      const executionEvents = telemetryRecords.filter(
        (record) => record.event === "event.observed" && /^tool.execute\.(before|after)$/.test(record.observedEvent),
      );
      assert(executionEvents.length >= 4, "reset execution before/after evidence is incomplete", failures);
      const boundary = checkpointValue;
      assert(boundary.length > 0, "post-reset checkpoint is empty", failures);
      assert(resetBoundaryAnchor !== undefined, "reset boundary anchor is missing", failures);
      const resetEvaluation = evaluateResetEvidence({
        records: telemetryRecords,
        resetBoundaryAnchor,
        firstPrompt: FIRST_PROMPT,
        secondPrompt: SECOND_PROMPT,
        resetPrompt: RESET_PROMPT,
        postResetPrompt: POST_RESET_PROMPT,
        postResetFollowupPrompt: POST_RESET_FOLLOWUP_PROMPT,
      });
      failures.push(...resetEvaluation.failures);
    }
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
    if (SCENARIO === "ordinary" && initialObservation !== undefined && finalObservation !== undefined) {
      const evaluation = evaluateOrdinary({
        mode: SCENARIO,
        records: telemetryRecords,
        externalBefore: initialObservation,
        externalAfter: finalObservation,
        externalHistory: finalObservation,
        observableOutput,
      });
      ordinaryEvaluator = { passed: evaluation.passed, failures: evaluation.failures };
      failures.push(...evaluation.failures);
    } else if (SCENARIO === "ordinary") {
      ordinaryEvaluator = { passed: false, failures: [`${SCENARIO} evaluator observations were unavailable`] };
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
  const automaticContextSuppressed =
    productionWrapperMarkers !== "" && (await exists(join(productionWrapperMarkers, "automatic-context-suppressed")));
  if (SCENARIO === "setup") {
    if (setupEvidence !== null) {
      setupEvidence = { ...setupEvidence, records: telemetryRecords, suppressionObserved: automaticContextSuppressed };
      setupEvaluator = evaluateSetupEvidence(setupEvidence);
      failures.push(...setupEvaluator.failures);
    } else failures.push("setup lifecycle evidence unavailable");
  }
  if (SCENARIO === "manual-update") {
    if (diagnosticsSettings !== null) {
      diagnosticsEvaluator = evaluateDiagnosticsEvidence({
        records: telemetryRecords,
        sessionID,
        expectedSettings: diagnosticsSettings,
      });
      failures.push(...diagnosticsEvaluator.failures);
    } else failures.push("diagnostic settings oracle unavailable");
    failures.push(
      ...evaluateManualEvidence({
        records: telemetryRecords,
        sessionID,
        runId,
        suppressionObserved: automaticContextSuppressed,
        finalCheckpoint: checkpointValue,
        finalBoundary,
      }).failures,
    );
  }
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
    observedToolNames,
    primaryModelToolNames,
    ordinaryEvaluator,
    injectionObservable,
    sandboxDisposition: failures.length === 0 ? "removed" : "retained",
    scenario: SCENARIO,
    setupEvaluator,
    setupEvidence,
    automaticContextSuppressed,
    ...(SCENARIO === "manual-update" ? { manualTelemetry: telemetryRecords } : {}),
    manualExecutionEvents: countToolExecutionEvents(telemetryRecords, "stm_memory_update"),
    resetExecutionEvents: countToolExecutionEvents(telemetryRecords, "stm_memory_reset"),
    diagnosticsExecutionEvents:
      countToolExecutionEvents(telemetryRecords, "stm_memory_logs") +
      countToolExecutionEvents(telemetryRecords, "stm_memory_settings"),
    diagnosticsEvaluator,
    expectedDiagnosticsSettings: SCENARIO === "manual-update" ? diagnosticsSettings : null,
    resetBoundaryAnchor,
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
