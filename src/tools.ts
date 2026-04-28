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

  return {
    short_term_memory: tool({
      description:
        "Inspect or control the short-term session memory plugin. Same interface as the /stm command. Actions: show, status, logs, update, reset, settings.",
      args: {
        action: tool.schema.string(),
      },
      async execute(args: { action: string }, ctx: ToolContext) {
        await reloadConfigLocal();
        const sessionID = getSessionID({}, ctx) || globalState.lastActiveSessionID;
        return await executeMemoryAction(args.action, sessionID, cmdCtx, client, updateMemory);
      },
    }),
  };
}
