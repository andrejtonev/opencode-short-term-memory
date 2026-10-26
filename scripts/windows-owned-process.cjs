const { execFile } = require("node:child_process");
const { createConnection } = require("node:net");

function canSignalOwnedChild(child) {
  return (
    !!child && Number.isSafeInteger(child.pid) && child.pid > 1 && child.exitCode === null && child.signalCode === null
  );
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function killTree(child, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: timeoutMs },
      (error) => {
        resolve({ succeeded: !error, error: error ? String(error) : null });
      },
    );
  });
}

function portIsClosed(endpoint, timeoutMs) {
  const url = new URL(endpoint);
  return new Promise((resolve) => {
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    const done = (closed) => {
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(false));
    socket.once("error", (error) => done(error.code === "ECONNREFUSED"));
  });
}

/** Uses only live owned ChildProcess identities; never signals a terminal child's stale PID. */
async function cleanupOwnedChildren(children, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("cleanup timeout must be a positive integer");
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const records = await Promise.all(
    children.filter(Boolean).map(async (child) => {
      const record = {
        pid: child.pid ?? null,
        signalled: false,
        killSucceeded: null,
        error: null,
        exited: child.exitCode !== null || child.signalCode !== null,
      };
      if (canSignalOwnedChild(child) && Date.now() < deadline) {
        record.signalled = true;
        try {
          // Subscribe before sending: the child can exit before taskkill returns.
          const [exited, killed] = await Promise.all([
            (options.waitForExit ?? waitForExit)(child, remaining()),
            (options.killTree ?? killTree)(child, remaining()),
          ]);
          record.killSucceeded = killed.succeeded;
          record.error = killed.error;
          record.exited = exited;
        } catch (error) {
          record.error = String(error);
        }
      }
      // Missing spawn identity is not evidence that a live child was contained.
      record.exited = record.exited || child.exitCode !== null || child.signalCode !== null;
      return record;
    }),
  );
  const ports = [];
  for (const endpoint of options.endpoints ?? []) {
    let closed = false;
    try {
      // Process exit can precede listener teardown, especially after taskkill.
      // Observe closure within the shared cleanup budget rather than treating
      // the first successful connection as a final containment failure.
      while (Date.now() < deadline) {
        closed = await (options.portIsClosed ?? portIsClosed)(endpoint, Math.min(250, remaining()));
        if (closed) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining())));
      }
    } catch {}
    ports.push({ endpoint, closed });
  }
  const childrenExited = records.every((record) => record.exited);
  const portsClosed = ports.every((record) => record.closed);
  const complete =
    childrenExited &&
    portsClosed &&
    records.every((record) => !record.error && (!record.signalled || record.killSucceeded === true));
  return { children: records, ports, childrenExited, portsClosed, complete };
}

function applyCleanupVerdict(record, cleanup) {
  record.functionalVerdict = record.functionalVerdict ?? record.verdict ?? "FAIL";
  record.cleanup = cleanup;
  record.cleanupVerdict = cleanup.complete ? "PASS" : "FAIL";
  record.verdict = record.functionalVerdict === "PASS" && cleanup.complete ? "PASS" : "FAIL";
  return record;
}

/** Stop only this harness's mock server; active SSE/keepalive connections cannot stall evidence writes. */
function closeOwnedServer(server, timeoutMs = 1000) {
  if (!server) return Promise.resolve({ closed: true, error: null });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ closed, error });
    };
    const timer = setTimeout(() => finish(false, "Owned mock server closure timed out"), timeoutMs);
    try {
      server.close((error) =>
        finish(
          !error || error.code === "ERR_SERVER_NOT_RUNNING",
          error && error.code !== "ERR_SERVER_NOT_RUNNING" ? String(error) : null,
        ),
      );
      server.closeAllConnections?.();
    } catch (error) {
      finish(false, String(error));
    }
  });
}

module.exports = { canSignalOwnedChild, cleanupOwnedChildren, applyCleanupVerdict, closeOwnedServer };
