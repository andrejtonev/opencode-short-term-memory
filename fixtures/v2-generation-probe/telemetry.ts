import { appendFile } from "node:fs/promises";

export const PROBE_MODES = [
  "ordinary",
  "session-generate",
  "session-generate-history",
  "standalone-generate",
  "compaction",
] as const;

export type ProbeMode = (typeof PROBE_MODES)[number];
export type CallbackOperation = "context" | "generate" | "compaction";
export type MessageBoundary = "before" | "during" | "after";
export type OperationOutcome = "success" | "failure" | "timeout";

export interface NormalizedMessageSnapshot {
  readonly position: number;
  readonly id?: string;
  readonly role: string;
  readonly text: string;
}

interface RecordBase {
  readonly runId: string;
  readonly mode: ProbeMode;
  readonly seq: number;
  readonly timestamp: string;
  readonly event: string;
}

export type ProbeTelemetryRecord =
  | (RecordBase & {
      readonly event: "setup" | "registration" | "provider" | "language-model";
      readonly name?: string;
      readonly provider?: string;
      readonly model?: string;
      readonly details?: Record<string, unknown>;
    })
  | (RecordBase & {
      readonly event: "callback.enter" | "callback.exit";
      readonly operation: CallbackOperation;
      readonly depth: number;
      readonly invocationCount: number;
      readonly outcome?: OperationOutcome;
      readonly error?: string;
    })
  | (RecordBase & {
      readonly event: "model.request";
      readonly provider: string;
      readonly model: string;
      readonly requestKind: "primary" | "compaction" | "title" | "generate";
    })
  | (RecordBase & {
      readonly event: "message.snapshot";
      readonly boundary: MessageBoundary;
      readonly position: number;
      readonly id?: string;
      readonly role: string;
      readonly text: string;
    })
  | (RecordBase & {
      readonly event: "model.invocation";
      readonly provider: string;
      readonly model: string;
      readonly requestKind: "doGenerate" | "doStream";
      readonly invocation: number;
      readonly sentinel: string;
      readonly details?: Record<string, unknown>;
    })
  | (RecordBase & {
      readonly event: "operation.start" | "operation.success" | "operation.failure" | "operation.timeout";
      readonly operation: CallbackOperation;
      readonly operationId: string;
      readonly source?: "plugin" | "host";
      readonly error?: string;
    })
  | (RecordBase & {
      readonly event: "event.observed";
      readonly observedEvent: string;
      readonly details?: Record<string, unknown>;
    })
  | (RecordBase & {
      readonly event: "cleanup" | "disposal";
      readonly details?: Record<string, unknown>;
    });

type WithoutRecordMetadata<T> = T extends RecordBase ? Omit<T, "runId" | "mode" | "seq" | "timestamp"> : never;
type RecordInput = WithoutRecordMetadata<ProbeTelemetryRecord>;

export interface TelemetryWriterOptions {
  readonly runId?: string;
  readonly mode?: ProbeMode;
  readonly path?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface ProbeTelemetryWriter {
  readonly runId: string;
  readonly mode: ProbeMode;
  readonly path: string;
  emit(input: RecordInput): Promise<ProbeTelemetryRecord>;
  flush(): Promise<void>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required telemetry ${name}`);
  }
  return value;
}

function assertMode(value: string): ProbeMode {
  if ((PROBE_MODES as readonly string[]).includes(value)) {
    return value as ProbeMode;
  }
  throw new Error(`Invalid telemetry mode: ${value}`);
}

export function createProbeTelemetryWriter(options: TelemetryWriterOptions = {}): ProbeTelemetryWriter {
  const env = options.env ?? (typeof Bun !== "undefined" ? Bun.env : {});
  const runId = required(options.runId ?? env.PROBE_RUN_ID, "runId");
  const mode = assertMode(required(options.mode ?? env.PROBE_MODE, "mode"));
  const path = required(options.path ?? env.PROBE_TELEMETRY_PATH, "path");
  let sequence = 0;
  let pending: Promise<void> = Promise.resolve();
  let disposed = false;

  const emit = (input: RecordInput): Promise<ProbeTelemetryRecord> => {
    if (disposed) {
      throw new Error("Cannot emit telemetry after disposal");
    }
    const record = {
      ...input,
      runId,
      mode,
      seq: ++sequence,
      timestamp: new Date().toISOString(),
    } as ProbeTelemetryRecord;
    const line = `${JSON.stringify(record)}\n`;
    pending = pending.then(() => appendFile(path, line, "utf8"));
    return pending.then(() => record);
  };

  const drain = (): Promise<void> => pending;
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return drain();
    }
    await emit({ event: "disposal", details: { reason: "writer.dispose" } });
    disposed = true;
    await drain();
  };

  return { runId, mode, path, emit, flush: drain, drain, dispose };
}

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : String(content);
  }
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

export function normalizeV2Messages(messages: readonly unknown[]): NormalizedMessageSnapshot[] {
  return messages.map((raw, position) => {
    if (typeof raw !== "object" || raw === null) {
      throw new TypeError(`Message at position ${position} is not an object`);
    }
    const message = raw as { id?: unknown; role?: unknown; content?: unknown; parts?: unknown };
    const id = typeof message.id === "string" && message.id.length > 0 ? message.id : undefined;
    const content = message.content ?? message.parts;
    return {
      position,
      ...(id === undefined ? {} : { id }),
      role: typeof message.role === "string" ? message.role : "unknown",
      text: messageText(content),
    };
  });
}

export type SnapshotChange = "appended" | "removed" | "replaced" | "unchanged";

export interface SnapshotComparison {
  readonly valid: boolean;
  readonly changes: readonly SnapshotChange[];
  readonly reasons: readonly string[];
}

export function compareOrderedMessageSnapshots(
  before: readonly NormalizedMessageSnapshot[],
  after: readonly NormalizedMessageSnapshot[],
): SnapshotComparison {
  const reasons: string[] = [];

  const collectIdPositions = (messages: readonly NormalizedMessageSnapshot[]): Map<string, number[]> => {
    const positions = new Map<string, number[]>();
    for (const message of messages) {
      if (message.id === undefined) continue;
      const existing = positions.get(message.id);
      if (existing === undefined) {
        positions.set(message.id, [message.position]);
      } else {
        existing.push(message.position);
      }
    }
    return positions;
  };

  const beforeIds = collectIdPositions(before);
  const afterIds = collectIdPositions(after);
  const reportIdProblems = (
    snapshot: "before" | "after",
    messages: readonly NormalizedMessageSnapshot[],
    positions: Map<string, number[]>,
  ): void => {
    for (const message of messages) {
      if (message.id === undefined) {
        reasons.push(`missing message ID in ${snapshot} at position ${message.position}`);
      }
    }
    for (const [id, idPositions] of positions) {
      if (idPositions.length > 1) {
        reasons.push(`duplicate message ID in ${snapshot}: ${id} at positions ${idPositions.join(", ")}`);
      }
    }
  };

  reportIdProblems("before", before, beforeIds);
  reportIdProblems("after", after, afterIds);

  const matchedBefore = new Set<number>();
  const pairs = new Map<number, number>();
  for (const message of after) {
    if (message.id === undefined) continue;
    const beforePositions = beforeIds.get(message.id);
    if (beforePositions?.length !== 1 || afterIds.get(message.id)?.length !== 1) continue;
    const beforePosition = beforePositions[0];
    pairs.set(message.position, beforePosition);
    matchedBefore.add(beforePosition);
  }

  // If stable correlation is unavailable, retain positional comparison so an
  // unchanged role/text pair with a changed or missing ID remains observable.
  for (const message of after) {
    if (pairs.has(message.position)) continue;
    const beforeMessage = before[message.position];
    if (beforeMessage === undefined || matchedBefore.has(beforeMessage.position)) continue;
    pairs.set(message.position, beforeMessage.position);
    matchedBefore.add(beforeMessage.position);
  }

  const changes: SnapshotChange[] = [];
  for (const newMessage of after) {
    const beforePosition = pairs.get(newMessage.position);
    if (beforePosition === undefined) {
      changes.push("appended");
      continue;
    }
    const oldMessage = before[beforePosition];
    const sameContent = oldMessage.role === newMessage.role && oldMessage.text === newMessage.text;
    if (sameContent) {
      changes.push("unchanged");
      if (oldMessage.id !== newMessage.id) {
        reasons.push(`changed or missing ID at position ${newMessage.position}`);
      }
    } else {
      changes.push("replaced");
    }
  }
  for (const message of before) {
    if (!matchedBefore.has(message.position)) changes.push("removed");
  }
  return { valid: reasons.length === 0, changes, reasons };
}
