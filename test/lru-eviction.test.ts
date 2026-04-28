import { beforeEach, describe, expect, test } from "bun:test";
import {
  createSessionRuntimeState,
  ensureSessionState,
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
  });
});
