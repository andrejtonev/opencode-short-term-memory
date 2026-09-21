import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  MEMORY_HEADER,
  checkpointPathFor,
  memoryPathFor,
  tailLog,
  writeText,
  type RuntimeState,
} from "../src/memory-utils";
import { collectVisibleMessagesSinceCheckpoint } from "../src/message-collector";
import { processMemoryChunks } from "../src/memory-lifecycle";
import { runActiveSessionSummarizer, runCleanOpencodeSummarizer, type SummarizerRuntime } from "../src/summarizer";
import type { Client } from "../src/types";

const VALID_SUMMARY = `${MEMORY_HEADER}\n\n### User Instructions\n- keep this\n\n### Long Horizon Context\n- stable`;

type PromptCall = {
  sessionId: string;
  prompt: {
    noReply?: unknown;
    model?: { providerID: string; modelID: string };
    parts?: Array<{ text?: string }>;
  };
};

function assistantEnvelope(text: string) {
  return { data: { info: { role: "assistant" }, parts: [{ type: "text", text }] } };
}

function runtimeState(): RuntimeState {
  return { updateCount: 0, injectCount: 0, injectCharCount: 0, compactCount: 0 };
}

function config(memoryDir: string, summarizerMode: "clean" | "active") {
  return {
    ...DEFAULT_CONFIG,
    memoryDir,
    summarizerMode,
    sideSessionRetries: 0,
    cleanFallbackToActiveSession: false,
    debounceMs: 0,
  };
}

function runtimeFor(response: unknown, promptCalls: PromptCall[] = []): SummarizerRuntime {
  return {
    createTemporarySession: async () => ({ id: "side-summarizer-1" }),
    deliverGeneratedPrompt: async (request) => {
      promptCalls.push(request as PromptCall);
      return response;
    },
    abortTemporarySession: async () => {},
    deleteTemporarySession: async () => {},
  };
}

function uiClient(): Client {
  return { tui: { showToast: async () => {} } } as unknown as Client;
}

describe("summarizer SDK envelopes", () => {
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "stm-summarizer-correctness-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("both summarizers accept an assistant envelope and omit noReply from generated-summary prompts", async () => {
    const memoryDir = join(testDir, "memory");
    const promptCalls: PromptCall[] = [];
    const runtime = runtimeFor(assistantEnvelope(VALID_SUMMARY), promptCalls);
    const cfg = config(memoryDir, "clean");

    await expect(runCleanOpencodeSummarizer(runtime, "clean prompt", cfg)).resolves.toBe(VALID_SUMMARY);
    await expect(
      runActiveSessionSummarizer(runtime, "session-1", "active prompt", { ...cfg, summarizerMode: "active" }),
    ).resolves.toBe(VALID_SUMMARY);

    expect(promptCalls).toHaveLength(2);
    for (const call of promptCalls) {
      expect(call.prompt.parts?.[0]?.text).toBeTruthy();
      expect("noReply" in call.prompt).toBe(false);
      expect("model" in call.prompt).toBe(false);
    }
  });

  test("both summarizers send an explicit valid model override", async () => {
    const memoryDir = join(testDir, "explicit-model");
    const promptCalls: PromptCall[] = [];
    const runtime = runtimeFor(assistantEnvelope(VALID_SUMMARY), promptCalls);
    const cfg = { ...config(memoryDir, "clean"), memoryModel: "openai/gpt-5.3" };

    await runCleanOpencodeSummarizer(runtime, "clean prompt", cfg);
    await runActiveSessionSummarizer(runtime, "session-1", "active prompt", {
      ...cfg,
      summarizerMode: "active",
    });

    expect(promptCalls).toHaveLength(2);
    for (const call of promptCalls) {
      expect(call.prompt.model).toEqual({ providerID: "openai", modelID: "gpt-5.3" });
    }
  });

  const rejectedResponses: Array<[string, unknown, string]> = [
    [
      "UserMessage envelope",
      { data: { info: { role: "user" }, parts: [{ type: "text", text: VALID_SUMMARY }] } },
      "assistant role",
    ],
    ["missing role", { data: { info: {}, parts: [{ type: "text", text: VALID_SUMMARY }] } }, "assistant role"],
    [
      "assistant content/text without parts",
      { data: { info: { role: "assistant" }, content: { text: VALID_SUMMARY } } },
      "parts array",
    ],
    ["empty assistant response", assistantEnvelope("   "), "empty output"],
    [
      "assistant parts response without memory header",
      assistantEnvelope("### User Instructions\n- retained instruction"),
      `output without ${MEMORY_HEADER}`,
    ],
    [
      "assistant template echo",
      assistantEnvelope(
        `${MEMORY_HEADER}\n<existing_memory>echo</existing_memory>\n<conversation_update>echo</conversation_update>`,
      ),
      "raw prompt-template markers",
    ],
    [
      "assistant agents context template echo",
      assistantEnvelope(`${MEMORY_HEADER}\n<agents_md_context>echo</agents_md_context>`),
      "raw prompt-template markers",
    ],
  ];

  for (const [label, response, expectedError] of rejectedResponses) {
    test(`rejects ${label} for clean and active summarizers`, async () => {
      const memoryDir = join(testDir, label.replaceAll(" ", "-"));
      const cfg = config(memoryDir, "clean");
      const cleanCalls: PromptCall[] = [];
      const activeCalls: PromptCall[] = [];

      await expect(runCleanOpencodeSummarizer(runtimeFor(response, cleanCalls), "clean prompt", cfg)).rejects.toThrow(
        expectedError,
      );
      await expect(
        runActiveSessionSummarizer(runtimeFor(response, activeCalls), "session-active-rejected", "active prompt", {
          ...cfg,
          summarizerMode: "active",
        }),
      ).rejects.toThrow(expectedError);

      expect(cleanCalls[0]?.prompt.parts?.[0]?.text).toBe("clean prompt");
      expect(activeCalls[0]?.prompt.parts?.[0]?.text).toBe("active prompt");
      expect("noReply" in (cleanCalls[0]?.prompt ?? {})).toBe(false);
      expect("noReply" in (activeCalls[0]?.prompt ?? {})).toBe(false);

      const log = await tailLog(50, memoryDir);
      expect(log).toContain('"event":"active_session_summarizer_error"');
      expect(log).not.toContain('"event":"active_session_summarizer_done"');
      expect(log).not.toContain('"event":"side_session_summarize_done"');
    });
  }

  test("a rejected clean response preserves memory and checkpoint and emits a failure event", async () => {
    const memoryDir = join(testDir, "clean-lifecycle");
    const sessionID = "session-clean-rejected";
    const memoryPath = memoryPathFor(sessionID, memoryDir);
    const checkpointPath = checkpointPathFor(sessionID, memoryDir);
    const existing = `${MEMORY_HEADER}\n\n### Decisions\n- pre-existing byte content\n`;
    await writeText(memoryPath, existing);
    await writeText(checkpointPath, "checkpoint-clean\n");
    const cfg = config(memoryDir, "clean");

    const wrote = await processMemoryChunks(
      uiClient(),
      runtimeFor({ data: { info: { role: "user" }, parts: [{ type: "text", text: VALID_SUMMARY }] } }),
      sessionID,
      "rejected-clean",
      cfg,
      memoryPath,
      existing,
      [{ rendered: "USER:\nnew input", lastMessageID: "message-clean" }],
      "",
      runtimeState(),
    );

    expect(wrote).toBe(false);
    expect(await readFile(memoryPath, "utf8")).toBe(existing);
    expect(await readFile(checkpointPath, "utf8")).toBe("checkpoint-clean\n");
    const log = await tailLog(50, memoryDir);
    expect(log).toContain('"event":"memory_update_clean_failed_no_fallback"');
    expect(log).not.toContain('"event":"side_session_summarize_done"');
  });

  test("a rejected active response preserves memory and checkpoint and emits a failure event", async () => {
    const memoryDir = join(testDir, "active-lifecycle");
    const sessionID = "session-active-rejected";
    const memoryPath = memoryPathFor(sessionID, memoryDir);
    const checkpointPath = checkpointPathFor(sessionID, memoryDir);
    const existing = `${MEMORY_HEADER}\n\n### Conclusions\n- active pre-existing bytes\n`;
    await writeText(memoryPath, existing);
    await writeText(checkpointPath, "checkpoint-active\n");
    const cfg = config(memoryDir, "active");
    const state = runtimeState();

    await expect(
      processMemoryChunks(
        uiClient(),
        runtimeFor({ data: { info: { role: "user" }, parts: [{ type: "text", text: VALID_SUMMARY }] } }),
        sessionID,
        "rejected-active",
        cfg,
        memoryPath,
        existing,
        [{ rendered: "USER:\nnew input", lastMessageID: "message-active" }],
        "",
        state,
      ),
    ).rejects.toThrow("assistant role");

    expect(await readFile(memoryPath, "utf8")).toBe(existing);
    expect(await readFile(checkpointPath, "utf8")).toBe("checkpoint-active\n");
    expect(state.updateCount).toBe(0);
    const log = await tailLog(50, memoryDir);
    expect(log).toContain('"event":"active_session_summarizer_error"');
    expect(log).not.toContain('"event":"active_session_summarizer_done"');
  });
});

test("collection excludes an active-session generated summary to preserve the recursion invariant", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "stm-collection-correctness-"));
  try {
    const memoryDir = join(testDir, "memory");
    const rows = [
      {
        id: "generated-summary",
        info: { id: "generated-summary", role: "assistant", time: { created: 1 } },
        parts: [{ type: "text", text: `${MEMORY_HEADER}\n\n### Conclusions\n- generated summary` }],
      },
      {
        id: "visible-assistant",
        info: { id: "visible-assistant", role: "assistant", time: { created: 2 } },
        parts: [{ type: "text", text: "ordinary assistant response" }],
      },
    ];
    const requestedLimits: Array<number | undefined> = [];
    const reader = {
      readSessionMessages: async (readSessionID: string, options?: { limit?: number }): Promise<readonly unknown[]> => {
        expect(readSessionID).toBe("session-collection");
        requestedLimits.push(options?.limit);
        return rows;
      },
    };

    const collected = await collectVisibleMessagesSinceCheckpoint(reader, "session-collection", {
      ...DEFAULT_CONFIG,
      memoryDir,
    });

    expect(collected.entries.map((entry) => entry.rendered)).toEqual(["ASSISTANT:\nordinary assistant response"]);
    expect(collected.entries.map((entry) => entry.rendered).join("\n")).not.toContain(MEMORY_HEADER);
    expect(requestedLimits).toEqual([DEFAULT_CONFIG.maxDeltaMessages]);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
