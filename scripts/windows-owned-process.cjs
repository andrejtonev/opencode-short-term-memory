const { execFile } = require("node:child_process");
const { createConnection } = require("node:net");
const trackedTrees = new WeakMap();

/** Acquire ownership while the root is live, before normal exit can erase its ancestry. */
function trackOwnedChild(child, options = {}) {
  if (trackedTrees.has(child)) return trackedTrees.get(child);
  if (!canSignalOwnedChild(child)) return;
  const snapshot = Promise.resolve()
    .then(() => (options.captureTree ?? captureOwnedTree)(child, options.timeoutMs ?? 5000))
    .then((value) => {
      if (!canSignalOwnedChild(child)) throw new Error("Owned root exited before ownership capture completed");
      return value;
    });
  trackedTrees.set(child, snapshot);
  snapshot.catch(() => undefined);
  return snapshot;
}

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

function processTable(timeoutMs) {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows process identity query is unavailable"));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {",
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; created = [string]$_.CreationDate.ToUniversalTime().Ticks; commandLine = [string]$_.CommandLine }",
    "})",
    "ConvertTo-Json -InputObject $rows -Compress -Depth 4",
  ].join("\n");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

async function captureOwnedTree(child, timeoutMs) {
  const rows = await processTable(timeoutMs);
  const childrenByParent = new Map();
  for (const row of rows) {
    if (!childrenByParent.has(row.parentPid)) childrenByParent.set(row.parentPid, []);
    childrenByParent.get(row.parentPid).push(row);
  }
  const identities = [];
  const pending = [child.pid];
  const visited = new Set();
  while (pending.length) {
    const parentPid = pending.pop();
    if (visited.has(parentPid)) continue;
    visited.add(parentPid);
    for (const row of rows.filter((candidate) => candidate.pid === parentPid)) {
      if (typeof row.created !== "string" || !/^\d+$/.test(row.created))
        throw new Error(`Process ${row.pid} has no stable creation identity`);
      identities.push({ pid: row.pid, created: row.created, commandLine: row.commandLine ?? "" });
    }
    for (const row of childrenByParent.get(parentPid) ?? []) pending.push(row.pid);
  }
  if (!identities.some((identity) => identity.pid === child.pid))
    throw new Error(`Owned root process ${child.pid} identity was absent from the pre-kill snapshot`);
  return { complete: true, rootPids: [child.pid], identities };
}

function isOwnedTreeGone(snapshot, rows) {
  const ownedPids = new Set([...(snapshot.rootPids ?? []), ...snapshot.identities.map((identity) => identity.pid)]);
  if (rows.some((row) => ownedPids.has(row.pid))) return false;
  // New descendants can appear after the initial snapshot, including deeper
  // descendants whose immediate parent is itself a late, uncaptured process.
  // Expand current ancestry from every captured PID and fail on any live row.
  const ancestry = new Set(ownedPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ancestry.has(row.parentPid)) {
        if (!ancestry.has(row.pid)) {
          ancestry.add(row.pid);
          changed = true;
        }
      }
    }
  }
  return !rows.some((row) => ancestry.has(row.pid));
}

async function verifyTreeGone(snapshot, timeoutMs) {
  return isOwnedTreeGone(snapshot, await processTable(timeoutMs));
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
        treeStatus: "unconfirmed",
        treeProcessCount: 0,
        treeVerificationError: null,
      };
      const liveAtEntry = canSignalOwnedChild(child);
      if (!liveAtEntry && (child.exitCode !== null || child.signalCode !== null)) {
        record.exited = true;
        // This cleanup invocation did not observe a live root and therefore
        // cannot safely take a creation-time snapshot or signal its stale PID.
        record.treeStatus = "already-terminal-unverified";
        const tracked = trackedTrees.get(child);
        if (tracked) {
          let timer;
          try {
            const snapshot = await Promise.race([
              tracked,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Owned tree snapshot timed out")), remaining());
              }),
            ]);
            if (snapshot?.complete && snapshot.identities?.length) {
              record.treeProcessCount = snapshot.identities.length;
              const gone = await (options.verifyTreeGone ?? verifyTreeGone)(snapshot, remaining());
              record.treeStatus = gone ? "verified-gone" : "unconfirmed";
            }
          } catch (error) {
            record.treeVerificationError = String(error);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
        return record;
      }
      let treeSnapshot;
      const validPid = Number.isSafeInteger(child.pid) && child.pid > 1;
      if (validPid && Date.now() < deadline) {
        try {
          treeSnapshot = await (options.captureTree ?? captureOwnedTree)(child, remaining());
          if (treeSnapshot?.complete && Array.isArray(treeSnapshot.identities)) {
            record.treeStatus = "snapshot-captured";
            record.treeProcessCount = treeSnapshot.identities.length;
          } else {
            record.treeVerificationError = "Owned process tree snapshot was incomplete";
          }
        } catch (error) {
          record.treeVerificationError = String(error);
        }
      }
      const verifyGone = async () => {
        if (!treeSnapshot?.complete || Date.now() >= deadline) return false;
        try {
          const gone = await (options.verifyTreeGone ?? verifyTreeGone)(treeSnapshot, remaining());
          record.treeStatus = gone ? "verified-gone" : "unconfirmed";
          return gone;
        } catch (error) {
          record.treeStatus = "unconfirmed";
          record.treeVerificationError = String(error);
          return false;
        }
      };
      // If the process becomes terminal while the snapshot is being acquired,
      // its exit event alone says nothing about children it may have left behind.
      if (!canSignalOwnedChild(child)) {
        record.exited = child.exitCode !== null || child.signalCode !== null;
        await verifyGone();
        return record;
      }
      if (Date.now() < deadline) {
        // Snapshot acquisition yields. Recheck the ChildProcess identity before
        // taskkill so an exit during capture can never turn into a stale-PID signal.
        if (!canSignalOwnedChild(child)) {
          record.exited = child.exitCode !== null || child.signalCode !== null;
          await verifyGone();
          return record;
        }
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
          if (killed.succeeded) record.treeStatus = "taskkill-succeeded";
          else await verifyGone();
        } catch (error) {
          record.error = String(error);
          record.treeStatus = "unconfirmed";
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
    records.every(
      (record) =>
        record.treeStatus === "taskkill-succeeded" ||
        (record.treeStatus === "verified-gone" && !record.treeVerificationError),
    );
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

module.exports = {
  canSignalOwnedChild,
  trackOwnedChild,
  cleanupOwnedChildren,
  applyCleanupVerdict,
  closeOwnedServer,
  isOwnedTreeGone,
};
