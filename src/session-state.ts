export const MAX_SESSION_STATES = 200;

export interface SessionRuntimeState {
  userTurnInjectState: { count: number; lastMessageID: string };
  lastInjectedSignature?: { signature: string; at: number };
  lastIdleScheduledAt: number;
  lastDcpCompressAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface IdleWaiter {
  promise: Promise<void>;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function createSessionRuntimeState(): SessionRuntimeState {
  return {
    userTurnInjectState: { count: 0, lastMessageID: "" },
    lastIdleScheduledAt: 0,
    lastDcpCompressAt: 0,
  };
}

export function touchSessionState(
  sessionID: string,
  sessionStates: Map<string, SessionRuntimeState>,
  sessionStatesOrder: string[],
  maxSessionStates: number,
): void {
  const idx = sessionStatesOrder.indexOf(sessionID);
  if (idx !== -1) sessionStatesOrder.splice(idx, 1);
  sessionStatesOrder.push(sessionID);
  while (sessionStatesOrder.length > maxSessionStates) {
    const oldest = sessionStatesOrder.shift()!;
    const state = sessionStates.get(oldest);
    if (state?.timer) clearTimeout(state.timer);
    sessionStates.delete(oldest);
  }
}

export function ensureSessionState(
  sessionID: string,
  sessionStates: Map<string, SessionRuntimeState>,
  sessionStatesOrder: string[],
  maxSessionStates: number,
): SessionRuntimeState {
  if (!sessionStates.has(sessionID)) {
    sessionStates.set(sessionID, createSessionRuntimeState());
    sessionStatesOrder.push(sessionID);
    if (sessionStatesOrder.length > maxSessionStates) {
      const oldest = sessionStatesOrder.shift()!;
      const state = sessionStates.get(oldest);
      if (state?.timer) clearTimeout(state.timer);
      sessionStates.delete(oldest);
    }
  } else {
    touchSessionState(sessionID, sessionStates, sessionStatesOrder, maxSessionStates);
  }
  return sessionStates.get(sessionID)!;
}

export function isSessionBusy(
  sessionID: string,
  sessionStates: Map<string, SessionRuntimeState>,
  updateInFlight: Set<string>,
  pendingUpdateAfterInFlight: Set<string>,
): boolean {
  if (updateInFlight.has(sessionID)) return true;
  if (pendingUpdateAfterInFlight.has(sessionID)) return true;
  const s = sessionStates.get(sessionID);
  return s?.timer != null;
}

export function notifySessionIdle(sessionID: string, idleWaiters: Map<string, IdleWaiter>): void {
  const waiter = idleWaiters.get(sessionID);
  if (waiter) {
    clearTimeout(waiter.timeout);
    idleWaiters.delete(sessionID);
    waiter.resolve();
  }
}

export function waitForSessionIdle(
  sessionID: string,
  timeoutMs: number,
  isBusy: (sid: string) => boolean,
  idleWaiters: Map<string, IdleWaiter>,
): Promise<void> {
  if (!isBusy(sessionID)) return Promise.resolve();
  const existing = idleWaiters.get(sessionID);
  if (existing) {
    clearTimeout(existing.timeout);
    existing.resolve();
  }
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const timeout = setTimeout(() => {
    if (idleWaiters.get(sessionID)?.promise === promise) {
      idleWaiters.delete(sessionID);
      resolve();
    }
  }, timeoutMs);
  idleWaiters.set(sessionID, { promise, resolve, timeout });
  return promise;
}

export async function waitForSessionUpdateDrain(
  sessionID: string,
  timeoutMs: number,
  waitForIdle: (sid: string, ms: number) => Promise<void>,
): Promise<void> {
  await waitForIdle(sessionID, timeoutMs);
}
