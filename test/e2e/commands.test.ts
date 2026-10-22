// ── /stm command e2e tests ───────────────────────────────────────────
// Exercises legacy server commands through a live OpenCode instance.
// The host still generates model output after the hook; read commands
// return fixed native-command guidance without forwarding local file contents.
// Native dialogs are verified separately in test/v1-tui.test.ts.
//
// Skipped unless OPENCODE_E2E=1 is set and the opencode binary is on $PATH.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";

import {
  cleanupE2EWorkspace,
  disableStmPluginSymlink,
  enableStmPluginSymlink,
  type E2EWorkspace,
  readLog,
  readMemoryFile,
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
  await writeStmProjectConfig(ws, {
    summarizerMode: "active",
    debug: true,
    debounceMs: 500,
    remindEveryN: 1,
    // Keep enough log history for the /stm logs test to find the
    // plugin_loaded marker. The default 300 lines gets trimmed off
    // after the summarizer runs a few chunks.
    logMaxLines: 20000,
  });
  // Ensure the memory dir exists so the plugin's ensureMemoryFile
  // doesn't race with the first /stm command.
  mkdirSync(ws.memoryDir, { recursive: true });
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

for (const action of ["show", "settings", "logs", "status"]) {
  describe(`/stm ${action} redirects to the native read dialog`, () => {
    test("returns native-command guidance through the legacy model response", async () => {
      if (!ENABLED) return;
      const result = runStmCommand(ws, action, SERVE_PORT, { timeoutMs: 60_000 });
      expect(result.sessionID).toBeTruthy();
      expect(result.agentText).toContain(`/stm-${action}`);
    });
  });
}

describe("/stm reset clears the memory file", () => {
  test("reset creates the default skeleton for the current session", async () => {
    if (!ENABLED) return;
    const result = runStmCommand(ws, "reset", SERVE_PORT, { timeoutMs: 60_000 });
    expect(result.sessionID).toBeTruthy();
    // The agent runs the command and returns. The reset path
    // removePath + ensureMemoryFile, so the current session's
    // memory file is the default skeleton.
    expect(result.agentText).toContain("Reset memory");
    // The log should have a memory_reset entry.
    const log = readLog(ws);
    expect(log).toContain("memory_reset");
  });
});

describe("memory file is created for the session that triggered plugin load", () => {
  test("a session_*.md file exists with the default skeleton", () => {
    if (!ENABLED) return;
    // After waitForStmLoaded, the plugin has run for at least the warm-up
    // session. There should be at least one session_*.md file written
    // by the plugin (not pre-seeded).
    const files = (() => {
      try {
        const { readdirSync } = require("node:fs");
        return readdirSync(ws.memoryDir);
      } catch {
        return [];
      }
    })();
    const memFiles = files.filter((f: string) => f.startsWith("session_") && f.endsWith(".md"));
    expect(memFiles.length).toBeGreaterThan(0);
    // And the file should have the default skeleton, not be empty
    // or stale. This catches a plugin that creates the file but
    // leaves it blank.
    const memFile = readMemoryFile(ws, memFiles[0]);
    expect(memFile).toContain("## Session Memory");
    expect(memFile).toContain("None captured yet");
  });
});
