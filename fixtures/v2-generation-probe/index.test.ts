import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { Model, type Plugin, Provider } from "@opencode/plugin";

import probe, {
  PROBE_COMPACTION_SUMMARY,
  PROBE_GENERATE_SENTINEL,
  PROBE_MODEL_ID,
  PROBE_PROVIDER_ID,
  PROBE_SESSION_PROMPT_SENTINEL,
  PROBE_STANDALONE_PROMPT_SENTINEL,
  PROBE_STREAM_SENTINEL,
} from "./index.js";
import {
  evaluateCompaction,
  evaluateOrdinary,
  evaluateSessionGenerate,
  evaluateSessionGenerateHistory,
  evaluateStandaloneGenerate,
  parseProbeTelemetryJsonl,
  type HostGenerateCallEvidence,
} from "./evaluator.js";
import {
  compareOrderedMessageSnapshots,
  normalizeV2Messages,
  type ProbeMode,
  type ProbeTelemetryRecord,
} from "./telemetry.js";

type Registration = Awaited<ReturnType<Plugin.Context["provider"]["transform"]>>;
type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0];
type LanguageInput = {
  readonly model: Model.Info;
  readonly sdk: unknown;
  readonly options: Record<string, unknown>;
  language?: LanguageModelV3;
};
type HookCallback = (input: unknown) => Promise<void> | void;
type TelemetryInput = ProbeTelemetryRecord extends infer Record
  ? Record extends ProbeTelemetryRecord
    ? Omit<Record, "runId" | "mode" | "seq" | "timestamp">
    : never
  : never;

function hasEvent<Event extends ProbeTelemetryRecord["event"]>(event: Event) {
  return (record: ProbeTelemetryRecord): record is ProbeTelemetryRecord & { readonly event: Event } =>
    record.event === event;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function telemetry(path: string): Promise<ProbeTelemetryRecord[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeTelemetryRecord);
}

function assertTelemetry(records: readonly ProbeTelemetryRecord[], runId: string, mode: ProbeMode): void {
  expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index + 1));
  expect(new Set(records.map((record) => record.runId))).toEqual(new Set([runId]));
  expect(new Set(records.map((record) => record.mode))).toEqual(new Set([mode]));
}

async function makeHarness(
  mode: ProbeMode,
  options: {
    readonly registrationFailure?: { readonly name: string; readonly value: unknown };
    readonly disposalFailure?: { readonly name: string; readonly value: unknown };
    readonly onDispose?: (name: string) => void;
    readonly sessionGenerate?: (
      input: Parameters<Plugin.Context["session"]["generate"]>[0],
    ) => Promise<{ text: string }>;
    readonly standaloneGenerate?: (
      input: Parameters<Plugin.Context["generate"]["text"]>[0],
    ) => Promise<{ text: string }>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "stm-v2-probe-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "telemetry.jsonl");
  const runId = `run-${mode}-${temporaryDirectories.length}`;
  const previous = {
    runId: Bun.env.PROBE_RUN_ID,
    mode: Bun.env.PROBE_MODE,
    path: Bun.env.PROBE_TELEMETRY_PATH,
  };
  Bun.env.PROBE_RUN_ID = runId;
  Bun.env.PROBE_MODE = mode;
  Bun.env.PROBE_TELEMETRY_PATH = path;

  const registrations: string[] = [];
  const disposals: string[] = [];
  const addedProviders: Array<{ info: Provider.Info; models: readonly Model.Info[] }> = [];
  const sessionCallbacks = new Map<string, HookCallback>();
  let languageCallback: ((input: LanguageInput) => Promise<void> | void) | undefined;
  let languageScope: unknown;
  let eventStarted = false;
  let eventAborted = false;
  const sessionGenerateInputs: Parameters<Plugin.Context["session"]["generate"]>[0][] = [];
  const standaloneGenerateInputs: Parameters<Plugin.Context["generate"]["text"]>[0][] = [];

  const registration = async (name: string): Promise<Registration> => {
    if (options.registrationFailure?.name === name) {
      return Promise.reject(options.registrationFailure.value);
    }
    registrations.push(name);
    return {
      async dispose() {
        disposals.push(name);
        options.onDispose?.(name);
        if (options.disposalFailure?.name === name) {
          return Promise.reject(options.disposalFailure.value);
        }
      },
    };
  };

  const providerTransform: Plugin.Context["provider"]["transform"] = async (callback) => {
    callback({
      add(input: Parameters<ProviderEditor["add"]>[0]) {
        addedProviders.push(input);
      },
    } as unknown as Parameters<typeof callback>[0]);
    return registration("provider.transform");
  };
  const aisdkHook = async (
    name: "language",
    callback: (input: LanguageInput) => Promise<void> | void,
    scope?: { readonly providerID?: string },
  ): Promise<Registration> => {
    expect(name).toBe("language");
    languageCallback = callback;
    languageScope = scope;
    return registration("aisdk.language");
  };
  const sessionHook: Plugin.Context["session"]["hook"] = async (name, callback) => {
    sessionCallbacks.set(name, callback as HookCallback);
    return registration(`session.${String(name)}`);
  };
  const eventSubscribe: Plugin.Context["event"]["subscribe"] = (requestOptions) => ({
    async *[Symbol.asyncIterator]() {
      eventStarted = true;
      yield { type: "fixture.event" } as never;
      await new Promise<void>((resolve) => {
        const signal = requestOptions?.signal;
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      eventAborted = requestOptions?.signal?.aborted === true;
    },
  });
  const sessionGenerate: Plugin.Context["session"]["generate"] = async (input) => {
    sessionGenerateInputs.push(input);
    return options.sessionGenerate?.(input) ?? { text: "SESSION_RUN_SENTINEL" };
  };
  const standaloneGenerate: Plugin.Context["generate"]["text"] = async (input) => {
    standaloneGenerateInputs.push(input);
    return options.standaloneGenerate?.(input) ?? { text: "STANDALONE_RUN_SENTINEL" };
  };
  const context = {
    provider: { transform: providerTransform },
    aisdk: { hook: aisdkHook },
    session: { hook: sessionHook, generate: sessionGenerate },
    generate: { text: standaloneGenerate },
    event: { subscribe: eventSubscribe },
  } as unknown as Plugin.Context;

  const restoreEnvironment = () => {
    for (const [key, value] of Object.entries(previous)) {
      const envName = key === "runId" ? "PROBE_RUN_ID" : key === "mode" ? "PROBE_MODE" : "PROBE_TELEMETRY_PATH";
      if (value === undefined) delete Bun.env[envName];
      else Bun.env[envName] = value;
    }
  };

  try {
    const cleanup = await probe.setup(context);
    return {
      addedProviders,
      cleanup: cleanup!,
      context,
      disposals,
      eventAborted: () => eventAborted,
      eventStarted: () => eventStarted,
      languageCallback: () => languageCallback!,
      languageScope: () => languageScope,
      path,
      registrations,
      restoreEnvironment,
      runId,
      sessionCallbacks,
      sessionGenerateInputs,
      standaloneGenerateInputs,
    };
  } catch (error) {
    restoreEnvironment();
    throw error;
  }
}

function callbackInput(sessionID = "session-1", messages: readonly unknown[] = []) {
  return { sessionID, messages };
}

const modelCall: LanguageModelV3CallOptions = { prompt: [] };
const compactionCall: LanguageModelV3CallOptions = {
  prompt: [
    {
      role: "system",
      content: "Create a continuation summary for the next model after compaction.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Summarize the conversation using this exact template:

## Objective
Describe the user's goal.

## Requirements
List the constraints.

## Decisions
Record established decisions.

## Work State

### Completed
List completed work.

### Active
List active work.

### Blocked
List blockers.

## Next Move
State the next action.

## Relevant Files
List relevant paths.

## Important Context
Preserve details needed to continue.`,
        },
      ],
    },
  ],
};
const incompleteCompactionCall: LanguageModelV3CallOptions = {
  prompt: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Compact this conversation into a continuation summary.

## Objective
## Requirements
## Decisions
## Work State
### Completed
### Active
### Blocked
## Next Move
## Relevant Files`,
        },
      ],
    },
  ],
};

const evaluatorHistory = [{ id: "message-1", role: "user", content: "hello" }];
const expectedRegistrations = [
  "provider.transform",
  "aisdk.language",
  "session.context",
  "session.generate",
  "session.compaction",
  "session.model.request",
  "event.subscribe",
] as const;

function evaluatorRecords(mode: ProbeMode, inputs: readonly TelemetryInput[]): ProbeTelemetryRecord[] {
  return inputs.map(
    (input, index) =>
      ({
        ...input,
        runId: `evaluator-${mode}`,
        mode,
        seq: index + 1,
        timestamp: "2026-09-18T00:00:00.000Z",
      }) as ProbeTelemetryRecord,
  );
}

function resequence(records: readonly ProbeTelemetryRecord[]): ProbeTelemetryRecord[] {
  return records.map((record, index) => ({ ...record, seq: index + 1 }));
}

function duplicateFirstRecord(
  records: readonly ProbeTelemetryRecord[],
  predicate: (record: ProbeTelemetryRecord) => boolean,
): ProbeTelemetryRecord[] {
  const index = records.findIndex(predicate);
  if (index < 0) throw new Error("record to duplicate was not found");
  return resequence([...records.slice(0, index + 1), { ...records[index]! }, ...records.slice(index + 1)]);
}

function historyRecord(input: TelemetryInput): ProbeTelemetryRecord {
  return evaluatorRecords("session-generate-history", [input])[0]!;
}

function cleanupInputs(): TelemetryInput[] {
  return [
    ...expectedRegistrations.map((name): TelemetryInput => ({ event: "registration", name })),
    { event: "cleanup", details: { phase: "start" } },
    ...expectedRegistrations
      .slice(0, -1)
      .reverse()
      .map((resource): TelemetryInput => ({ event: "disposal", details: { resource } })),
    { event: "disposal", details: { reason: "writer.dispose" } },
    { event: "cleanup", details: { phase: "complete" } },
  ];
}

function validGenerationRecords(mode: "session-generate" | "standalone-generate"): ProbeTelemetryRecord[] {
  return evaluatorRecords(mode, [
    ...expectedRegistrations.map((name): TelemetryInput => ({ event: "registration", name })),
    { event: "callback.enter", operation: "context", depth: 1, invocationCount: 1 },
    {
      event: "message.snapshot",
      boundary: "before",
      position: 0,
      id: "message-1",
      role: "user",
      text: "hello",
    },
    { event: "operation.start", operation: "generate", operationId: "generate-1" },
    ...(mode === "session-generate"
      ? ([
          {
            event: "model.request",
            provider: PROBE_PROVIDER_ID,
            model: PROBE_MODEL_ID,
            requestKind: "generate",
          },
        ] satisfies TelemetryInput[])
      : []),
    {
      event: "model.invocation",
      provider: PROBE_PROVIDER_ID,
      model: PROBE_MODEL_ID,
      requestKind: "doStream",
      invocation: 1,
      sentinel: PROBE_STREAM_SENTINEL,
    },
    {
      event: "language-model",
      name: "operation.result",
      details: { operationId: "generate-1", text: PROBE_STREAM_SENTINEL },
    },
    { event: "operation.success", operation: "generate", operationId: "generate-1" },
    {
      event: "callback.exit",
      operation: "context",
      depth: 1,
      invocationCount: 1,
      outcome: "success",
    },
    ...cleanupInputs().slice(expectedRegistrations.length),
  ]);
}

function validSessionGenerateHistoryRecords(
  generateSnapshot: TelemetryInput = {
    event: "message.snapshot",
    boundary: "during",
    position: 0,
    id: "message-1",
    role: "user",
    text: "hello",
  },
): ProbeTelemetryRecord[] {
  return evaluatorRecords("session-generate-history", [
    ...expectedRegistrations.map((name): TelemetryInput => ({ event: "registration", name })),
    { event: "callback.enter", operation: "context", depth: 1, invocationCount: 1 },
    {
      event: "message.snapshot",
      boundary: "during",
      position: 0,
      id: "message-1",
      role: "user",
      text: "hello",
    },
    { event: "callback.exit", operation: "context", depth: 1, invocationCount: 1, outcome: "success" },
    { event: "callback.enter", operation: "generate", depth: 1, invocationCount: 1 },
    generateSnapshot,
    { event: "callback.exit", operation: "generate", depth: 1, invocationCount: 1, outcome: "success" },
    {
      event: "model.request",
      provider: PROBE_PROVIDER_ID,
      model: PROBE_MODEL_ID,
      requestKind: "generate",
    },
    {
      event: "model.invocation",
      provider: PROBE_PROVIDER_ID,
      model: PROBE_MODEL_ID,
      requestKind: "doStream",
      invocation: 1,
      sentinel: PROBE_STREAM_SENTINEL,
    },
    ...cleanupInputs().slice(expectedRegistrations.length),
  ]);
}

function withOrderingInterleaving(
  records: readonly ProbeTelemetryRecord[],
  beforeRequest: readonly TelemetryInput[] = [],
  afterRequest: readonly TelemetryInput[] = [],
): ProbeTelemetryRecord[] {
  const requestIndex = records.findIndex(
    (record) => record.event === "model.request" && record.requestKind === "generate",
  );
  const streamIndex = records.findIndex((record) => record.event === "model.invocation");
  if (requestIndex < 0 || streamIndex < 0) throw new Error("required ordering record was not found");
  return resequence([
    ...records.slice(0, requestIndex),
    ...beforeRequest.map(historyRecord),
    ...records.slice(requestIndex, streamIndex),
    ...afterRequest.map(historyRecord),
    ...records.slice(streamIndex),
  ]);
}

const durableSeed = [
  { id: "seed-1", role: "user", content: "first" },
  { id: "seed-2", role: "assistant", content: "second" },
] as const;
const successfulHostEvidence: HostGenerateCallEvidence = {
  callCount: 1,
  outcome: "success",
  returnedText: PROBE_STREAM_SENTINEL,
};

function evaluateHistory(
  options: {
    readonly records?: readonly ProbeTelemetryRecord[];
    readonly hostEvidence?: HostGenerateCallEvidence;
    readonly before?: unknown;
    readonly after?: unknown;
    readonly settled?: unknown;
  } = {},
) {
  return evaluateSessionGenerateHistory({
    mode: "session-generate-history",
    records: options.records ?? validSessionGenerateHistoryRecords(),
    hostEvidence: options.hostEvidence ?? successfulHostEvidence,
    externalBefore: options.before ?? durableSeed,
    externalAfter: options.after ?? durableSeed,
    externalSettledAfter: options.settled ?? options.after ?? durableSeed,
  });
}

describe("passive session.generate history evaluator", () => {
  test("accepts matching retained released-host ordering with stable history and complete cleanup", () => {
    const records = validSessionGenerateHistoryRecords();
    const before = durableSeed.map((message) => ({ ...message }));
    const after = durableSeed.map((message) => ({ ...message }));
    const settled = durableSeed.map((message) => ({ ...message }));
    const result = evaluateHistory({ records, before, after, settled });
    const generateExit = records.find((record) => record.event === "callback.exit" && record.operation === "generate")!;
    const generateRequest = records.find(
      (record) => record.event === "model.request" && record.requestKind === "generate",
    )!;
    const stream = records.find(hasEvent("model.invocation"))!;

    expect(result.passed).toBeTrue();
    expect(result.failures).toEqual([]);
    expect(generateRequest.seq).toBe(generateExit.seq + 1);
    expect(stream.seq).toBe(generateRequest.seq + 1);
    expect(successfulHostEvidence).toEqual({
      callCount: 1,
      outcome: "success",
      returnedText: PROBE_STREAM_SENTINEL,
    });
    expect(after).toEqual(before);
    expect(settled).toEqual(after);
    expect(records.filter(hasEvent("registration")).map((record) => record.name)).toEqual([...expectedRegistrations]);
    expect(records.filter(hasEvent("disposal"))).toHaveLength(expectedRegistrations.length);
    expect(result.evidence).toMatchObject({
      callbackCounts: { context: 1, generate: 1, compaction: 0 },
      callbackMaxDepth: { context: 1, generate: 1, compaction: 0 },
      modelRequests: 1,
      modelInvocations: 1,
      operationStarts: 0,
      operationSuccesses: 0,
      operationFailures: 0,
      operationTimeouts: 0,
      sentinelObserved: true,
      durableHistoryEffect: "unchanged",
      cleanup: { completed: true, missingRegistrations: [], missingDisposals: [], writerDisposed: true },
    });
  });

  test.each([
    [
      "model request",
      {
        event: "model.request",
        provider: "other-provider",
        model: "other-model",
        requestKind: "primary",
      } satisfies TelemetryInput,
    ],
    [
      "callback boundary",
      { event: "callback.enter", operation: "context", depth: 1, invocationCount: 2 } satisfies TelemetryInput,
    ],
  ] as const)("rejects an interposed %s after the generate callback exit", (_name, interposed) => {
    const records = validSessionGenerateHistoryRecords();
    const requestIndex = records.findIndex(
      (record) => record.event === "model.request" && record.requestKind === "generate",
    );
    const result = evaluateHistory({
      records: resequence([
        ...records.slice(0, requestIndex),
        historyRecord(interposed),
        ...records.slice(requestIndex),
      ]),
    });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(
      "generate model request was not the first non-event record after the successful generate callback exit",
    );
  });

  test("rejects a generate request before the generate callback exit", () => {
    const records = validSessionGenerateHistoryRecords();
    const requestIndex = records.findIndex(
      (record) => record.event === "model.request" && record.requestKind === "generate",
    );
    const exitIndex = records.findIndex(
      (record) => record.event === "callback.exit" && record.operation === "generate",
    );
    const request = records[requestIndex]!;
    const withoutRequest = records.filter((_, index) => index !== requestIndex);
    const moved = resequence([...withoutRequest.slice(0, exitIndex), request, ...withoutRequest.slice(exitIndex)]);
    const result = evaluateHistory({ records: moved });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(
      "generate model request was not the first non-event record after the successful generate callback exit",
    );
  });

  test.each([
    [
      "nonmatching stream",
      {
        event: "model.invocation",
        provider: PROBE_PROVIDER_ID,
        model: PROBE_MODEL_ID,
        requestKind: "doStream",
        invocation: 2,
        sentinel: "wrong-sentinel",
      } satisfies TelemetryInput,
      `exact ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID} deterministic stream invocation was not the first non-event record after the generate model request`,
    ],
    [
      "matching stream",
      {
        event: "model.invocation",
        provider: PROBE_PROVIDER_ID,
        model: PROBE_MODEL_ID,
        requestKind: "doStream",
        invocation: 2,
        sentinel: PROBE_STREAM_SENTINEL,
      } satisfies TelemetryInput,
      "observed 1 additional doStream invocation(s) before the next host boundary",
    ],
  ] as const)("rejects an interposed %s before the expected exact doStream", (_name, interposed, failure) => {
    const records = validSessionGenerateHistoryRecords();
    const streamIndex = records.findIndex(hasEvent("model.invocation"));
    const result = evaluateHistory({
      records: resequence([...records.slice(0, streamIndex), historyRecord(interposed), ...records.slice(streamIndex)]),
    });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(failure);
  });

  test.each([
    [
      "model.request",
      { event: "model.request", provider: "other-provider", model: "other-model", requestKind: "primary" },
    ],
    ["callback boundary", { event: "callback.enter", operation: "context", depth: 1, invocationCount: 2 }],
    [
      "model invocation",
      {
        event: "model.invocation",
        provider: PROBE_PROVIDER_ID,
        model: PROBE_MODEL_ID,
        requestKind: "doStream",
        invocation: 2,
        sentinel: PROBE_STREAM_SENTINEL,
      },
    ],
    ["operation lifecycle", { event: "operation.start", operation: "generate", operationId: "interposed" }],
    ["setup", { event: "setup", name: "interposed" }],
    ["registration", { event: "registration", name: "interposed" }],
    ["cleanup", { event: "cleanup", details: { phase: "start" } }],
    ["disposal", { event: "disposal", details: { resource: "interposed" } }],
    [
      "message snapshot",
      { event: "message.snapshot", boundary: "during", position: 1, role: "user", text: "interposed" },
    ],
    ["language-model", { event: "language-model", name: "interposed" }],
    ["provider", { event: "provider", name: "interposed" }],
  ] as const)("rejects a representative non-event record in each semantic interval: %s", (_name, interposed) => {
    const beforeRequest = evaluateHistory({
      records: withOrderingInterleaving(validSessionGenerateHistoryRecords(), [interposed]),
    });
    const afterRequest = evaluateHistory({
      records: withOrderingInterleaving(validSessionGenerateHistoryRecords(), [], [interposed]),
    });

    expect(beforeRequest.passed).toBeFalse();
    expect(beforeRequest.failures).toContain(
      "generate model request was not the first non-event record after the successful generate callback exit",
    );
    expect(afterRequest.passed).toBeFalse();
    if (_name === "model invocation") {
      expect(afterRequest.failures).toContain(
        "observed 1 additional doStream invocation(s) before the next host boundary",
      );
    } else {
      expect(afterRequest.failures).toContain(
        `exact ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID} deterministic stream invocation was not the first non-event record after the generate model request`,
      );
    }
  });

  test("accepts multiple event.observed records in both semantic intervals", () => {
    const records = withOrderingInterleaving(
      validSessionGenerateHistoryRecords(),
      [
        { event: "event.observed", observedEvent: "before-1" },
        { event: "event.observed", observedEvent: "before-2" },
      ],
      [
        { event: "event.observed", observedEvent: "after-1" },
        { event: "event.observed", observedEvent: "after-2" },
      ],
    );

    expect(evaluateHistory({ records }).passed).toBeTrue();
  });

  test("rejects a wrong non-event before a later valid stream", () => {
    const records = withOrderingInterleaving(
      validSessionGenerateHistoryRecords(),
      [],
      [{ event: "model.request", provider: "other-provider", model: "other-model", requestKind: "primary" }],
    );
    expect(evaluateHistory({ records }).failures).toContain(
      `exact ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID} deterministic stream invocation was not the first non-event record after the generate model request`,
    );
  });

  test.each(["missing request", "missing stream"] as const)("rejects event-only records with a %s", (missing) => {
    let records = withOrderingInterleaving(
      validSessionGenerateHistoryRecords(),
      [{ event: "event.observed", observedEvent: "before" }],
      [{ event: "event.observed", observedEvent: "after" }],
    );
    records = records.filter((record) =>
      missing === "missing request"
        ? !(record.event === "model.request" && record.requestKind === "generate")
        : record.event !== "model.invocation",
    );
    const result = evaluateHistory({ records: resequence(records) });

    expect(result.passed).toBeFalse();
    expect(result.failures.length).toBeGreaterThan(0);
  });

  test("rejects a delayed additional exact deterministic stream before the next host boundary", () => {
    const records = validSessionGenerateHistoryRecords();
    const streamIndex = records.findIndex(hasEvent("model.invocation"));
    const stream = records[streamIndex]!;
    const result = evaluateHistory({
      records: resequence([
        ...records.slice(0, streamIndex + 1),
        historyRecord({ event: "language-model", name: "unrelated.record" }),
        { ...stream, invocation: 2 } as ProbeTelemetryRecord,
        ...records.slice(streamIndex + 1),
      ]),
    });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("observed 1 additional doStream invocation(s) before the next host boundary");
  });

  test.each([
    ["wrong provider", { provider: "other-provider" }],
    ["wrong model", { model: "other-model" }],
    ["wrong sentinel", { sentinel: "wrong-sentinel" }],
  ] as const)("rejects a later doStream with a %s before the next host boundary", (_name, mutation) => {
    const records = validSessionGenerateHistoryRecords();
    const streamIndex = records.findIndex(hasEvent("model.invocation"));
    const stream = records[streamIndex]!;
    const result = evaluateHistory({
      records: resequence([
        ...records.slice(0, streamIndex + 1),
        historyRecord({ event: "language-model", name: "unrelated.record" }),
        { ...stream, ...mutation, invocation: 2 } as ProbeTelemetryRecord,
        ...records.slice(streamIndex + 1),
      ]),
    });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("observed 1 additional doStream invocation(s) before the next host boundary");
  });

  test("accepts a later exact deterministic stream after a new host request boundary", () => {
    const records = validSessionGenerateHistoryRecords();
    const streamIndex = records.findIndex(hasEvent("model.invocation"));
    const stream = records[streamIndex]!;
    const result = evaluateHistory({
      records: resequence([
        ...records.slice(0, streamIndex + 1),
        historyRecord({
          event: "model.request",
          provider: "other-provider",
          model: "other-model",
          requestKind: "primary",
        }),
        { ...stream, invocation: 2 } as ProbeTelemetryRecord,
        ...records.slice(streamIndex + 1),
      ]),
    });

    expect(result.passed).toBeTrue();
    expect(result.failures).toEqual([]);
    expect(result.evidence.modelInvocations).toBe(2);
  });

  test("rejects fabricated successful host evidence without a matching request or stream", () => {
    const records = validSessionGenerateHistoryRecords().filter(
      (record) => record.event !== "model.request" && record.event !== "model.invocation",
    );
    const result = evaluateHistory({ records: resequence(records), hostEvidence: successfulHostEvidence });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("expected exactly one generate model request, observed 0");
    expect(result.evidence.sentinelObserved).toBeFalse();
  });

  test("accepts one append-only durable message", () => {
    const after = [...durableSeed, { id: "new-1", role: "assistant", content: PROBE_STREAM_SENTINEL }];
    const result = evaluateHistory({ after, settled: after });

    expect(result.passed).toBeTrue();
    expect(result.failures).toEqual([]);
    expect(result.evidence.durableHistoryEffect).toBe("appended");
  });

  test.each([
    [
      "zero calls",
      { ...successfulHostEvidence, callCount: 0 },
      "expected exactly one direct host generate call, observed 0",
    ],
    [
      "two calls",
      { ...successfulHostEvidence, callCount: 2 },
      "expected exactly one direct host generate call, observed 2",
    ],
    [
      "failure",
      { ...successfulHostEvidence, outcome: "failure" as const },
      "direct host generate call outcome was failure, not success",
    ],
    [
      "timeout",
      { ...successfulHostEvidence, outcome: "timeout" as const },
      "direct host generate call outcome was timeout, not success",
    ],
    [
      "wrong sentinel",
      { ...successfulHostEvidence, returnedText: "wrong" },
      "direct host generate call did not return the exact deterministic stream sentinel",
    ],
    [
      "reported error",
      { ...successfulHostEvidence, error: "host error" },
      "direct host generate call reported an error",
    ],
  ] as const)("rejects host evidence with %s", (_name, hostEvidence, failure) => {
    expect(evaluateHistory({ hostEvidence }).failures).toContain(failure);
  });

  test.each([
    [
      "missing context callback",
      (records: readonly ProbeTelemetryRecord[]) =>
        records.filter(
          (record) =>
            !(
              (record.event === "callback.enter" || record.event === "callback.exit") &&
              record.operation === "context"
            ),
        ),
      "expected exactly one context callback enter, observed 0",
    ],
    [
      "missing generate callback",
      (records: readonly ProbeTelemetryRecord[]) =>
        records.filter(
          (record) =>
            !(
              (record.event === "callback.enter" || record.event === "callback.exit") &&
              record.operation === "generate"
            ),
        ),
      "expected exactly one generate callback enter, observed 0",
    ],
    [
      "missing context snapshot",
      (records: readonly ProbeTelemetryRecord[]) =>
        records.filter((record) => !(record.event === "message.snapshot" && record.seq === 9)),
      "context callback message snapshot was not observed inside its callback interval",
    ],
    [
      "missing generate snapshot",
      (records: readonly ProbeTelemetryRecord[]) =>
        records.filter((record) => !(record.event === "message.snapshot" && record.seq === 12)),
      "generate callback message snapshot was not observed inside its callback interval",
    ],
    [
      "nested callback",
      (records: readonly ProbeTelemetryRecord[]) =>
        records.map((record) =>
          record.event === "callback.enter" && record.operation === "generate" ? { ...record, depth: 2 } : record,
        ),
      "callback maximum depth exceeded one",
    ],
    [
      "missing model request",
      (records: readonly ProbeTelemetryRecord[]) => records.filter((record) => record.event !== "model.request"),
      "expected exactly one generate model request, observed 0",
    ],
    [
      "model drift",
      (records: readonly ProbeTelemetryRecord[]) =>
        records.map((record) => (record.event === "model.request" ? { ...record, model: "wrong-model" } : record)),
      `generate model request did not use ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID}`,
    ],
    [
      "missing interval stream",
      (records: readonly ProbeTelemetryRecord[]) => records.filter((record) => record.event !== "model.invocation"),
      `exact ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID} deterministic stream invocation was not the first non-event record after the generate model request`,
    ],
    [
      "wrong interval stream",
      (records: readonly ProbeTelemetryRecord[]) =>
        records.map((record) =>
          record.event === "model.invocation" ? { ...record, sentinel: "wrong-sentinel" } : record,
        ),
      `exact ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID} deterministic stream invocation was not the first non-event record after the generate model request`,
    ],
    [
      "callback failure",
      (records: readonly ProbeTelemetryRecord[]) =>
        records.map((record) =>
          record.event === "callback.exit" && record.operation === "generate"
            ? { ...record, outcome: "failure" as const, error: "failed" }
            : record,
        ),
      "a callback failed or timed out",
    ],
    [
      "callback timeout",
      (records: readonly ProbeTelemetryRecord[]) =>
        records.map((record) =>
          record.event === "callback.exit" && record.operation === "generate"
            ? { ...record, outcome: "timeout" as const, error: "timed out" }
            : record,
        ),
      "a callback failed or timed out",
    ],
  ] as const)("rejects %s", (_name, mutate, failure) => {
    const result = evaluateHistory({ records: resequence(mutate(validSessionGenerateHistoryRecords())) });
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(failure);
  });

  test("rejects duplicate generate requests even with multiple streams", () => {
    const records = validSessionGenerateHistoryRecords();
    const requestIndex = records.findIndex(hasEvent("model.request"));
    const streamIndex = records.findIndex(hasEvent("model.invocation"));
    const duplicated = resequence([
      ...records.slice(0, requestIndex + 1),
      { ...records[requestIndex]! },
      ...records.slice(requestIndex + 1, streamIndex + 1),
      { ...records[streamIndex]!, invocation: 2 } as ProbeTelemetryRecord,
      ...records.slice(streamIndex + 1),
    ]);
    const result = evaluateHistory({ records: duplicated });

    expect(result.failures).toContain("expected exactly one generate model request, observed 2");
    expect(result.passed).toBeFalse();
  });

  test.each(["plugin", "host"] as const)("rejects any %s operation lifecycle telemetry", (source) => {
    const records = resequence([
      ...validSessionGenerateHistoryRecords(),
      ...evaluatorRecords("session-generate-history", [
        { event: "operation.start", operation: "generate", operationId: `${source}-1`, source },
      ]),
    ]);
    const result = evaluateHistory({ records });

    expect(result.failures).toContain(
      "expected host evidence to be separate from telemetry, observed 1 operation records",
    );
    if (source === "plugin") {
      expect(result.failures).toContain("passive plugin emitted 1 plugin-triggered operation lifecycle records");
    }
  });

  test("rejects an unexpected compaction callback", () => {
    const records = resequence([
      ...validSessionGenerateHistoryRecords(),
      ...evaluatorRecords("session-generate-history", [
        { event: "callback.enter", operation: "compaction", depth: 1, invocationCount: 1 },
        { event: "callback.exit", operation: "compaction", depth: 1, invocationCount: 1, outcome: "success" },
      ]),
    ]);
    expect(evaluateHistory({ records }).failures).toContain("session generate history unexpectedly entered compaction");
  });

  test.each([
    ["empty baseline", [], durableSeed, durableSeed, "external before message history was empty"],
    [
      "missing ID",
      durableSeed,
      [{ role: "user", content: "first" }, durableSeed[1]],
      [{ role: "user", content: "first" }, durableSeed[1]],
      "external after message history has missing IDs at positions 0",
    ],
    [
      "duplicate ID",
      durableSeed,
      [durableSeed[0], { id: "seed-1", role: "assistant", content: "second" }],
      [durableSeed[0], { id: "seed-1", role: "assistant", content: "second" }],
      "external after message history has duplicate IDs: seed-1",
    ],
    ["removed seed", durableSeed, [durableSeed[0]], [durableSeed[0]], "external after history removed seeded messages"],
    [
      "replaced seed",
      durableSeed,
      [{ ...durableSeed[0], content: "changed" }, durableSeed[1]],
      [{ ...durableSeed[0], content: "changed" }, durableSeed[1]],
      "external after history changed, replaced, or reordered seed message at position 0",
    ],
    [
      "reordered seed",
      durableSeed,
      [durableSeed[1], durableSeed[0]],
      [durableSeed[1], durableSeed[0]],
      "external after history changed, replaced, or reordered seed message at position 0",
    ],
    [
      "reused seed ID",
      durableSeed,
      [...durableSeed, { id: "seed-1", role: "assistant", content: "again" }],
      [...durableSeed, { id: "seed-1", role: "assistant", content: "again" }],
      "external after appended message reused seed ID seed-1",
    ],
    [
      "late mutation",
      durableSeed,
      durableSeed,
      [...durableSeed, { id: "late-1", role: "assistant", content: "late" }],
      "external history mutated after the post-call observation; quiescence was not proven",
    ],
    ["unrecognized arrays", {}, {}, {}, "external before observation did not contain a recognized message array"],
    [
      "positional fallback",
      durableSeed,
      [
        { id: "replacement-1", role: "user", content: "first" },
        { id: "replacement-2", role: "assistant", content: "second" },
      ],
      [
        { id: "replacement-1", role: "user", content: "first" },
        { id: "replacement-2", role: "assistant", content: "second" },
      ],
      "external after history changed, replaced, or reordered seed message at position 0",
    ],
  ] as const)("rejects durable history with %s", (_name, before, after, settled, failure) => {
    const result = evaluateHistory({ before, after, settled });
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(failure);
    expect(result.evidence.durableHistoryEffect).toBeUndefined();
  });

  test("does not apply the durable ID gate to a synthetic generate callback snapshot", () => {
    const records = validSessionGenerateHistoryRecords({
      event: "message.snapshot",
      boundary: "during",
      position: 0,
      role: "user",
      text: "synthetic prompt without an ID",
    });
    const result = evaluateHistory({ records });

    expect(result.passed).toBeTrue();
    expect(result.evidence.durableHistoryEffect).toBe("unchanged");
  });
});

describe("operation source parser", () => {
  test.each(["host", "plugin"] as const)("accepts the optional %s source", (source) => {
    const record = evaluatorRecords("session-generate-history", [
      { event: "operation.start", operation: "generate", operationId: "generate-1", source },
    ])[0]!;
    expect(
      parseProbeTelemetryJsonl(JSON.stringify(record), {
        runId: record.runId,
        mode: "session-generate-history",
      }),
    ).toEqual([record]);
  });

  test("rejects an unknown operation source", () => {
    const record = {
      ...evaluatorRecords("session-generate-history", [
        { event: "operation.start", operation: "generate", operationId: "generate-1" },
      ])[0]!,
      source: "unknown",
    };
    expect(() =>
      parseProbeTelemetryJsonl(JSON.stringify(record), {
        runId: record.runId,
        mode: "session-generate-history",
      }),
    ).toThrow("source has unknown value unknown");
  });
});

function validOrdinaryRecords(): ProbeTelemetryRecord[] {
  return evaluatorRecords("ordinary", [
    ...expectedRegistrations.map((name): TelemetryInput => ({ event: "registration", name })),
    { event: "callback.enter", operation: "context", depth: 1, invocationCount: 1 },
    {
      event: "message.snapshot",
      boundary: "before",
      position: 0,
      id: "message-1",
      role: "user",
      text: "hello",
    },
    {
      event: "model.request",
      provider: PROBE_PROVIDER_ID,
      model: PROBE_MODEL_ID,
      requestKind: "primary",
    },
    {
      event: "model.invocation",
      provider: PROBE_PROVIDER_ID,
      model: PROBE_MODEL_ID,
      requestKind: "doStream",
      invocation: 1,
      sentinel: PROBE_STREAM_SENTINEL,
    },
    { event: "callback.exit", operation: "context", depth: 1, invocationCount: 1, outcome: "success" },
    ...cleanupInputs().slice(expectedRegistrations.length),
  ]);
}

function validCompactionRecords(): ProbeTelemetryRecord[] {
  return evaluatorRecords("compaction", [
    ...expectedRegistrations.map((name): TelemetryInput => ({ event: "registration", name })),
    { event: "callback.enter", operation: "compaction", depth: 1, invocationCount: 1 },
    { event: "event.observed", observedEvent: "session.compaction.started", details: { sessionID: "session-1" } },
    {
      event: "model.request",
      provider: PROBE_PROVIDER_ID,
      model: PROBE_MODEL_ID,
      requestKind: "compaction",
    },
    {
      event: "model.invocation",
      provider: PROBE_PROVIDER_ID,
      model: PROBE_MODEL_ID,
      requestKind: "doStream",
      invocation: 1,
      sentinel: PROBE_COMPACTION_SUMMARY,
    },
    { event: "event.observed", observedEvent: "session.compaction.ended", details: { sessionID: "session-1" } },
    { event: "callback.exit", operation: "compaction", depth: 1, invocationCount: 1, outcome: "success" },
    ...cleanupInputs().slice(expectedRegistrations.length),
  ]);
}

function evaluateSyntheticCompaction(records: readonly ProbeTelemetryRecord[]) {
  return evaluateCompaction({
    mode: "compaction",
    records,
    externalBefore: evaluatorHistory,
    externalAfter: [{ id: "message-1", role: "user", content: "compacted hello" }],
  });
}

describe("strict evaluator lifecycle coverage", () => {
  test("rejects compaction without a callback exit", () => {
    const records = validCompactionRecords().filter(
      (record) => !(record.event === "callback.exit" && record.operation === "compaction"),
    );
    const result = evaluateSyntheticCompaction(records);

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("expected exactly one compaction callback exit, observed 0");
  });

  test.each([
    ["enter", "callback.enter", "expected exactly one compaction callback enter, observed 2"],
    ["exit", "callback.exit", "expected exactly one compaction callback exit, observed 2"],
  ] as const)("rejects a duplicate compaction callback %s", (_name, event, failure) => {
    const records = duplicateFirstRecord(
      validCompactionRecords(),
      (record) => record.event === event && "operation" in record && record.operation === "compaction",
    );
    const result = evaluateSyntheticCompaction(records);

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(failure);
  });

  test.each([
    ["invocation count", "invocationCount", 2],
    ["depth", "depth", 2],
  ] as const)("rejects a compaction callback exit with mismatched %s", (_name, field, value) => {
    const records = validCompactionRecords().map((record) =>
      record.event === "callback.exit" && record.operation === "compaction"
        ? ({ ...record, [field]: value } as ProbeTelemetryRecord)
        : record,
    );
    const result = evaluateSyntheticCompaction(records);

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("compaction callback did not have one matching successful exit");
  });

  test("rejects a failed compaction callback exit", () => {
    const records = validCompactionRecords().map((record) =>
      record.event === "callback.exit" && record.operation === "compaction"
        ? ({ ...record, outcome: "failure", error: "compaction failed" } as ProbeTelemetryRecord)
        : record,
    );
    const result = evaluateSyntheticCompaction(records);

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("compaction callback did not have one matching successful exit");
    expect(result.failures).toContain("a callback failed or timed out");
  });

  test("rejects a duplicate cleanup registration", () => {
    const records = duplicateFirstRecord(
      validSessionGenerateHistoryRecords(),
      (record) => record.event === "registration" && record.name === "provider.transform",
    );
    const result = evaluateHistory({ records });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("expected exactly one provider.transform registration, observed 2");
    expect(result.failures).toContain("duplicate registrations: provider.transform");
  });

  test("rejects a duplicate cleanup disposal", () => {
    const records = duplicateFirstRecord(
      validSessionGenerateHistoryRecords(),
      (record) => record.event === "disposal" && record.details?.resource === "session.model.request",
    );
    const result = evaluateHistory({ records });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("duplicate registration disposals: session.model.request");
  });

  test("rejects cleanup registration disposal in the wrong order", () => {
    const records = validSessionGenerateHistoryRecords();
    const first = records.findIndex(
      (record) => record.event === "disposal" && record.details?.resource === "session.model.request",
    );
    const second = records.findIndex(
      (record) => record.event === "disposal" && record.details?.resource === "session.compaction",
    );
    const reordered = [...records];
    [reordered[first], reordered[second]] = [reordered[second]!, reordered[first]!];
    const result = evaluateHistory({ records: resequence(reordered) });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(
      "registration disposal order was not exactly session.model.request, session.compaction, session.generate, session.context, aisdk.language, provider.transform",
    );
  });

  test.each([
    [
      "cleanup start",
      (record: ProbeTelemetryRecord) => record.event === "cleanup" && record.details?.phase === "start",
      "expected exactly one cleanup start, observed 2",
    ],
    [
      "cleanup complete",
      (record: ProbeTelemetryRecord) => record.event === "cleanup" && record.details?.phase === "complete",
      "expected exactly one cleanup complete, observed 2",
    ],
    [
      "writer disposal",
      (record: ProbeTelemetryRecord) => record.event === "disposal" && record.details?.reason === "writer.dispose",
      "expected exactly one telemetry writer disposal, observed 2",
    ],
  ] as const)("rejects a duplicate %s", (_name, predicate, failure) => {
    const records = duplicateFirstRecord(validSessionGenerateHistoryRecords(), predicate);
    const result = evaluateHistory({ records });

    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(failure);
  });
});

function evaluateGeneration(
  mode: "session-generate" | "standalone-generate",
  records: readonly ProbeTelemetryRecord[],
  externalAfter: unknown = evaluatorHistory,
) {
  const input = {
    records,
    returnedText: PROBE_STREAM_SENTINEL,
    externalBefore: evaluatorHistory,
    externalAfter,
  } as const;
  return mode === "session-generate"
    ? evaluateSessionGenerate({ ...input, mode })
    : evaluateStandaloneGenerate({ ...input, mode });
}

describe("generation evaluator adversarial coverage", () => {
  test("accepts released-host session generation evidence", () => {
    const result = evaluateGeneration("session-generate", validGenerationRecords("session-generate"), [
      ...evaluatorHistory,
      { id: "message-2", role: "assistant", content: PROBE_STREAM_SENTINEL },
    ]);

    expect(result.passed).toBeTrue();
    expect(result.failures).toEqual([]);
    expect(result.evidence).toMatchObject({
      sentinelObserved: true,
      modelRequests: 1,
      modelInvocations: 1,
      operationStarts: 1,
      operationSuccesses: 1,
      callbackMaxDepth: { context: 1 },
      externalChanges: ["unchanged", "appended"],
      cleanup: { completed: true, missingRegistrations: [], missingDisposals: [], writerDisposed: true },
    });
  });

  test("accepts standalone generation from interval-correlated invocation evidence without a session request", () => {
    const records = validGenerationRecords("standalone-generate");
    expect(records.some((record) => record.event === "model.request" && record.requestKind === "generate")).toBeFalse();

    const result = evaluateGeneration("standalone-generate", records);
    expect(result.passed).toBeTrue();
    expect(result.evidence).toMatchObject({ sentinelObserved: true, modelRequests: 0, modelInvocations: 1 });
  });

  test("rejects generation without a context callback enter", () => {
    const records = validGenerationRecords("standalone-generate").filter(
      (record) => !(record.event === "callback.enter" && record.operation === "context"),
    );
    expect(evaluateGeneration("standalone-generate", records).failures).toContain(
      "context callback enter was not observed",
    );
  });

  test("rejects generation without a matching successful context callback exit", () => {
    const records = validGenerationRecords("standalone-generate").filter(
      (record) => !(record.event === "callback.exit" && record.operation === "context"),
    );
    expect(evaluateGeneration("standalone-generate", records).failures).toContain(
      "matching successful context callback exit was not observed",
    );
  });

  test("rejects generation without a message snapshot", () => {
    const records = validGenerationRecords("standalone-generate").filter(
      (record) => record.event !== "message.snapshot",
    );
    expect(evaluateGeneration("standalone-generate", records).failures).toContain(
      "message snapshot was not observed during the run",
    );
  });

  test("rejects ordinary evaluation with recognized but empty history", () => {
    const result = evaluateOrdinary({
      mode: "ordinary",
      records: validOrdinaryRecords(),
      observableOutput: PROBE_STREAM_SENTINEL,
      externalBefore: [],
      externalAfter: [],
    });
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("external after message history was empty");
  });

  test("rejects ordinary after-history without the stream sentinel", () => {
    const result = evaluateOrdinary({
      mode: "ordinary",
      records: validOrdinaryRecords(),
      observableOutput: PROBE_STREAM_SENTINEL,
      externalBefore: evaluatorHistory,
      externalAfter: [...evaluatorHistory, { id: "message-2", role: "assistant", content: "other output" }],
    });
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("external after message history did not contain the stream sentinel");
  });

  test("rejects session generation without an external history mutation", () => {
    const result = evaluateGeneration("session-generate", validGenerationRecords("session-generate"));
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("external history did not change during the session-generate run");
  });

  test("rejects session generation after-history without the stream sentinel", () => {
    const result = evaluateGeneration("session-generate", validGenerationRecords("session-generate"), [
      ...evaluatorHistory,
      { id: "message-2", role: "assistant", content: "other output" },
    ]);
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("external after message history did not contain the stream sentinel");
  });

  test("rejects standalone generation with empty after-history", () => {
    const result = evaluateGeneration("standalone-generate", validGenerationRecords("standalone-generate"), []);
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("external after message history was empty");
  });

  test("rejects a paired replacement that changes both ID and content conservatively", () => {
    const result = evaluateGeneration("standalone-generate", validGenerationRecords("standalone-generate"), [
      { id: "message-2", role: "user", content: "changed" },
    ]);
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("external history: changed or missing ID for replacement at position 0");
  });

  test("rejects doGenerate-only evidence", () => {
    const records = validGenerationRecords("standalone-generate").map((record) =>
      record.event === "model.invocation"
        ? { ...record, requestKind: "doGenerate" as const, sentinel: PROBE_GENERATE_SENTINEL }
        : record,
    );
    expect(evaluateGeneration("standalone-generate", records).failures).toContain(
      "expected exactly one deterministic stream invocation in the generate interval, observed 0",
    );
  });

  test("accepts released-host matching stream invocations outside the operation interval", () => {
    const records = validGenerationRecords("standalone-generate");
    const invocation = records.find(hasEvent("model.invocation"))!;
    const successIndex = records.findIndex((record) => record.event === "operation.success");
    const withOutsideInvocations = resequence([
      ...records.slice(0, successIndex + 1),
      { ...invocation, invocation: 2 },
      { ...invocation, invocation: 3 },
      ...records.slice(successIndex + 1),
    ]);

    const result = evaluateGeneration("standalone-generate", withOutsideInvocations);
    const inIntervalInvocations = withOutsideInvocations.filter(
      (record) =>
        record.event === "model.invocation" &&
        record.seq > withOutsideInvocations.find(hasEvent("operation.start"))!.seq &&
        record.seq < withOutsideInvocations.find(hasEvent("operation.success"))!.seq,
    );
    expect(result.passed).toBeTrue();
    expect(result.failures).toEqual([]);
    expect(inIntervalInvocations).toHaveLength(1);
    expect(result.evidence.modelInvocations).toBe(3);
  });

  test("rejects matching stream evidence found only outside the operation interval", () => {
    const records = validGenerationRecords("standalone-generate");
    const invocation = records.find(hasEvent("model.invocation"))!;
    const withoutInvocation = records.filter((record) => record !== invocation);
    const successIndex = withoutInvocation.findIndex((record) => record.event === "operation.success");
    const outsideOnly = resequence([
      ...withoutInvocation.slice(0, successIndex + 1),
      invocation,
      ...withoutInvocation.slice(successIndex + 1),
    ]);

    const result = evaluateGeneration("standalone-generate", outsideOnly);
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(
      "expected exactly one deterministic stream invocation in the generate interval, observed 0",
    );
    expect(result.failures).not.toContain(
      "a matching deterministic stream invocation was observed outside the generate operation interval",
    );
  });

  test("rejects multiple matching stream invocations inside the operation interval", () => {
    const records = validGenerationRecords("standalone-generate");
    const invocationIndex = records.findIndex(hasEvent("model.invocation"));
    const duplicated = resequence([
      ...records.slice(0, invocationIndex + 1),
      { ...records[invocationIndex]!, invocation: 2 } as ProbeTelemetryRecord,
      ...records.slice(invocationIndex + 1),
    ]);
    expect(evaluateGeneration("standalone-generate", duplicated).failures).toContain(
      "expected exactly one deterministic stream invocation in the generate interval, observed 2",
    );
  });

  test.each([
    ["provider", "wrong-provider"],
    ["model", "wrong-model"],
  ] as const)("rejects a stream invocation with the wrong %s", (field, value) => {
    const records = validGenerationRecords("standalone-generate").map((record) =>
      record.event === "model.invocation" ? { ...record, [field]: value } : record,
    );
    expect(evaluateGeneration("standalone-generate", records).passed).toBeFalse();
  });

  test("preserves recursion, history, and cleanup rejection gates", () => {
    const valid = validGenerationRecords("standalone-generate");
    const recursive = resequence([
      ...valid,
      evaluatorRecords("standalone-generate", [
        { event: "callback.enter", operation: "context", depth: 2, invocationCount: 2 },
      ])[0]!,
    ]);
    expect(evaluateGeneration("standalone-generate", recursive).failures).toContain(
      "standalone generation recursively entered the context callback",
    );

    expect(
      evaluateGeneration("standalone-generate", valid, [{ id: "changed", role: "user", content: "hello" }]).failures,
    ).toContain("external history: changed or missing ID at position 0");

    const missingCleanup = valid.filter(
      (record) => !(record.event === "cleanup" && record.details?.phase === "complete"),
    );
    expect(evaluateGeneration("standalone-generate", missingCleanup).failures).toContain(
      "expected exactly one cleanup complete, observed 0",
    );
  });

  test("retains compaction.failed details and fails without compaction.ended", () => {
    const failureDetails = {
      sessionID: "session-1",
      error: { name: "Error", message: "deterministic compaction failure", stack: "fixture stack" },
      request: { provider: PROBE_PROVIDER_ID, model: PROBE_MODEL_ID },
    };
    const records = evaluatorRecords("compaction", [
      { event: "callback.enter", operation: "compaction", depth: 1, invocationCount: 1 },
      { event: "event.observed", observedEvent: "session.compaction.started", details: { sessionID: "session-1" } },
      { event: "event.observed", observedEvent: "session.compaction.failed", details: failureDetails },
      { event: "callback.exit", operation: "compaction", depth: 1, invocationCount: 1, outcome: "success" },
      ...cleanupInputs(),
    ]);
    const failed = records.find(
      (record) => record.event === "event.observed" && record.observedEvent === "session.compaction.failed",
    );
    expect(failed).toMatchObject({ details: failureDetails });

    const result = evaluateCompaction({
      mode: "compaction",
      records,
      externalBefore: evaluatorHistory,
      externalAfter: [],
    });
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain("durable compaction ended event was not observed");
    expect(result.failures).toContain("durable compaction failed event was observed");
  });

  test("evaluator accepts complete synthetic compaction evidence", () => {
    const result = evaluateCompaction({
      mode: "compaction",
      records: validCompactionRecords(),
      externalBefore: evaluatorHistory,
      externalAfter: [{ id: "message-1", role: "user", content: "compacted hello" }],
    });
    expect(result.passed).toBeTrue();
    expect(result.failures).toEqual([]);
    expect(result.evidence).toMatchObject({
      callbackCounts: { compaction: 1 },
      modelRequests: 1,
      modelInvocations: 1,
      durableEvents: ["session.compaction.started", "session.compaction.ended"],
      externalChanges: ["replaced"],
      cleanup: { completed: true, missingRegistrations: [], missingDisposals: [], writerDisposed: true },
    });
  });

  test("rejects missing and wrong compaction model requests", () => {
    const valid = validCompactionRecords();
    const missing = valid.filter((record) => record.event !== "model.request");
    expect(
      evaluateCompaction({
        mode: "compaction",
        records: missing,
        externalBefore: evaluatorHistory,
        externalAfter: [{ id: "message-1", role: "user", content: "compacted hello" }],
      }).failures,
    ).toContain("expected exactly one compaction model request, observed 0");

    const wrong = valid.map((record) =>
      record.event === "model.request" ? { ...record, model: "wrong-model" } : record,
    );
    expect(
      evaluateCompaction({
        mode: "compaction",
        records: wrong,
        externalBefore: evaluatorHistory,
        externalAfter: [{ id: "message-1", role: "user", content: "compacted hello" }],
      }).failures,
    ).toContain(`compaction model request did not use ${PROBE_PROVIDER_ID}/${PROBE_MODEL_ID}`);
  });

  test("rejects compaction without an exact summary stream in the request-to-ended interval", () => {
    const records = validCompactionRecords().filter((record) => record.event !== "model.invocation");
    const result = evaluateCompaction({
      mode: "compaction",
      records,
      externalBefore: evaluatorHistory,
      externalAfter: [{ id: "message-1", role: "user", content: "compacted hello" }],
    });
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(
      "exact compaction summary stream invocation was not observed between request and durable end",
    );
  });

  test("rejects a non-compaction stream sentinel in the request-to-ended interval", () => {
    const records = validCompactionRecords().map((record) =>
      record.event === "model.invocation" ? { ...record, sentinel: PROBE_STREAM_SENTINEL } : record,
    );
    const result = evaluateCompaction({
      mode: "compaction",
      records,
      externalBefore: evaluatorHistory,
      externalAfter: [{ id: "message-1", role: "user", content: "compacted hello" }],
    });
    expect(result.passed).toBeFalse();
    expect(result.failures).toContain(
      "deterministic stream invocation used a non-compaction sentinel between request and durable end",
    );
  });
});

describe("V2 deterministic provider and model", () => {
  test("registers exact inventory/order/scope and replaces only its model", async () => {
    const harness = await makeHarness("ordinary");
    try {
      expect(harness.registrations).toEqual([
        "provider.transform",
        "aisdk.language",
        "session.context",
        "session.generate",
        "session.compaction",
        "session.model.request",
      ]);
      expect(harness.languageScope()).toEqual({ providerID: PROBE_PROVIDER_ID });
      expect(harness.addedProviders).toHaveLength(1);
      expect(String(harness.addedProviders[0]?.info.id)).toBe(PROBE_PROVIDER_ID);
      expect(harness.addedProviders[0]?.models.map((model) => String(model.id))).toEqual([PROBE_MODEL_ID]);

      const matching: LanguageInput = {
        model: harness.addedProviders[0]!.models[0]!,
        sdk: {},
        options: {},
      };
      await harness.languageCallback()(matching);
      expect(matching.language).toMatchObject({
        specificationVersion: "v3",
        provider: PROBE_PROVIDER_ID,
        modelId: PROBE_MODEL_ID,
        supportedUrls: {},
      });

      const otherProvider = Provider.Info.empty(Provider.ID.make("other"));
      const untouched: LanguageInput = {
        model: Model.Info.default(otherProvider.id, Model.ID.make(PROBE_MODEL_ID)),
        sdk: {},
        options: {},
      };
      await harness.languageCallback()(untouched);
      expect(untouched.language).toBeUndefined();

      const otherModel: LanguageInput = {
        model: Model.Info.default(harness.addedProviders[0]!.info.id, Model.ID.make("other-model")),
        sdk: {},
        options: {},
      };
      await harness.languageCallback()(otherModel);
      expect(otherModel.language).toBeUndefined();
    } finally {
      await harness.cleanup();
      harness.restoreEnvironment();
    }
    expect(harness.eventStarted()).toBeTrue();
    expect(harness.eventAborted()).toBeTrue();
    const records = await telemetry(harness.path);
    expect(records.filter(hasEvent("registration")).map((record) => record.name)).toEqual([
      "provider.transform",
      "aisdk.language",
      "session.context",
      "session.generate",
      "session.compaction",
      "session.model.request",
      "event.subscribe",
    ]);
  });

  test("returns complete deterministic V3 generate and stream results with invocation telemetry", async () => {
    const harness = await makeHarness("ordinary");
    try {
      const input: LanguageInput = {
        model: harness.addedProviders[0]!.models[0]!,
        sdk: {},
        options: {},
      };
      await harness.languageCallback()(input);
      const language = input.language!;
      const generated = await language.doGenerate(modelCall);
      expect(generated).toEqual({
        content: [{ type: "text", text: PROBE_GENERATE_SENTINEL }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      });
      const streamed = await language.doStream(modelCall);
      const parts: LanguageModelV3StreamPart[] = [];
      for await (const part of streamed.stream) parts.push(part);
      expect(parts).toEqual([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "stm-probe-text-2" },
        { type: "text-delta", id: "stm-probe-text-2", delta: "STM_PROBE_STREAM_SENTINEL" },
        { type: "text-end", id: "stm-probe-text-2" },
        {
          type: "finish",
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          finishReason: { unified: "stop", raw: "stop" },
        },
      ]);
    } finally {
      await harness.cleanup();
      harness.restoreEnvironment();
    }
    const records = await telemetry(harness.path);
    assertTelemetry(records, harness.runId, "ordinary");
    expect(records.filter((record) => record.event === "model.invocation")).toEqual([
      expect.objectContaining({
        requestKind: "doGenerate",
        invocation: 1,
        sentinel: PROBE_GENERATE_SENTINEL,
      }),
      expect.objectContaining({
        requestKind: "doStream",
        invocation: 2,
        sentinel: "STM_PROBE_STREAM_SENTINEL",
      }),
    ]);
  });

  test("returns the exact continuation summary for complete standardized compaction prompts", async () => {
    const harness = await makeHarness("ordinary");
    try {
      const input: LanguageInput = {
        model: harness.addedProviders[0]!.models[0]!,
        sdk: {},
        options: {},
      };
      await harness.languageCallback()(input);
      const language = input.language!;
      expect(await language.doGenerate(compactionCall)).toEqual({
        content: [{ type: "text", text: PROBE_COMPACTION_SUMMARY }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      });

      const streamed = await language.doStream(compactionCall);
      const parts: LanguageModelV3StreamPart[] = [];
      for await (const part of streamed.stream) parts.push(part);
      expect(parts).toEqual([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "stm-probe-text-2" },
        { type: "text-delta", id: "stm-probe-text-2", delta: PROBE_COMPACTION_SUMMARY },
        { type: "text-end", id: "stm-probe-text-2" },
        {
          type: "finish",
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          finishReason: { unified: "stop", raw: "stop" },
        },
      ]);
    } finally {
      await harness.cleanup();
      harness.restoreEnvironment();
    }

    const records = await telemetry(harness.path);
    expect(records.filter(hasEvent("model.invocation"))).toEqual([
      expect.objectContaining({
        requestKind: "doGenerate",
        invocation: 1,
        sentinel: PROBE_COMPACTION_SUMMARY,
      }),
      expect.objectContaining({
        requestKind: "doStream",
        invocation: 2,
        sentinel: PROBE_COMPACTION_SUMMARY,
      }),
    ]);
  });

  test("fails closed to ordinary sentinels when a compaction prompt is missing a required heading", async () => {
    const harness = await makeHarness("ordinary");
    try {
      const input: LanguageInput = {
        model: harness.addedProviders[0]!.models[0]!,
        sdk: {},
        options: {},
      };
      await harness.languageCallback()(input);
      const language = input.language!;
      const generated = await language.doGenerate(incompleteCompactionCall);
      expect(generated.content).toEqual([{ type: "text", text: PROBE_GENERATE_SENTINEL }]);

      const streamed = await language.doStream(incompleteCompactionCall);
      const parts: LanguageModelV3StreamPart[] = [];
      for await (const part of streamed.stream) parts.push(part);
      expect(parts.find((part) => part.type === "text-delta")).toEqual({
        type: "text-delta",
        id: "stm-probe-text-2",
        delta: PROBE_STREAM_SENTINEL,
      });
    } finally {
      await harness.cleanup();
      harness.restoreEnvironment();
    }

    const records = await telemetry(harness.path);
    expect(records.filter(hasEvent("model.invocation")).map((record) => record.sentinel)).toEqual([
      PROBE_GENERATE_SENTINEL,
      PROBE_STREAM_SENTINEL,
    ]);
  });
});

describe("callbacks and generation modes", () => {
  test("session-generate-history observes callbacks without initiating generation", async () => {
    const harness = await makeHarness("session-generate-history");
    try {
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }];
      await harness.sessionCallbacks.get("context")!(callbackInput("history-session", messages));
      await harness.sessionCallbacks.get("generate")!(callbackInput("history-session", messages));

      expect(harness.sessionGenerateInputs).toEqual([]);
      expect(harness.standaloneGenerateInputs).toEqual([]);
    } finally {
      await harness.cleanup();
      harness.restoreEnvironment();
    }

    const records = await telemetry(harness.path);
    assertTelemetry(records, harness.runId, "session-generate-history");
    expect(records.filter(hasEvent("message.snapshot"))).toHaveLength(2);
    expect(
      records.filter((record) =>
        ["operation.start", "operation.success", "operation.failure", "operation.timeout"].includes(record.event),
      ),
    ).toEqual([]);
    expect(
      records.flatMap((record) =>
        record.event === "callback.enter" || record.event === "callback.exit"
          ? [{ event: record.event, operation: record.operation, outcome: record.outcome }]
          : [],
      ),
    ).toEqual([
      { event: "callback.enter", operation: "context", outcome: undefined },
      { event: "callback.exit", operation: "context", outcome: "success" },
      { event: "callback.enter", operation: "generate", outcome: undefined },
      { event: "callback.exit", operation: "generate", outcome: "success" },
    ]);
  });

  test.each(["ordinary", "compaction"] as const)("%s mode never triggers generation", async (mode) => {
    const harness = await makeHarness(mode);
    try {
      await harness.sessionCallbacks.get("context")!(
        callbackInput("ordinary-session", [{ id: "m1", role: "user", content: "hi" }]),
      );
      if (mode === "compaction") {
        await harness.sessionCallbacks.get("compaction")!(callbackInput("ordinary-session", []));
      }
      expect(harness.sessionGenerateInputs).toEqual([]);
      expect(harness.standaloneGenerateInputs).toEqual([]);
    } finally {
      await harness.cleanup();
      harness.restoreEnvironment();
    }
  });

  test.each([
    ["session-generate", "SESSION_RUN_SENTINEL"],
    ["standalone-generate", "STANDALONE_RUN_SENTINEL"],
  ] as const)("%s triggers once and records callback/model request semantics", async (mode, resultSentinel) => {
    const harness = await makeHarness(mode);
    try {
      const contextCallback = harness.sessionCallbacks.get("context")!;
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }];
      await contextCallback(callbackInput("current-session", messages));
      await contextCallback(callbackInput("current-session", messages));
      await harness.sessionCallbacks.get("generate")!(callbackInput("current-session", messages));
      await harness.sessionCallbacks.get("compaction")!(callbackInput("current-session", messages));
      await harness.sessionCallbacks.get("model.request")!({
        kind: "generate",
        model: { providerID: "host-provider", id: "host-model" },
      });

      if (mode === "session-generate") {
        expect(harness.sessionGenerateInputs).toEqual([
          {
            sessionID: "current-session",
            prompt: `${PROBE_SESSION_PROMPT_SENTINEL}:${harness.runId}`,
          },
        ]);
        expect(harness.standaloneGenerateInputs).toEqual([]);
      } else {
        expect(harness.sessionGenerateInputs).toEqual([]);
        expect(harness.standaloneGenerateInputs).toEqual([
          {
            prompt: `${PROBE_STANDALONE_PROMPT_SENTINEL}:${harness.runId}`,
            model: { providerID: PROBE_PROVIDER_ID, id: PROBE_MODEL_ID },
          },
        ]);
      }
    } finally {
      await harness.cleanup();
      harness.restoreEnvironment();
    }

    const records = await telemetry(harness.path);
    assertTelemetry(records, harness.runId, mode);
    expect(records.filter((record) => record.event === "operation.start")).toHaveLength(1);
    expect(records.filter((record) => record.event === "operation.success")).toHaveLength(1);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "language-model",
        name: "operation.result",
        details: expect.objectContaining({ text: resultSentinel }),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "model.request",
        requestKind: "generate",
        provider: "host-provider",
        model: "host-model",
      }),
    );
    expect(records.filter((record) => record.event === "message.snapshot")).toHaveLength(4);
    expect(
      records
        .filter(
          (record) =>
            record.event === "callback.enter" ||
            record.event === "message.snapshot" ||
            record.event === "operation.start" ||
            record.event === "operation.success" ||
            (record.event === "language-model" && record.name === "operation.result") ||
            record.event === "callback.exit",
        )
        .slice(0, 6)
        .map((record) => record.event),
    ).toEqual([
      "callback.enter",
      "message.snapshot",
      "operation.start",
      "language-model",
      "operation.success",
      "callback.exit",
    ]);
    expect(
      records
        .filter((record) => record.event === "callback.enter" || record.event === "callback.exit")
        .map((record) => ({
          event: record.event,
          operation: "operation" in record ? record.operation : undefined,
          depth: "depth" in record ? record.depth : undefined,
          invocationCount: "invocationCount" in record ? record.invocationCount : undefined,
        })),
    ).toEqual([
      { event: "callback.enter", operation: "context", depth: 1, invocationCount: 1 },
      { event: "callback.exit", operation: "context", depth: 1, invocationCount: 1 },
      { event: "callback.enter", operation: "context", depth: 1, invocationCount: 2 },
      { event: "callback.exit", operation: "context", depth: 1, invocationCount: 2 },
      { event: "callback.enter", operation: "generate", depth: 1, invocationCount: 1 },
      { event: "callback.exit", operation: "generate", depth: 1, invocationCount: 1 },
      { event: "callback.enter", operation: "compaction", depth: 1, invocationCount: 1 },
      { event: "callback.exit", operation: "compaction", depth: 1, invocationCount: 1 },
    ]);
  });

  test("a nested context callback does not retrigger session generation", async () => {
    let nestedContext: HookCallback | undefined;
    const harness = await makeHarness("session-generate", {
      sessionGenerate: async () => {
        await nestedContext!(callbackInput("nested-session"));
        return { text: "NESTED_RUN_SENTINEL" };
      },
    });
    nestedContext = harness.sessionCallbacks.get("context")!;
    try {
      await nestedContext(callbackInput("outer-session"));
      expect(harness.sessionGenerateInputs).toHaveLength(1);
    } finally {
      await harness.cleanup();
      harness.restoreEnvironment();
    }
    const records = await telemetry(harness.path);
    expect(
      records
        .filter(hasEvent("callback.enter"))
        .filter((record) => record.operation === "context")
        .map((record) => ({ depth: record.depth, invocationCount: record.invocationCount })),
    ).toEqual([
      { depth: 1, invocationCount: 1 },
      { depth: 2, invocationCount: 2 },
    ]);
    expect(records.filter((record) => record.event === "operation.start")).toHaveLength(1);
  });

  test("generation rejection is recorded and rethrown exactly", async () => {
    const failure = new Error("deterministic rejection");
    const harness = await makeHarness("session-generate", { sessionGenerate: () => Promise.reject(failure) });
    try {
      await expect(harness.sessionCallbacks.get("context")!(callbackInput())).rejects.toBe(failure);
    } finally {
      await harness.cleanup();
      harness.restoreEnvironment();
    }
    const records = await telemetry(harness.path);
    expect(records).toContainEqual(
      expect.objectContaining({ event: "operation.failure", error: "Error: deterministic rejection" }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "callback.exit",
        operation: "context",
        outcome: "failure",
        depth: 1,
        invocationCount: 1,
      }),
    );
  });
});

describe("cleanup", () => {
  test("is idempotent, aborts event consumption, and disposes once in reverse order", async () => {
    const harness = await makeHarness("ordinary");
    const first = harness.cleanup();
    const second = harness.cleanup();
    expect(second).toBe(first);
    await first;
    harness.restoreEnvironment();
    expect(harness.eventAborted()).toBeTrue();
    expect(harness.disposals).toEqual([
      "session.model.request",
      "session.compaction",
      "session.generate",
      "session.context",
      "aisdk.language",
      "provider.transform",
    ]);
    const records = await telemetry(harness.path);
    expect(records.filter(hasEvent("cleanup")).map((record) => record.details?.phase)).toEqual(["start", "complete"]);
    expect(
      records.filter(hasEvent("cleanup")).find((record) => record.details?.phase === "complete")?.details,
    ).toMatchObject({
      callbacks: {
        context: { count: 0, depth: 0, maxDepth: 0 },
        generate: { count: 0, depth: 0, maxDepth: 0 },
        compaction: { count: 0, depth: 0, maxDepth: 0 },
      },
    });
    expect(records.filter(hasEvent("disposal")).map((record) => record.details?.resource)).toEqual([
      "session.model.request",
      "session.compaction",
      "session.generate",
      "session.context",
      "aisdk.language",
      "provider.transform",
      undefined,
    ]);
  });

  test("preserves a null cleanup rejection while continuing reverse disposal", async () => {
    const harness = await makeHarness("ordinary", {
      disposalFailure: { name: "session.compaction", value: null },
    });
    let rejected: unknown = Symbol("not rejected");
    try {
      await harness.cleanup();
    } catch (error) {
      rejected = error;
    } finally {
      harness.restoreEnvironment();
    }
    expect(rejected).toBeNull();
    expect(harness.disposals).toEqual([
      "session.model.request",
      "session.compaction",
      "session.generate",
      "session.context",
      "aisdk.language",
      "provider.transform",
    ]);
  });
});

describe("message snapshots", () => {
  test("normalizes text and accepts unchanged and appended stable IDs", () => {
    const before = normalizeV2Messages([{ id: "a", role: "user", parts: [{ text: "one" }, { text: " two" }] }]);
    const after = normalizeV2Messages([
      { id: "a", role: "user", content: "one two" },
      { id: "b", role: "assistant", content: [{ text: "reply" }] },
    ]);
    expect(before).toEqual([{ position: 0, id: "a", role: "user", text: "one two" }]);
    expect(compareOrderedMessageSnapshots(before, after)).toEqual({
      valid: true,
      changes: ["unchanged", "appended"],
      reasons: [],
    });
  });

  test("rejects missing and duplicate IDs in both snapshots", () => {
    const before = normalizeV2Messages([
      { role: "user", content: "missing before" },
      { id: "dup-before", role: "user", content: "a" },
      { id: "dup-before", role: "assistant", content: "b" },
    ]);
    const after = normalizeV2Messages([
      { role: "user", content: "missing after" },
      { id: "dup-after", role: "user", content: "a" },
      { id: "dup-after", role: "assistant", content: "b" },
    ]);
    expect(compareOrderedMessageSnapshots(before, after).reasons).toEqual([
      "missing message ID in before at position 0",
      "duplicate message ID in before: dup-before at positions 1, 2",
      "missing message ID in after at position 0",
      "duplicate message ID in after: dup-after at positions 1, 2",
      "changed or missing ID at position 1",
      "changed or missing ID at position 2",
    ]);
  });

  test("rejects a changed ID for stable content and classifies replacement/removal deterministically", () => {
    const changedId = compareOrderedMessageSnapshots(
      normalizeV2Messages([{ id: "old", role: "user", content: "same" }]),
      normalizeV2Messages([{ id: "new", role: "user", content: "same" }]),
    );
    expect(changedId).toEqual({
      valid: false,
      changes: ["unchanged"],
      reasons: ["changed or missing ID at position 0"],
    });
    expect(
      compareOrderedMessageSnapshots(
        normalizeV2Messages([
          { id: "a", role: "user", content: "old" },
          { id: "removed", role: "assistant", content: "gone" },
        ]),
        normalizeV2Messages([{ id: "a", role: "user", content: "new" }]),
      ),
    ).toEqual({ valid: true, changes: ["replaced", "removed"], reasons: [] });
  });
});

test("setup failure performs best-effort reverse cleanup and preserves the original error", async () => {
  const original = new Error("registration failed: session.generate");
  const setupDisposals: string[] = [];
  let failure: unknown;
  try {
    await makeHarness("ordinary", {
      registrationFailure: { name: "session.generate", value: original },
      disposalFailure: { name: "session.context", value: new Error("cleanup must not win") },
      onDispose: (name) => setupDisposals.push(name),
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBe(original);
  expect(setupDisposals).toEqual(["session.context", "aisdk.language", "provider.transform"]);
});
