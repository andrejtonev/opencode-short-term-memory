// ── E2E test for includeAgentsMdOnFirstUpdate ─────────────────────────
//
// (#3 in OPEN_GAPS.md)
//
// When a session's first memory update runs with
// includeAgentsMdOnFirstUpdate: true, the AGENTS.md file at the
// project root is injected into the summarizer prompt. We verify
// by capturing the prompt the model receives via a fake client
// and asserting the AGENTS.md content is present.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
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

// ── 1. AGENTS.md is injected into the first summarizer prompt ──────

describe("includeAgentsMdOnFirstUpdate injects AGENTS.md into the first prompt", () => {
  test("with includeAgentsMdOnFirstUpdate=true, the first summarizer prompt contains the AGENTS.md body", async () => {
    if (!ENABLED) return;

    // Drop a sentinel AGENTS.md at the project root.
    const agentsMdPath = join(ws.projectDir, "AGENTS.md");
    const sentinel = "PROJECT_RULE: always use tabs for indentation.";
    writeFileSync(agentsMdPath, sentinel, "utf-8");

    // Capture every prompt the model receives. We track prompts that
    // contain the AGENTS.md context block.
    const prompts: string[] = [];
    const fake = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "hello" },
        { id: "a1", role: "assistant", content: "hi" },
      ],
      promptResponder: async (args: unknown) => {
        const a = args as { body?: { parts?: Array<{ text?: string }> } };
        const text = a?.body?.parts?.[0]?.text ?? "";
        prompts.push(text);
        return {
          data: {
            parts: [
              {
                type: "text",
                text: "## Session Memory\n\n### Long Horizon Context\n- captured\n",
              },
            ],
          },
        };
      },
    });

    const originalCwd = process.cwd();
    try {
      process.chdir(ws.projectDir);
      // Build a plugin with includeAgentsMdOnFirstUpdate: true.
      const plugin = await SessionMemoryPlugin({
        client: fake as unknown as Client,
        directory: ws.projectDir,
        // Plugin config can be overridden via the opencode.json, but
        // for this test we rely on the project's stm.jsonc. We
        // patch the config in-memory by writing a fresh stm.jsonc.
      });
      // Re-seed the project config to include includeAgentsMdOnFirstUpdate: true.
      await writeStmProjectConfig(ws, {
        summarizerMode: "active",
        debug: true,
        debounceMs: 0,
        logMaxLines: 20000,
        includeAgentsMdOnFirstUpdate: true,
      });
      // The plugin we just built loaded its config from disk at factory
      // time. We need a fresh plugin that reads the new config.
      // (The factory's reloadConfigLocal will pick up the change.)
      const sessionID = `agents-md-${Date.now()}`;
      await plugin["session.created"]({ sessionID });

      // Trigger an update via the tool.
      await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

      // The first prompt must contain the AGENTS.md content.
      expect(prompts.length).toBeGreaterThan(0);
      const firstPrompt = prompts[0] ?? "";
      expect(firstPrompt).toContain("PROJECT_RULE: always use tabs for indentation.");
      expect(firstPrompt).toContain("<agents_md_context>");
      expect(firstPrompt).toContain("</agents_md_context>");
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("with includeAgentsMdOnFirstUpdate=false (default), the first prompt does NOT contain AGENTS.md", async () => {
    if (!ENABLED) return;

    // Reset the config so the default (false) is in effect for this test.
    await writeStmProjectConfig(ws, {
      summarizerMode: "active",
      debug: true,
      debounceMs: 0,
      logMaxLines: 20000,
      includeAgentsMdOnFirstUpdate: false,
    });

    const agentsMdPath = join(ws.projectDir, "AGENTS.md");
    const sentinel = "PROJECT_RULE: this must NOT be in the prompt.";
    writeFileSync(agentsMdPath, sentinel, "utf-8");

    const prompts: string[] = [];
    const fake = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "hello" },
        { id: "a1", role: "assistant", content: "hi" },
      ],
      promptResponder: async (args: unknown) => {
        const a = args as { body?: { parts?: Array<{ text?: string }> } };
        const text = a?.body?.parts?.[0]?.text ?? "";
        prompts.push(text);
        return {
          data: {
            parts: [{ type: "text", text: "## Session Memory\n\n### Long Horizon Context\n- captured\n" }],
          },
        };
      },
    });

    const originalCwd = process.cwd();
    try {
      process.chdir(ws.projectDir);
      const plugin = await SessionMemoryPlugin({
        client: fake as unknown as Client,
        directory: ws.projectDir,
      });
      const sessionID = `no-agents-md-${Date.now()}`;
      await plugin["session.created"]({ sessionID });
      await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

      expect(prompts.length).toBeGreaterThan(0);
      const firstPrompt = prompts[0] ?? "";
      // The default is includeAgentsMdOnFirstUpdate: false → no
      // <agents_md_context> block in the prompt.
      expect(firstPrompt).not.toContain("<agents_md_context>");
      expect(firstPrompt).not.toContain("PROJECT_RULE: this must NOT be in the prompt.");
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("a missing AGENTS.md file does not break the first update", async () => {
    if (!ENABLED) return;

    // Make sure AGENTS.md does NOT exist at the project root.
    const agentsMdPath = join(ws.projectDir, "AGENTS.md");
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(agentsMdPath);
    } catch {
      // ignore — file may not exist
    }

    const prompts: string[] = [];
    const fake = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "hello" },
        { id: "a1", role: "assistant", content: "hi" },
      ],
      promptResponder: async (args: unknown) => {
        const a = args as { body?: { parts?: Array<{ text?: string }> } };
        const text = a?.body?.parts?.[0]?.text ?? "";
        prompts.push(text);
        return {
          data: {
            parts: [{ type: "text", text: "## Session Memory\n\n### Long Horizon Context\n- captured\n" }],
          },
        };
      },
    });

    const originalCwd = process.cwd();
    try {
      process.chdir(ws.projectDir);
      const plugin = await SessionMemoryPlugin({
        client: fake as unknown as Client,
        directory: ws.projectDir,
      });
      // includeAgentsMdOnFirstUpdate: true, but the AGENTS.md is
      // missing — the plugin should handle this gracefully.
      await writeStmProjectConfig(ws, {
        summarizerMode: "active",
        debug: true,
        debounceMs: 0,
        logMaxLines: 20000,
        includeAgentsMdOnFirstUpdate: true,
      });
      const sessionID = `missing-agents-${Date.now()}`;
      await plugin["session.created"]({ sessionID });
      await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

      // The first prompt was sent; no <agents_md_context> block (the
      // file was missing, so the plugin's readText returned "").
      expect(prompts.length).toBeGreaterThan(0);
      const firstPrompt = prompts[0] ?? "";
      expect(firstPrompt).not.toContain("<agents_md_context>");
      // The memory file was still written.
      const memFile = readMemoryFile(ws, `session_${sessionID}.md`);
      expect(memFile).toContain("## Session Memory");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
