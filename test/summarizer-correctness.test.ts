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
    tools?: Record<string, boolean>;
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

  test("guarded host tools retain definitions, approval permissions and isolated cleanup", async () => {
    const calls: PromptCall[] = [];
    const runtime = { ...runtimeFor(assistantEnvelope(VALID_SUMMARY), calls), cleanSessionToolGuard: true as const };
    const created: unknown[] = [];
    runtime.createTemporarySession = async (request) => {
      created.push(request);
      return { id: "side-summarizer-1" };
    };
    const deleted: string[] = [];
    runtime.deleteTemporarySession = async ({ id }) => {
      deleted.push(id);
    };
    await expect(
      runCleanOpencodeSummarizer(runtime, "supplied conversation only", config(testDir, "clean")),
    ).resolves.toBe(VALID_SUMMARY);
    expect(calls[0]!.prompt).not.toHaveProperty("tools");
    expect(calls[0]!.prompt.system).toContain("clean short-term memory summarizer");
    expect(deleted).toEqual(["side-summarizer-1"]);
    expect(created).toEqual([
      {
        options: { title: "Session Memory Summarizer", permission: [{ permission: "*", pattern: "*", action: "ask" }] },
      },
    ]);
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
    expect(promptCalls[0].prompt.tools).toEqual({ "*": false });
    // V1 persists prompt tool restrictions as session permissions. Never
    // disable the user's tools when summarizing in the active session.
    expect(promptCalls[1].prompt).not.toHaveProperty("tools");
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

  for (const failureCase of [
    { status: 403, type: "FreeTierError", message: "FreeTierError (403)" },
    { status: 401, type: "api_key_expired", message: "api_key_expired" },
  ]) {
    test(`preserves native ${failureCase.type} and never accepts accompanying text`, async () => {
      const response = {
        data: {
          info: {
            role: "assistant",
            error: {
              name: "APIError",
              data: {
                statusCode: failureCase.status,
                isRetryable: false,
                responseBody: JSON.stringify({ error: { type: failureCase.type } }),
              },
            },
          },
          parts: [{ type: "text", text: VALID_SUMMARY }],
        },
      };
      const runtime = runtimeFor(response);
      const cfg = config(join(testDir, failureCase.type), "clean");
      await expect(runCleanOpencodeSummarizer(runtime, "prompt", cfg)).rejects.toThrow(failureCase.message);
      await expect(runActiveSessionSummarizer(runtime, "active", "prompt", cfg)).rejects.toThrow(failureCase.message);
    });

    test(`permanent ${failureCase.type} makes one clean attempt with no active fallback or memory change`, async () => {
      const memoryDir = join(testDir, `permanent-${failureCase.type}`);
      const sessionID = "permanent-rejection";
      const memoryPath = memoryPathFor(sessionID, memoryDir);
      const checkpointPath = checkpointPathFor(sessionID, memoryDir);
      await writeText(memoryPath, "original memory");
      await writeText(checkpointPath, "original checkpoint");
      const calls: PromptCall[] = [];
      let deleted = 0;
      const runtime = runtimeFor(
        {
          data: {
            info: {
              role: "assistant",
              error: {
                name: "APIError",
                data: {
                  statusCode: failureCase.status,
                  isRetryable: false,
                  responseBody: JSON.stringify({ error: { type: failureCase.type } }),
                },
              },
            },
            parts: [],
          },
        },
        calls,
      );
      runtime.deleteTemporarySession = async () => {
        deleted++;
      };
      const failures: string[] = [];
      const wrote = await processMemoryChunks(
        uiClient(),
        runtime,
        sessionID,
        "manual",
        {
          ...config(memoryDir, "clean"),
          sideSessionRetries: 3,
          cleanFallbackToActiveSession: true,
        },
        memoryPath,
        "original memory",
        [{ rendered: "new input", lastMessageID: "new-message" }],
        "",
        runtimeState(),
        undefined,
        (detail) => failures.push(detail),
      );
      expect(wrote).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.sessionId).toBe("side-summarizer-1");
      expect(calls[0]?.prompt.tools).toEqual({ "*": false });
      expect(deleted).toBe(1);
      expect(failures[0]).toContain(failureCase.message);
      expect(await readFile(memoryPath, "utf8")).toBe("original memory");
      expect(await readFile(checkpointPath, "utf8")).toBe("original checkpoint");
    });
  }

  test("explicitly retryable provider 503 still retries and commits a successful summary", async () => {
    const memoryDir = join(testDir, "transient-provider");
    const calls: PromptCall[] = [];
    const runtime = runtimeFor(undefined, calls);
    runtime.deliverGeneratedPrompt = async (request) => {
      calls.push(request as PromptCall);
      return calls.length === 1
        ? {
            data: {
              info: { role: "assistant", error: { name: "APIError", data: { statusCode: 503, isRetryable: true } } },
              parts: [],
            },
          }
        : assistantEnvelope(VALID_SUMMARY);
    };
    const wrote = await processMemoryChunks(
      uiClient(),
      runtime,
      "transient",
      "manual",
      { ...config(memoryDir, "clean"), sideSessionRetries: 1 },
      memoryPathFor("transient", memoryDir),
      "",
      [{ rendered: "new input", lastMessageID: "new-message" }],
      "",
      runtimeState(),
    );
    expect(wrote).toBe(true);
    expect(calls).toHaveLength(2);
    expect(await readFile(checkpointPathFor("transient", memoryDir), "utf8")).toContain("new-message");
  });

  test("a later permanent rejection reports partial progress and preserves the earlier checkpoint", async () => {
    const memoryDir = join(testDir, "partial-provider-failure");
    let attempts = 0;
    const runtime = runtimeFor(undefined);
    runtime.deliverGeneratedPrompt = async () =>
      ++attempts === 1
        ? assistantEnvelope(VALID_SUMMARY)
        : {
            data: {
              info: {
                role: "assistant",
                error: {
                  name: "APIError",
                  data: {
                    statusCode: 403,
                    isRetryable: false,
                    responseBody: JSON.stringify({ error: { type: "FreeTierError" } }),
                  },
                },
              },
              parts: [],
            },
          };
    const failures: { detail: string; partial: boolean }[] = [];
    const wrote = await processMemoryChunks(
      uiClient(),
      runtime,
      "partial",
      "manual",
      { ...config(memoryDir, "clean"), maxUpdateInputLength: 100 },
      memoryPathFor("partial", memoryDir),
      "",
      [
        { rendered: "A".repeat(90), lastMessageID: "first-message" },
        { rendered: "B".repeat(90), lastMessageID: "second-message" },
      ],
      "",
      runtimeState(),
      undefined,
      (detail, partial) => failures.push({ detail, partial }),
    );
    expect(wrote).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.partial).toBe(true);
    expect(failures[0]?.detail).toContain("FreeTierError (403)");
    expect(await readFile(checkpointPathFor("partial", memoryDir), "utf8")).toBe("first-message\n");
    expect(attempts).toBe(2);
  });

  test("a concurrent edit after an earlier commit reports partial failure and preserves that edit", async () => {
    const memoryDir = join(testDir, "partial-concurrent-edit");
    const memoryPath = memoryPathFor("concurrent", memoryDir);
    const checkpointPath = checkpointPathFor("concurrent", memoryDir);
    let commits = 0;
    const failures: { detail: string; partial: boolean }[] = [];
    const wrote = await processMemoryChunks(
      uiClient(),
      runtimeFor(assistantEnvelope(VALID_SUMMARY)),
      "concurrent",
      "manual",
      { ...config(memoryDir, "clean"), maxUpdateInputLength: 100 },
      memoryPath,
      "",
      [
        { rendered: "A".repeat(90), lastMessageID: "first-message" },
        { rendered: "B".repeat(90), lastMessageID: "second-message" },
      ],
      "",
      runtimeState(),
      async (_previous, next, checkpointID) => {
        if (++commits === 1) {
          await writeText(memoryPath, next);
          await writeText(checkpointPath, `${checkpointID}\n`);
          return "committed";
        }
        await writeText(memoryPath, "manual concurrent edit");
        return "concurrent_change";
      },
      (detail, partial) => failures.push({ detail, partial }),
    );
    expect(wrote).toBe(true);
    expect(failures).toEqual([
      { detail: "Memory changed during generation; the update did not complete.", partial: true },
    ]);
    expect(await readFile(memoryPath, "utf8")).toBe("manual concurrent edit");
    expect(await readFile(checkpointPath, "utf8")).toBe("first-message\n");
  });

  for (const failureKind of ["active generation", "commit I/O"] as const) {
    test(`a later ${failureKind} error preserves partial progress for the caller`, async () => {
      const memoryDir = join(testDir, `partial-${failureKind.replaceAll(" ", "-").replaceAll("/", "-")}`);
      let generations = 0;
      let commits = 0;
      const runtime = runtimeFor(undefined);
      runtime.deliverGeneratedPrompt = async () => {
        if (++generations === 2 && failureKind === "active generation") throw new Error("second generation failed");
        return assistantEnvelope(VALID_SUMMARY);
      };
      const failures: { detail: string; partial: boolean }[] = [];
      await expect(
        processMemoryChunks(
          uiClient(),
          runtime,
          "partial",
          "manual",
          { ...config(memoryDir, "active"), maxUpdateInputLength: 100 },
          memoryPathFor("partial", memoryDir),
          "",
          [
            { rendered: "A".repeat(90), lastMessageID: "first-message" },
            { rendered: "B".repeat(90), lastMessageID: "second-message" },
          ],
          "",
          runtimeState(),
          async () => {
            if (++commits === 2) throw new Error("second commit failed");
            return "committed";
          },
          (detail, partial) => failures.push({ detail, partial }),
        ),
      ).rejects.toThrow(failureKind === "active generation" ? "second generation failed" : "second commit failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.partial).toBe(true);
    });
  }

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
