import { readRawFile, resetBoundaryPathFor } from "./memory-utils";
import { getV2MemoryReadRevision, isV2MemorySessionDeleted } from "./v2-mutation-coordination";
import { parseV2ResetBoundary } from "./v2-reset-boundary";
import type { V2Context, V2SessionContext } from "./v2-adapter";
import { readV2CurrentHistory } from "./v2-current-history";

const MAX_SESSION_STATES = 256;
const MAX_IDS = 4096;

type SessionState = {
  candidates: Set<string>;
  counted: Set<string>;
  count: number;
  boundary?: string;
  latestCandidate?: string;
  latestEligible: boolean;
  eligibilityByID: Map<string, boolean>;
};

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

  async function boundaryFor(sessionID: string, memoryDir: string): Promise<string | null | undefined> {
    const raw = await readRawFile(resetBoundaryPathFor(sessionID, memoryDir));
    if (raw === null) return undefined;
    try {
      return parseV2ResetBoundary(raw).anchorID;
    } catch {
      return null;
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
    if (boundary === null) return false;
    let messages = input.messages as readonly unknown[];
    let beforeBoundary: readonly unknown[] = [];
    if (boundary !== undefined) {
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
      const indices = current.history.messages.flatMap((message, index) => (message.id === boundary ? [index] : []));
      if (indices.length !== 1) return false;
      beforeBoundary = current.history.messages.slice(0, indices[0]! + 1);
      const eligibleIDs = new Set(
        current.history.messages
          .slice(indices[0]! + 1)
          .filter(isUser)
          .map(idOf),
      );
      messages = messages.filter((message) => eligibleIDs.has(idOf(message)));
    }
    if (boundary !== state.boundary) {
      state.boundary = boundary;
      if (boundary !== undefined) {
        for (const message of beforeBoundary) {
          const id = idOf(message);
          if (id) {
            state.candidates.delete(id);
            boundedAdd(state.counted, id);
          }
        }
        state.count = 0;
        state.latestCandidate = undefined;
        state.latestEligible = false;
        state.eligibilityByID.clear();
      }
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

  return Object.freeze({
    record,
    shouldInject,
    dispose() {
      disposed = true;
      states.clear();
    },
  });
}

export type ReturnTypeOfReminderCadence = ReturnType<typeof createV2ReminderCadence>;
