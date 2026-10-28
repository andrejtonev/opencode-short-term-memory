import { diagnosticErrorMessage } from "./diagnostics";
import { resolve } from "node:path";
import { SIDE_SESSION_TITLE } from "./memory-utils";
import type { Client } from "./types";
import {
  safeID,
  decode,
  V1_ACTIONS,
  V1_REQUEST_PREFIX,
  V1_RESPONSE_PREFIX,
  V1_ACTION_TIMEOUT_MS,
  boundV1Output,
  type V1Request,
  type V1Response,
  type V1Action,
} from "./v1-native-protocol";
export {
  newV1Request,
  decodeV1Response,
  V1_REQUEST_PREFIX,
  V1_RESPONSE_PREFIX,
  type V1Action,
} from "./v1-native-protocol";

/** Native event transport; no prompt or session.command request is made. */
export function createV1ActionReceiver(options: {
  directory: string;
  client: Client;
  isInternal(sessionID: string): boolean;
  execute(request: V1Request): Promise<string>;
}) {
  const seen = new Map<string, number>();
  const active = new Set<string>();
  return async (command: unknown): Promise<boolean> => {
    if (typeof command !== "string" || !command.startsWith(V1_REQUEST_PREFIX)) return false;
    const raw = decode(command, V1_REQUEST_PREFIX, 8_192);
    if (
      !raw ||
      !safeID(raw.requestID) ||
      typeof raw.directory !== "string" ||
      raw.directory !== options.directory ||
      resolve(raw.directory) !== resolve(options.directory) ||
      (raw.sessionID !== undefined && !safeID(raw.sessionID)) ||
      !V1_ACTIONS.includes(raw.action as V1Action) ||
      (raw.confirm !== undefined && typeof raw.confirm !== "boolean") ||
      typeof raw.createdAt !== "number" ||
      Math.abs(Date.now() - raw.createdAt) > 10_000
    )
      return true;
    const request = raw as V1Request;
    for (const [id, time] of seen) if (!active.has(id) && Date.now() - time > V1_ACTION_TIMEOUT_MS) seen.delete(id);
    if (seen.has(request.requestID)) return true;
    // Keep in-flight IDs reserved, and refuse an overloaded receiver without evicting them.
    if (seen.size >= 256 || active.size >= 8) return true;
    seen.set(request.requestID, Date.now());
    active.add(request.requestID);
    let message: string;
    try {
      if (["reset", "setup"].includes(request.action) && request.confirm !== true)
        throw new Error("Explicit confirmation is required. No action ran.");
      if (["show", "update", "reset"].includes(request.action) && !request.sessionID)
        throw new Error("Open a session first. No action ran.");
      if (request.sessionID) {
        const result = await options.client.session.get({
          path: { id: request.sessionID },
          query: { directory: request.directory },
        });
        if (
          result.error ||
          result.data?.id !== request.sessionID ||
          result.data.directory !== request.directory ||
          options.isInternal(request.sessionID) ||
          result.data.title === SIDE_SESSION_TITLE
        )
          throw new Error(
            "The selected session does not match this project or is an internal memory session. No action ran.",
          );
      }
      message = await options.execute(request);
    } catch (error) {
      message = `STM ${request.action} failed: ${diagnosticErrorMessage(error)}`;
    } finally {
      active.delete(request.requestID);
      seen.set(request.requestID, Date.now());
    }
    const response: V1Response = {
      requestID: request.requestID,
      directory: request.directory,
      sessionID: request.sessionID,
      message: boundV1Output(message),
    };
    // Publish is required: executeCommand discards unknown command names in 1.18.35.
    await options.client.tui
      .publish({
        query: { directory: request.directory },
        body: { type: "tui.command.execute", properties: { command: V1_RESPONSE_PREFIX + JSON.stringify(response) } },
      })
      .catch(() => undefined);
    return true;
  };
}
