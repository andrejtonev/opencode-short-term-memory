import { tool } from "@opencode-ai/plugin";
import type { SessionMemoryConfig } from "./memory-utils";
import { getSessionID } from "./memory-utils";
import type { CommandContext } from "./commands";
import { executeMemoryAction } from "./commands";
import type { Client, ToolContext } from "./types";

export interface CreateToolsContext {
  cmdCtx: CommandContext;
  globalState: { lastActiveSessionID?: string };
  client: Client;
  reloadConfigLocal: () => Promise<SessionMemoryConfig>;
  updateMemory: (client: Client, sessionID: string, reason: string, cfg: SessionMemoryConfig) => Promise<void>;
}

export function createTools(ctx: CreateToolsContext): Record<string, unknown> {
  const { cmdCtx, globalState, client, reloadConfigLocal, updateMemory } = ctx;
  const executeAction = async (
    action: string,
    toolCtx: ToolContext,
    options: { confirm?: boolean } = {},
  ): Promise<string> => {
    await reloadConfigLocal();
    const sessionID = getSessionID({}, toolCtx) || globalState.lastActiveSessionID;
    return await executeMemoryAction(action, sessionID, cmdCtx, client, updateMemory, options);
  };

  return {
    stm_memory_read: tool({
      description:
        "Read the current session's short-term memory. Use this first when prior decisions, constraints, or task context may affect your work.",
      args: {},
      async execute(_args: Record<string, never>, toolCtx: ToolContext) {
        return await executeAction("show", toolCtx);
      },
    }),
    stm_memory_status: tool({
      description: "Show the current session's short-term memory status and resolved runtime configuration.",
      args: {},
      async execute(_args: Record<string, never>, toolCtx: ToolContext) {
        return await executeAction("status", toolCtx);
      },
    }),
    stm_memory_update: tool({
      description: "Update short-term memory for the current session, then return the resulting memory.",
      args: {},
      async execute(_args: Record<string, never>, toolCtx: ToolContext) {
        return await executeAction("update", toolCtx);
      },
    }),
    stm_memory_logs: tool({
      description:
        "Read recent short-term memory plugin logs. Logs can contain sensitive operational context; do not disclose their contents unless necessary.",
      args: {},
      async execute(_args: Record<string, never>, toolCtx: ToolContext) {
        return await executeAction("logs", toolCtx);
      },
    }),
    stm_memory_settings: tool({
      description: "Show the resolved short-term memory plugin settings for diagnostics.",
      args: {},
      async execute(_args: Record<string, never>, toolCtx: ToolContext) {
        return await executeAction("settings", toolCtx);
      },
    }),
    stm_memory_reset: tool({
      description:
        "Permanently reset the current session's short-term memory and checkpoint. Call only when intentional, with confirm set to true.",
      args: {
        confirm: tool.schema.literal(true),
      },
      async execute(args: { confirm?: boolean }, toolCtx: ToolContext) {
        if (args.confirm !== true) {
          return "Refused to reset short-term memory: set confirm to literal true to confirm this destructive action.";
        }
        return await executeAction("reset", toolCtx);
      },
    }),
    stm_memory_setup: tool({
      description:
        "Create a project-local .opencode/stm.jsonc example without overwriting existing STM config. Requires confirm set to true.",
      args: {
        confirm: tool.schema.boolean().optional(),
      },
      async execute(args: { confirm?: boolean }, toolCtx: ToolContext) {
        return await executeAction("setup", toolCtx, { confirm: args.confirm });
      },
    }),
    short_term_memory: tool({
      description:
        "Inspect or control the short-term session memory plugin. Same interface as the /stm command. Actions: show, status, logs, update, reset, settings, setup.",
      args: {
        action: tool.schema.string(),
        confirm: tool.schema.boolean().optional(),
      },
      async execute(args: { action: string; confirm?: boolean }, ctx: ToolContext) {
        return await executeAction(args.action, ctx, { confirm: args.confirm });
      },
    }),
  };
}
