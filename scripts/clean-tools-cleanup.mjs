import { cleanupOwnedChildren, applyCleanupVerdict, closeOwnedServer } from "./windows-owned-process.cjs";

function killDetachedGroup(child) {
  try {
    // The clean-tools runner creates its POSIX host with detached:true.
    process.kill(-child.pid, "SIGKILL");
    return Promise.resolve({ succeeded: true, error: null });
  } catch (error) {
    return Promise.resolve({ succeeded: false, error: String(error) });
  }
}

/** Finalize only the clean-tools runner's owned host and mock, retaining the functional result separately. */
export async function cleanupCleanToolsRun(
  { host, mock, endpoint, evidence, platform = process.platform },
  options = {},
) {
  const cleanup = await cleanupOwnedChildren([host], {
    endpoints: endpoint ? [endpoint] : [],
    ...(platform === "win32" ? {} : { killTree: killDetachedGroup }),
    ...options,
  });
  cleanup.mock = await closeOwnedServer(mock, options.mockTimeoutMs);
  cleanup.complete = cleanup.complete && cleanup.mock.closed;
  applyCleanupVerdict(evidence, cleanup);
  evidence.hostExited = cleanup.childrenExited;
  return cleanup;
}
