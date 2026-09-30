import type { Info as ToolDefinition, ToolContext } from "@opencode/plugin/promise/tool";
import { checkpointPathFor, ensureMemoryFile, memoryPathFor, readConfig, readText } from "./memory-utils";
import { readLastProcessedMessageID } from "./message-collector";
import { isV2MemoryUpdateInFlight } from "./v2-memory-update";
import type { V2Context } from "./v2-adapter";

const EMPTY_INPUT = {
  type: "object",
  properties: {},
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
  const text = await readText(memoryPath, "");
  const checkpoint = await readLastProcessedMessageID(sessionID, config);
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
    `memoryBytes: ${Buffer.byteLength(text, "utf8")}`,
    `checkpoint: ${checkpoint || "none"}`,
    `updaterBusy: ${isV2MemoryUpdateInFlight(directory, sessionID)}`,
  ].join("\n");
  return textResult(markdown);
}

export function createV2MemoryTools(context: V2Context): readonly [ToolDefinition, ToolDefinition] {
  const directory = context.location.directory;
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
  return [readTool, statusTool];
}

export function createV2MemoryToolRegistrations(
  context: V2Context,
): readonly [
  { readonly name: "stm_memory_read"; readonly definition: ToolDefinition },
  { readonly name: "stm_memory_status"; readonly definition: ToolDefinition },
] {
  const [readTool, statusTool] = createV2MemoryTools(context);
  return [
    { name: "stm_memory_read", definition: readTool },
    { name: "stm_memory_status", definition: statusTool },
  ];
}
