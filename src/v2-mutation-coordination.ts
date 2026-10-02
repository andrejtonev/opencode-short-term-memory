type Release = () => void;
type MutationState = { updater: boolean; waiters: Array<(release: Release) => void> };

// Shared only within this process. Explicit mutations are not reentrant.
const mutations = new Map<string, MutationState>();

function mutationKey(directory: string, sessionID: string): string {
  return JSON.stringify([directory, sessionID]);
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
  if (mutations.has(key)) return undefined;
  const state: MutationState = { updater: true, waiters: [] };
  mutations.set(key, state);
  return releaseFor(key, state);
}

export function isV2MemoryUpdateInFlight(directory: string, sessionID: string): boolean {
  return mutations.get(mutationKey(directory, sessionID))?.updater === true;
}

export async function withV2MemoryMutation<T>(
  directory: string,
  sessionID: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const key = mutationKey(directory, sessionID);
  const existing = mutations.get(key);
  let release: Release;
  if (existing) {
    release = await new Promise<Release>((resolve) => existing.waiters.push(resolve));
  } else {
    const state: MutationState = { updater: false, waiters: [] };
    mutations.set(key, state);
    release = releaseFor(key, state);
  }
  try {
    return await operation();
  } finally {
    release();
  }
}
