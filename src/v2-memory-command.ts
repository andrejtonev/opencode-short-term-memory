import { safeSessionID } from "./memory-utils";
import type { createV2MemoryActions } from "./v2-memory-tools";

export type V2MemoryCommandActions = ReturnType<typeof createV2MemoryActions>;
export const V2_MEMORY_ACTIONS = ["show", "status", "logs", "update", "reset", "settings", "setup"] as const;
export type V2MemoryAction = (typeof V2_MEMORY_ACTIONS)[number];

export type V2MemoryActionInput = {
  readonly requestID: string;
  readonly sessionID: string;
  readonly action: V2MemoryAction;
  readonly confirm?: boolean;
};

export type V2MemoryActionRequest = {
  readonly requestID: string;
  readonly sessionID: string;
  readonly title: string;
  readonly mutating: boolean;
  readonly run: () => Promise<string>;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function isAction(value: unknown): value is V2MemoryAction {
  return typeof value === "string" && (V2_MEMORY_ACTIONS as readonly string[]).includes(value);
}

/** Validate a TUI menu request before it can reserve a receiver or run a server action. */
export function parseV2MemoryAction(input: unknown, actions: V2MemoryCommandActions): V2MemoryActionRequest {
  const value = record(input);
  if (!value) throw new Error("Invalid STM action request. No action was run.");

  const { requestID, sessionID, action, confirm } = value;
  if (typeof requestID !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestID)) {
    throw new Error("STM action requestID must be nonempty and path-safe.");
  }
  if (typeof sessionID !== "string" || !sessionID.trim() || safeSessionID(sessionID) !== sessionID) {
    throw new Error("STM action sessionID must be nonempty and path-safe.");
  }
  if (!isAction(action)) throw new Error("Unknown STM action. No action was run.");
  if (confirm !== undefined && typeof confirm !== "boolean") {
    throw new Error("STM action confirmation must be a boolean.");
  }
  if ((action === "reset" || action === "setup") && confirm !== true) {
    throw new Error(`Explicit confirmation is required for STM ${action}. No action was run.`);
  }

  const run = async () => {
    switch (action) {
      case "show":
        return await actions.show(sessionID);
      case "status":
        return await actions.status(sessionID);
      case "logs":
        return await actions.logs(sessionID);
      case "update":
        return await actions.update(sessionID);
      case "reset":
        return await actions.reset(sessionID, { confirm: true });
      case "settings":
        return await actions.settings(sessionID);
      case "setup":
        return await actions.setup(sessionID, { confirm: true });
    }
  };

  return {
    requestID,
    sessionID,
    title: `STM ${action}`,
    mutating: action === "update" || action === "reset" || action === "setup",
    run,
  };
}
