// ── Direct hook contract tests ───────────────────────────────────────
// These tests fire the plugin's hooks directly with synthetic payloads
// to verify the wire contract. They are independent of the live LLM
// round-trip and the live opencode serve; the live serve is only used
// to make `waitForStmLoaded` work so the workspace is initialized.
//
// Gaps closed (from the mutation report):
//   * `command.execute.before` — was untested directly; the model was
//     calling the `short_term_memory` tool instead, masking the hook.
//   * `chat.message` — never fired in any e2e test.
//   * `safeSessionID` — path-traversal protection not e2e-tested.
//   * `remindEveryN` count + `INJECTION_PREFIX` skip — not e2e-tested.
//   * `lastInjectedSignature` / `duplicateWindowMs` dedup — only the
//     messageID dedup branch was tested; the signature/timeout branch
//     was defense-in-depth.
//
// Skipped unless OPENCODE_E2E=1 is set and the opencode binary is on $PATH.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
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
    logMaxLines: 20000,
    remindEveryN: 1,
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

// ── Helpers ──────────────────────────────────────────────────────────

async function buildLivePlugin(): Promise<Awaited<ReturnType<typeof SessionMemoryPlugin>>> {
  const originalCwd = process.cwd();
  try {
    process.chdir(ws.projectDir);
    const fake = createFakeClient({ messagesRows: [], promptText: "" });
    return await SessionMemoryPlugin({
      client: fake as unknown as Client,
      directory: ws.projectDir,
    });
  } finally {
    process.chdir(originalCwd);
  }
}

function waitForLogEntry(needle: string, maxWaitMs = 5_000): Promise<boolean> {
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

function logHas(needle: string): boolean {
  return readLog(ws).includes(needle);
}

// ── 1. command.execute.before direct hook ────────────────────────────

describe("command.execute.before hook (direct)", () => {
  test("sets output.stop=true and output.message=status text for /stm status", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const output: { stop?: boolean; message?: string } = {};
    await plugin["command.execute.before"]({ command: { name: "stm", argument: "status" } }, output as never);
    // The hook must short-circuit the LLM.
    expect(output.stop).toBe(true);
    expect(typeof output.message).toBe("string");
    expect(output.message).toMatch(/Session Memory Plugin Status/i);
  });

  test("sets output.message=settings JSON for /stm settings", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const output: { stop?: boolean; message?: string } = {};
    await plugin["command.execute.before"]({ command: { name: "stm", argument: "settings" } }, output as never);
    expect(output.stop).toBe(true);
    // settings returns JSON; the hook must surface it as a string.
    expect(() => JSON.parse(output.message ?? "")).not.toThrow();
    const parsed = JSON.parse(output.message ?? "{}");
    expect(parsed.memoryModel).toBeTypeOf("string");
  });

  test("returns the default memory skeleton for /stm show on a fresh session", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const sessionID = `cmd-show-${Date.now()}`;
    // Pre-create the session so the file is bootstrapped.
    await plugin["session.created"]({ sessionID });
    const output: { stop?: boolean; message?: string } = {};
    await plugin["command.execute.before"](
      {
        command: { name: "stm", argument: "show" },
        sessionID,
      },
      output as never,
    );
    expect(output.stop).toBe(true);
    expect(output.message).toContain("## Session Memory");
    expect(output.message).toContain("None captured yet");
  });

  test("resets and recreates the skeleton for /stm reset", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const sessionID = `cmd-reset-${Date.now()}`;
    await plugin["session.created"]({ sessionID });
    // Pollute the file with custom content.
    const memPath = join(ws.memoryDir, `session_${sessionID}.md`);
    writeFileSync(memPath, "## Session Memory\n\n### Active References\n- pollution\n", "utf-8");
    expect(readMemoryFile(ws, `session_${sessionID}.md`)).toContain("pollution");

    const output: { stop?: boolean; message?: string } = {};
    await plugin["command.execute.before"]({ command: { name: "stm", argument: "reset" }, sessionID }, output as never);
    expect(output.stop).toBe(true);
    expect(output.message).toContain("Reset memory");
    // The file is recreated as the default skeleton.
    const after = readMemoryFile(ws, `session_${sessionID}.md`);
    expect(after).not.toBeNull();
    expect(after).toContain("None captured yet");
    expect(after).not.toContain("pollution");
    // The log records the reset.
    expect(logHas("memory_reset")).toBe(true);
  });

  test("ignores non-stm commands (does not set stop=true)", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const output: { stop?: boolean; message?: string } = {};
    await plugin["command.execute.before"]({ command: { name: "foo", argument: "bar" } }, output as never);
    // A non-stm command must NOT short-circuit; the LLM continues.
    expect(output.stop).toBeFalsy();
  });

  test("treats a missing argument as 'status' (parseMemoryActionFromCommandArgument)", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const output: { stop?: boolean; message?: string } = {};
    await plugin["command.execute.before"]({ command: { name: "stm" } }, output as never);
    expect(output.stop).toBe(true);
    expect(output.message).toMatch(/Session Memory Plugin Status/i);
  });

  test("strips extra whitespace from the argument", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const output: { stop?: boolean; message?: string } = {};
    await plugin["command.execute.before"]({ command: { name: "stm", argument: "   settings   " } }, output as never);
    expect(output.stop).toBe(true);
    expect(() => JSON.parse(output.message ?? "")).not.toThrow();
  });

  test("falls back to status when the action is unknown", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const output: { stop?: boolean; message?: string } = {};
    await plugin["command.execute.before"]({ command: { name: "stm", argument: "nonsense-action" } }, output as never);
    // Unknown actions still return the status text (or the "Unknown action"
    // message); either way the hook fires and stop=true is set.
    expect(output.stop).toBe(true);
    expect(typeof output.message).toBe("string");
  });
});

// ── 2. chat.message hook ──────────────────────────────────────────────

async function warmUpPlugin(plugin: Awaited<ReturnType<typeof buildLivePlugin>>): Promise<void> {
  // The plugin's runBackgroundInit is deferred to a microtask and writes
  // a `plugin_loaded` log line. Any test that diffs the log file size
  // around a hook invocation must wait for that initial write to settle
  // first, or it will see the `plugin_loaded` line as noise.
  await plugin.event({} as never);
  await waitForLogEntry("plugin_loaded", 5_000);
}

describe("chat.message hook (direct)", () => {
  test("logs a user message and skips assistant messages", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    await warmUpPlugin(plugin);
    const sessionID = `chat-${Date.now()}`;

    // User message: should produce a chat_message log entry.
    await plugin["chat.message"]({ sessionID, message: { role: "user", content: "hello world from e2e" } }, {
      message: { role: "user", content: "hello world from e2e" },
    } as never);
    const saw = await waitForLogEntry("chat_message", 3_000);
    expect(saw).toBe(true);

    // Assistant message: should NOT produce another chat_message log entry.
    const logSizeBefore = readLog(ws).length;
    await plugin["chat.message"]({ sessionID, message: { role: "assistant", content: "ack" } }, {
      message: { role: "assistant", content: "ack" },
    } as never);
    // Give the handler a moment.
    await new Promise((r) => setTimeout(r, 100));
    const logSizeAfter = readLog(ws).length;
    expect(logSizeAfter).toBe(logSizeBefore);
  });

  test("skips a self-injection message that contains [MEMORY_SYSTEM]", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    await warmUpPlugin(plugin);
    const sessionID = `chat-self-${Date.now()}`;
    const logSizeBefore = readLog(ws).length;
    await plugin["chat.message"](
      {
        sessionID,
        message: { role: "user", content: "[MEMORY_SYSTEM] injected memory" },
      },
      { message: { role: "user", content: "[MEMORY_SYSTEM] injected memory" } } as never,
    );
    await new Promise((r) => setTimeout(r, 100));
    const logSizeAfter = readLog(ws).length;
    // No log line should have been written (self-injection is filtered).
    expect(logSizeAfter).toBe(logSizeBefore);
  });
});

// ── 3. safeSessionID path-traversal protection ───────────────────────

describe("safeSessionID path-traversal protection", () => {
  test("a sessionID with path traversal chars is stored under a sanitized filename", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const evilID = `../../etc/passwd-${Date.now()}`;
    // The plugin must not write to a path outside the memoryDir.
    // memoryPathFor replaces anything outside [a-zA-Z0-9_.-] with '_'.
    await plugin["session.created"]({ sessionID: evilID });
    // No file under <memoryDir> should contain the literal traversal sequence.
    const { readdirSync } = (await import("node:fs")) as typeof import("node:fs");
    const files = readdirSync(ws.memoryDir) as string[];
    // The expected file uses the sanitized form: ../../etc/passwd-12345
    // → "______etc_passwd-12345.md"
    const safeName = evilID.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const expected = `session_${safeName}.md`;
    expect(files).toContain(expected);
    // The file is inside the memory dir, not at /etc/passwd.
    const memFile = readMemoryFile(ws, expected);
    expect(memFile).not.toBeNull();
    expect(memFile).toContain("## Session Memory");
  });
});

// ── 4. INJECTION_PREFIX skip ─────────────────────────────────────────

describe("memory injection is skipped when the system prompt already has the prefix", () => {
  test("a system transform that already contains [MEMORY_SYSTEM] does not push again", async () => {
    if (!ENABLED) return;
    const plugin = await buildLivePlugin();
    const sessionID = `prefix-${Date.now()}`;
    await plugin["session.created"]({ sessionID });
    writeFileSync(
      join(ws.memoryDir, `session_${sessionID}.md`),
      "## Session Memory\n\n### Active References\n- present in upstream\n",
      "utf-8",
    );

    // First call: pushes the memory into the system prompt.
    const out1 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-A" }, out1 as never);
    expect(out1.system.length).toBe(1);
    expect(out1.system[0]).toContain("[MEMORY_SYSTEM]");

    // Second call: the system prompt already has [MEMORY_SYSTEM] upstream;
    // the hook must NOT push a second time.
    const out2 = {
      system: ["[MEMORY_SYSTEM] already pushed by upstream layer", "## Session Memory"],
    };
    const beforeLen = out2.system.length;
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-B" }, out2 as never);
    expect(out2.system.length).toBe(beforeLen);
  });
});

// ── 5. remindEveryN count ────────────────────────────────────────────

describe("remindEveryN controls how often the memory is injected", () => {
  test("with remindEveryN=2, only every 2nd user turn triggers injection", async () => {
    if (!ENABLED) return;
    // Re-seed with remindEveryN=2.
    await writeStmProjectConfig(ws, {
      summarizerMode: "active",
      debug: true,
      debounceMs: 500,
      remindEveryN: 2,
    });
    stopServe(SERVE_PORT);
    await startServe(ws, SERVE_PORT);
    await waitForStmLoaded(ws);

    const plugin = await buildLivePlugin();
    const sessionID = `remind-${Date.now()}`;
    await plugin["session.created"]({ sessionID });
    writeFileSync(
      join(ws.memoryDir, `session_${sessionID}.md`),
      "## Session Memory\n\n### Active References\n- periodic\n",
      "utf-8",
    );

    // Turn 1: should be skipped (count=1, remindEveryN=2 → 1 % 2 !== 0).
    const out1 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-1" }, out1 as never);
    expect(out1.system.length).toBe(0);

    // Turn 2: should inject (count=2, 2 % 2 === 0).
    const out2 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-2" }, out2 as never);
    expect(out2.system.length).toBe(1);
    expect(out2.system[0]).toContain("periodic");
  });
});

// ── 6. lastInjectedSignature dedup ───────────────────────────────────

describe("memory injection dedups the same messageID within the duplicate window", () => {
  test("two transform calls with the same messageID in rapid succession produce only one push", async () => {
    if (!ENABLED) return;
    // Re-seed with default remindEveryN=1 (so the counter gate is open
    // and the signature dedup is the only thing that can block re-push).
    await writeStmProjectConfig(ws, {
      summarizerMode: "active",
      debug: true,
      debounceMs: 500,
      remindEveryN: 1,
    });
    stopServe(SERVE_PORT);
    await startServe(ws, SERVE_PORT);
    await waitForStmLoaded(ws);

    const plugin = await buildLivePlugin();
    const sessionID = `dedup-${Date.now()}`;
    await plugin["session.created"]({ sessionID });
    writeFileSync(
      join(ws.memoryDir, `session_${sessionID}.md`),
      "## Session Memory\n\n### Active References\n- dedup me\n",
      "utf-8",
    );

    // First call: no previous signature → push.
    const out1 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-X" }, out1 as never);
    expect(out1.system.length).toBe(1);
    expect(out1.system[0]).toContain("dedup me");

    // Second call: same messageID, same content, within the
    // duplicate window (>= 2.5s). The signature-based dedup must
    // block the second push.
    const out2 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-X" }, out2 as never);
    expect(out2.system.length).toBe(0);
  });
});
