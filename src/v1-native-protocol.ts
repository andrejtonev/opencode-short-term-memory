import { randomUUID } from "node:crypto";

export const V1_ACTIONS = ["show", "logs", "settings", "status", "update", "reset", "setup"] as const;
export type V1Action = (typeof V1_ACTIONS)[number];
export const V1_REQUEST_PREFIX = "stm.native.request:";
export const V1_RESPONSE_PREFIX = "stm.native.response:";
export const V1_ACTION_TIMEOUT_MS = 120_000;
export const V1_OUTPUT_MAX_CHARS = 16_384;
export type V1Request = {
  requestID: string;
  directory: string;
  sessionID?: string;
  action: V1Action;
  confirm?: boolean;
  createdAt: number;
};
export type V1Response = Pick<V1Request, "requestID" | "directory" | "sessionID"> & { message: string };
export const safeID = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function newV1Request(
  location: { directory: string; sessionID?: string },
  action: V1Action,
  confirm?: boolean,
): V1Request {
  return { ...location, action, confirm, requestID: randomUUID(), createdAt: Date.now() };
}
export function decodeV1Response(command: unknown): V1Response | undefined {
  const value = decode(command, V1_RESPONSE_PREFIX, 110_000);
  if (
    !value ||
    !safeID(value.requestID) ||
    typeof value.directory !== "string" ||
    (value.sessionID !== undefined && !safeID(value.sessionID)) ||
    typeof value.message !== "string" ||
    value.message.length > V1_OUTPUT_MAX_CHARS
  )
    return;
  return value as V1Response;
}
export function decode(command: unknown, prefix: string, maxLength: number): Record<string, unknown> | undefined {
  if (typeof command !== "string" || !command.startsWith(prefix) || command.length > maxLength) return;
  try {
    const value = JSON.parse(command.slice(prefix.length));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
}
export function boundV1Output(message: string): string {
  if (message.length <= V1_OUTPUT_MAX_CHARS) return message;
  const notice = "[Display truncated; inspect the file for the full contents.]\n";
  const budget = V1_OUTPUT_MAX_CHARS - notice.length;
  return message.slice(0, budget) + "\n" + notice.trimEnd();
}
