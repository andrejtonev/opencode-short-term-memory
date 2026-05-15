import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin, createFakeClient } from "./test-helpers";
import { readText, memoryPathFor } from "../src/memory-utils";

const OPENCODE_TEST_MODEL = process.env.OPENCODE_MEMORY_MODEL_FOR_TESTS || "opencode/minimax-m2.5-free";

const INTEGRATION_TEST_CONFIG = {
  enabled: true,
  memoryModel: OPENCODE_TEST_MODEL,
  summarizerMode: "clean" as const,
  cleanFallbackToActiveSession: false,
  includeAgentsMdOnFirstUpdate: false,
  sideSessionRetries: 2,
  remindEveryN: 1,
  maxMemoryLength: 4000,
  maxUpdateInputLength: 6000,
  debounceMs: 1200,
  debug: false,
  logMaxLines: 300,
  collapseAssistantBursts: true,
};

function integrationPromptResponder(requiredTokens: string[]) {
  return () => {
    const refs = requiredTokens.map((t) => `- ${t}`).join("\n");
    return `## Session Memory\n\n### User Instructions\n${refs}\n\n### Long Horizon Context\n${refs}\n\n### Decisions\n${refs}\n\n### Active References\n${refs}\n`;
  };
}

function withSyntheticNoise(messages: Array<{ role: string; content: string }>) {
  const noisy: Array<{ role: string; content: string }> = [];
  let counter = 0;
  for (const message of messages) {
    noisy.push({ role: "tool", content: `tool trace ${counter++}` });
    noisy.push({ role: "system", content: `internal planning ${counter++}` });
    noisy.push(message);
  }

  // Simulate long assistant "thinking"/stream bursts after the core user turn.
  for (let i = 0; i < 20; i += 1) {
    noisy.push({ role: "assistant", content: `assistant internal chunk ${i + 1}` });
  }
  return noisy;
}

const SCENARIOS = [
  {
    name: "short-tracking-simple",
    messages: [
      { role: "user", content: "I am working on /src/auth.ts" },
      { role: "assistant", content: "Got it, looking at /src/auth.ts" },
      { role: "user", content: "Actually, scratch that, I'm moving to /lib/auth.ts instead" },
    ],
    requiredTokens: ["/lib/auth.ts"],
    excludedTokens: ["/src/auth.ts"],
  },
  {
    name: "long-context-evolution-and-pruning",
    messages: [
      { role: "user", content: "Important to remember: I'm setting up a project with TypeScript." },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "I'm working on the data processing module: /src/data/parser.ts" },
      { role: "assistant", content: "Acknowledged." },
      {
        role: "user",
        content: "Change of plans, I'm refactoring the parser to /lib/parser-v2.ts and ignoring the old one.",
      },
      { role: "assistant", content: "Refactoring to /lib/parser-v2.ts" },
      { role: "user", content: "Also, please use Zod for validation from now on." },
      { role: "user", content: "And keep the logging minimal." },
    ],
    // The memory should retain the current state and ignore the old, rejected paths
    requiredTokens: ["TypeScript", "/lib/parser-v2.ts", "Zod", "logging minimal"],
    excludedTokens: ["/src/data/parser.ts"],
  },
];

const originalCwd = process.cwd();
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalLocalAppData = process.env.LOCALAPPDATA;
let testDir = "";

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "opencode-integration-memory-test-"));
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

for (const scenario of SCENARIOS) {
  test.serial(
    `Integration Test: ${scenario.name}`,
    async () => {
      const sessionID = `integration-${Date.now()}-${scenario.name}`;

      const client = createFakeClient({
        messagesRows: withSyntheticNoise(scenario.messages),
        promptResponder: integrationPromptResponder(scenario.requiredTokens),
      });

      const { plugin } = await createPlugin(INTEGRATION_TEST_CONFIG, client);

      // Trigger update
      await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

      // Assert file contents
      const memoryContent = await readText(memoryPathFor(sessionID), "");
      const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
      const failedToUpdate =
        logText.includes("memory_update_clean_failed_no_fallback") ||
        logText.includes("empty_summarizer_output") ||
        logText.includes("memory_update_error");
      if (failedToUpdate) {
        throw new Error(
          `Integration memory update failed for session ${sessionID}\nLog tail:\n${logText.split(/\r?\n/).slice(-25).join("\n")}`,
        );
      }

      for (const token of scenario.requiredTokens) {
        expect(memoryContent).toContain(token);
      }

      // Proves update path collected visible messages from the session client.
      expect(client.calls.messages.length).toBeGreaterThanOrEqual(1);
      // Proves clean mode created a side session, ran prompt, and cleaned up.
      expect(client.calls.create.length).toBeGreaterThanOrEqual(1);
      expect(client.calls.prompt.length).toBeGreaterThanOrEqual(1);
      expect(client.calls.delete.length).toBeGreaterThanOrEqual(1);

      // Verify that the plugin injects useful memory context into the system prompt.
      const transformOutput = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"](
        { sessionID, messageID: `transform-${scenario.name}` },
        transformOutput,
      );
      expect(transformOutput.system.length).toBe(1);
      for (const token of scenario.requiredTokens) {
        expect(transformOutput.system[0]).toContain(token);
      }
    },
    30000,
  );
}

test.serial(
  "Integration Test: unknown model triggers clean failure then active fallback",
  async () => {
    const sessionID = `integration-unknown-model-${Date.now()}`;
    const fallbackToken = "fallback from active session prompt";
    let cleanPromptAttempted = 0;
    const client = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "Please keep this task in memory." },
        { id: "a1", role: "assistant", content: "Acknowledged." },
      ],
      promptResponder: (args) => {
        const a = args as Record<string, unknown>;
        const body = a?.body as Record<string, unknown> | undefined;
        const model = body?.model as Record<string, unknown> | undefined;
        const modelID = model?.modelID as string | undefined;
        cleanPromptAttempted++;
        // First prompt is for the side session (clean mode) — fail it
        if (cleanPromptAttempted <= 2 && modelID?.includes("__definitely_invalid_model")) {
          throw new Error("Invalid model");
        }
        return `## Session Memory\n\n### Long Horizon Context\n- ${fallbackToken}\n`;
      },
    });

    const { plugin } = await createPlugin(
      {
        ...INTEGRATION_TEST_CONFIG,
        memoryModel: "opencode/__definitely_invalid_model_for_fallback_test__",
        cleanFallbackToActiveSession: true,
        sideSessionRetries: 1,
      },
      client,
    );

    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    const memoryContent = await readText(memoryPathFor(sessionID), "");
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(memoryContent).toContain(fallbackToken);
    // 2 failed clean attempts + 1 successful active fallback
    expect(client.calls.prompt.length).toBe(3);
    expect(logText).toContain("memory_update_clean_failed_fallback");
  },
  30000,
);
