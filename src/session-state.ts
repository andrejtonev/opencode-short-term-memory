export const MAX_SESSION_STATES = 200;
export const MAX_CANONICAL_TURN_IDS = 64;

export interface MemoryDeliveryClaim {
  turnID: string;
  memoryRevision: number;
}

export interface SessionRuntimeState {
  userTurnInjectState: { count: number; lastMessageID: string };
  userTurnInvocationSequence: number;
  lastInjectedSignature?: { signature: string; at: number };
  canonicalTurnIDs: Set<string>;
  canonicalTurnOrder: string[];
  memoryRevision: number;
  deliveryClaim?: MemoryDeliveryClaim;
  retryableDeliveryClaim?: MemoryDeliveryClaim;
  lastDeliveredClaim?: MemoryDeliveryClaim;
  childStartupSnapshot?: string;
  childStartupInjectionPending: boolean;
  childDcpInjectionPending: boolean;
  mainDcpDeliveryPending: boolean;
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
    userTurnInvocationSequence: 0,
    canonicalTurnIDs: new Set(),
    canonicalTurnOrder: [],
    memoryRevision: 0,
    childStartupInjectionPending: false,
    childDcpInjectionPending: false,
    mainDcpDeliveryPending: false,
    lastIdleScheduledAt: 0,
    lastDcpCompressAt: 0,
  };
}

export function resetSessionDeliveryState(state: SessionRuntimeState): void {
  state.userTurnInjectState = { count: 0, lastMessageID: "" };
  state.userTurnInvocationSequence = 0;
  state.lastInjectedSignature = undefined;
  state.canonicalTurnIDs.clear();
  state.canonicalTurnOrder.length = 0;
  state.memoryRevision = 0;
  state.deliveryClaim = undefined;
  state.retryableDeliveryClaim = undefined;
  state.lastDeliveredClaim = undefined;
  state.childStartupSnapshot = undefined;
  state.childStartupInjectionPending = false;
  state.childDcpInjectionPending = false;
  state.mainDcpDeliveryPending = false;
}

export function rememberCanonicalTurn(state: SessionRuntimeState, turnID: string): boolean {
  if (!turnID || state.canonicalTurnIDs.has(turnID)) return false;
  state.canonicalTurnIDs.add(turnID);
  state.canonicalTurnOrder.push(turnID);
  while (state.canonicalTurnOrder.length > MAX_CANONICAL_TURN_IDS) {
    state.canonicalTurnIDs.delete(state.canonicalTurnOrder.shift()!);
  }
  return true;
}

export function bumpMemoryRevision(state: SessionRuntimeState): number {
  state.memoryRevision += 1;
  return state.memoryRevision;
}

export function claimMemoryDelivery(
  state: SessionRuntimeState,
  turnID: string,
  expectedMemoryRevision: number,
): MemoryDeliveryClaim | undefined {
  if (!turnID || expectedMemoryRevision !== state.memoryRevision || state.deliveryClaim) return undefined;
  const previous = state.lastDeliveredClaim;
  if (previous?.turnID === turnID && previous.memoryRevision === expectedMemoryRevision) return undefined;
  const claim = { turnID, memoryRevision: expectedMemoryRevision };
  state.deliveryClaim = claim;
  return claim;
}

export function completeMemoryDelivery(state: SessionRuntimeState, claim: MemoryDeliveryClaim): void {
  if (state.deliveryClaim !== claim) return;
  const retryable = state.retryableDeliveryClaim;
  if (retryable?.turnID === claim.turnID && retryable.memoryRevision === claim.memoryRevision) {
    state.retryableDeliveryClaim = undefined;
  }
  state.lastDeliveredClaim = claim;
  state.deliveryClaim = undefined;
}

export function releaseMemoryDelivery(state: SessionRuntimeState, claim: MemoryDeliveryClaim): void {
  if (state.deliveryClaim === claim) {
    state.retryableDeliveryClaim = claim;
    state.deliveryClaim = undefined;
  }
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
