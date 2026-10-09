// ── STM e2e tests ────────────────────────────────────────────────────
// Live `opencode serve` instance + symlinked local plugin. Skipped unless
// OPENCODE_E2E=1 is exported and the `opencode` binary is on $PATH. See
// test/e2e/README.md for how to run.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  cleanupE2EWorkspace,
  disableStmPluginSymlink,
  enableStmPluginSymlink,
  type E2EWorkspace,
  listMemoryFiles,
  parseStartupTime,
  readLog,
  readMemoryFile,
  readSideSessionsState,
  runAttach,
  runStmCommand,
  setupE2EWorkspace,
  shouldRunE2E,
  startServe,
  stopServe,
  waitForStmLoaded,
  writeStmProjectConfig,
} from "./harness.js";

const ENABLED = shouldRunE2E();
const SERVE_PORT = Number(process.env.STM_E2E_PORT ?? 18999);

let ws: E2EWorkspace;
let pluginEnabled = false;

beforeAll(async () => {
  if (!ENABLED) return;
  ws = setupE2EWorkspace();
  enableStmPluginSymlink(ws);
  pluginEnabled = true;
  await writeStmProjectConfig(ws, { summarizerMode: "active", debug: true, debounceMs: 300 });
  await startServe(ws, SERVE_PORT);
  await waitForStmLoaded(ws);
});

afterAll(async () => {
  await stopServe(SERVE_PORT);
  if (ws) {
    if (pluginEnabled) {
      disableStmPluginSymlink(ws);
      pluginEnabled = false;
    }
    cleanupE2EWorkspace(ws);
  }
});

// ── 1. Plugin loads + smoke ──────────────────────────────────────────

describe("plugin loads and /stm status works", () => {
  test("plugin_loaded log entry was written by the background init", () => {
    if (!ENABLED) return;
    // The harness's `waitForStmLoaded` polls for this marker before
    // the suite starts, so this test is a sanity check that the
    // marker is the JSONL line the rest of the suite greps for.
    const log = readLog(ws);
    expect(log).toContain('"event":"plugin_loaded"');
  });

  test("stm status returns the plugin status text", async () => {
    if (!ENABLED) return;
    const result = runStmCommand(ws, "status", SERVE_PORT, { timeoutMs: 120_000 });
    // The session was created → the opencode plugin is registered and the
    // tool is visible to the agent. This is the strongest signal we can
    // get from outside opencode that the plugin is wired in.
    expect(result.sessionID).toBeTruthy();
    // With the configured model reachable, the agent echoes the
    // /stm status output. We assert on the extracted agent text
    // (text events + tool output) — not on the raw NDJSON stream —
    // so the test is model-agnostic.
    expect(result.agentText).toMatch(/Session Memory Plugin Status/i);
    expect(result.agentText).toContain("summarizerMode");
  });

  test("a chat produces a memory file in the project .opencode/memory/", async () => {
    if (!ENABLED) return;
    // Wait for the previous status run to settle (no other opencode call
    // shares the same session; each `runAttach` returns a fresh sessionID).
    const before = listMemoryFiles(ws);
    const result = runAttach(ws, "Reply with exactly the word DONE and nothing else.", SERVE_PORT, {
      timeoutMs: 120_000,
    });
    const diagnostics = JSON.stringify(
      {
        projectDir: ws.projectDir,
        exitCode: result.exitCode,
        eventCount: result.events.length,
        stdoutTail: result.raw.slice(-4000),
        stderrTail: result.stderr.slice(-4000),
        memoryLogTail: readLog(ws).slice(-4000),
      },
      null,
      2,
    );
    expect(result.sessionID, diagnostics).toBeTruthy();
    expect(result.events.length, diagnostics).toBeGreaterThan(0);

    // Wait for the post-idle memory bootstrap to write a session file.
    const deadline = Date.now() + 15_000;
    let files = before;
    while (Date.now() < deadline) {
      files = listMemoryFiles(ws);
      const newOnes = files.filter((f) => !before.includes(f));
      if (newOnes.some((f) => f.startsWith("session_") && f.endsWith(".md"))) {
        const memFile = newOnes.find((f) => f.startsWith("session_") && f.endsWith(".md"));
        const contents = readMemoryFile(ws, memFile!);
        expect(contents).toContain("## Session Memory");
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`No new session_*.md was created within 15s. Files now: ${files.join(", ")}`);
  });
});

// ── 2. Side session tracking end-to-end ──────────────────────────────

describe("clean summarizer side session tracking", () => {
  test("clean update creates and deletes a side session; tracking file is empty after", async () => {
    if (!ENABLED) return;
    // Re-seed config for clean mode and tighter debounce so the test
    // doesn't wait 30s of idle debounce.
    await writeStmProjectConfig(ws, { summarizerMode: "clean", debug: true, debounceMs: 200 });
    // Restart the serve so the new config takes effect.
    await stopServe(SERVE_PORT);
    await startServe(ws, SERVE_PORT);
    await waitForStmLoaded(ws);

    // Run a manual /stm update which forces the clean summarizer path.
    const result = runStmCommand(ws, "update", SERVE_PORT, { timeoutMs: 120_000 });
    expect(result.sessionID).toBeTruthy();

    // Wait for the summarizer to finish and the side session to be deleted.
    // The tracking file should be empty (or absent) once cleanup runs.
    const deadline = Date.now() + 60_000;
    let tracked: string[] = ["placeholder"];
    while (Date.now() < deadline && tracked.length > 0) {
      tracked = readSideSessionsState(ws);
      if (tracked.length === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(tracked).toEqual([]);

    // The log should record the side session lifecycle.
    const log = readLog(ws);
    expect(log).toContain('"event":"side_session_created"');
    expect(log).toContain('"event":"side_session_summarize_done"');
  });
});

// ── 3. Orphan cleanup on next startup ────────────────────────────────

describe("orphan side sessions cleaned up on next opencode startup", () => {
  test("stale side-sessions.json entries are deleted when serve restarts", async () => {
    if (!ENABLED) return;
    // Simulate a crashed run: write stale session IDs into the tracking file.
    const statePath = join(ws.memoryDir, "side-sessions.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(statePath, JSON.stringify(["orphan-A", "orphan-B"]), "utf-8");

    // Restart serve → plugin should run cleanupOrphanedSideSessions and
    // delete both stale entries.
    await stopServe(SERVE_PORT);
    await startServe(ws, SERVE_PORT);
    await waitForStmLoaded(ws);

    // Give the background init a moment to run cleanup.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const log = readLog(ws);
      if (log.includes("orphan_side_sessions_cleanup_done")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const log = readLog(ws);
    expect(log).toContain("orphan_side_sessions_cleanup_start");
    expect(log).toContain("orphan_side_sessions_cleanup_done");

    // After cleanup, the tracking file should be empty (both deletes succeed).
    expect(readSideSessionsState(ws)).toEqual([]);

    // Side-session cleanup remains scoped to the isolated workspace.
    expect(existsSync(statePath)).toBe(true);
  });
});

// ── 4. Startup time <10ms under live opencode ───────────────────────

describe("factory startup is <10ms under a live opencode", () => {
  test("factory_returned_ms is under 10ms in the serve stderr", async () => {
    if (!ENABLED) return;
    // Restart so we capture a fresh [STM-STARTUP] line.
    await stopServe(SERVE_PORT);
    await startServe(ws, SERVE_PORT);
    await waitForStmLoaded(ws);

    const elapsed = parseStartupTime(ws);
    expect(elapsed).not.toBeNull();
    if (elapsed === null) return;
    // Hard requirement. The unit test in side-sessions-cleanup.test.ts
    // already asserts <50ms; this is the live e2e bound.
    expect(elapsed).toBeLessThan(10);
  });
});

// ── 5. Isolated XDG config remains unpolluted ───────────────────────

describe("isolated XDG config remains unpolluted", () => {
  test("startup does not create an isolated global stm.jsonc", () => {
    if (!ENABLED) return;
    // Plugin startup must not create a global STM config in the isolated
    // XDG_CONFIG_HOME. The user's real config is intentionally not inspected.
    const isolatedGlobal = join(ws.xdgHome, "opencode", "stm.jsonc");
    expect(existsSync(isolatedGlobal)).toBe(false);
  });
});
