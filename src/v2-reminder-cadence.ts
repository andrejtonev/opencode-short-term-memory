import { readRawFile, resetBoundaryPathFor } from "./memory-utils";
import { getV2MemoryReadRevision, isV2MemorySessionDeleted } from "./v2-mutation-coordination";
import { parseV2ResetBoundary } from "./v2-reset-boundary";
import type { V2Context, V2SessionContext } from "./v2-adapter";
import { readV2CurrentHistory } from "./v2-current-history";

const MAX_SESSION_STATES = 256;
const MAX_IDS = 4096;

export type V2InjectionTransport = "system" | "message";

type SessionState = {
  candidates: Set<string>;
  counted: Set<string>;
  count: number;
  boundaryKey?: string;
  transport?: V2InjectionTransport;
  latestCandidate?: string;
  latestEligible: boolean;
  eligibilityByID: Map<string, boolean>;
};

type BoundaryResult =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly anchorID: string | null }
  | { readonly kind: "invalid" };

function boundaryKey(boundary: BoundaryResult): string {
  if (boundary.kind === "missing") return "missing";
  if (boundary.kind === "invalid") return "invalid";
  return boundary.anchorID === null ? "empty" : `anchor:${boundary.anchorID}`;
}

function idOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; messageID?: unknown };
  const id = record.id ?? record.messageID;
  return typeof id === "string" && id ? id : undefined;
}

function isUser(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { role?: unknown }).role === "user");
}

export function createV2ReminderCadence(context: V2Context, directory: string) {
  const states = new Map<string, SessionState>();
  let disposed = false;

  function stateFor(sessionID: string): SessionState {
    let state = states.get(sessionID);
    if (!state) {
      if (states.size >= MAX_SESSION_STATES) states.delete(states.keys().next().value as string);
      state = {
        candidates: new Set(),
        counted: new Set(),
        count: 0,
        boundaryKey: "missing",
        latestEligible: false,
        eligibilityByID: new Map(),
      };
      states.set(sessionID, state);
    }
    return state;
  }

  function boundedAdd(set: Set<string>, id: string): void {
    if (set.size >= MAX_IDS) set.delete(set.values().next().value as string);
    set.add(id);
  }

  function resetCadence(state: SessionState, nextBoundaryKey: string, preserveCandidates: Iterable<string> = []): void {
    state.boundaryKey = nextBoundaryKey;
    state.candidates.clear();
    state.counted.clear();
    state.count = 0;
    state.latestCandidate = undefined;
    state.latestEligible = false;
    state.eligibilityByID.clear();
    for (const id of preserveCandidates) boundedAdd(state.candidates, id);
  }

  function selectTransport(
    sessionID: string,
    transport: V2InjectionTransport,
    currentMessages: readonly unknown[] = [],
  ): void {
    if (disposed || !sessionID || isV2MemorySessionDeleted(directory, sessionID)) return;
    const state = stateFor(sessionID);
    if (state.transport === transport) return;
    if (state.transport !== undefined) {
      const currentIDs = new Set(currentMessages.map(idOf).filter((id): id is string => id !== undefined));
      const preserve = [...state.candidates].filter((id) => currentIDs.has(id));
      resetCadence(state, state.boundaryKey ?? "missing", preserve);
    }
    state.transport = transport;
  }

  function record(input: { sessionID: string; messageID: string }): void {
    if (disposed) return;
    if (isV2MemorySessionDeleted(directory, input.sessionID)) {
      states.delete(input.sessionID);
      return;
    }
    if (!input.sessionID || !input.messageID) return;
    const state = stateFor(input.sessionID);
    if (state.counted.has(input.messageID)) return;
    boundedAdd(state.candidates, input.messageID);
  }

  async function boundaryFor(sessionID: string, memoryDir: string): Promise<BoundaryResult> {
    const raw = await readRawFile(resetBoundaryPathFor(sessionID, memoryDir));
    if (raw === null) return { kind: "missing" };
    try {
      return { kind: "valid", anchorID: parseV2ResetBoundary(raw).anchorID };
    } catch {
      return { kind: "invalid" };
    }
  }

  async function shouldInject(input: V2SessionContext, remindEveryN: number, memoryDir: string): Promise<boolean> {
    if (disposed) return false;
    const revision = getV2MemoryReadRevision(directory, input.sessionID);
    if (isV2MemorySessionDeleted(directory, input.sessionID)) {
      states.delete(input.sessionID);
      return false;
    }
    const state = stateFor(input.sessionID);
    const boundary = await boundaryFor(input.sessionID, memoryDir);
    if (disposed || getV2MemoryReadRevision(directory, input.sessionID) !== revision) return false;
    if (isV2MemorySessionDeleted(directory, input.sessionID)) {
      states.delete(input.sessionID);
      return false;
    }
    if (boundary.kind === "invalid") return false;
    let messages = input.messages as readonly unknown[];
    if (boundary.kind === "valid" && boundary.anchorID !== null) {
      // Reset anchors belong to durable history, not the model-facing projection
      // (which omits idle/agent-switch records and may change other record roles).
      const current = await readV2CurrentHistory(context, input.sessionID, 5_000, input.model);
      if (
        disposed ||
        isV2MemorySessionDeleted(directory, input.sessionID) ||
        getV2MemoryReadRevision(directory, input.sessionID) !== revision
      )
        return false;
      if (current.status !== "ready") return false;
      const indices = current.history.messages.flatMap((message, index) =>
        message.id === boundary.anchorID ? [index] : [],
      );
      if (indices.length !== 1) return false;
      const eligibleIDs = new Set(
        current.history.messages
          .slice(indices[0]! + 1)
          .filter(isUser)
          .map(idOf),
      );
      messages = messages.filter((message) => eligibleIDs.has(idOf(message)));
    }
    const nextBoundaryKey = boundaryKey(boundary);
    if (nextBoundaryKey !== state.boundaryKey) {
      const preserve = messages.map(idOf).filter((id): id is string => id !== undefined && state.candidates.has(id));
      resetCadence(state, nextBoundaryKey, preserve);
    }

    for (const message of messages) {
      const id = idOf(message);
      if (!id || !isUser(message) || !state.candidates.has(id) || state.counted.has(id)) continue;
      state.candidates.delete(id);
      boundedAdd(state.counted, id);
      state.count += 1;
      state.latestCandidate = id;
      state.latestEligible = state.count % Math.max(1, Math.trunc(remindEveryN || 1)) === 0;
      if (state.eligibilityByID.size >= MAX_IDS) {
        state.eligibilityByID.delete(state.eligibilityByID.keys().next().value as string);
      }
      state.eligibilityByID.set(id, state.latestEligible);
    }
    let selectedEligibility: boolean | undefined;
    for (const message of messages) {
      const id = idOf(message);
      const eligibility = id === undefined ? undefined : state.eligibilityByID.get(id);
      if (eligibility !== undefined) selectedEligibility = eligibility;
    }
    return selectedEligibility ?? false;
  }

  async function shouldInjectPrompt(
    input: { readonly sessionID: string; readonly messageID: string },
    remindEveryN: number,
    memoryDir: string,
  ): Promise<boolean> {
    if (disposed || !input.sessionID || !input.messageID) return false;
    const revision = getV2MemoryReadRevision(directory, input.sessionID);
    if (isV2MemorySessionDeleted(directory, input.sessionID)) {
      states.delete(input.sessionID);
      return false;
    }
    const state = stateFor(input.sessionID);
    const boundary = await boundaryFor(input.sessionID, memoryDir);
    if (
      disposed ||
      isV2MemorySessionDeleted(directory, input.sessionID) ||
      getV2MemoryReadRevision(directory, input.sessionID) !== revision ||
      boundary.kind === "invalid"
    )
      return false;
    if (boundary.kind === "valid" && boundary.anchorID !== null) {
      const current = await readV2CurrentHistory(context, input.sessionID, 5_000);
      if (
        disposed ||
        isV2MemorySessionDeleted(directory, input.sessionID) ||
        getV2MemoryReadRevision(directory, input.sessionID) !== revision
      )
        return false;
      if (
        current.status !== "ready" ||
        current.history.messages.filter((message) => message.id === boundary.anchorID).length !== 1
      )
        return false;
      const anchorIndex = current.history.messages.findIndex((message) => message.id === boundary.anchorID);
      const promptIndex = current.history.messages.findIndex((message) => message.id === input.messageID);
      if (promptIndex !== -1 && promptIndex <= anchorIndex) return false;
    }
    const nextBoundaryKey = boundaryKey(boundary);
    if (nextBoundaryKey !== state.boundaryKey) resetCadence(state, nextBoundaryKey);

    if (state.counted.has(input.messageID)) return state.eligibilityByID.get(input.messageID) ?? false;
    if (!state.candidates.has(input.messageID)) boundedAdd(state.candidates, input.messageID);
    state.candidates.delete(input.messageID);
    boundedAdd(state.counted, input.messageID);
    state.count += 1;
    state.latestCandidate = input.messageID;
    state.latestEligible = state.count % Math.max(1, Math.trunc(remindEveryN || 1)) === 0;
    if (state.eligibilityByID.size >= MAX_IDS) {
      state.eligibilityByID.delete(state.eligibilityByID.keys().next().value as string);
    }
    state.eligibilityByID.set(input.messageID, state.latestEligible);
    return state.latestEligible;
  }

  return Object.freeze({
    record,
    selectTransport,
    shouldInject,
    shouldInjectPrompt,
    dispose() {
      disposed = true;
      states.clear();
    },
  });
}

export type ReturnTypeOfReminderCadence = ReturnType<typeof createV2ReminderCadence>;
