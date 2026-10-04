import type { Model } from "@opencode/schema/model";
import type { V2Context } from "./v2-adapter";
import { safeSessionID } from "./memory-utils";

export type V2CurrentModel = Model.Ref;

export type V2ProjectedMessage =
  | {
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly content: readonly [{ readonly type: "text"; readonly text: string }];
    }
  | { readonly id: string; readonly role: "tool"; readonly content: readonly [] };

export type V2CurrentHistory = {
  readonly source: "durable-visible-text";
  readonly sessionID: string;
  readonly model: V2CurrentModel;
  readonly messages: readonly V2ProjectedMessage[];
  readonly stoppedBeforeMessageID?: string;
};

export type V2CurrentHistoryResult =
  | { readonly status: "ready"; readonly history: V2CurrentHistory }
  | { readonly status: "no-model"; readonly sessionID: string }
  | { readonly status: "invalid-history"; readonly sessionID: string; readonly reason: string }
  | { readonly status: "error"; readonly sessionID: string; readonly reason: string };

type RawRecord = Record<string, unknown>;
export type V2CurrentHistoryContext = Pick<V2Context, "session">;

function recordOf(value: unknown): RawRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RawRecord) : undefined;
}

function isCurrentModel(value: unknown): value is V2CurrentModel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  return (
    typeof model.id === "string" &&
    model.id.length > 0 &&
    typeof model.providerID === "string" &&
    model.providerID.length > 0 &&
    (model.variant === undefined || typeof model.variant === "string")
  );
}

function invalid(sessionID: string, reason: string): V2CurrentHistoryResult {
  return { status: "invalid-history", sessionID, reason };
}

function validTime(value: unknown): value is { created: number; completed?: number } {
  const time = recordOf(value);
  return (
    time !== undefined &&
    typeof time.created === "number" &&
    Number.isFinite(time.created) &&
    (time.completed === undefined || (typeof time.completed === "number" && Number.isFinite(time.completed)))
  );
}

function textPart(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text: string[] = [];
  for (const value of content) {
    const part = recordOf(value);
    if (part === undefined) return undefined;
    if (part.type === "text" || part.type === "reasoning") {
      if (typeof part.text !== "string") return undefined;
      if (part.type === "text") text.push(part.text);
      else if (part.time !== undefined && !validTime(part.time)) return undefined;
    } else if (part.type === "tool") {
      const state = recordOf(part.state);
      if (typeof part.id !== "string" || typeof part.name !== "string" || !validTime(part.time) || state === undefined)
        return undefined;
      if (state.status === "streaming") {
        if (typeof state.input !== "string") return undefined;
      } else if (state.status === "running" || state.status === "completed" || state.status === "error") {
        if (recordOf(state.input) === undefined) return undefined;
        if (state.status === "running" && recordOf(state.metadata) === undefined) return undefined;
        if (state.status === "error") {
          const error = recordOf(state.error);
          if (error === undefined || typeof error.type !== "string" || typeof error.message !== "string")
            return undefined;
        }
        if (state.status === "completed" || state.content !== undefined) {
          if (!Array.isArray(state.content) || state.content.length === 0) return undefined;
          for (const value of state.content) {
            const result = recordOf(value);
            if (result === undefined) return undefined;
            if (result.type === "text") {
              if (typeof result.text !== "string") return undefined;
            } else if (result.type === "file") {
              if (typeof result.uri !== "string" || typeof result.mime !== "string") return undefined;
            } else return undefined;
          }
        }
      } else return undefined;
    } else return undefined;
  }
  return text.join("");
}

function project(sessionID: string, model: V2CurrentModel, values: unknown): V2CurrentHistoryResult {
  if (!Array.isArray(values)) return invalid(sessionID, "invalid_history_records");
  const messages: V2ProjectedMessage[] = [];
  const ids = new Set<string>();
  let stoppedBeforeMessageID: string | undefined;

  for (const value of values) {
    const record = recordOf(value);
    if (record === undefined) return invalid(sessionID, "invalid_message_record");
    if (typeof record.id !== "string" || !record.id.startsWith("msg_")) return invalid(sessionID, "invalid_message_id");
    if (!validTime(record.time)) return invalid(sessionID, "invalid_message_time");
    if (ids.has(record.id)) return invalid(sessionID, "duplicate_message_id");
    ids.add(record.id);

    if (record.type === "assistant") {
      if (typeof record.agent !== "string" || !isCurrentModel(record.model))
        return invalid(sessionID, "invalid_assistant_record");
      if (record.time.completed === undefined) {
        stoppedBeforeMessageID = record.id;
        break;
      }
      const text = textPart(record.content);
      if (text === undefined) return invalid(sessionID, "invalid_assistant_content");
      if (text) messages.push({ id: record.id, role: "assistant", content: [{ type: "text", text }] });
      else messages.push({ id: record.id, role: "tool", content: [] });
      continue;
    }

    if (record.type === "user") {
      if (typeof record.text !== "string") return invalid(sessionID, "invalid_user_text");
      messages.push({ id: record.id, role: "user", content: [{ type: "text", text: record.text }] });
      continue;
    }

    // Excluded durable record types still carry exact boundary anchors.
    switch (record.type) {
      case "synthetic":
      case "system":
        if (typeof record.text !== "string") return invalid(sessionID, "invalid_excluded_record");
        break;
      case "skill":
        if (typeof record.text !== "string" || typeof record.skill !== "string" || typeof record.name !== "string")
          return invalid(sessionID, "invalid_excluded_record");
        break;
      case "agent-switched":
        if (typeof record.agent !== "string") return invalid(sessionID, "invalid_excluded_record");
        break;
      case "model-switched":
        if (!isCurrentModel(record.model)) return invalid(sessionID, "invalid_excluded_record");
        break;
      case "location-switched":
        if (typeof recordOf(record.location)?.directory !== "string")
          return invalid(sessionID, "invalid_excluded_record");
        break;
      case "shell":
        if (
          typeof record.shellID !== "string" ||
          typeof record.command !== "string" ||
          (record.status !== "running" &&
            record.status !== "exited" &&
            record.status !== "timeout" &&
            record.status !== "killed")
        )
          return invalid(sessionID, "invalid_excluded_record");
        break;
      case "compaction":
        if (record.reason !== "auto" && record.reason !== "manual")
          return invalid(sessionID, "invalid_excluded_record");
        if (record.status === "running" || record.status === "completed") {
          if (typeof record.summary !== "string" || typeof record.recent !== "string")
            return invalid(sessionID, "invalid_excluded_record");
        } else if (record.status === "failed") {
          const error = recordOf(record.error);
          if (error === undefined || typeof error.type !== "string" || typeof error.message !== "string")
            return invalid(sessionID, "invalid_excluded_record");
        } else return invalid(sessionID, "invalid_excluded_record");
        break;
      case "idle":
        if (record.outcome !== "succeeded" && record.outcome !== "failed" && record.outcome !== "interrupted")
          return invalid(sessionID, "invalid_excluded_record");
        break;
      default:
        return invalid(sessionID, "invalid_message_type");
    }
    messages.push({ id: record.id, role: "tool", content: [] });
  }

  return {
    status: "ready",
    history: {
      source: "durable-visible-text",
      sessionID,
      model,
      messages,
      ...(stoppedBeforeMessageID === undefined ? {} : { stoppedBeforeMessageID }),
    },
  };
}

function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (callback: () => void) => {
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(signal.reason ?? new Error("request_timeout")));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
  });
}

export async function readV2CurrentHistory(
  context: V2CurrentHistoryContext,
  sessionID: string,
  timeoutMs = 5_000,
): Promise<V2CurrentHistoryResult> {
  if (!sessionID.trim() || safeSessionID(sessionID) !== sessionID) return invalid(sessionID, "invalid_session_id");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    return { status: "error", sessionID, reason: "invalid_timeout" };
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const [records, session] = await Promise.all([
      bounded(() => context.session.context({ sessionID }, { signal }), signal),
      bounded(() => context.session.get({ sessionID }, { signal }), signal),
    ]);
    const current = recordOf(session);
    if (current === undefined) return invalid(sessionID, "invalid_session_record");
    if (current.id !== sessionID) return invalid(sessionID, "session_id_mismatch");
    if (!isCurrentModel(current.model)) return { status: "no-model", sessionID };
    // These independent reads are durable history, not an atomic model-facing snapshot.
    return project(sessionID, current.model, records);
  } catch (error) {
    return { status: "error", sessionID, reason: error instanceof Error ? error.message : String(error) };
  }
}
