import type { CommandInvocation } from "@opencode/plugin/promise/command";
import { safeSessionID } from "./memory-utils";
import type { createV2MemoryActions } from "./v2-memory-tools";

export type V2MemoryCommandActions = ReturnType<typeof createV2MemoryActions>;
const USAGE = "Use: /stm [status|show|logs|settings|update|setup confirm true|reset confirm true].";

// Parsing never invokes an action: even reads must wait for receiver admission.
export function parseV2MemoryCommand(
  input: CommandInvocation,
  actions: V2MemoryCommandActions,
): {
  sessionID: string;
  title: string;
  mutating: boolean;
  run: () => Promise<string>;
} {
  const sessionID = input.sessionID;
  if (typeof sessionID !== "string" || !sessionID.trim() || safeSessionID(sessionID) !== sessionID) {
    throw new Error("STM command sessionID must be nonempty and path-safe.");
  }
  if (!input.prompt || typeof input.prompt.text !== "string") throw new Error(`Invalid STM prompt. ${USAGE}`);
  if (input.prompt.files?.length || input.prompt.agents?.length || input.prompt.skills?.length) {
    throw new Error(`STM commands do not accept attachments. ${USAGE}`);
  }
  const tokens = input.prompt.text.trim().split(/\s+/);
  const action = (tokens[0] || "status").toLowerCase();
  if (action === "setup" || action === "reset") {
    if (tokens.length === 1 || (tokens.length === 3 && tokens[1] === "confirm" && tokens[2] !== "true")) {
      return {
        sessionID,
        title: `STM ${action}`,
        mutating: false,
        run: async () => `Refused: ${action} not run. Use /stm ${action} confirm true with exact literal confirmation.`,
      };
    }
    if (tokens.length !== 3 || tokens[1] !== "confirm" || tokens[2] !== "true") {
      throw new Error(`Unexpected confirmation arguments. ${USAGE}`);
    }
    return {
      sessionID,
      title: `STM ${action}`,
      mutating: true,
      run: () => actions[action](sessionID, { confirm: true }),
    };
  }
  if (
    tokens.length !== 1 ||
    !(action === "status" || action === "show" || action === "logs" || action === "settings" || action === "update")
  ) {
    throw new Error(`Unknown action or unexpected arguments. ${USAGE}`);
  }
  return {
    sessionID,
    title: `STM ${action}`,
    mutating: action === "update" || action === "show",
    run: () => actions[action](sessionID),
  };
}
