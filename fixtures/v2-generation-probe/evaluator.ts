import { PROBE_COMPACTION_SUMMARY, PROBE_MODEL_ID, PROBE_PROVIDER_ID, PROBE_STREAM_SENTINEL } from "./index.js";
import {
  PROBE_MODES,
  compareOrderedMessageSnapshots,
  type CallbackOperation,
  type NormalizedMessageSnapshot,
  type ProbeMode,
  type ProbeTelemetryRecord,
  type SnapshotChange,
  type SnapshotComparison,
} from "./telemetry.js";

const CALLBACK_OPERATIONS = ["context", "generate", "compaction"] as const;
const OPERATION_OUTCOMES = ["success", "failure", "timeout"] as const;
const MESSAGE_BOUNDARIES = ["before", "during", "after"] as const;
const REQUEST_KINDS = ["primary", "compaction", "title", "generate"] as const;
const INVOCATION_KINDS = ["doGenerate", "doStream"] as const;
const OPERATION_SOURCES = ["plugin", "host"] as const;
const EXPECTED_REGISTRATIONS = [
  "provider.transform",
  "aisdk.language",
  "session.context",
  "session.generate",
  "session.compaction",
  "session.model.request",
  "event.subscribe",
] as const;
const EXPECTED_DISPOSALS = EXPECTED_REGISTRATIONS.filter((name) => name !== "event.subscribe");
const EXPECTED_DISPOSAL_ORDER = [...EXPECTED_DISPOSALS].reverse();

type JsonObject = Record<string, unknown>;

export interface TelemetryExpectation {
  readonly runId: string;
  readonly mode: ProbeMode;
}

export interface NormalizedExternalSnapshot {
  readonly messages: readonly NormalizedMessageSnapshot[];
  readonly missingIds: readonly number[];
  readonly observed: boolean;
}

export interface CleanupEvidence {
  readonly started: boolean;
  readonly completed: boolean;
  readonly registered: readonly string[];
  readonly disposed: readonly string[];
  readonly missingRegistrations: readonly string[];
  readonly missingDisposals: readonly string[];
  readonly writerDisposed: boolean;
}

export interface EvaluationEvidence {
  readonly mode: ProbeMode;
  readonly telemetryRecords: number;
  readonly callbackCounts: Readonly<Record<CallbackOperation, number>>;
  readonly callbackMaxDepth: Readonly<Record<CallbackOperation, number>>;
  readonly modelRequests: number;
  readonly modelInvocations: number;
  readonly operationStarts: number;
  readonly operationSuccesses: number;
  readonly operationFailures: number;
  readonly operationTimeouts: number;
  readonly sentinelObserved: boolean;
  readonly externalComparison?: SnapshotComparison;
  readonly externalChanges?: readonly SnapshotChange[];
  readonly externalSettledComparison?: SnapshotComparison;
  readonly durableHistoryEffect?: DurableHistoryEffect;
  readonly durableEvents: readonly string[];
  readonly cleanup: CleanupEvidence;
}

export interface ProbeEvaluationResult {
  readonly mode: ProbeMode;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly evidence: EvaluationEvidence;
}

interface EvaluationBase {
  readonly records: readonly ProbeTelemetryRecord[];
  readonly externalBefore?: unknown;
  readonly externalAfter?: unknown;
}

export type DurableHistoryEffect = "unchanged" | "appended";

export interface HostGenerateCallEvidence {
  readonly callCount: number;
  readonly outcome: "success" | "failure" | "timeout";
  readonly returnedText?: unknown;
  readonly error?: unknown;
}

export interface OrdinaryEvaluationInput extends EvaluationBase {
  readonly mode: "ordinary";
  readonly observableOutput?: unknown;
  readonly externalHistory?: unknown;
}

export interface SessionGenerateEvaluationInput extends EvaluationBase {
  readonly mode: "session-generate";
  readonly returnedText: unknown;
}

export interface SessionGenerateHistoryEvaluationInput extends EvaluationBase {
  readonly mode: "session-generate-history";
  readonly hostEvidence: HostGenerateCallEvidence;
  readonly externalBefore: unknown;
  readonly externalAfter: unknown;
  readonly externalSettledAfter: unknown;
}

export interface StandaloneGenerateEvaluationInput extends EvaluationBase {
  readonly mode: "standalone-generate";
  readonly returnedText: unknown;
}

export interface CompactionEvaluationInput extends EvaluationBase {
  readonly mode: "compaction";
}

export type ProbeModeEvaluationInput =
  | OrdinaryEvaluationInput
  | SessionGenerateEvaluationInput
  | SessionGenerateHistoryEvaluationInput
  | StandaloneGenerateEvaluationInput
  | CompactionEvaluationInput;

export interface AggregateProbeEvaluation {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly modes: Readonly<Record<ProbeMode, ProbeEvaluationResult>>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(line: number, message: string): never {
  throw new TypeError(`Malformed telemetry line ${line}: ${message}`);
}

function requireString(record: JsonObject, key: string, line: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) malformed(line, `${key} must be a nonempty string`);
  return value;
}

function requireNumber(record: JsonObject, key: string, line: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    malformed(line, `${key} must be a nonnegative integer`);
  }
  return value;
}

function requireMember<const T extends readonly string[]>(
  record: JsonObject,
  key: string,
  values: T,
  line: number,
): T[number] {
  const value = requireString(record, key, line);
  if (!(values as readonly string[]).includes(value)) malformed(line, `${key} has unknown value ${value}`);
  return value as T[number];
}

function validateOptionalString(record: JsonObject, key: string, line: number): void {
  if (record[key] !== undefined && typeof record[key] !== "string") malformed(line, `${key} must be a string`);
}

function validateDetails(record: JsonObject, line: number): void {
  if (record.details !== undefined && !isObject(record.details)) malformed(line, "details must be an object");
}

function validateTelemetryRecord(
  value: unknown,
  line: number,
  expectation: TelemetryExpectation,
): ProbeTelemetryRecord {
  if (!isObject(value)) malformed(line, "record must be an object");
  const runId = requireString(value, "runId", line);
  const mode = requireMember(value, "mode", PROBE_MODES, line);
  requireNumber(value, "seq", line);
  const timestamp = requireString(value, "timestamp", line);
  if (Number.isNaN(Date.parse(timestamp))) malformed(line, "timestamp must be parseable");
  if (runId !== expectation.runId) malformed(line, `runId ${runId} does not match ${expectation.runId}`);
  if (mode !== expectation.mode) malformed(line, `mode ${mode} does not match ${expectation.mode}`);

  const event = requireString(value, "event", line);
  switch (event) {
    case "setup":
    case "registration":
    case "provider":
    case "language-model":
      validateOptionalString(value, "name", line);
      validateOptionalString(value, "provider", line);
      validateOptionalString(value, "model", line);
      validateDetails(value, line);
      break;
    case "callback.enter":
    case "callback.exit":
      requireMember(value, "operation", CALLBACK_OPERATIONS, line);
      requireNumber(value, "depth", line);
      requireNumber(value, "invocationCount", line);
      if (value.outcome !== undefined) requireMember(value, "outcome", OPERATION_OUTCOMES, line);
      validateOptionalString(value, "error", line);
      break;
    case "model.request":
      requireString(value, "provider", line);
      requireString(value, "model", line);
      requireMember(value, "requestKind", REQUEST_KINDS, line);
      break;
    case "message.snapshot":
      requireMember(value, "boundary", MESSAGE_BOUNDARIES, line);
      requireNumber(value, "position", line);
      validateOptionalString(value, "id", line);
      requireString(value, "role", line);
      if (typeof value.text !== "string") malformed(line, "text must be a string");
      break;
    case "model.invocation":
      validateDetails(value, line);
      requireMember(value, "requestKind", INVOCATION_KINDS, line);
      requireNumber(value, "invocation", line);
      requireString(value, "sentinel", line);
      break;
    case "operation.start":
    case "operation.success":
    case "operation.failure":
    case "operation.timeout":
      requireMember(value, "operation", CALLBACK_OPERATIONS, line);
      requireString(value, "operationId", line);
      if (value.source !== undefined) requireMember(value, "source", OPERATION_SOURCES, line);
      validateOptionalString(value, "error", line);
      break;
    case "event.observed":
      requireString(value, "observedEvent", line);
      validateDetails(value, line);
      break;
    case "cleanup":
    case "disposal":
      validateDetails(value, line);
      break;
    default:
      malformed(line, `unknown event ${event}`);
  }
  return value as unknown as ProbeTelemetryRecord;
}

export function parseProbeTelemetryJsonl(text: string, expectation: TelemetryExpectation): ProbeTelemetryRecord[] {
  if (text.trim() === "") throw new TypeError("Telemetry JSONL must be nonempty");
  const lines = text.split(/\r?\n/);
  const records: ProbeTelemetryRecord[] = [];
  let previousSequence = -1;
  for (let index = 0; index < lines.length; index++) {
    const source = lines[index];
    if (source.trim() === "") {
      if (index === lines.length - 1) continue;
      malformed(index + 1, "blank lines are not allowed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      malformed(index + 1, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const record = validateTelemetryRecord(parsed, index + 1, expectation);
    if (record.seq <= previousSequence) malformed(index + 1, `seq ${record.seq} is not strictly increasing and unique`);
    previousSequence = record.seq;
    records.push(record);
  }
  if (records.length === 0) throw new TypeError("Telemetry JSONL must contain at least one record");
  return records;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isObject(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.delta === "string") return part.delta;
      return "";
    })
    .join("");
}

function externalMessageArray(observation: unknown): readonly unknown[] | undefined {
  if (Array.isArray(observation)) return observation;
  if (!isObject(observation)) return undefined;
  if (Array.isArray(observation.messages)) return observation.messages;
  if (Array.isArray(observation.data)) return observation.data;
  if (isObject(observation.context)) {
    if (Array.isArray(observation.context.messages)) return observation.context.messages;
    if (Array.isArray(observation.context.data)) return observation.context.data;
  }
  return undefined;
}

export function normalizeExternalMessages(observation: unknown): NormalizedExternalSnapshot {
  const source = externalMessageArray(observation);
  const messages = (source ?? []).map((raw, position): NormalizedMessageSnapshot => {
    if (!isObject(raw)) throw new TypeError(`External message at position ${position} is not an object`);
    const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : undefined;
    const role =
      typeof raw.role === "string" && raw.role.length > 0
        ? raw.role
        : typeof raw.type === "string" && raw.type.length > 0
          ? raw.type
          : "unknown";
    const text =
      typeof raw.text === "string"
        ? raw.text
        : textFromContent(raw.content ?? raw.parts ?? (isObject(raw.message) ? raw.message.content : undefined));
    return { position, ...(id === undefined ? {} : { id }), role, text };
  });
  return {
    messages,
    missingIds: messages.filter((message) => message.id === undefined).map((message) => message.position),
    observed: source !== undefined,
  };
}

function recordsFor<Event extends ProbeTelemetryRecord["event"]>(
  records: readonly ProbeTelemetryRecord[],
  event: Event,
) {
  return records.filter((record): record is ProbeTelemetryRecord & { readonly event: Event } => record.event === event);
}

function includesText(value: unknown, sentinel: string): boolean {
  if (typeof value === "string") return value.includes(sentinel);
  if (Array.isArray(value)) return value.some((item) => includesText(item, sentinel));
  if (!isObject(value)) return false;
  return Object.values(value).some((item) => includesText(item, sentinel));
}

function callbackSummary(records: readonly ProbeTelemetryRecord[]): {
  counts: Record<CallbackOperation, number>;
  maxDepth: Record<CallbackOperation, number>;
} {
  const counts: Record<CallbackOperation, number> = { context: 0, generate: 0, compaction: 0 };
  const maxDepth: Record<CallbackOperation, number> = { context: 0, generate: 0, compaction: 0 };
  for (const record of recordsFor(records, "callback.enter")) {
    counts[record.operation]++;
    maxDepth[record.operation] = Math.max(maxDepth[record.operation], record.depth);
  }
  return { counts, maxDepth };
}

function stringDetail(record: { readonly details?: Record<string, unknown> }, key: string): string | undefined {
  const value = record.details?.[key];
  return typeof value === "string" ? value : undefined;
}

export function evaluateCleanup(records: readonly ProbeTelemetryRecord[]): {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly evidence: CleanupEvidence;
} {
  const cleanup = recordsFor(records, "cleanup");
  const registered = recordsFor(records, "registration").flatMap((record) =>
    record.name === undefined ? [] : [record.name],
  );
  const disposals = recordsFor(records, "disposal");
  const disposed = disposals.flatMap((record) => {
    const resource = stringDetail(record, "resource");
    return resource === undefined ? [] : [resource];
  });
  const cleanupStarts = cleanup.filter((record) => stringDetail(record, "phase") === "start");
  const cleanupCompletes = cleanup.filter((record) => stringDetail(record, "phase") === "complete");
  const writerDisposals = disposals.filter((record) => stringDetail(record, "reason") === "writer.dispose");
  const started = cleanupStarts.length > 0;
  const completed = cleanupCompletes.length > 0;
  const writerDisposed = writerDisposals.length > 0;
  const missingRegistrations = EXPECTED_REGISTRATIONS.filter((name) => !registered.includes(name));
  const missingDisposals = EXPECTED_DISPOSALS.filter((name) => !disposed.includes(name));
  const failures: string[] = [];
  if (cleanupStarts.length !== 1) failures.push(`expected exactly one cleanup start, observed ${cleanupStarts.length}`);
  if (cleanupCompletes.length !== 1)
    failures.push(`expected exactly one cleanup complete, observed ${cleanupCompletes.length}`);
  if (missingRegistrations.length > 0) failures.push(`missing registrations: ${missingRegistrations.join(", ")}`);
  if (missingDisposals.length > 0) failures.push(`missing registration disposals: ${missingDisposals.join(", ")}`);
  for (const name of EXPECTED_REGISTRATIONS) {
    const count = registered.filter((registeredName) => registeredName === name).length;
    if (count > 1) failures.push(`expected exactly one ${name} registration, observed ${count}`);
  }
  const duplicateRegistrations = [...new Set(registered.filter((name, index) => registered.indexOf(name) !== index))];
  const duplicateDisposals = [...new Set(disposed.filter((name, index) => disposed.indexOf(name) !== index))];
  if (duplicateRegistrations.length > 0) failures.push(`duplicate registrations: ${duplicateRegistrations.join(", ")}`);
  if (duplicateDisposals.length > 0)
    failures.push(`duplicate registration disposals: ${duplicateDisposals.join(", ")}`);
  if (
    disposed.length !== EXPECTED_DISPOSAL_ORDER.length ||
    disposed.some((name, index) => name !== EXPECTED_DISPOSAL_ORDER[index])
  ) {
    failures.push(`registration disposal order was not exactly ${EXPECTED_DISPOSAL_ORDER.join(", ")}`);
  }
  if (writerDisposals.length !== 1)
    failures.push(`expected exactly one telemetry writer disposal, observed ${writerDisposals.length}`);
  return {
    passed: failures.length === 0,
    failures,
    evidence: {
      started,
      completed,
      registered,
      disposed,
      missingRegistrations,
      missingDisposals,
      writerDisposed,
    },
  };
}

function compareExternal(
  before: unknown,
  after: unknown,
  failures: string[],
  requirement: "present" | "unchanged",
  nonempty: "after" | "both" = "after",
): SnapshotComparison | undefined {
  if (before === undefined || after === undefined) {
    failures.push("external before/after message history evidence is missing");
    return undefined;
  }
  const normalizedBefore = normalizeExternalMessages(before);
  const normalizedAfter = normalizeExternalMessages(after);
  if (!normalizedBefore.observed || !normalizedAfter.observed) {
    failures.push("external before/after observations did not contain a recognized message array");
    return undefined;
  }
  if (nonempty === "both" && normalizedBefore.messages.length === 0) {
    failures.push("external before message history was empty");
  }
  if (normalizedAfter.messages.length === 0) failures.push("external after message history was empty");
  let comparison = compareOrderedMessageSnapshots(normalizedBefore.messages, normalizedAfter.messages);
  if (comparison.valid) {
    const idReasons: string[] = [];
    const pairedLength = Math.min(normalizedBefore.messages.length, normalizedAfter.messages.length);
    for (let position = 0; position < pairedLength; position++) {
      const beforeMessage = normalizedBefore.messages[position];
      const afterMessage = normalizedAfter.messages[position];
      if (comparison.changes[position] === "replaced" && beforeMessage.id !== afterMessage.id) {
        idReasons.push(`changed or missing ID for replacement at position ${position}`);
      }
    }
    if (idReasons.length > 0) {
      comparison = { valid: false, changes: comparison.changes, reasons: idReasons };
    }
  }
  if (!comparison.valid) failures.push(...comparison.reasons.map((reason) => `external history: ${reason}`));
  if (requirement === "unchanged" && comparison.changes.some((change) => change !== "unchanged")) {
    failures.push(`external history changed: ${comparison.changes.join(", ")}`);
  }
  return comparison;
}

function requireContextCallbackAndSnapshot(records: readonly ProbeTelemetryRecord[], failures: string[]): void {
  const enters = recordsFor(records, "callback.enter").filter((record) => record.operation === "context");
  const exits = recordsFor(records, "callback.exit").filter(
    (record) =>
      record.operation === "context" &&
      record.outcome === "success" &&
      enters.some(
        (enter) =>
          enter.invocationCount === record.invocationCount && enter.depth === record.depth && enter.seq < record.seq,
      ),
  );
  if (enters.length === 0) failures.push("context callback enter was not observed");
  if (exits.length === 0) failures.push("matching successful context callback exit was not observed");
  if (recordsFor(records, "message.snapshot").length === 0) {
    failures.push("message snapshot was not observed during the run");
  }
}

function baseEvidence(
  mode: ProbeMode,
  records: readonly ProbeTelemetryRecord[],
  sentinelObserved: boolean,
  cleanup: CleanupEvidence,
  externalComparison?: SnapshotComparison,
  externalSettledComparison?: SnapshotComparison,
  durableHistoryEffect?: DurableHistoryEffect,
): EvaluationEvidence {
  const callbacks = callbackSummary(records);
  const durableEvents = recordsFor(records, "event.observed").map((record) => record.observedEvent);
  return {
    mode,
    telemetryRecords: records.length,
    callbackCounts: callbacks.counts,
    callbackMaxDepth: callbacks.maxDepth,
    modelRequests: recordsFor(records, "model.request").length,
    modelInvocations: recordsFor(records, "model.invocation").length,
    operationStarts: recordsFor(records, "operation.start").length,
    operationSuccesses: recordsFor(records, "operation.success").length,
    operationFailures: recordsFor(records, "operation.failure").length,
    operationTimeouts: recordsFor(records, "operation.timeout").length,
    sentinelObserved,
    ...(externalComparison === undefined ? {} : { externalComparison, externalChanges: externalComparison.changes }),
    ...(externalSettledComparison === undefined ? {} : { externalSettledComparison }),
    ...(durableHistoryEffect === undefined ? {} : { durableHistoryEffect }),
    durableEvents,
    cleanup,
  };
}

interface StrictDurableHistoryEvidence {
  readonly comparison?: SnapshotComparison;
  readonly settledComparison?: SnapshotComparison;
  readonly effect?: DurableHistoryEffect;
}

function evaluateStrictDurableHistory(
  beforeObservation: unknown,
  afterObservation: unknown,
  settledObservation: unknown,
  failures: string[],
): StrictDurableHistoryEvidence {
  let before: NormalizedExternalSnapshot;
  let after: NormalizedExternalSnapshot;
  let settled: NormalizedExternalSnapshot;
  try {
    before = normalizeExternalMessages(beforeObservation);
    after = normalizeExternalMessages(afterObservation);
    settled = normalizeExternalMessages(settledObservation);
  } catch (error) {
    failures.push(
      `strict durable history normalization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }

  const snapshots = [
    ["before", before],
    ["after", after],
    ["settled", settled],
  ] as const;
  let snapshotsStructurallyValid = true;
  for (const [name, snapshot] of snapshots) {
    if (!snapshot.observed) {
      failures.push(`external ${name} observation did not contain a recognized message array`);
      snapshotsStructurallyValid = false;
    }
    if (snapshot.messages.length === 0) {
      failures.push(`external ${name} message history was empty`);
      snapshotsStructurallyValid = false;
    }
    if (snapshot.missingIds.length > 0) {
      failures.push(`external ${name} message history has missing IDs at positions ${snapshot.missingIds.join(", ")}`);
      snapshotsStructurallyValid = false;
    }
    const ids = snapshot.messages.flatMap((message) => (message.id === undefined ? [] : [message.id]));
    const duplicates = [...new Set(ids.filter((id, position) => ids.indexOf(id) !== position))];
    if (duplicates.length > 0) {
      failures.push(`external ${name} message history has duplicate IDs: ${duplicates.join(", ")}`);
      snapshotsStructurallyValid = false;
    }
  }

  const exactMessage = (left: NormalizedMessageSnapshot, right: NormalizedMessageSnapshot): boolean =>
    left.id === right.id && left.role === right.role && left.text === right.text;
  const prefixPreserved = (candidate: NormalizedExternalSnapshot, name: "after" | "settled"): boolean => {
    if (candidate.messages.length < before.messages.length) {
      failures.push(`external ${name} history removed seeded messages`);
      return false;
    }
    let preserved = true;
    for (let position = 0; position < before.messages.length; position++) {
      if (!exactMessage(before.messages[position], candidate.messages[position])) {
        failures.push(`external ${name} history changed, replaced, or reordered seed message at position ${position}`);
        preserved = false;
      }
    }
    return preserved;
  };

  const afterPrefixPreserved = prefixPreserved(after, "after");
  const settledPrefixPreserved = prefixPreserved(settled, "settled");
  const beforeIds = new Set(before.messages.flatMap((message) => (message.id === undefined ? [] : [message.id])));
  for (const [name, snapshot] of [
    ["after", after],
    ["settled", settled],
  ] as const) {
    for (const message of snapshot.messages.slice(before.messages.length)) {
      if (message.id !== undefined && beforeIds.has(message.id)) {
        failures.push(`external ${name} appended message reused seed ID ${message.id}`);
        snapshotsStructurallyValid = false;
      }
    }
  }

  const comparison: SnapshotComparison = {
    valid: afterPrefixPreserved,
    changes: [
      ...before.messages.map((): SnapshotChange => "unchanged"),
      ...after.messages.slice(before.messages.length).map((): SnapshotChange => "appended"),
    ],
    reasons: afterPrefixPreserved ? [] : ["seed history was not preserved as an exact ordered prefix"],
  };
  const settledExactlyMatches =
    after.messages.length === settled.messages.length &&
    after.messages.every((message, position) => exactMessage(message, settled.messages[position]));
  const settledComparison: SnapshotComparison = {
    valid: settledExactlyMatches,
    changes: settledExactlyMatches ? after.messages.map((): SnapshotChange => "unchanged") : [],
    reasons: settledExactlyMatches ? [] : ["post-call and settled histories differ by ID, role, text, or length"],
  };
  if (!settledExactlyMatches)
    failures.push("external history mutated after the post-call observation; quiescence was not proven");

  const effect: DurableHistoryEffect | undefined =
    snapshotsStructurallyValid && afterPrefixPreserved && settledPrefixPreserved && settledExactlyMatches
      ? after.messages.length === before.messages.length
        ? "unchanged"
        : "appended"
      : undefined;
  if (effect === undefined) failures.push("durable history effect could not be classified as unchanged or appended");
  return { comparison, settledComparison, effect };
}

function requireSingleSuccessfulCallback(
  records: readonly ProbeTelemetryRecord[],
  operation: CallbackOperation,
  failures: string[],
):
  | {
      readonly enter: ProbeTelemetryRecord & { readonly event: "callback.enter" };
      readonly exit: ProbeTelemetryRecord & { readonly event: "callback.exit" };
    }
  | undefined {
  const enters = recordsFor(records, "callback.enter").filter((record) => record.operation === operation);
  const exits = recordsFor(records, "callback.exit").filter((record) => record.operation === operation);
  if (enters.length !== 1) failures.push(`expected exactly one ${operation} callback enter, observed ${enters.length}`);
  if (exits.length !== 1) failures.push(`expected exactly one ${operation} callback exit, observed ${exits.length}`);
  if (enters.length !== 1 || exits.length !== 1) return undefined;
  const enter = enters[0];
  const exit = exits[0];
  if (enter.depth !== 1) failures.push(`${operation} callback maximum depth was not exactly one`);
  if (
    exit.outcome !== "success" ||
    exit.depth !== enter.depth ||
    exit.invocationCount !== enter.invocationCount ||
    exit.seq <= enter.seq
  ) {
    failures.push(`${operation} callback did not have one matching successful exit`);
  }
  return { enter, exit };
}

function requireExactModel(
  records: readonly ProbeTelemetryRecord[],
  requestKind: "primary" | "generate",
  failures: string[],
): void {
  const requests = recordsFor(records, "model.request").filter((record) => record.requestKind === requestKind);
  if (requests.length === 0) failures.push(`no ${requestKind} model request was observed`);
  if (requests.some((record) => record.provider !== PROBE_PROVIDER_ID || record.model !== PROBE_MODEL_ID)) {
    failures.push(`${requestKind} model request did not use ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID}`);
  }
}

function requireNoFailedActivity(records: readonly ProbeTelemetryRecord[], failures: string[]): void {
  const failedCallbacks = recordsFor(records, "callback.exit").filter(
    (record) => record.outcome === "failure" || record.outcome === "timeout",
  );
  if (failedCallbacks.length > 0) failures.push("a callback failed or timed out");
  if (recordsFor(records, "operation.failure").length > 0) failures.push("an operation failure was observed");
  if (recordsFor(records, "operation.timeout").length > 0) failures.push("an operation timeout was observed");
}

function requireSingleGenerateOperation(
  records: readonly ProbeTelemetryRecord[],
  returnedText: unknown,
  failures: string[],
): boolean {
  const starts = recordsFor(records, "operation.start").filter((record) => record.operation === "generate");
  const successes = recordsFor(records, "operation.success").filter((record) => record.operation === "generate");
  if (starts.length !== 1) failures.push(`expected exactly one generate operation start, observed ${starts.length}`);
  if (successes.length !== 1)
    failures.push(`expected exactly one generate operation success, observed ${successes.length}`);
  if (starts.length !== 1 || successes.length !== 1) return false;

  const start = starts[0];
  const success = successes[0];
  const inOperation = (seq: number): boolean => seq >= start.seq && seq <= success.seq;
  if (start.operationId !== success.operationId) failures.push("generate operation start and success IDs differ");
  if (start.seq >= success.seq) failures.push("generate operation start did not precede its success");

  const resultRecords = recordsFor(records, "language-model").filter(
    (record) =>
      record.name === "operation.result" &&
      inOperation(record.seq) &&
      stringDetail(record, "operationId") === start.operationId &&
      stringDetail(record, "text") === PROBE_STREAM_SENTINEL,
  );
  const exactReturned = returnedText === PROBE_STREAM_SENTINEL;
  if (!exactReturned) failures.push("generate result did not equal the deterministic stream sentinel");
  if (resultRecords.length !== 1)
    failures.push("exactly one interval-correlated telemetry operation result stream sentinel was not observed");

  const deterministicStreams = recordsFor(records, "model.invocation").filter(
    (record) =>
      record.requestKind === "doStream" &&
      record.sentinel === PROBE_STREAM_SENTINEL &&
      record.provider === PROBE_PROVIDER_ID &&
      record.model === PROBE_MODEL_ID,
  );
  const intervalStreams = deterministicStreams.filter((record) => inOperation(record.seq));
  if (intervalStreams.length !== 1)
    failures.push(
      `expected exactly one deterministic stream invocation in the generate interval, observed ${intervalStreams.length}`,
    );
  return (
    start.operationId === success.operationId &&
    start.seq < success.seq &&
    exactReturned &&
    resultRecords.length === 1 &&
    intervalStreams.length === 1
  );
}

export function countToolExecutionEvents(records: readonly ProbeTelemetryRecord[], tool: string): number {
  return records.filter(
    (record) =>
      record.event === "event.observed" &&
      (record.observedEvent === "tool.execute.before" || record.observedEvent === "tool.execute.after") &&
      (record.details?.eventData as { tool?: unknown } | undefined)?.tool === tool,
  ).length;
}

export function evaluatePrimaryMemoryToolInventory(toolNames: readonly string[]): readonly string[] {
  const failures: string[] = [];
  for (const name of ["stm_memory_read", "stm_memory_status", "stm_memory_reset", "stm_memory_update"]) {
    if (!toolNames.includes(name)) failures.push(`primary model invocation did not expose ${name}`);
  }
  if (toolNames.includes("stm_memory_aggregate")) {
    failures.push("primary model invocation exposed a forbidden V2 aggregate tool");
  }
  return failures;
}

export function evaluateOrdinary(input: OrdinaryEvaluationInput): ProbeEvaluationResult {
  const failures: string[] = [];
  const records = input.records;
  const outputObserved = includesText(input.observableOutput, PROBE_STREAM_SENTINEL);
  const historyObserved = includesText(input.externalHistory ?? input.externalAfter, PROBE_STREAM_SENTINEL);
  const sentinelObserved = outputObserved || historyObserved;
  if (!sentinelObserved) failures.push("stream sentinel was absent from observable output and external history");
  requireExactModel(records, "primary", failures);
  const primaryRequests = recordsFor(records, "model.request").filter((record) => record.requestKind === "primary");
  const streamInvocations = recordsFor(records, "model.invocation").filter(
    (record) => record.requestKind === "doStream" && record.sentinel === PROBE_STREAM_SENTINEL,
  );
  if (primaryRequests.length === 0) failures.push("primary model request count is vacuous");
  if (streamInvocations.length === 0) failures.push("primary model invocation count is vacuous");
  requireContextCallbackAndSnapshot(records, failures);
  const callbacks = callbackSummary(records);
  if (Math.max(...Object.values(callbacks.maxDepth)) > 1) failures.push("callback maximum depth exceeded one");
  if (callbacks.counts.generate > 0) failures.push("unexpected generate callback was observed");
  if (callbacks.counts.compaction > 0) failures.push("unexpected compaction callback was observed");
  requireNoFailedActivity(records, failures);
  const comparison = compareExternal(input.externalBefore, input.externalAfter, failures, "present");
  if (comparison !== undefined && !comparison.changes.some((change) => change !== "unchanged")) {
    failures.push("external history did not change during ordinary generation");
  }
  if (!includesText(input.externalAfter, PROBE_STREAM_SENTINEL)) {
    failures.push("external after message history did not contain the stream sentinel");
  }
  const cleanup = evaluateCleanup(records);
  failures.push(...cleanup.failures);
  return {
    mode: "ordinary",
    passed: failures.length === 0,
    failures,
    evidence: baseEvidence("ordinary", records, sentinelObserved, cleanup.evidence, comparison),
  };
}

export function evaluateSessionGenerate(input: SessionGenerateEvaluationInput): ProbeEvaluationResult {
  const failures: string[] = [];
  const sentinelObserved = requireSingleGenerateOperation(input.records, input.returnedText, failures);
  requireExactModel(input.records, "generate", failures);
  requireContextCallbackAndSnapshot(input.records, failures);
  const callbacks = callbackSummary(input.records);
  if (callbacks.maxDepth.context > 1) failures.push("session generation recursively entered the context callback");
  if (callbacks.counts.compaction > 0) failures.push("session generation unexpectedly entered compaction");
  requireNoFailedActivity(input.records, failures);
  const comparison = compareExternal(input.externalBefore, input.externalAfter, failures, "present");
  if (comparison !== undefined && !comparison.changes.some((change) => change !== "unchanged")) {
    failures.push("external history did not change during the session-generate run");
  }
  if (!includesText(input.externalAfter, PROBE_STREAM_SENTINEL)) {
    failures.push("external after message history did not contain the stream sentinel");
  }
  const cleanup = evaluateCleanup(input.records);
  failures.push(...cleanup.failures);
  return {
    mode: "session-generate",
    passed: failures.length === 0,
    failures,
    evidence: baseEvidence("session-generate", input.records, sentinelObserved, cleanup.evidence, comparison),
  };
}

export function evaluateSessionGenerateHistory(input: SessionGenerateHistoryEvaluationInput): ProbeEvaluationResult {
  const failures: string[] = [];
  const records = input.records;
  const host = input.hostEvidence;
  if (host.callCount !== 1) failures.push(`expected exactly one direct host generate call, observed ${host.callCount}`);
  if (host.outcome !== "success") failures.push(`direct host generate call outcome was ${host.outcome}, not success`);
  if (host.returnedText !== PROBE_STREAM_SENTINEL) {
    failures.push("direct host generate call did not return the exact deterministic stream sentinel");
  }
  if (host.error !== undefined) failures.push("direct host generate call reported an error");

  const operationRecords = records.filter((record) =>
    ["operation.start", "operation.success", "operation.failure", "operation.timeout"].includes(record.event),
  ) as readonly Extract<
    ProbeTelemetryRecord,
    { readonly event: "operation.start" | "operation.success" | "operation.failure" | "operation.timeout" }
  >[];
  const pluginOperations = operationRecords.filter((record) => record.source === "plugin");
  if (pluginOperations.length > 0) {
    failures.push(`passive plugin emitted ${pluginOperations.length} plugin-triggered operation lifecycle records`);
  }
  if (operationRecords.length > 0) {
    failures.push(
      `expected host evidence to be separate from telemetry, observed ${operationRecords.length} operation records`,
    );
  }

  const contextInterval = requireSingleSuccessfulCallback(records, "context", failures);
  const generateInterval = requireSingleSuccessfulCallback(records, "generate", failures);
  const callbacks = callbackSummary(records);
  if (callbacks.counts.compaction !== 0) failures.push("session generate history unexpectedly entered compaction");
  if (Math.max(...Object.values(callbacks.maxDepth)) > 1) failures.push("callback maximum depth exceeded one");

  const snapshots = recordsFor(records, "message.snapshot");
  if (
    contextInterval !== undefined &&
    !snapshots.some((record) => record.seq > contextInterval.enter.seq && record.seq < contextInterval.exit.seq)
  ) {
    failures.push("context callback message snapshot was not observed inside its callback interval");
  }
  if (
    generateInterval !== undefined &&
    !snapshots.some((record) => record.seq > generateInterval.enter.seq && record.seq < generateInterval.exit.seq)
  ) {
    failures.push("generate callback message snapshot was not observed inside its callback interval");
  }

  const generateRequests = recordsFor(records, "model.request").filter((record) => record.requestKind === "generate");
  if (generateRequests.length !== 1) {
    failures.push(`expected exactly one generate model request, observed ${generateRequests.length}`);
  }
  if (generateRequests.some((record) => record.provider !== PROBE_PROVIDER_ID || record.model !== PROBE_MODEL_ID)) {
    failures.push(`generate model request did not use ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID}`);
  }

  let exactOrderedStream = false;
  if (generateInterval !== undefined && generateRequests.length === 1) {
    const request = generateRequests[0];
    const firstNonEventAfter = (seq: number): ProbeTelemetryRecord | undefined =>
      records.find((record) => record.seq > seq && record.event !== "event.observed");
    const firstAfterGenerateExit = firstNonEventAfter(generateInterval.exit.seq);
    if (firstAfterGenerateExit !== request) {
      failures.push(
        "generate model request was not the first non-event record after the successful generate callback exit",
      );
    }

    const invocation = firstNonEventAfter(request.seq);
    if (
      invocation === undefined ||
      invocation.event !== "model.invocation" ||
      invocation.requestKind !== "doStream" ||
      invocation.provider !== PROBE_PROVIDER_ID ||
      invocation.model !== PROBE_MODEL_ID ||
      invocation.sentinel !== PROBE_STREAM_SENTINEL
    ) {
      failures.push(
        `exact ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID} deterministic stream invocation was not the first non-event record after the generate model request`,
      );
    } else {
      exactOrderedStream = true;
      const nextHostBoundary = records.find(
        (record) =>
          record.seq > invocation.seq &&
          (record.event === "model.request" || record.event === "callback.enter" || record.event === "callback.exit"),
      );
      const additionalStreams = recordsFor(records, "model.invocation").filter(
        (record) =>
          record.seq > invocation.seq &&
          (nextHostBoundary === undefined || record.seq < nextHostBoundary.seq) &&
          record.requestKind === "doStream",
      );
      if (additionalStreams.length > 0) {
        failures.push(
          `observed ${additionalStreams.length} additional doStream invocation(s) before the next host boundary`,
        );
      }
    }
  }

  requireNoFailedActivity(records, failures);
  const durable = evaluateStrictDurableHistory(
    input.externalBefore,
    input.externalAfter,
    input.externalSettledAfter,
    failures,
  );
  const cleanup = evaluateCleanup(records);
  failures.push(...cleanup.failures);
  const sentinelObserved = host.returnedText === PROBE_STREAM_SENTINEL && exactOrderedStream;
  return {
    mode: "session-generate-history",
    passed: failures.length === 0,
    failures,
    evidence: baseEvidence(
      "session-generate-history",
      records,
      sentinelObserved,
      cleanup.evidence,
      durable.comparison,
      durable.settledComparison,
      durable.effect,
    ),
  };
}

export function evaluateStandaloneGenerate(input: StandaloneGenerateEvaluationInput): ProbeEvaluationResult {
  const failures: string[] = [];
  const sentinelObserved = requireSingleGenerateOperation(input.records, input.returnedText, failures);
  requireContextCallbackAndSnapshot(input.records, failures);
  const callbacks = callbackSummary(input.records);
  if (callbacks.maxDepth.context > 1) failures.push("standalone generation recursively entered the context callback");
  if (callbacks.counts.generate > 0)
    failures.push("standalone generation unexpectedly entered the session generate callback");
  if (callbacks.counts.compaction > 0) failures.push("standalone generation unexpectedly entered compaction");
  requireNoFailedActivity(input.records, failures);
  const comparison = compareExternal(input.externalBefore, input.externalAfter, failures, "unchanged");
  const cleanup = evaluateCleanup(input.records);
  failures.push(...cleanup.failures);
  return {
    mode: "standalone-generate",
    passed: failures.length === 0,
    failures,
    evidence: baseEvidence("standalone-generate", input.records, sentinelObserved, cleanup.evidence, comparison),
  };
}

export function evaluateCompaction(input: CompactionEvaluationInput): ProbeEvaluationResult {
  const failures: string[] = [];
  requireSingleSuccessfulCallback(input.records, "compaction", failures);
  const durableEvents = recordsFor(input.records, "event.observed").map((record) => record.observedEvent);
  if (!durableEvents.includes("session.compaction.started"))
    failures.push("durable compaction started event was not observed");
  if (!durableEvents.includes("session.compaction.ended"))
    failures.push("durable compaction ended event was not observed");
  if (durableEvents.includes("session.compaction.failed"))
    failures.push("durable compaction failed event was observed");
  const compactionRequests = recordsFor(input.records, "model.request").filter(
    (record) => record.requestKind === "compaction",
  );
  if (compactionRequests.length !== 1) {
    failures.push(`expected exactly one compaction model request, observed ${compactionRequests.length}`);
  }
  if (compactionRequests.some((record) => record.provider !== PROBE_PROVIDER_ID || record.model !== PROBE_MODEL_ID)) {
    failures.push(`compaction model request did not use ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID}`);
  }
  if (compactionRequests.length === 1) {
    const request = compactionRequests[0];
    const ended = recordsFor(input.records, "event.observed").find(
      (record) => record.observedEvent === "session.compaction.ended" && record.seq > request.seq,
    );
    if (ended === undefined) {
      failures.push("durable compaction ended event did not follow the compaction model request");
    } else {
      const intervalStreams = recordsFor(input.records, "model.invocation").filter(
        (record) => record.requestKind === "doStream" && record.seq > request.seq && record.seq < ended.seq,
      );
      const exactSummaryStreams = intervalStreams.filter(
        (record) =>
          record.provider === PROBE_PROVIDER_ID &&
          record.model === PROBE_MODEL_ID &&
          record.sentinel === PROBE_COMPACTION_SUMMARY,
      );
      if (exactSummaryStreams.length === 0) {
        failures.push("exact compaction summary stream invocation was not observed between request and durable end");
      }
      if (
        intervalStreams.some(
          (record) =>
            record.provider === PROBE_PROVIDER_ID &&
            record.model === PROBE_MODEL_ID &&
            record.sentinel !== PROBE_COMPACTION_SUMMARY,
        )
      ) {
        failures.push("deterministic stream invocation used a non-compaction sentinel between request and durable end");
      }
    }
  }
  requireNoFailedActivity(input.records, failures);
  const comparison = compareExternal(input.externalBefore, input.externalAfter, failures, "present", "both");
  if (comparison !== undefined && !comparison.changes.some((change) => change !== "unchanged")) {
    failures.push("external history did not prove any compaction removal, replacement, or append");
  }
  const cleanup = evaluateCleanup(input.records);
  failures.push(...cleanup.failures);
  return {
    mode: "compaction",
    passed: failures.length === 0,
    failures,
    evidence: baseEvidence("compaction", input.records, false, cleanup.evidence, comparison),
  };
}

export function evaluateProbeMode(input: ProbeModeEvaluationInput): ProbeEvaluationResult {
  switch (input.mode) {
    case "ordinary":
      return evaluateOrdinary(input);
    case "session-generate":
      return evaluateSessionGenerate(input);
    case "session-generate-history":
      return evaluateSessionGenerateHistory(input);
    case "standalone-generate":
      return evaluateStandaloneGenerate(input);
    case "compaction":
      return evaluateCompaction(input);
  }
}

export function evaluateAllProbeModes(inputs: {
  readonly ordinary: OrdinaryEvaluationInput;
  readonly "session-generate": SessionGenerateEvaluationInput;
  readonly "session-generate-history": SessionGenerateHistoryEvaluationInput;
  readonly "standalone-generate": StandaloneGenerateEvaluationInput;
  readonly compaction: CompactionEvaluationInput;
}): AggregateProbeEvaluation {
  const modes = {
    ordinary: evaluateOrdinary(inputs.ordinary),
    "session-generate": evaluateSessionGenerate(inputs["session-generate"]),
    "session-generate-history": evaluateSessionGenerateHistory(inputs["session-generate-history"]),
    "standalone-generate": evaluateStandaloneGenerate(inputs["standalone-generate"]),
    compaction: evaluateCompaction(inputs.compaction),
  };
  const failures = PROBE_MODES.flatMap((mode) => modes[mode].failures.map((failure) => `${mode}: ${failure}`));
  return { passed: failures.length === 0, failures, modes };
}
