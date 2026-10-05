import type { Info as ToolDefinition, ToolContext } from "@opencode/plugin/promise/tool";
import {
  checkpointPathFor,
  createProjectExampleConfig,
  ensureMemoryFile,
  memoryPathFor,
  readConfig,
  readRawFile,
  readText,
  resetBoundaryPathFor,
  safeSessionID,
  tailLog,
} from "./memory-utils";
import { readLastProcessedMessageID } from "./message-collector";
import { createV2MemoryUpdater, isV2MemoryUpdateInFlight } from "./v2-memory-update";
import type { V2Context } from "./v2-adapter";
import { readV2CurrentHistory } from "./v2-current-history";
import { parseV2ResetBoundary } from "./v2-reset-boundary";
import { resetV2MemoryPersistence } from "./v2-reset-persistence";

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

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] as const };
}

async function readMemory(sessionID: string, directory: string) {
  const config = await readConfig(undefined, directory);
  const memoryPath = await ensureMemoryFile(sessionID, config);
  return await readText(memoryPath, "");
}

export async function readV2MemoryStatus(sessionID: string, directory: string): Promise<string> {
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
  let boundaryAnchor: string | undefined;
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
  const markdown = [
    "generation: v2",
    `enabled: ${config.enabled}`,
    `authoritative sessionID: ${sessionID}`,
    `configuredMemoryModel: ${config.memoryModel || "none"}`,
    "effectiveMemoryModel: current-session",
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
) {
  if (confirm !== true) {
    return "Refused to reset V2 short-term memory: set confirm to literal true to confirm this destructive action.";
  }
  authoritativeIdentity(sessionID, messageID);
  if (isV2MemoryUpdateInFlight(directory, sessionID)) {
    return "Refused to reset V2 short-term memory: an update is active for this session; retry after it finishes.";
  }
  // Only snapshot eligibility failures are refusals; persistence failures still propagate.
  let refusal: string | undefined;
  let anchor: string;
  try {
    anchor = await resetV2MemoryPersistence(
      sessionID,
      directory,
      messageID ??
        (async () => {
          const current = await readV2CurrentHistory(pluginContext, sessionID);
          if (current.status !== "ready") {
            refusal = `Refused to reset V2 short-term memory: ${current.status}: ${JSON.stringify(current.status === "no-model" ? "current session model unavailable" : current.reason)}.`;
          } else if (current.history.stoppedBeforeMessageID !== undefined) {
            refusal = `Refused to reset V2 short-term memory: unfinished history stoppedBeforeMessageID: ${JSON.stringify(current.history.stoppedBeforeMessageID)}.`;
          } else {
            const messages = current.history.messages;
            const lastID = messages.at(-1)?.id;
            if (
              typeof lastID === "string" &&
              lastID.trim() &&
              messages.filter(({ id }) => id === lastID).length === 1
            ) {
              return lastID;
            }
            refusal =
              "Refused to reset V2 short-term memory: settled durable history has no nonempty unique last record anchor.";
          }
          throw new Error(refusal);
        }),
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
  return [
    ...labels,
    `update: ${result.status}`,
    `reason: ${result.status === "committed" ? "delta_exhausted" : result.reason}`,
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

export function createV2MemoryActions(pluginContext: V2Context) {
  const directory = pluginContext.location.directory;
  const updater = createV2MemoryUpdater(pluginContext, directory);
  return {
    show: (sessionID: string) => readMemory(sessionID, directory),
    status: (sessionID: string) => readV2MemoryStatus(sessionID, directory),
    update: (sessionID: string) => updateMemory(sessionID, pluginContext, directory, updater),
    reset: (sessionID: string, input: { readonly confirm?: unknown; readonly messageID?: string }) =>
      resetMemory(sessionID, input.confirm, pluginContext, directory, input.messageID),
    logs: async (_sessionID: string) => {
      const config = await readConfig(undefined, directory);
      return (await tailLog(120, config.memoryDir)) || "No logs yet.";
    },
    settings: async (_sessionID: string) => {
      const config = await readConfig(undefined, directory);
      return JSON.stringify(
        {
          generation: "v2",
          resolvedConfig: config,
          effective: {
            enabled: config.enabled,
            memoryModel: "current-session",
            summarizerMode: config.summarizerMode,
            maxMemoryLength: config.maxMemoryLength,
            maxUpdateInputLength: config.maxUpdateInputLength,
            maxDeltaMessages: config.maxDeltaMessages,
            memoryDir: config.memoryDir,
            updateHook: "context",
            injectionHooks: ["context", "compaction"],
          },
          inactiveSettings: [
            "memoryModel",
            "cleanFallbackToActiveSession",
            "includeAgentsMdOnFirstUpdate",
            "injectInSubagents",
            "enableLegacyPeriodicSystemTransform",
            "sideSessionRetries",
            "remindEveryN",
            "debounceMs",
            "debug",
            "logMaxLines",
            "collapseAssistantBursts",
          ],
        },
        null,
        2,
      );
    },
    setup: async (_sessionID: string, input: { readonly confirm?: unknown }) => {
      if (input.confirm !== true) {
        return "Refused to create a project example config: set confirm to literal true to confirm setup.";
      }
      const result = await createProjectExampleConfig(directory);
      return [
        result.message,
        `configPath: ${result.configPath}`,
        "Shared example: see stm_memory_settings for effective V2 settings; configured memoryModel overrides are not applied in V2.",
      ].join("\n");
    },
  };
}

export function createV2MemoryTools(
  pluginContext: V2Context,
): readonly [
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
  ToolDefinition,
] {
  const actions = createV2MemoryActions(pluginContext);
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
    description:
      "Reset persisted V2 short-term memory after literal confirmation. If an update is active, retry after it finishes.",
    input: RESET_INPUT,
    options: { codemode: false },
    execute: async (input: unknown, context: ToolContext) => {
      const confirm =
        input !== null && typeof input === "object" ? (input as { confirm?: unknown }).confirm : undefined;
      if (confirm === true && (typeof context.messageID !== "string" || !context.messageID.trim())) {
        authoritativeIdentity(context.sessionID);
        throw new Error("reset messageID must be a nonempty string");
      }
      return textResult(
        await actions.reset(confirm === true ? context.sessionID : "", {
          confirm,
          messageID: confirm === true ? context.messageID : undefined,
        }),
      );
    },
  } satisfies ToolDefinition;
  const updateTool = {
    name: "stm_memory_update",
    description:
      "Update current-session short-term memory from fresh settled durable visible text, using the current session model. Preserves assistant and reset-boundary gates; reports skips, failures and cumulative progress. Retry if busy.",
    input: EMPTY_INPUT,
    options: { codemode: false },
    execute: async (_input: Record<string, never>, context: ToolContext) =>
      textResult(await actions.update(context.sessionID)),
  } satisfies ToolDefinition;
  const logsTool = {
    name: "stm_memory_logs",
    description:
      "Read the latest 120 log lines shared by all sessions using the configured memory directory, not filtered to this session. Logs may contain sensitive context; review before sharing.",
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
      "Create a project-local .opencode/stm.jsonc shared example without overwriting existing STM config. Requires confirm set to true. See stm_memory_settings for effective V2 settings; memoryModel overrides are not applied in V2.",
    input: SETUP_INPUT,
    options: { codemode: false },
    execute: async (input: unknown) => {
      const confirm =
        input !== null && typeof input === "object" ? (input as { confirm?: unknown }).confirm : undefined;
      return textResult(await actions.setup("", { confirm }));
    },
  } satisfies ToolDefinition;
  return [readTool, statusTool, resetTool, updateTool, logsTool, settingsTool, setupTool];
}

export function createV2MemoryToolRegistrations(context: V2Context) {
  return createV2MemoryTools(context).map((definition) => ({ name: definition.name, definition }));
}
