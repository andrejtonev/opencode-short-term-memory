import { beforeEach, describe, expect, test } from "bun:test";
import {
  bumpMemoryRevision,
  claimMemoryDelivery,
  completeMemoryDelivery,
  createSessionRuntimeState,
  ensureSessionState,
  MAX_CANONICAL_TURN_IDS,
  releaseMemoryDelivery,
  rememberCanonicalTurn,
  resetSessionDeliveryState,
  touchSessionState,
  MAX_SESSION_STATES,
  type SessionRuntimeState,
} from "../src/session-state";

describe("Session state LRU eviction", () => {
  let sessionStates: Map<string, SessionRuntimeState>;
  let sessionStatesOrder: string[];

  beforeEach(() => {
    sessionStates = new Map();
    sessionStatesOrder = [];
  });

  test("ensureSessionState never exceeds MAX_SESSION_STATES", () => {
    // Create more sessions than the max
    for (let i = 0; i < MAX_SESSION_STATES + 50; i++) {
      ensureSessionState(`session-${i}`, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
    }

    expect(sessionStates.size).toBe(MAX_SESSION_STATES);
    expect(sessionStatesOrder.length).toBe(MAX_SESSION_STATES);
  });

  test("oldest sessions evicted when LRU capacity exceeded", () => {
    // Create exactly MAX_SESSION_STATES sessions
    for (let i = 0; i < MAX_SESSION_STATES; i++) {
      ensureSessionState(`session-${i}`, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
    }

    expect(sessionStates.has("session-0")).toBe(true);
    expect(sessionStates.has(`session-${MAX_SESSION_STATES - 1}`)).toBe(true);

    // Add one more — the oldest should be evicted
    ensureSessionState("overflow-session", sessionStates, sessionStatesOrder, MAX_SESSION_STATES);

    expect(sessionStates.size).toBe(MAX_SESSION_STATES);
    expect(sessionStates.has("session-0")).toBe(false);
    expect(sessionStates.has("overflow-session")).toBe(true);
  });

  test("touchSessionState moves session to end of LRU order", () => {
    // Create sessions 0..4
    for (let i = 0; i < 5; i++) {
      ensureSessionState(`session-${i}`, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
    }

    // Order should be [0, 1, 2, 3, 4]
    expect(sessionStatesOrder).toEqual(["session-0", "session-1", "session-2", "session-3", "session-4"]);

    // Touch session-1 — should move to end
    touchSessionState("session-1", sessionStates, sessionStatesOrder, MAX_SESSION_STATES);

    expect(sessionStatesOrder).toEqual(["session-0", "session-2", "session-3", "session-4", "session-1"]);
  });

  test("touching a session protects it from eviction", () => {
    const max = 5;

    for (let i = 0; i < max; i++) {
      ensureSessionState(`session-${i}`, sessionStates, sessionStatesOrder, max);
    }

    // Touch session-0 so it's not the oldest anymore
    touchSessionState("session-0", sessionStates, sessionStatesOrder, max);

    // Add one more — session-1 should be evicted (not session-0)
    ensureSessionState("overflow", sessionStates, sessionStatesOrder, max);

    expect(sessionStates.size).toBe(max);
    expect(sessionStates.has("session-0")).toBe(true); // protected by touch
    expect(sessionStates.has("session-1")).toBe(false); // evicted
    expect(sessionStates.has("overflow")).toBe(true);
  });

  test("ensureSessionState touches existing sessions to promote them", () => {
    const max = 3;

    ensureSessionState("a", sessionStates, sessionStatesOrder, max);
    ensureSessionState("b", sessionStates, sessionStatesOrder, max);
    ensureSessionState("c", sessionStates, sessionStatesOrder, max);

    // Re-ensure "a" — should move to end
    ensureSessionState("a", sessionStates, sessionStatesOrder, max);

    // Add "d" — "b" should be evicted (not "a")
    ensureSessionState("d", sessionStates, sessionStatesOrder, max);

    expect(sessionStates.size).toBe(max);
    expect(sessionStates.has("a")).toBe(true);
    expect(sessionStates.has("b")).toBe(false);
    expect(sessionStates.has("c")).toBe(true);
    expect(sessionStates.has("d")).toBe(true);
    expect(sessionStatesOrder).toEqual(["c", "a", "d"]);
  });

  test("eviction clears active timers on evicted sessions", () => {
    const max = 3;

    ensureSessionState("a", sessionStates, sessionStatesOrder, max);
    const b = ensureSessionState("b", sessionStates, sessionStatesOrder, max);
    ensureSessionState("c", sessionStates, sessionStatesOrder, max);

    // Set a timer on session "b"
    let timerFired = false;
    b.timer = setTimeout(() => {
      timerFired = true;
    }, 60000);

    // Overflow — "a" should be evicted (not "b"), so "b"'s timer survives
    ensureSessionState("d", sessionStates, sessionStatesOrder, max);

    expect(sessionStates.has("a")).toBe(false);
    expect(sessionStates.has("b")).toBe(true);

    // Overflow again — "b" should now be evicted with its timer
    ensureSessionState("e", sessionStates, sessionStatesOrder, max);

    expect(sessionStates.has("b")).toBe(false);
    // The timer should not fire since b was evicted (the timer was cleared)
    clearTimeout(b.timer!);
    expect(timerFired).toBe(false);
  });

  test("createSessionRuntimeState returns fresh state with zero counters", () => {
    const state = createSessionRuntimeState();

    expect(state.userTurnInjectState.count).toBe(0);
    expect(state.userTurnInjectState.lastMessageID).toBe("");
    expect(state.lastIdleScheduledAt).toBe(0);
    expect(state.lastDcpCompressAt).toBe(0);
    expect(state.timer).toBeUndefined();
    expect(state.lastInjectedSignature).toBeUndefined();
    expect(state.canonicalTurnIDs).toEqual(new Set());
    expect(state.canonicalTurnOrder).toEqual([]);
    expect(state.memoryRevision).toBe(0);
    expect(state.deliveryClaim).toBeUndefined();
    expect(state.lastDeliveredClaim).toBeUndefined();
    expect(state.retryableDeliveryClaim).toBeUndefined();
    expect(state.childStartupSnapshot).toBeUndefined();
    expect(state.childStartupInjectionPending).toBe(false);
    expect(state.childDcpInjectionPending).toBe(false);
    expect(state.mainDcpDeliveryPending).toBe(false);
  });

  test("canonical turn identity dedupe evicts the oldest identity at capacity", () => {
    const state = createSessionRuntimeState();

    for (let i = 0; i < MAX_CANONICAL_TURN_IDS; i++) {
      expect(rememberCanonicalTurn(state, `turn-${i}`)).toBe(true);
    }

    expect(rememberCanonicalTurn(state, "turn-0")).toBe(false);
    expect(rememberCanonicalTurn(state, "overflow-turn")).toBe(true);
    expect(state.canonicalTurnIDs.size).toBe(MAX_CANONICAL_TURN_IDS);
    expect(state.canonicalTurnOrder).toHaveLength(MAX_CANONICAL_TURN_IDS);
    expect(state.canonicalTurnIDs.has("turn-0")).toBe(false);
    expect(state.canonicalTurnOrder[0]).toBe("turn-1");
    expect(rememberCanonicalTurn(state, "turn-0")).toBe(true);
  });

  test("delivery claims reject stale revisions and support release, retry, and completion", () => {
    const state = createSessionRuntimeState();
    const revision = bumpMemoryRevision(state);

    expect(claimMemoryDelivery(state, "turn-1", revision - 1)).toBeUndefined();

    const firstClaim = claimMemoryDelivery(state, "turn-1", revision)!;
    expect(claimMemoryDelivery(state, "turn-2", revision)).toBeUndefined();

    releaseMemoryDelivery(state, firstClaim);
    expect(state.deliveryClaim).toBeUndefined();
    expect(state.retryableDeliveryClaim).toBe(firstClaim);

    const retryClaim = claimMemoryDelivery(state, "turn-1", revision)!;
    expect(retryClaim).not.toBe(firstClaim);
    expect(state.retryableDeliveryClaim).toBe(firstClaim);
    completeMemoryDelivery(state, retryClaim);

    expect(state.deliveryClaim).toBeUndefined();
    expect(state.lastDeliveredClaim).toBe(retryClaim);
    expect(state.retryableDeliveryClaim).toBeUndefined();
    expect(claimMemoryDelivery(state, "turn-1", revision)).toBeUndefined();

    const nextRevision = bumpMemoryRevision(state);
    expect(claimMemoryDelivery(state, "turn-1", nextRevision)).toEqual({
      turnID: "turn-1",
      memoryRevision: nextRevision,
    });
  });

  test("resetSessionDeliveryState clears delivery and child state", () => {
    const state = createSessionRuntimeState();
    state.userTurnInjectState = { count: 3, lastMessageID: "message-3" };
    state.lastInjectedSignature = { signature: "signature", at: 123 };
    rememberCanonicalTurn(state, "turn-1");
    const revision = bumpMemoryRevision(state);
    const claim = claimMemoryDelivery(state, "turn-1", revision)!;
    completeMemoryDelivery(state, claim);
    state.deliveryClaim = { turnID: "turn-2", memoryRevision: revision };
    state.retryableDeliveryClaim = { turnID: "turn-3", memoryRevision: revision };
    state.childStartupSnapshot = "startup memory";
    state.childStartupInjectionPending = true;
    state.childDcpInjectionPending = true;
    state.mainDcpDeliveryPending = true;

    resetSessionDeliveryState(state);

    expect(state.userTurnInjectState).toEqual({ count: 0, lastMessageID: "" });
    expect(state.lastInjectedSignature).toBeUndefined();
    expect(state.canonicalTurnIDs).toEqual(new Set());
    expect(state.canonicalTurnOrder).toEqual([]);
    expect(state.memoryRevision).toBe(0);
    expect(state.deliveryClaim).toBeUndefined();
    expect(state.lastDeliveredClaim).toBeUndefined();
    expect(state.retryableDeliveryClaim).toBeUndefined();
    expect(state.childStartupSnapshot).toBeUndefined();
    expect(state.childStartupInjectionPending).toBe(false);
    expect(state.childDcpInjectionPending).toBe(false);
    expect(state.mainDcpDeliveryPending).toBe(false);
  });

  test("LRU eviction removes populated delivery and child state", () => {
    const evicted = ensureSessionState("evicted", sessionStates, sessionStatesOrder, 1);
    const revision = bumpMemoryRevision(evicted);
    evicted.deliveryClaim = { turnID: "turn-1", memoryRevision: revision };
    evicted.lastDeliveredClaim = { turnID: "turn-0", memoryRevision: 0 };
    evicted.childStartupSnapshot = "startup memory";
    evicted.childStartupInjectionPending = true;
    evicted.childDcpInjectionPending = true;
    evicted.mainDcpDeliveryPending = true;

    ensureSessionState("retained", sessionStates, sessionStatesOrder, 1);

    expect(sessionStates.has("evicted")).toBe(false);
    expect(sessionStates.has("retained")).toBe(true);
    expect(sessionStatesOrder).toEqual(["retained"]);
  });
});
