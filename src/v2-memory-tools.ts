import { resolve } from "node:path";
import type { Info as ToolDefinition, ToolContext } from "@opencode/plugin/promise/tool";
import { readConfigDiagnostics } from "./memory-utils";
import {
  checkpointPathFor,
  createProjectExampleConfig,
  memoryPathFor,
  parseModel,
  readConfig,
  readRawFile,
  readText,
  resetBoundaryPathFor,
  safeSessionID,
  logPath,
  type SessionMemoryConfig,
} from "./memory-utils";
import { readLastProcessedMessageID } from "./message-collector";
import { createV2MemoryUpdater, isV2MemoryUpdateInFlight } from "./v2-memory-update";
import type { V2Context } from "./v2-adapter";
import { readV2CurrentHistory, readV2ResetAnchor } from "./v2-current-history";
import { getV2MemoryReadRevision, getV2MemorySessionSignal } from "./v2-mutation-coordination";
import { parseV2ResetBoundary } from "./v2-reset-boundary";
import { resetV2MemoryPersistence } from "./v2-reset-persistence";
import { getV2ConfigInstallation } from "./v2-config-installation";
import { readV2Telemetry } from "./v2-telemetry";

const EMPTY_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} satisfies ToolDefinition["input"];

const RESET_INPUT = {
  type: "object",
  properties: { confirm: { type: "boolean" } },
  required: ["confirm"],
  additionalProperties: false,
} satisfies ToolDefinition["input"];

const SETUP_INPUT = {
  type: "object",
  properties: { confirm: { type: "boolean" } },
  additionalProperties: false,
} satisfies ToolDefinition["input"];

const COMPATIBILITY_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["show", "status", "update", "reset", "logs", "settings", "setup"],
    },
    confirm: { type: "boolean" },
  },
  additionalProperties: false,
} satisfies ToolDefinition["input"];

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] as const };
}

function memoryModelSelection(config: SessionMemoryConfig) {
  const configuredModel = config.memoryModel.trim();
  if (!configuredModel) {
    return {
      memoryModel: null,
      memoryModelSelection: config.summarizerMode === "clean" ? "host-default" : "current-session",
    };
  }
  const parsedModel = parseModel(configuredModel);
  if (!parsedModel || !parsedModel.providerID.trim() || !parsedModel.modelID.trim()) {
    return { memoryModel: null, memoryModelSelection: "invalid-override" };
  }
  return { memoryModel: configuredModel, memoryModelSelection: "explicit-override" };
}

async function readMemory(sessionID: string, directory: string, lifetimeSignal?: AbortSignal) {
  if (typeof sessionID !== "string" || !sessionID.trim() || safeSessionID(sessionID) !== sessionID) {
    throw new Error("STM read sessionID must be nonempty and path-safe.");
  }
  const revision = getV2MemoryReadRevision(directory, sessionID);
  const assertCurrent = () => {
    lifetimeSignal?.throwIfAborted();
    getV2MemorySessionSignal(directory, sessionID).throwIfAborted();
    if (getV2MemoryReadRevision(directory, sessionID) !== revision) throw new Error("memory_read_invalidated");
  };
  assertCurrent();
  const config = await readConfig(undefined, directory);
  assertCurrent();
  const memory = await readText(memoryPathFor(sessionID, config.memoryDir), "No memory file exists yet.");
  assertCurrent();
  return memory;
}

export async function readV2MemoryStatus(sessionID: string, directory: string, context?: V2Context): Promise<string> {
  if (typeof sessionID !== "string" || !sessionID.trim() || safeSessionID(sessionID) !== sessionID) {
    throw new Error("STM status sessionID must be nonempty and path-safe.");
  }
  const config = await readConfig(undefined, directory);
  const memoryPath = memoryPathFor(sessionID, config.memoryDir);
  const checkpointPath = checkpointPathFor(sessionID, config.memoryDir);
  const boundaryPath = resetBoundaryPathFor(sessionID, config.memoryDir);
  const text = await readText(memoryPath, "");
  const checkpoint = await readLastProcessedMessageID(sessionID, config);
  let boundaryState = "absent";
  let boundaryAnchor: string | null | undefined;
  try {
    const rawBoundary = await readRawFile(boundaryPath);
    if (rawBoundary !== null) {
      try {
        boundaryAnchor = parseV2ResetBoundary(rawBoundary).anchorID;
        boundaryState = "valid";
      } catch {
        boundaryState = "invalid";
      }
    }
  } catch {
    boundaryState = "unreadable";
  }
  const selection = memoryModelSelection(config);
  const telemetry = readV2Telemetry(context);
  const markdown = [
    "generation: v2",
    `enabled: ${config.enabled}`,
    `authoritative sessionID: ${sessionID}`,
    `configuredMemoryModel: ${config.memoryModel || "none"}`,
    `effectiveMemoryModel: ${selection.memoryModel ?? (selection.memoryModelSelection === "host-default" ? "host default" : selection.memoryModelSelection === "current-session" ? "current session" : "unavailable")}`,
    `memoryModelSelection: ${selection.memoryModelSelection}`,
    `summarizerMode: ${config.summarizerMode}`,
    `memoryDir: ${config.memoryDir}`,
    `memoryPath: ${memoryPath}`,
    `checkpointPath: ${checkpointPath}`,
    `resetBoundaryPath: ${boundaryPath}`,
    `resetBoundary: ${boundaryState}`,
    ...(boundaryAnchor ? [`resetBoundaryAnchor: ${boundaryAnchor}`] : []),
    "resetPolicy: pause if anchor absent",
    `memoryBytes: ${Buffer.byteLength(text, "utf8")}`,
    `checkpoint: ${checkpoint || "none"}`,
    `updaterBusy: ${isV2MemoryUpdateInFlight(directory, sessionID)}`,
    "counterScope: plugin-runtime",
    `updateCount: ${telemetry.updateCount}`,
    `injectCount: ${telemetry.injectCount}`,
    `injectCharCount: ${telemetry.injectCharCount}`,
    `compactCount: ${telemetry.compactCount}`,
    `lastUpdateAt: ${telemetry.lastUpdateAt || "never"}`,
    `lastInjectAt: ${telemetry.lastInjectAt || "never"}`,
    `lastError: ${telemetry.lastError || "none"}`,
  ].join("\n");
  return markdown;
}

function authoritativeIdentity(sessionID: string, messageID?: string): void {
  if (typeof sessionID !== "string" || !sessionID.trim()) {
    throw new Error("reset sessionID must be a nonempty string");
  }
  if (safeSessionID(sessionID) !== sessionID) {
    throw new Error("reset sessionID contains unsafe path characters");
  }
  if (messageID !== undefined && (typeof messageID !== "string" || !messageID.trim())) {
    throw new Error("reset messageID must be a nonempty string");
  }
}

async function resetMemory(
  sessionID: string,
  confirm: unknown,
  pluginContext: V2Context,
  directory: string,
  messageID?: string,
  lifetimeSignal?: AbortSignal,
) {
  if (confirm !== true) {
    return "Refused to reset V2 short-term memory: set confirm to literal true to confirm this destructive action.";
  }
  authoritativeIdentity(sessionID, messageID);
  lifetimeSignal?.throwIfAborted();
  // Only snapshot eligibility failures are refusals; persistence failures still propagate.
  let refusal: string | undefined;
  let anchor: string | null;
  try {
    anchor = await resetV2MemoryPersistence(
      sessionID,
      directory,
      async () => {
        try {
          return await readV2ResetAnchor(pluginContext, sessionID);
        } catch (error) {
          refusal = `Refused to reset V2 short-term memory: ${error instanceof Error ? error.message : String(error)}.`;
          throw error;
        }
      },
      undefined,
      undefined,
      lifetimeSignal,
    );
  } catch (error) {
    if (refusal !== undefined) return refusal;
    throw error;
  }
  return [
    "generation: v2",
    "reset: completed",
    "scope: memory, checkpoint, and reset boundary",
    `authoritative sessionID: ${sessionID}`,
    `resetBoundaryAnchor: ${anchor}`,
    ...(messageID === undefined
      ? ["boundaryScope: through last record of settled durable snapshot; not invocation message"]
      : []),
    "resetPolicy: pause if anchor absent",
    "crashAtomic: false",
    "semanticErasure: false",
  ].join("\n");
}

async function updateMemory(
  sessionID: string,
  pluginContext: V2Context,
  directory: string,
  updater: ReturnType<typeof createV2MemoryUpdater>,
) {
  if (typeof sessionID !== "string" || !sessionID.trim() || safeSessionID(sessionID) !== sessionID) {
    return [
      "generation: v2",
      "update: error",
      "reason: invalid_session_id",
      "source: not-read",
      `sessionID: ${JSON.stringify(sessionID) ?? "unavailable"}`,
      "progress: not-started",
      "rollback: not-applicable",
      "detail: authoritative tool sessionID must be nonempty and path-safe",
    ].join("\n");
  }
  const labels = ["generation: v2", `sessionID: ${sessionID}`];
  if (isV2MemoryUpdateInFlight(directory, sessionID)) {
    return [
      ...labels,
      "update: busy",
      "reason: update_in_flight",
      "source: not-read",
      "progress: not-started",
      "rollback: not-applicable",
      "detail: retry after the active update finishes",
    ].join("\n");
  }
  const current = await readV2CurrentHistory(pluginContext, sessionID);
  if (current.status !== "ready") {
    return [
      ...labels,
      `update: ${current.status === "error" ? "error" : "unavailable"}`,
      `reason: ${current.status}`,
      "source: unavailable",
      "progress: not-started",
      "rollback: not-applicable",
      `detail: ${JSON.stringify(current.status === "no-model" ? "current session model unavailable" : current.reason)}`,
    ].join("\n");
  }
  // Do not queue a mutation lock around the updater: it acquires ownership itself.
  const result = await updater(current.history);
  if (result.status === "committed") {
    const config = await readConfig(undefined, directory);
    return await readText(
      memoryPathFor(sessionID, config.memoryDir),
      "Memory update completed, but no memory file was found.",
    );
  }
  return [
    ...labels,
    `update: ${result.status}`,
    `reason: ${result.reason}`,
    `source: ${current.history.source}`,
    ...(current.history.stoppedBeforeMessageID
      ? [`stoppedBeforeMessageID: ${current.history.stoppedBeforeMessageID}`]
      : []),
    `progress: cumulative-invocation ${JSON.stringify({
      checkpointedChunks: result.checkpointedChunks,
      checkpointedMessages: result.checkpointedMessages,
      persistedPartialFragments: result.persistedPartialFragments,
    })}`,
    `rollback: ${result.status === "error" ? (result.rollback ?? "none-reported") : "not-applicable"}`,
    `detail: ${result.status === "error" ? JSON.stringify(result.detail) : "none"}`,
  ].join("\n");
}

export function createV2MemoryActions(pluginContext: V2Context, lifetimeSignal?: AbortSignal) {
  const directory = pluginContext.location.directory;
  const updater = createV2MemoryUpdater(pluginContext, directory, { lifetimeSignal });
  return {
    show: (sessionID: string) => readMemory(sessionID, directory, lifetimeSignal),
    status: (sessionID: string) => readV2MemoryStatus(sessionID, directory, pluginContext),
    update: (sessionID: string) => updateMemory(sessionID, pluginContext, directory, updater),
    reset: (sessionID: string, input: { readonly confirm?: unknown; readonly messageID?: string }) =>
      resetMemory(sessionID, input.confirm, pluginContext, directory, input.messageID, lifetimeSignal),
    logs: async (_sessionID: string) => {
      const config = await readConfig(undefined, directory);
      return resolve(logPath(config.memoryDir));
    },
    settings: async (_sessionID: string) => {
      const config = await readConfig(undefined, directory);
      const configuration = await readConfigDiagnostics(directory);
      const installation = getV2ConfigInstallation(pluginContext);
      return JSON.stringify(
        {
          generation: "v2",
          configuration: {
            ...configuration,
            ...(installation ? { installation } : {}),
          },
          resolvedConfig: config,
          effective: {
            enabled: config.enabled,
            ...memoryModelSelection(config),
            summarizerMode: config.summarizerMode,
            maxMemoryLength: config.maxMemoryLength,
            maxUpdateInputLength: config.maxUpdateInputLength,
            maxDeltaMessages: config.maxDeltaMessages,
            memoryDir: config.memoryDir,
            cleanFallbackToActiveSession: config.cleanFallbackToActiveSession,
            includeAgentsMdOnFirstUpdate: config.includeAgentsMdOnFirstUpdate,
            injectInSubagents: config.injectInSubagents,
            enableLegacyPeriodicSystemTransform: config.enableLegacyPeriodicSystemTransform,
            sideSessionRetries: config.sideSessionRetries,
            remindEveryN: config.remindEveryN,
            debounceMs: config.debounceMs,
            collapseAssistantBursts: config.collapseAssistantBursts,
            debug: config.debug,
            logMaxLines: config.logMaxLines,
            updateHook: "idle",
            updateHooks: ["idle", "compaction", "manual"],
            injectionHooks: ["context", "prompt", "compaction"],
          },
          inactiveSettings: [],
        },
        null,
        2,
      );
    },
    setup: async (_sessionID: string, input: { readonly confirm?: unknown }) => {
      if (input.confirm !== true) {
        return "Refused to create a project example config: set confirm to literal true to confirm setup.";
      }
      lifetimeSignal?.throwIfAborted();
      const result = await createProjectExampleConfig(directory, () => !lifetimeSignal?.aborted);
      return [
        result.message,
        `configPath: ${result.configPath}`,
        "Shared example: see stm_memory_settings for effective V2 settings; explicit memoryModel overrides apply in either summarizer mode.",
      ].join("\n");
    },
  };
}

export function createV2MemoryTools(
  pluginContext: V2Context,
  lifetimeSignal?: AbortSignal,
): readonly [
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
] {
  const actions = createV2MemoryActions(pluginContext, lifetimeSignal);
  const readTool = {
    name: "stm_memory_read",
    description: "Read the current session's persisted short-term memory.",
    input: EMPTY_INPUT,
    options: { codemode: false },
    execute: async (_input: Record<string, never>, context: ToolContext) =>
      textResult(await actions.show(context.sessionID)),
  } satisfies ToolDefinition;
  const statusTool = {
    name: "stm_memory_status",
    description: "Show persisted V2 short-term memory status for the current session.",
    input: EMPTY_INPUT,
    options: { codemode: false },
    execute: async (_input: Record<string, never>, context: ToolContext) =>
      textResult(await actions.status(context.sessionID)),
  } satisfies ToolDefinition;
  const resetTool = {
    name: "stm_memory_reset",
    description: "Reset persisted V2 short-term memory after literal confirmation.",
    input: RESET_INPUT,
    options: { codemode: false },
    execute: async (input: unknown, context: ToolContext) => {
      const confirm =
        input !== null && typeof input === "object" ? (input as { confirm?: unknown }).confirm : undefined;
      return textResult(await actions.reset(confirm === true ? context.sessionID : "", { confirm }));
    },
  } satisfies ToolDefinition;
  const updateTool = {
    name: "stm_memory_update",
    description:
      "Update short-term memory from fresh settled durable visible text. With no memoryModel override, clean mode uses the host default model and active mode uses the current session model; an explicit memoryModel override applies in either mode. Returns the resulting memory when committed and reports skips, failures, and cumulative progress otherwise. Retry if busy.",
    input: EMPTY_INPUT,
    options: { codemode: false },
    execute: async (_input: Record<string, never>, context: ToolContext) =>
      textResult(await actions.update(context.sessionID)),
  } satisfies ToolDefinition;
  const logsTool = {
    name: "stm_memory_logs",
    description:
      "Return the absolute path to the shared STM log file on the OpenCode server. Does not read log contents.",
    input: EMPTY_INPUT,
    options: { codemode: false },
    execute: async (_input: Record<string, never>) => textResult(await actions.logs("")),
  } satisfies ToolDefinition;
  const settingsTool = {
    name: "stm_memory_settings",
    description:
      "Read resolved project configuration and effective V2 short-term memory behavior, including settings inactive in V2. Does not read host sessions or change configuration.",
    input: EMPTY_INPUT,
    options: { codemode: false },
    execute: async (_input: Record<string, never>) => textResult(await actions.settings("")),
  } satisfies ToolDefinition;
  const setupTool = {
    name: "stm_memory_setup",
    description:
      "Create a project-local .opencode/stm.jsonc shared example without overwriting existing STM config. Requires confirm set to true. See stm_memory_settings for effective V2 settings; explicit memoryModel overrides apply in either summarizer mode.",
    input: SETUP_INPUT,
    options: { codemode: false },
    execute: async (input: unknown) => {
      const confirm =
        input !== null && typeof input === "object" ? (input as { confirm?: unknown }).confirm : undefined;
      return textResult(await actions.setup("", { confirm }));
    },
  } satisfies ToolDefinition;
  const compatibilityTool = {
    name: "short_term_memory",
    description:
      "Inspect or control V2 short-term memory for the invoking session. Actions: show, status, logs, update, reset, settings, setup.",
    input: COMPATIBILITY_INPUT,
    options: { codemode: false },
    execute: async (input: unknown, context: ToolContext) => {
      const value =
        input !== null && typeof input === "object"
          ? (input as { readonly action?: unknown; readonly confirm?: unknown })
          : {};
      const action = String(value.action || "status").toLowerCase();
      if (!["show", "status", "update", "reset", "logs", "settings", "setup"].includes(action)) {
        return textResult(
          `Refused to run short_term_memory: unknown action ${JSON.stringify(action)}. Use show, status, update, reset, logs, settings, or setup.`,
        );
      }
      if (action === "reset") {
        if (value.confirm !== true) {
          return textResult(
            "Refused to reset V2 short-term memory: set confirm to literal true to confirm this destructive action.",
          );
        }
        return textResult(await actions.reset(context.sessionID, { confirm: true }));
      }
      if (action === "show") return textResult(await actions.show(context.sessionID));
      if (action === "status") return textResult(await actions.status(context.sessionID));
      if (action === "update") return textResult(await actions.update(context.sessionID));
      if (action === "logs") return textResult(await actions.logs(context.sessionID));
      if (action === "settings") return textResult(await actions.settings(context.sessionID));
      return textResult(await actions.setup(context.sessionID, { confirm: value.confirm }));
    },
  } satisfies ToolDefinition;
  return [readTool, statusTool, resetTool, updateTool, logsTool, settingsTool, setupTool, compatibilityTool];
}

export function createV2MemoryToolRegistrations(context: V2Context, lifetimeSignal?: AbortSignal) {
  return createV2MemoryTools(context, lifetimeSignal).map((definition) => ({ name: definition.name, definition }));
}
