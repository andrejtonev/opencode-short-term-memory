import type { Info as ToolDefinition, ToolContext } from "@opencode/plugin/promise/tool";
import {
  checkpointPathFor,
  ensureMemoryFile,
  memoryPathFor,
  readConfig,
  readRawFile,
  readText,
  resetBoundaryPathFor,
  safeSessionID,
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

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] as const };
}

async function readMemory(context: ToolContext, directory: string) {
  const config = await readConfig(undefined, directory);
  const memoryPath = await ensureMemoryFile(context.sessionID, config);
  return textResult(await readText(memoryPath, ""));
}

async function readStatus(context: ToolContext, directory: string) {
  const config = await readConfig(undefined, directory);
  const sessionID = context.sessionID;
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
  return textResult(markdown);
}

function authoritativeIdentity(context: ToolContext): { readonly sessionID: string; readonly messageID: string } {
  if (typeof context.sessionID !== "string" || !context.sessionID.trim()) {
    throw new Error("reset sessionID must be a nonempty string");
  }
  if (safeSessionID(context.sessionID) !== context.sessionID) {
    throw new Error("reset sessionID contains unsafe path characters");
  }
  if (typeof context.messageID !== "string" || !context.messageID.trim()) {
    throw new Error("reset messageID must be a nonempty string");
  }
  return { sessionID: context.sessionID, messageID: context.messageID };
}

async function resetMemory(input: unknown, context: ToolContext, directory: string) {
  if (input === null || typeof input !== "object" || (input as { confirm?: unknown }).confirm !== true) {
    return textResult(
      "Refused to reset V2 short-term memory: set confirm to literal true to confirm this destructive action.",
    );
  }
  const { sessionID, messageID } = authoritativeIdentity(context);
  if (isV2MemoryUpdateInFlight(directory, sessionID)) {
    return textResult(
      "Refused to reset V2 short-term memory: an update is active for this session; retry after it finishes.",
    );
  }
  await resetV2MemoryPersistence(sessionID, directory, messageID);
  return textResult(
    [
      "generation: v2",
      "reset: completed",
      "scope: memory, checkpoint, and reset boundary",
      `authoritative sessionID: ${sessionID}`,
      `resetBoundaryAnchor: ${messageID}`,
      "resetPolicy: pause if anchor absent",
      "crashAtomic: false",
      "semanticErasure: false",
    ].join("\n"),
  );
}

async function updateMemory(
  context: ToolContext,
  pluginContext: V2Context,
  directory: string,
  updater: ReturnType<typeof createV2MemoryUpdater>,
) {
  const sessionID = context.sessionID;
  if (typeof sessionID !== "string" || !sessionID.trim() || safeSessionID(sessionID) !== sessionID) {
    return textResult(
      [
        "generation: v2",
        "update: error",
        "reason: invalid_session_id",
        "source: not-read",
        `sessionID: ${JSON.stringify(sessionID) ?? "unavailable"}`,
        "progress: not-started",
        "rollback: not-applicable",
        "detail: authoritative tool sessionID must be nonempty and path-safe",
      ].join("\n"),
    );
  }
  const labels = ["generation: v2", `sessionID: ${sessionID}`];
  if (isV2MemoryUpdateInFlight(directory, sessionID)) {
    return textResult(
      [
        ...labels,
        "update: busy",
        "reason: update_in_flight",
        "source: not-read",
        "progress: not-started",
        "rollback: not-applicable",
        "detail: retry after the active update finishes",
      ].join("\n"),
    );
  }
  const current = await readV2CurrentHistory(pluginContext, sessionID);
  if (current.status !== "ready") {
    return textResult(
      [
        ...labels,
        `update: ${current.status === "error" ? "error" : "unavailable"}`,
        `reason: ${current.status}`,
        "source: unavailable",
        "progress: not-started",
        "rollback: not-applicable",
        `detail: ${JSON.stringify(current.status === "no-model" ? "current session model unavailable" : current.reason)}`,
      ].join("\n"),
    );
  }
  // Do not queue a mutation lock around the updater: it acquires ownership itself.
  const result = await updater(current.history);
  return textResult(
    [
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
    ].join("\n"),
  );
}

export function createV2MemoryTools(
  pluginContext: V2Context,
): readonly [ToolDefinition, ToolDefinition, ToolDefinition, ToolDefinition] {
  const directory = pluginContext.location.directory;
  const updater = createV2MemoryUpdater(pluginContext, directory);
  const readTool = {
    name: "stm_memory_read",
    description: "Read the current session's persisted short-term memory.",
    input: EMPTY_INPUT,
    options: { codemode: false },
    execute: async (_input: Record<string, never>, context: ToolContext) => readMemory(context, directory),
  } satisfies ToolDefinition;
  const statusTool = {
    name: "stm_memory_status",
    description: "Show persisted V2 short-term memory status for the current session.",
    input: EMPTY_INPUT,
    options: { codemode: false },
    execute: async (_input: Record<string, never>, context: ToolContext) => readStatus(context, directory),
  } satisfies ToolDefinition;
  const resetTool = {
    name: "stm_memory_reset",
    description:
      "Reset persisted V2 short-term memory after literal confirmation. If an update is active, retry after it finishes.",
    input: RESET_INPUT,
    options: { codemode: false },
    execute: async (input: unknown, context: ToolContext) => resetMemory(input, context, directory),
  } satisfies ToolDefinition;
  const updateTool = {
    name: "stm_memory_update",
    description:
      "Update current-session short-term memory from fresh settled durable visible text, using the current session model. Preserves assistant and reset-boundary gates; reports skips, failures and cumulative progress. Retry if busy.",
    input: EMPTY_INPUT,
    options: { codemode: false },
    execute: async (_input: Record<string, never>, context: ToolContext) =>
      updateMemory(context, pluginContext, directory, updater),
  } satisfies ToolDefinition;
  return [readTool, statusTool, resetTool, updateTool];
}

export function createV2MemoryToolRegistrations(
  context: V2Context,
): readonly [
  { readonly name: "stm_memory_read"; readonly definition: ToolDefinition },
  { readonly name: "stm_memory_status"; readonly definition: ToolDefinition },
  { readonly name: "stm_memory_reset"; readonly definition: ToolDefinition },
  { readonly name: "stm_memory_update"; readonly definition: ToolDefinition },
] {
  const [readTool, statusTool, resetTool, updateTool] = createV2MemoryTools(context);
  return [
    { name: "stm_memory_read", definition: readTool },
    { name: "stm_memory_status", definition: statusTool },
    { name: "stm_memory_reset", definition: resetTool },
    { name: "stm_memory_update", definition: updateTool },
  ];
}
