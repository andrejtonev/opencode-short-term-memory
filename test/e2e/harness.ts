// ── STM e2e harness ──────────────────────────────────────────────────
// Spins up a live `opencode serve` instance with the local STM plugin
// loaded via symlink (no npm install, no global mutation). Each suite
// gets a fresh temp project dir + temp XDG config home so tests are
// isolated and the user's `~/.config/opencode/` is never touched.
//
// Inspired by ../opencode-kasper/tests/e2e/harness.ts, adapted for STM.

import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ensureDir } from "../../src/memory-utils";

const PLUGIN_SOURCE = resolve(__dirname, "..", "..", "src", "index.ts");
const STM_E2E_MODEL = process.env.STM_E2E_MODEL ?? "opencode-go/minimax-m2.7";
const STM_E2E_FALLBACK_MODEL = process.env.STM_E2E_FALLBACK_MODEL ?? "opencode/minimax-m2.5-free";
const SERVE_PORT = Number(process.env.STM_E2E_PORT ?? 18999);
const RUN_TIMEOUT_MS = Number(process.env.STM_E2E_TIMEOUT ?? 180_000);
const SERVE_STDOUT = "ignore" as const;
const SERVE_STDERR = "pipe" as const;

// ── Skip condition ───────────────────────────────────────────────────

export function isOpenCodeAvailable(): boolean {
  try {
    execSync("opencode --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function shouldRunE2E(): boolean {
  if (process.env.OPENCODE_E2E !== "1") return false;
  return isOpenCodeAvailable();
}

// ── Project / XDG scaffolding ────────────────────────────────────────

export interface E2EWorkspace {
  projectDir: string;
  xdgHome: string;
  dataHome: string;
  pluginsDir: string;
  stmConfigPath: string;
  memoryDir: string;
  serveLogPath: string;
}

export function setupE2EWorkspace(): E2EWorkspace {
  const root = mkdtempSync(join(tmpdir(), "stm-e2e-"));
  const projectDir = join(root, "project");
  const xdgHome = join(root, "xdg");
  const dataHome = join(root, "data");
  const pluginsDir = join(xdgHome, "opencode", "plugins");
  const memoryDir = join(projectDir, ".opencode", "memory");
  const stmConfigPath = join(projectDir, ".opencode", "stm.jsonc");
  const serveLogPath = join(root, "opencode.serve.log");

  for (const d of [projectDir, pluginsDir, dataHome, dirname(stmConfigPath), dirname(memoryDir)]) {
    mkdirSync(d, { recursive: true });
  }

  // Project-local opencode.json. We do NOT list the STM plugin here —
  // opencode will discover it via the symlink in <xdgHome>/opencode/plugins/.
  writeFileSync(
    join(projectDir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
    "utf-8",
  );

  return { projectDir, xdgHome, dataHome, pluginsDir, stmConfigPath, memoryDir, serveLogPath };
}

export function cleanupE2EWorkspace(ws: E2EWorkspace): void {
  if (process.env.STM_E2E_KEEP_TMP === "1") {
    console.log(`(info) STM_E2E_KEEP_TMP=1 — leaving ${ws.projectDir} on disk`);
    return;
  }
  try {
    rmSync(dirname(ws.projectDir), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ── Plugin symlink ───────────────────────────────────────────────────

export function enableStmPluginSymlink(ws: E2EWorkspace): void {
  const linkPath = join(ws.pluginsDir, "opencode-short-term-memory.ts");
  if (existsSync(linkPath)) rmSync(linkPath);
  // Symlink the source file directly. The plugin's `src/index.ts` re-exports
  // the factory from `./session-memory`, and opencode (via bun) resolves
  // those relative imports. No build step required.
  mkdirSync(ws.pluginsDir, { recursive: true });
  // Use the spawnSync helper so symlink creation works on every platform.
  const r = spawnSync(
    "node",
    [resolve(__dirname, "..", "..", "scripts", "e2e-symlink-plugin.mjs"), ws.xdgHome, PLUGIN_SOURCE],
    {
      stdio: "pipe",
    },
  );
  if (r.status !== 0) {
    const stderr = r.stderr?.toString() ?? "";
    throw new Error(`Failed to create STM plugin symlink: ${stderr}`);
  }
}

export function disableStmPluginSymlink(ws: E2EWorkspace): void {
  const linkPath = join(ws.pluginsDir, "opencode-short-term-memory.ts");
  try {
    if (existsSync(linkPath)) rmSync(linkPath);
  } catch {
    // best-effort
  }
}

// ── Environment isolation ────────────────────────────────────────────

// The user running the e2e suite almost certainly has an `opencode web`
// instance listening on :4000 with OPENCODE_SERVER_PASSWORD set. If we
// forward that env var to our child `opencode serve`, our child will
// require auth using the *web instance's* password and our test ports
// will return 401. We strip the auth env vars so the test instance runs
// unsecured (it only listens on 127.0.0.1 inside a temp workspace).
// We also redirect XDG_DATA_HOME so the test instance's sqlite db and
// logs don't share a lock with the user's long-running opencode.
function baseIsolatedEnv(ws: E2EWorkspace): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: ws.xdgHome,
    XDG_DATA_HOME: ws.dataHome,
    HOME: process.env.HOME ?? "",
    OPENCODE_E2E: "1",
  };
  // Strip auth so the test serve doesn't try to use the user's web password.
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_SERVER_USERNAME;
  return env;
}

export function isolateServeEnv(ws: E2EWorkspace): NodeJS.ProcessEnv {
  return { ...baseIsolatedEnv(ws), STM_STARTUP_TIMING: "1" };
}

export function isolateRunEnv(ws: E2EWorkspace): NodeJS.ProcessEnv {
  return baseIsolatedEnv(ws);
}

// ── Project config seeding ───────────────────────────────────────────

export interface StmSeedConfig {
  summarizerMode?: "clean" | "active";
  debounceMs?: number;
  memoryModel?: string;
  debug?: boolean;
  maxMemoryLength?: number;
  remindEveryN?: number;
  cleanFallbackToActiveSession?: boolean;
  sideSessionRetries?: number;
}

export async function writeStmProjectConfig(ws: E2EWorkspace, cfg: StmSeedConfig = {}): Promise<void> {
  // Atomic: ensure the parent dir exists, then write. The plugin's
  // ensureDefaultConfigFile will skip seeding the global stm.jsonc because
  // it sees this project-local file.
  //
  // IMPORTANT: we write the memoryDir as an absolute path. The plugin's
  // config is loaded with the test's cwd (not the project dir), so a
  // relative "memoryDir" would resolve to the test runner's cwd and
  // miss the project. Absolute paths make the test independent of cwd.
  await ensureDir(dirname(ws.stmConfigPath));
  const absMemoryDir = ws.memoryDir;
  const lines = [
    "{",
    "  // E2E harness seeded config",
    `  "enabled": ${cfg.enabled ?? true},`,
    `  "summarizerMode": "${cfg.summarizerMode ?? "active"}",`,
    `  "memoryModel": "${cfg.memoryModel ?? STM_E2E_FALLBACK_MODEL}",`,
    `  "memoryDir": "${absMemoryDir}",`,
    `  "debounceMs": ${cfg.debounceMs ?? 500},`,
    `  "remindEveryN": ${cfg.remindEveryN ?? 1},`,
    `  "maxMemoryLength": ${cfg.maxMemoryLength ?? 10000},`,
    `  "sideSessionRetries": ${cfg.sideSessionRetries ?? 1},`,
    `  "cleanFallbackToActiveSession": ${cfg.cleanFallbackToActiveSession ?? false},`,
    `  "injectInSubagents": ${cfg.injectInSubagents ?? true},`,
    `  "debug": ${cfg.debug ?? false},`,
    "}",
  ];
  writeFileSync(ws.stmConfigPath, lines.join("\n") + "\n", "utf-8");
}

// ── opencode serve lifecycle ─────────────────────────────────────────

const _serveProcesses = new Map<number, { proc: ChildProcess; stderrFile: string }>();

export function startServe(ws: E2EWorkspace, port = SERVE_PORT, opts?: { serveTimeoutMs?: number }): Promise<number> {
  stopServe(port);

  // Open the log file for streaming append. We write each stderr chunk
  // as it arrives so waitForStmLoaded can grep a live file, not a buffer
  // that only flushes on settle.
  const logFd = require("node:fs").openSync(ws.serveLogPath, "w");
  writeFileSync(ws.serveLogPath, "", "utf-8"); // truncate

  return new Promise((resolve, reject) => {
    const proc = spawn("opencode", ["serve", "--port", String(port)], {
      cwd: ws.projectDir,
      stdio: [SERVE_STDOUT, SERVE_STDOUT, SERVE_STDERR],
      detached: false,
      env: isolateServeEnv(ws),
    });

    // Stream stderr to the log file as it arrives.
    proc.stderr?.on("data", (chunk: Buffer) => {
      try {
        require("node:fs").writeSync(logFd, chunk);
      } catch {
        // file may have been closed by settle; safe to ignore
      }
    });

    let settled = false;
    const settle = (ok: boolean, val: number | Error) => {
      if (settled) return;
      settled = true;
      try {
        require("node:fs").closeSync(logFd);
      } catch {
        // already closed
      }
      if (ok) {
        _serveProcesses.set(port, { proc, stderrFile: ws.serveLogPath });
        resolve(val as number);
      } else {
        proc.kill("SIGTERM");
        reject(val);
      }
    };

    proc.on("error", (err) => settle(false, err));

    const serveStartupMs = opts?.serveTimeoutMs ?? 60_000;
    const deadline = Date.now() + serveStartupMs;

    const check = () => {
      if (isServeRunning(port)) {
        settle(true, port);
        return;
      }
      if (Date.now() > deadline) {
        // Read the live log file for diagnostics.
        let tail = "";
        try {
          tail = readFileSync(ws.serveLogPath, "utf-8").slice(-4000);
        } catch {
          // ignore
        }
        settle(
          false,
          new Error(`Serve on port ${port} did not start within ${serveStartupMs / 1000}s. ` + `Stderr tail:\n${tail}`),
        );
        return;
      }
      setTimeout(check, 500);
    };

    setTimeout(check, 1_000);
  });
}

export function stopServe(port?: number): void {
  const targetPort = port ?? SERVE_PORT;
  if (targetPort !== SERVE_PORT) {
    throw new Error(
      `stopServe called with port=${targetPort} (expected ${SERVE_PORT}). ` +
        `Refusing to fuser-kill a non-test port to avoid touching the developer's opencode.`,
    );
  }
  const entry = _serveProcesses.get(targetPort);
  if (entry) {
    try {
      entry.proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    _serveProcesses.delete(targetPort);
  }
  try {
    execSync(`fuser -k ${targetPort}/tcp 2>/dev/null || true`, { stdio: "pipe" });
  } catch {
    // ignore
  }
}

export function isServeRunning(port = SERVE_PORT): boolean {
  // Guard against accidentally probing the user's long-running opencode
  // (e.g. the web instance on :4000). The harness only ever uses
  // SERVE_PORT (default 18999) — anything else is operator error.
  if (port !== SERVE_PORT) {
    throw new Error(
      `isServeRunning called with port=${port} (expected ${SERVE_PORT}). ` +
        `Refusing to probe a non-test port to avoid touching the developer's opencode.`,
    );
  }
  try {
    // The test serve is unsecured (we strip OPENCODE_SERVER_PASSWORD in
    // isolateServeEnv), so a plain curl to / is the right health check.
    const resp = execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/`, {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 5_000,
    });
    return resp.trim().startsWith("2");
  } catch {
    return false;
  }
}

// ── opencode run --attach ────────────────────────────────────────────

export interface RunResult {
  sessionID: string;
  events: unknown[];
  raw: string;
  exitCode: number | null;
  stderr: string;
}

function parseNDJSON(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip non-JSON
    }
  }
  return events;
}

export function runAttach(
  ws: E2EWorkspace,
  prompt: string,
  port = SERVE_PORT,
  opts?: { timeoutMs?: number; model?: string },
): RunResult {
  const result = spawnSync(
    "opencode",
    [
      "run",
      "--attach",
      `http://localhost:${port}`,
      "--format",
      "json",
      "--model",
      opts?.model ?? STM_E2E_MODEL,
      "--dir",
      ws.projectDir,
      "--dangerously-skip-permissions",
      prompt,
    ],
    {
      cwd: ws.projectDir,
      timeout: opts?.timeoutMs ?? RUN_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024,
      env: isolateRunEnv(ws),
    },
  );

  const raw = result.stdout ?? "";
  const events = parseNDJSON(raw);
  const sessionID =
    (events.find((e) => e && typeof e === "object" && "sessionID" in e) as { sessionID?: string } | undefined)
      ?.sessionID ?? "";
  return { sessionID, events, raw, exitCode: result.status, stderr: result.stderr ?? "" };
}

// ── /stm command helper ──────────────────────────────────────────────

/**
 * Drive the /stm slash command through the live opencode instance. The
 * agent is asked to run the /stm command and return the output verbatim.
 */
export function runStmCommand(
  ws: E2EWorkspace,
  action: string,
  port = SERVE_PORT,
  opts?: { timeoutMs?: number },
): RunResult {
  const prompt = `Run the /stm ${action} slash command exactly. ` + `Output its raw response and nothing else.`;
  return runAttach(ws, prompt, port, opts);
}

// ── STM artifact helpers ─────────────────────────────────────────────

export function listMemoryFiles(ws: E2EWorkspace): string[] {
  try {
    const entries = execSync(`ls -1 ${ws.memoryDir} 2>/dev/null`, { encoding: "utf-8" });
    return entries.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function readMemoryFile(ws: E2EWorkspace, name: string): string | null {
  try {
    return readFileSync(join(ws.memoryDir, name), "utf-8");
  } catch {
    return null;
  }
}

export function readLog(ws: E2EWorkspace): string {
  try {
    return readFileSync(join(ws.memoryDir, "session-memory.log"), "utf-8");
  } catch {
    return "";
  }
}

export function readSideSessionsState(ws: E2EWorkspace): string[] {
  try {
    const raw = readFileSync(join(ws.memoryDir, "side-sessions.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Parse the [STM-STARTUP] marker from the captured serve stderr. Returns
 * the elapsed-ms value as a number, or null if the marker is not present.
 */
export function parseStartupTime(ws: E2EWorkspace): number | null {
  try {
    const raw = readFileSync(ws.serveLogPath, "utf-8");
    const match = raw.match(/\[STM-STARTUP\] factory_returned_ms=([\d.]+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Wait for the plugin to load and write its `plugin_loaded` log entry.
 *
 * The plugin is loaded lazily: in opencode >=1.15.x, `serve` starts with
 * `instance: false` and only spins up a per-project InstanceContext (which
 * loads plugins) when a request with `x-opencode-directory: <dir>` reaches
 * the server. The `runAttach(... "ping")` call below triggers that
 * load. Once the InstanceContext is up, the plugin's factory runs, the
 * background init writes the log file, and we can grep for the marker.
 */
export async function waitForStmLoaded(
  ws: E2EWorkspace,
  opts?: { maxWaitMs?: number; pollMs?: number },
): Promise<void> {
  const maxWaitMs = opts?.maxWaitMs ?? 30_000;
  const pollMs = opts?.pollMs ?? 250;

  // Trigger a per-project request so the InstanceContext is created and
  // the plugin's factory is invoked. This run may legitimately fail
  // (e.g. model not available) — we don't care; we only need the
  // request to reach the serve so the plugin is loaded.
  spawnSync(
    "opencode",
    [
      "run",
      "--attach",
      `http://localhost:${SERVE_PORT}`,
      "--format",
      "json",
      "--model",
      STM_E2E_MODEL,
      "--dir",
      ws.projectDir,
      "--dangerously-skip-permissions",
      "ping",
    ],
    {
      cwd: ws.projectDir,
      timeout: 30_000,
      encoding: "utf-8",
      stdio: "pipe",
      env: isolateRunEnv(ws),
    },
  );

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const log = readLog(ws);
    if (log.includes('"event":"plugin_loaded"')) return;
    if (existsSync(join(ws.memoryDir, "session-memory.log"))) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (readLog(ws).includes('"event":"plugin_loaded"')) return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Dump as much diagnostic context as we can.
  const serveTail = (() => {
    try {
      return readFileSync(ws.serveLogPath, "utf-8").slice(-4000);
    } catch {
      return "(no serve log)";
    }
  })();
  const memLogTail = (() => {
    try {
      return readFileSync(join(ws.memoryDir, "session-memory.log"), "utf-8").slice(-2000);
    } catch {
      return "(no memory log)";
    }
  })();
  throw new Error(
    `STM plugin did not load within ${maxWaitMs / 1000}s.\n` +
      `Serve stderr tail:\n${serveTail}\nMemory log tail:\n${memLogTail}`,
  );
}
