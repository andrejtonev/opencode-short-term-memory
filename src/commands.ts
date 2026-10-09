import type { SessionMemoryConfig, RuntimeState } from "./memory-utils";
import type { Client } from "./types";
import {
  createProjectExampleConfig,
  logEvent,
  tailLog,
  ensureMemoryFile,
  readText,
  memoryPathFor,
  logPath,
  parseModel,
  removePath,
  checkpointPathFor,
} from "./memory-utils";
import { resetSessionDeliveryState, type SessionRuntimeState } from "./session-state";

export function parseMemoryActionFromCommandArgument(argument: unknown): string {
  const raw = String(argument || "")
    .trim()
    .toLowerCase();
  if (!raw) return "status";
  return raw.split(/\s+/)[0] || "status";
}

export interface CommandContext {
  config: SessionMemoryConfig;
  baseDir?: string;
  sessionStates: Map<string, SessionRuntimeState>;
  globalState: RuntimeState;
  clearSessionDeliveryMetadata?: (sessionID: string) => void;
  resetSessionPersistence?: (sessionID: string, config: SessionMemoryConfig) => Promise<void>;
}

function memoryModelSelection(config: SessionMemoryConfig) {
  const parsedModel = parseModel(config.memoryModel);
  if (parsedModel) {
    return { memoryModelSelection: "explicit-override", memoryModel: config.memoryModel };
  }

  if (!config.memoryModel.trim()) {
    return {
      memoryModelSelection: "host-default",
      memoryModel: "host-default (no override configured)",
    };
  }

  return {
    memoryModelSelection: "invalid-override",
    memoryModel: "unavailable (invalid override ignored; no configured selection)",
  };
}

export async function statusText(sessionID: string | undefined, ctx: CommandContext): Promise<string> {
  const { config, sessionStates, globalState } = ctx;
  const sid = sessionID || globalState.lastActiveSessionID;
  const sessionState = sid ? sessionStates.get(sid) : undefined;
  const memory = sid ? await readText(memoryPathFor(sid, config.memoryDir), "") : "";
  const modelSelection = memoryModelSelection(config);
  return [
    "# Session Memory Plugin Status",
    `- enabled: ${config.enabled}`,
    `- activeSessionID: ${sid || "unknown"}`,
    `- memoryModelSelection: ${modelSelection.memoryModelSelection}`,
    `- memoryModel: ${modelSelection.memoryModel}`,
    `- summarizerMode: ${config.summarizerMode}`,
    `- cleanFallbackToActiveSession: ${config.cleanFallbackToActiveSession}`,
    `- includeAgentsMdOnFirstUpdate: ${config.includeAgentsMdOnFirstUpdate}`,
    `- injectInSubagents: ${config.injectInSubagents}`,
    `- effectiveDeliveryMode: ${config.enableLegacyPeriodicSystemTransform ? "legacySystemTransform" : "promptNoReply"}`,
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
    `- memoryRevision: ${sessionState?.memoryRevision ?? 0}`,
    `- deliveryClaimPending: ${sessionState?.deliveryClaim != null}`,
    `- childStartupInjectionPending: ${sessionState?.childStartupInjectionPending ?? false}`,
    `- childDcpInjectionPending: ${sessionState?.childDcpInjectionPending ?? false}`,
    `- mainDcpDeliveryPending: ${sessionState?.mainDcpDeliveryPending ?? false}`,
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
  options: { confirm?: boolean } = {},
): Promise<string> {
  const { config, sessionStates } = ctx;
  const action = String(actionInput || "status").toLowerCase();
  await logEvent(config, "tool_memory", { action, sessionID });

  if (action === "settings") {
    const modelSelection = memoryModelSelection(config);
    return JSON.stringify(
      {
        ...config,
        memoryModelSelection: modelSelection.memoryModelSelection,
        effectiveDeliveryMode: config.enableLegacyPeriodicSystemTransform ? "legacySystemTransform" : "promptNoReply",
      },
      null,
      2,
    );
  }
  if (action === "logs") return (await tailLog(120, config.memoryDir)) || "No logs yet.";
  if (action === "status") return await statusText(sessionID, ctx);
  if (action === "setup") {
    if (options.confirm !== true) {
      return [
        "Setup not run: explicit confirmation is required.",
        "Run `/stm setup confirm true` or call `stm_memory_setup` with `confirm: true`.",
        "This creates only the project-local .opencode/stm.jsonc example and never overwrites stm.jsonc or stm.json.",
      ].join("\n");
    }
    const result = await createProjectExampleConfig(ctx.baseDir);
    return result.message;
  }
  if (!sessionID) return "No active session ID found yet. Send one chat message, then run this again.";
  if (action === "show") {
    await ensureMemoryFile(sessionID, config);
    return await readText(memoryPathFor(sessionID, config.memoryDir), "No memory file found.");
  }
  if (action === "reset") {
    if (ctx.resetSessionPersistence) {
      await ctx.resetSessionPersistence(sessionID, config);
    } else {
      await removePath(memoryPathFor(sessionID, config.memoryDir));
      await removePath(checkpointPathFor(sessionID, config.memoryDir));
      await ensureMemoryFile(sessionID, config);
    }
    const s = sessionStates.get(sessionID);
    if (s) resetSessionDeliveryState(s);
    ctx.clearSessionDeliveryMetadata?.(sessionID);
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
  return "Unknown action. Use: show, status, logs, update, reset, settings, setup.";
}
