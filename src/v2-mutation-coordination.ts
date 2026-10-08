type Release = () => void;
type MutationState = { updater: boolean; waiters: Array<(release: Release) => void> };

// Shared only within this process. Explicit mutations are not reentrant.
const mutations = new Map<string, MutationState>();
const sessionControllers = new Map<string, AbortController>();

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
  return mutations.get(mutationKey(directory, sessionID))?.updater === true;
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
