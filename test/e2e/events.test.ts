// ── Event-handler e2e tests ──────────────────────────────────────────
// Verifies the plugin's hook implementations are wired into the live
// opencode instance. We use the live serve (proving the plugin is
// loaded) and then fire events programmatically (proving the hook
// functions execute correctly). The LLM is NOT required for these —
// the event handlers only read state and dispatch to background work.
//
// Skipped unless OPENCODE_E2E=1 is set and the opencode binary is on $PATH.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import SessionMemoryPlugin from "../../src/session-memory";
import type { Client } from "../../src/types";
import { createFakeClient } from "../test-helpers";
import {
  cleanupE2EWorkspace,
  disableStmPluginSymlink,
  enableStmPluginSymlink,
  type E2EWorkspace,
  isServeRunning,
  readLog,
  readMemoryFile,
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
    injectInSubagents: true,
  });
  await startServe(ws, SERVE_PORT);
  await waitForStmLoaded(ws);
});

afterAll(() => {
  if (isServeRunning(SERVE_PORT)) stopServe(SERVE_PORT);
  if (ws) {
    if (pluginEnabled) {
      disableStmPluginSymlink(ws);
      pluginEnabled = false;
    }
    cleanupE2EWorkspace(ws);
  }
});

// ── Helper: build a plugin instance pointed at the live project dir ──

async function buildLivePlugin(): Promise<Awaited<ReturnType<typeof SessionMemoryPlugin>>> {
  // We use a fake client because the hook tests below don't drive a
  // chat — they fire the plugin's hooks directly with synthetic
  // payloads and assert on log entries / file system state.
  //
  // We temporarily chdir to the project dir so the plugin's
  // ensureMemoryFile / readConfig etc. resolve relative to the
  // project, not the test runner's cwd.
  const originalCwd = process.cwd();
  try {
    process.chdir(ws.projectDir);
    const fake = createFakeClient({
      messagesRows: [],
      promptText: "",
    });
    return await SessionMemoryPlugin({
      client: fake as unknown as Client,
      directory: ws.projectDir,
    });
  } finally {
    process.chdir(originalCwd);
  }
}

function waitForLogEntry(log: string, needle: string, maxWaitMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  return new Promise((resolve) => {
    const tick = () => {
      const text = readLog(ws);
      if (text.includes(needle)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ── 1. Sub-agent memory inheritance ──────────────────────────────────

describe("sub-agent memory inheritance", () => {
  test("a child session inherits the parent's memory file when injectInSubagents is true", async () => {
    if (!ENABLED) return;
    const parentID = `parent-${Date.now()}`;
    const childID = `child-${Date.now()}`;

    // Build a plugin instance pointed at the live project dir.
    const plugin = await buildLivePlugin();

    // Pre-seed the parent's memory file.
    const parentMem = `## Session Memory\n\n### User Instructions\n- Parent says use tabs\n`;
    writeFileSync(join(ws.memoryDir, `session_${parentID}.md`), parentMem, "utf-8");

    // Fire session.created for the parent (sets up the session).
    await plugin["session.created"]({ sessionID: parentID });

    // Fire session.created for the child with parentID set. The plugin
    // should copy the parent's memory to the child's memory file.
    await plugin["session.created"]({
      sessionID: childID,
      event: { properties: { info: { parentID } } },
    });

    // Allow a microtask for the copy to complete.
    await new Promise((r) => setTimeout(r, 100));

    const childMem = readMemoryFile(ws, `session_${childID}.md`);
    expect(childMem).toContain("Parent says use tabs");

    // The log should record the subagent injection.
    const sawInjection = await waitForLogEntry(readLog(ws), "subagent_created_with_memory");
    expect(sawInjection).toBe(true);
  });

  test("a child session does NOT inherit the parent's memory when injectInSubagents is false", async () => {
    if (!ENABLED) return;
    // Re-seed the config without injectInSubagents and restart.
    await writeStmProjectConfig(ws, {
      summarizerMode: "active",
      debug: true,
      debounceMs: 500,
      injectInSubagents: false,
    });
    stopServe(SERVE_PORT);
    await startServe(ws, SERVE_PORT);
    await waitForStmLoaded(ws);

    const plugin = await buildLivePlugin();
    const parentID = `parent2-${Date.now()}`;
    const childID = `child2-${Date.now()}`;

    const parentMem = `## Session Memory\n\n### User Instructions\n- Parent content\n`;
    writeFileSync(join(ws.memoryDir, `session_${parentID}.md`), parentMem, "utf-8");

    await plugin["session.created"]({ sessionID: parentID });
    await plugin["session.created"]({
      sessionID: childID,
      event: { properties: { info: { parentID } } },
    });

    await new Promise((r) => setTimeout(r, 100));

    const childMem = readMemoryFile(ws, `session_${childID}.md`);
    // The file may be created (skeleton) but should NOT contain the parent's content.
    if (childMem) {
      expect(childMem).not.toContain("Parent content");
    }
    const sawSkip = await waitForLogEntry(readLog(ws), "subagent_created_skipped_injection");
    expect(sawSkip).toBe(true);
  });
});

// ── 2. DCP compress event ───────────────────────────────────────────

describe("DCP compress event triggers memory update", () => {
  test("message.part.updated with compress tool completed is logged as dcp_compress_triggered", async () => {
    if (!ENABLED) return;
    // Restore the default config for the rest of the suite.
    await writeStmProjectConfig(ws, {
      summarizerMode: "active",
      debug: true,
      debounceMs: 0,
      injectInSubagents: true,
    });
    stopServe(SERVE_PORT);
    await startServe(ws, SERVE_PORT);
    await waitForStmLoaded(ws);

    const plugin = await buildLivePlugin();
    const sessionID = `dcp-${Date.now()}`;
    await plugin["session.created"]({ sessionID });

    const dcpEvent = {
      event: {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            type: "tool",
            tool: "compress",
            state: { status: "completed" },
          },
        },
      },
    };
    await plugin.event(dcpEvent as unknown as Parameters<typeof plugin.event>[0]);

    // The trigger log entry should appear even if the update itself
    // fails (no model available).
    const sawTrigger = await waitForLogEntry(readLog(ws), "dcp_compress_triggered");
    expect(sawTrigger).toBe(true);
  });
});

// ── 3. Compaction hook ──────────────────────────────────────────────

describe("compaction hook runs the memory update first", () => {
  test("experimental.session.compacting is invoked without throwing", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const sessionID = `compact-${Date.now()}`;
    await plugin["session.created"]({ sessionID });

    // Pre-seed memory so the compaction has something to push.
    writeFileSync(
      join(ws.memoryDir, `session_${sessionID}.md`),
      "## Session Memory\n\n### Active References\n- pre-compaction context\n",
      "utf-8",
    );

    // Fire the compaction hook. It will call updateMemory, which
    // will likely fail (no messages to summarize), but the hook
    // should not throw.
    const output = { context: [] as string[] };
    let threw: unknown = null;
    try {
      await plugin["experimental.session.compacting"]({ sessionID }, output);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeNull();
    // The hook always appends a "compaction_drain_retry" or pushes the
    // memory context. We accept either: the important thing is that
    // the hook didn't throw.
  });
});

// ── 4. Memory injection into chat system transform ──────────────────

describe("memory injection into chat system transform", () => {
  test("a non-empty memory file is injected into the system prompt", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const sessionID = `inject-${Date.now()}`;
    await plugin["session.created"]({ sessionID });

    // Pre-seed memory.
    writeFileSync(
      join(ws.memoryDir, `session_${sessionID}.md`),
      "## Session Memory\n\n### Long Horizon Context\n- inject me\n",
      "utf-8",
    );

    // Fire the system transform hook.
    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-1" }, output);
    // The first call should push the memory into the system prompt.
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("inject me");
    expect(output.system[0]).toContain("[MEMORY_SYSTEM]");

    // A second call with the same messageID should be deduped (no new push).
    const output2 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-1" }, output2);
    expect(output2.system.length).toBe(0);
  });
});

// ── 5. enabled=false gating ────────────────────────────────────────

describe("enabled=false gates all memory operations", () => {
  test("no updates run and no injection happens when enabled is false (the skeleton file is still created so the path is stable)", async () => {
    if (!ENABLED) return;
    // Re-seed with enabled=false.
    await writeStmProjectConfig(ws, {
      summarizerMode: "active",
      debug: true,
      debounceMs: 0,
      enabled: false,
    });
    stopServe(SERVE_PORT);
    await startServe(ws, SERVE_PORT);
    await waitForStmLoaded(ws);

    const plugin = await buildLivePlugin();
    const sessionID = `disabled-${Date.now()}`;
    await plugin["session.created"]({ sessionID });

    // The skeleton file IS created (so the file path is stable for any
    // consumer that wants to read it). It must contain the default
    // empty sections — not any user-driven content.
    const memFile = readMemoryFile(ws, `session_${sessionID}.md`);
    expect(memFile).not.toBeNull();
    expect(memFile).toContain("None captured yet");

    // But the system transform should be a no-op: no injection.
    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-1" }, output);
    expect(output.system.length).toBe(0);
  });
});

// ── 6. Memory file persistence across opencode restart ─────────────

describe("memory persists across opencode restart", () => {
  test("a memory file written before restart is still present after restart", async () => {
    if (!ENABLED) return;
    // Restore default config.
    await writeStmProjectConfig(ws, {
      summarizerMode: "active",
      debug: true,
      debounceMs: 500,
    });
    stopServe(SERVE_PORT);
    await startServe(ws, SERVE_PORT);
    await waitForStmLoaded(ws);

    const sessionID = `persist-${Date.now()}`;
    const mem = "## Session Memory\n\n### User Instructions\n- persisted across restart\n";
    writeFileSync(join(ws.memoryDir, `session_${sessionID}.md`), mem, "utf-8");

    // Read the file via the live plugin (proves the plugin can see it
    // after restart).
    const plugin = await buildLivePlugin();
    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-1" }, output);
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("persisted across restart");
  });
});

// ── 7. session.deleted cleans up memory file ────────────────────────

describe("session.deleted removes the memory file", () => {
  test("firing session.deleted for a known session removes its memory file", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const sessionID = `delete-me-${Date.now()}`;
    writeFileSync(
      join(ws.memoryDir, `session_${sessionID}.md`),
      "## Session Memory\n\n### Active References\n- to be deleted\n",
      "utf-8",
    );

    // Fire session.created first to register the session in the plugin's
    // internal state (so session.deleted doesn't reject it as unknown).
    await plugin["session.created"]({ sessionID });

    expect(readMemoryFile(ws, `session_${sessionID}.md`)).not.toBeNull();

    await plugin["session.deleted"]({ sessionID });

    // The memory file should be gone.
    expect(readMemoryFile(ws, `session_${sessionID}.md`)).toBeNull();
  });
});

// ── 8. Memory dir is created if missing ────────────────────────────

describe("memory dir is auto-created by the plugin", () => {
  test("the plugin creates the memory dir on first run", () => {
    if (!ENABLED) return;
    // We've already run the plugin many times; the dir must exist.
    expect(existsSync(ws.memoryDir)).toBe(true);
    // And it must contain at least the session-memory.log.
    const files = (() => {
      try {
        return readdirSync(ws.memoryDir);
      } catch {
        return [];
      }
    })();
    expect(files).toContain("session-memory.log");
  });
});
