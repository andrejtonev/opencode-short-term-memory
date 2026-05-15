import type { SessionMemoryConfig, RuntimeState } from "./memory-utils";
import type { Client } from "./types";
import {
  logEvent,
  tailLog,
  ensureMemoryFile,
  readText,
  memoryPathFor,
  logPath,
  removePath,
  checkpointPathFor,
} from "./memory-utils";
import { type SessionRuntimeState } from "./session-state";

export function parseMemoryActionFromCommandArgument(argument: unknown): string {
  const raw = String(argument || "")
    .trim()
    .toLowerCase();
  if (!raw) return "status";
  return raw.split(/\s+/)[0] || "status";
}

export interface CommandContext {
  config: SessionMemoryConfig;
  sessionStates: Map<string, SessionRuntimeState>;
  globalState: RuntimeState;
}

export async function statusText(sessionID: string | undefined, ctx: CommandContext): Promise<string> {
  const { config, globalState } = ctx;
  const sid = sessionID || globalState.lastActiveSessionID;
  const memory = sid ? await readText(memoryPathFor(sid, config.memoryDir), "") : "";
  return [
    "# Session Memory Plugin Status",
    `- enabled: ${config.enabled}`,
    `- activeSessionID: ${sid || "unknown"}`,
    `- memoryModel: ${config.memoryModel}`,
    `- summarizerMode: ${config.summarizerMode}`,
    `- cleanFallbackToActiveSession: ${config.cleanFallbackToActiveSession}`,
    `- includeAgentsMdOnFirstUpdate: ${config.includeAgentsMdOnFirstUpdate}`,
    `- injectInSubagents: ${config.injectInSubagents}`,
    `- sideSessionRetries: ${config.sideSessionRetries}`,
    `- remindEveryN: ${config.remindEveryN}`,
    `- maxDeltaMessages: ${config.maxDeltaMessages}`,
    `- memoryDir: ${config.memoryDir}`,
    `- debug: ${config.debug}`,
    `- memoryBytes: ${memory.length}`,
    `- updateCount: ${globalState.updateCount}`,
    `- injectCount: ${globalState.injectCount}`,
    `- injectCharCount: ${globalState.injectCharCount}`,
    `- compactCount: ${globalState.compactCount}`,
    `- lastUpdateAt: ${globalState.lastUpdateAt || "never"}`,
    `- lastInjectAt: ${globalState.lastInjectAt || "never"}`,
    `- startupWarning: ${globalState.startupWarning || "none"}`,
    `- lastError: ${globalState.lastError || "none"}`,
    `- memoryPath: ${sid ? memoryPathFor(sid, config.memoryDir) : "unknown"}`,
    `- logPath: ${logPath(config.memoryDir)}`,
  ].join("\n");
}

export async function executeMemoryAction(
  actionInput: string,
  sessionID: string | undefined,
  ctx: CommandContext,
  client: Client,
  updateMemoryFn: (client: Client, sessionID: string, reason: string, cfg: SessionMemoryConfig) => Promise<void>,
): Promise<string> {
  const { config, sessionStates } = ctx;
  const action = String(actionInput || "status").toLowerCase();
  await logEvent(config, "tool_memory", { action, sessionID });

  if (action === "settings") return JSON.stringify(config, null, 2);
  if (action === "logs") return (await tailLog(120, config.memoryDir)) || "No logs yet.";
  if (action === "status") return await statusText(sessionID, ctx);
  if (!sessionID) return "No active session ID found yet. Send one chat message, then run this again.";
  if (action === "show") {
    await ensureMemoryFile(sessionID, config);
    return await readText(memoryPathFor(sessionID, config.memoryDir), "No memory file found.");
  }
  if (action === "reset") {
    await removePath(memoryPathFor(sessionID, config.memoryDir));
    await removePath(checkpointPathFor(sessionID, config.memoryDir));
    await ensureMemoryFile(sessionID, config);
    const s = sessionStates.get(sessionID);
    if (s) {
      s.userTurnInjectState = { count: 0, lastMessageID: "" };
      s.lastInjectedSignature = undefined;
    }
    await logEvent(config, "memory_reset", { sessionID });
    return `Reset memory for session ${sessionID}.`;
  }
  if (action === "update") {
    await updateMemoryFn(client, sessionID, "manual_tool", config);
    return await readText(
      memoryPathFor(sessionID, config.memoryDir),
      "Memory update attempted, but no memory file was found.",
    );
  }
  return "Unknown action. Use: show, status, logs, update, reset, settings.";
}
