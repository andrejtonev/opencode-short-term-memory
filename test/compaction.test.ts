import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin, createFakeClient } from "./test-helpers";
import { memoryPathFor, readText } from "../src/memory-utils";
import { preflightCleanSummarizerExecutable, resolveTestExecutable } from "./resolve-test-executable";

const OPENCODE_TEST_MODEL = process.env.OPENCODE_MEMORY_MODEL_FOR_TESTS || "opencode/minimax-m2.5-free";

const COMPACTION_TEST_CONFIG = {
  enabled: true,
  memoryModel: OPENCODE_TEST_MODEL,
  summarizerMode: "clean" as const,
  cleanFallbackToActiveSession: false,
  includeAgentsMdOnFirstUpdate: false,
  opencodeExecutable: "",
  sideSessionRetries: 2,
  remindEveryN: 1,
  maxMemoryLength: 4000,
  maxUpdateInputLength: 6000,
  debounceMs: 1200,
  debug: false,
  logMaxLines: 300,
};

const originalCwd = process.cwd();
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalLocalAppData = process.env.LOCALAPPDATA;
let testDir = "";
const resolvedExecutable = await resolveTestExecutable();
const cleanModePreflight = await preflightCleanSummarizerExecutable(resolvedExecutable);
if (!cleanModePreflight.ok) {
  console.warn(`[compaction.test] Skipping clean-mode compaction integration: ${cleanModePreflight.reason}`);
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "opencode-compaction-test-"));
  process.env.XDG_CONFIG_HOME = join(testDir, ".xdg");
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.LOCALAPPDATA;
  process.chdir(testDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  rm(testDir, { recursive: true, force: true }).catch(() => {});
});

test.serial.skipIf(!cleanModePreflight.ok)(
  "predefined memory survives compaction and is injected into system prompt",
  async () => {
    const sessionID = `compact-predefined-${Date.now()}`;
    const messages = [
      { role: "user", content: "Important: project is TypeScript." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "Parser moved to /lib/parser-v2.ts." },
      { role: "assistant", content: "Tracking /lib/parser-v2.ts." },
      { role: "user", content: "Use Zod for validation and keep logging minimal." },
    ];
    const client = createFakeClient({ messagesRows: messages, promptShouldThrow: true });
    const { plugin } = await createPlugin(
      {
        ...COMPACTION_TEST_CONFIG,
        // Strict clean-mode integration: use real opencode executable and do not allow fallback.
        opencodeExecutable: resolvedExecutable,
      },
      client,
    );

    const compactionOutput = { context: [] as string[], system: [] as string[] };
    await plugin["experimental.session.compacting"]({ sessionID }, compactionOutput);

    const memoryContent = await readText(memoryPathFor(sessionID), "");
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    const failedToUpdate =
      logText.includes("memory_update_clean_failed_no_fallback") ||
      logText.includes("empty_summarizer_output") ||
      logText.includes("memory_update_error");
    if (failedToUpdate) {
      throw new Error(
        `Compaction update failed for session ${sessionID}\nExecutable: ${resolvedExecutable}\nLog tail:\n${logText.split(/\r?\n/).slice(-25).join("\n")}`,
      );
    }
    expect(memoryContent).toContain("TypeScript");
    expect(memoryContent).toContain("/lib/parser-v2.ts");
    expect(memoryContent).toContain("Zod");
    expect(memoryContent).toContain("logging");

    expect(compactionOutput.context.length).toBe(1);
    expect(compactionOutput.context[0]).toContain("## Session Memory");
    expect(compactionOutput.context[0]).toContain("/lib/parser-v2.ts");

    const systemOutput = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "post-compact-msg-1" }, systemOutput);

    expect(systemOutput.system.length).toBe(1);
    expect(systemOutput.system[0]).toContain("[MEMORY_SYSTEM]");
    expect(systemOutput.system[0]).toContain("/lib/parser-v2.ts");
    expect(systemOutput.system[0]).toContain("TypeScript");

    // Prove strict clean mode did not fall back to active-session prompt.
    expect(client.calls.messages.length).toBe(1);
    expect(client.calls.prompt.length).toBe(0);
  },
  60000,
);
