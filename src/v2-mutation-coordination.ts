type Release = () => void;
type MutationState = { updater: boolean; waiters: Array<(release: Release) => void> };

// Shared only within this process. Explicit mutations are not reentrant.
const mutations = new Map<string, MutationState>();
const sessionControllers = new Map<string, AbortController>();
const readRevisions = new WeakMap<AbortSignal, number>();
const generationControllers = new Map<string, AbortController>();
const updateReservations = new Map<string, object>();

function mutationKey(directory: string, sessionID: string): string {
  return JSON.stringify([directory, sessionID]);
}

export function getV2MemorySessionSignal(directory: string, sessionID: string): AbortSignal {
  const key = mutationKey(directory, sessionID);
  let controller = sessionControllers.get(key);
  if (!controller) {
    controller = new AbortController();
    sessionControllers.set(key, controller);
  }
  return controller.signal;
}

export function isV2MemorySessionDeleted(directory: string, sessionID: string): boolean {
  return sessionControllers.get(mutationKey(directory, sessionID))?.signal.aborted === true;
}

export function getV2MemoryReadRevision(directory: string, sessionID: string): number {
  return readRevisions.get(getV2MemorySessionSignal(directory, sessionID)) ?? 0;
}

export function invalidateV2MemoryReads(directory: string, sessionID: string): void {
  const signal = getV2MemorySessionSignal(directory, sessionID);
  readRevisions.set(signal, (readRevisions.get(signal) ?? 0) + 1);
}

export function getV2MemoryGenerationSignal(directory: string, sessionID: string): AbortSignal {
  const key = mutationKey(directory, sessionID);
  let controller = generationControllers.get(key);
  if (!controller) {
    controller = new AbortController();
    generationControllers.set(key, controller);
  }
  return controller.signal;
}

// Reset revokes the old update's right to persist without waiting for its provider.
// The updater separately retains its provider reservation until that call settles.
export function invalidateV2MemoryGeneration(directory: string, sessionID: string): void {
  const key = mutationKey(directory, sessionID);
  generationControllers.get(key)?.abort(new Error("memory_reset"));
  generationControllers.set(key, new AbortController());
}

export function tryReserveV2MemoryUpdate(directory: string, sessionID: string): Release | undefined {
  const key = mutationKey(directory, sessionID);
  if (isV2MemorySessionDeleted(directory, sessionID) || mutations.has(key) || updateReservations.has(key))
    return undefined;
  const owner = {};
  updateReservations.set(key, owner);
  return () => {
    if (updateReservations.get(key) === owner) updateReservations.delete(key);
  };
}

function releaseFor(key: string, state: MutationState): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.updater = false;
    const next = state.waiters.shift();
    // Keep ownership reserved until the queued callback resumes: no barging.
    if (next) next(releaseFor(key, state));
    else mutations.delete(key);
  };
}

// Automatic callbacks must acquire synchronously or skip, including during handoff.
export function tryAcquireV2MemoryUpdate(directory: string, sessionID: string): Release | undefined {
  const key = mutationKey(directory, sessionID);
  if (isV2MemorySessionDeleted(directory, sessionID) || mutations.has(key)) return undefined;
  const state: MutationState = { updater: true, waiters: [] };
  mutations.set(key, state);
  return releaseFor(key, state);
}

export function isV2MemoryUpdateInFlight(directory: string, sessionID: string): boolean {
  const key = mutationKey(directory, sessionID);
  return updateReservations.has(key) || mutations.get(key)?.updater === true;
}

async function acquireMutation(key: string): Promise<Release> {
  const existing = mutations.get(key);
  if (existing) {
    return new Promise<Release>((resolve) => existing.waiters.push(resolve));
  }
  const state: MutationState = { updater: false, waiters: [] };
  mutations.set(key, state);
  return releaseFor(key, state);
}

export async function withV2MemoryMutation<T>(
  directory: string,
  sessionID: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const signal = getV2MemorySessionSignal(directory, sessionID);
  if (signal.aborted) throw signal.reason;
  const release = await acquireMutation(mutationKey(directory, sessionID));
  try {
    if (signal.aborted) throw signal.reason;
    return await operation();
  } finally {
    release();
  }
}

export async function deleteV2MemorySession(
  directory: string,
  sessionID: string,
  operation: () => void | Promise<void>,
): Promise<void> {
  getV2MemorySessionSignal(directory, sessionID);
  sessionControllers.get(mutationKey(directory, sessionID))!.abort(new Error("session_deleted"));
  const release = await acquireMutation(mutationKey(directory, sessionID));
  try {
    await operation();
  } finally {
    release();
  }
}
