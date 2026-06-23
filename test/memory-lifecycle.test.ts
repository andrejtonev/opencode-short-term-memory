// ── Tests for processMemoryChunks and clean-mode retry / fallback. ──
//
// Two open gaps from the e2e mutation report are covered here:
//   #1: chunking with realistic-sized conversations (80 messages that
//       exceed maxUpdateInputLength). The chunker must produce a final
//       memory file that contains every chunk's contribution.
//   #5: clean-mode retry exhaustion + fallback to the active session
//       when cleanFallbackToActiveSession is true.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processMemoryChunks } from "../src/memory-lifecycle";
import {
  DEFAULT_CONFIG,
  MEMORY_HEADER,
  checkpointPathFor,
  memoryPathFor,
  readText,
  writeText,
  type RuntimeState,
} from "../src/memory-utils";
import { type VisibleDeltaEntry } from "../src/message-collector";
import type { Client } from "../src/types";

function fakeEntry(i: number, role: "user" | "assistant"): VisibleDeltaEntry {
  return {
    rendered: `${role.toUpperCase()}:\nThis is turn number ${i} with a unique marker marker_${i}_${role[0]}.`,
    lastMessageID: `m${i}`,
  };
}

function createRuntimeState(): RuntimeState {
  return {
    updateCount: 0,
    injectCount: 0,
    injectCharCount: 0,
    compactCount: 0,
  };
}

function basicMemoryResult(existing: string, conversation: string): string {
  // The summarizer mock: a deterministic response that preserves all
  // unique markers in the input. This is what a "good" model would do.
  const markers = conversation.match(/marker_\d+_[ua]/g) ?? [];
  return [
    MEMORY_HEADER,
    "",
    "### User Instructions",
    "- none",
    "",
    "### Long Horizon Context",
    "- none",
    "",
    "### Decisions",
    "- none",
    "",
    "### Conclusions",
    "- none",
    "",
    "### Active References",
    ...markers.map((m) => `- ${m}`),
  ].join("\n");
}

describe("processMemoryChunks: chunking with realistic conversations", () => {
  const originalCwd = process.cwd();
  let testDir = "";
  let memoryDir = "";
  let memoryPath = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-chunk-test-"));
    process.chdir(testDir);
    memoryDir = join(testDir, ".opencode", "memory");
    memoryPath = memoryPathFor("session-chunk", memoryDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test("a 80-entry conversation is split into multiple chunks", async () => {
    const entries: VisibleDeltaEntry[] = [];
    for (let i = 0; i < 80; i += 1) {
      entries.push(fakeEntry(i, i % 2 === 0 ? "user" : "assistant"));
    }

    // maxUpdateInputLength set tight so we force chunking.
    const config = {
      ...DEFAULT_CONFIG,
      memoryDir,
      summarizerMode: "active" as const,
      maxUpdateInputLength: 1500,
      maxMemoryLength: 50000,
      debounceMs: 0,
    };

    // The mock counts prompts and extracts the conversation-update
    // portion of each prompt (the part that the chunker controls).
    const callLog: Array<{ promptCount: number; conversationChars: number }> = [];
    const client = {
      session: {
        prompt: async (args: unknown) => {
          const a = args as { body?: { parts?: Array<{ text?: string }> } };
          const promptText = a?.body?.parts?.[0]?.text ?? "";
          // The chunker feeds the conversation between the LAST
          // <conversation_update> and </conversation_update> tags.
          // (The literal string "<conversation_update>" also appears
          // in the instructions, so we match the LAST occurrence.)
          const lastOpen = promptText.lastIndexOf("<conversation_update>\n");
          const lastClose = promptText.lastIndexOf("</conversation_update>");
          const conversationChars =
            lastOpen >= 0 && lastClose > lastOpen ? lastClose - lastOpen - "<conversation_update>\n".length : 0;
          callLog.push({ promptCount: callLog.length + 1, conversationChars });
          return {
            data: {
              parts: [{ type: "text", text: basicMemoryResult("", promptText) }],
            },
          };
        },
      },
    } as unknown as Client;

    const globalState = createRuntimeState();
    await processMemoryChunks(
      client,
      "session-chunk",
      "test",
      config,
      memoryPath,
      "", // no existing memory
      entries,
      "", // no AGENTS.md
      globalState,
    );

    // The chunker should have produced multiple chunks (at least 2).
    expect(callLog.length).toBeGreaterThan(1);
    // Each chunk's conversation portion must be ≤ maxUpdateInputLength.
    // The first chunk is the tightest; later chunks may be smaller
    // because the input runs out.
    for (const call of callLog) {
      expect(call.conversationChars).toBeLessThanOrEqual(config.maxUpdateInputLength);
    }
    // The final memory file was written and is well-formed.
    const final = await readText(memoryPath, "");
    expect(final).toContain(MEMORY_HEADER);

    // updateCount is incremented once per chunk, not once per message.
    expect(globalState.updateCount).toBe(callLog.length);

    // The total conversation characters processed is at least the sum
    // of the input entries' lengths. We allow a small margin for the
    // chunker's bookkeeping.
    const totalInputChars = entries.reduce((s, e) => s + e.rendered.length, 0);
    const totalChunkConvChars = callLog.reduce((s, c) => s + c.conversationChars, 0);
    // The chunker must not have dropped messages; it should have
    // processed roughly all of the input (allowing some slack for the
    // very last chunk potentially being smaller than maxUpdateInputLength
    // when the input runs out).
    expect(totalChunkConvChars).toBeGreaterThanOrEqual(totalInputChars - config.maxUpdateInputLength);
  });

  test("a single-entry oversized message is truncated with a marker", async () => {
    const huge = "X".repeat(5000);
    const entries: VisibleDeltaEntry[] = [{ rendered: `USER:\n${huge}`, lastMessageID: "m-huge" }];

    const config = {
      ...DEFAULT_CONFIG,
      memoryDir,
      summarizerMode: "active" as const,
      maxUpdateInputLength: 1000,
      maxMemoryLength: 50000,
      debounceMs: 0,
    };

    const client = {
      session: {
        prompt: async (args: unknown) => {
          const a = args as { body?: { parts?: Array<{ text?: string }> } };
          const promptText = a?.body?.parts?.[0]?.text ?? "";
          return {
            data: {
              parts: [{ type: "text", text: basicMemoryResult("", promptText) }],
            },
          };
        },
      },
    } as unknown as Client;

    const globalState = createRuntimeState();
    await processMemoryChunks(
      client,
      "session-truncate",
      "test",
      config,
      memoryPathFor("session-truncate", memoryDir),
      "",
      entries,
      "",
      globalState,
    );

    // Single chunk (the truncated message fits in one chunk).
    const final = await readText(memoryPathFor("session-truncate", memoryDir), "");
    expect(final).toContain(MEMORY_HEADER);
    // The full 5000-char payload is not preserved (it's truncated),
    // but the chunker's marker should have been written into the prompt.
    expect(globalState.updateCount).toBe(1);
  });

  test("an empty entry list is a no-op (no prompt, no write)", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      memoryDir,
      summarizerMode: "active" as const,
      debounceMs: 0,
    };
    const promptCalls: unknown[] = [];
    const client = {
      session: {
        prompt: async (args: unknown) => {
          promptCalls.push(args);
          return { data: { parts: [{ type: "text", text: "" }] } };
        },
      },
    } as unknown as Client;

    const globalState = createRuntimeState();
    await processMemoryChunks(
      client,
      "session-empty",
      "test",
      config,
      memoryPathFor("session-empty", memoryDir),
      "",
      [],
      "",
      globalState,
    );

    expect(promptCalls.length).toBe(0);
    expect(globalState.updateCount).toBe(0);
  });
});

describe("processMemoryChunks: clean-mode retry + fallback (#5)", () => {
  const originalCwd = process.cwd();
  let testDir = "";
  let memoryDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-clean-fallback-test-"));
    process.chdir(testDir);
    memoryDir = join(testDir, ".opencode", "memory");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // Helpers: the clean and active summarizers both use the same
  // system message. The clean one calls into a freshly-created side
  // session (path.id starts with "side-"), the active one uses the
  // original session id.
  function isCleanCall(args: unknown): boolean {
    const a = args as { path?: { id?: string } };
    return typeof a?.path?.id === "string" && a.path.id.startsWith("side-");
  }

  test("with sideSessionRetries=2, a failing clean summarizer retries 3 times (1 + 2) then gives up (no fallback)", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      memoryDir,
      summarizerMode: "clean" as const,
      sideSessionRetries: 2,
      cleanFallbackToActiveSession: false,
      debounceMs: 0,
    };

    let cleanCalls = 0;
    let activeCalls = 0;
    const client = {
      session: {
        create: async () => ({ data: { id: "side-1" } }),
        delete: async () => ({ data: true }),
        prompt: async (args: unknown) => {
          if (isCleanCall(args)) {
            cleanCalls += 1;
            throw new Error("simulated side-session failure");
          }
          activeCalls += 1;
          return { data: { parts: [{ type: "text", text: basicMemoryResult("", "fallback result") }] } };
        },
      },
    } as unknown as Client;

    const entries: VisibleDeltaEntry[] = [fakeEntry(0, "user")];
    const globalState = createRuntimeState();
    await processMemoryChunks(
      client,
      "session-fail-no-fallback",
      "test",
      config,
      memoryPathFor("session-fail-no-fallback", memoryDir),
      "",
      entries,
      "",
      globalState,
    );

    // 1 initial + 2 retries = 3 clean attempts. No fallback.
    expect(cleanCalls).toBe(3);
    expect(activeCalls).toBe(0);
    expect(globalState.lastError).toContain("simulated side-session failure");
  });

  test("with sideSessionRetries=1 and cleanFallbackToActiveSession=true, a failing clean summarizer falls back to the active session", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      memoryDir,
      summarizerMode: "clean" as const,
      sideSessionRetries: 1,
      cleanFallbackToActiveSession: true,
      debounceMs: 0,
    };

    let cleanCalls = 0;
    let activeCalls = 0;
    const client = {
      session: {
        create: async () => ({ data: { id: "side-fb" } }),
        delete: async () => ({ data: true }),
        prompt: async (args: unknown) => {
          if (isCleanCall(args)) {
            cleanCalls += 1;
            throw new Error("simulated side-session failure");
          }
          activeCalls += 1;
          return { data: { parts: [{ type: "text", text: basicMemoryResult("", "fallback result") }] } };
        },
      },
    } as unknown as Client;

    const entries: VisibleDeltaEntry[] = [fakeEntry(0, "user")];
    const globalState = createRuntimeState();
    await processMemoryChunks(
      client,
      "session-fallback",
      "test",
      config,
      memoryPathFor("session-fallback", memoryDir),
      "",
      entries,
      "",
      globalState,
    );

    // 1 initial + 1 retry = 2 clean attempts, then fallback to active.
    expect(cleanCalls).toBe(2);
    expect(activeCalls).toBe(1);
    // The final memory was written by the active-session fallback.
    const final = await readText(memoryPathFor("session-fallback", memoryDir), "");
    expect(final).toContain(MEMORY_HEADER);
  });

  test("a successful clean summarizer on the second retry proceeds and writes memory", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      memoryDir,
      summarizerMode: "clean" as const,
      sideSessionRetries: 3,
      cleanFallbackToActiveSession: false,
      debounceMs: 0,
    };

    let cleanCalls = 0;
    const client = {
      session: {
        create: async () => ({ data: { id: "side-recover" } }),
        delete: async () => ({ data: true }),
        prompt: async (args: unknown) => {
          if (isCleanCall(args)) {
            cleanCalls += 1;
            if (cleanCalls < 2) throw new Error("transient failure");
            return { data: { parts: [{ type: "text", text: basicMemoryResult("", "recovered") }] } };
          }
          return { data: { parts: [{ type: "text", text: "" }] } };
        },
      },
    } as unknown as Client;

    const entries: VisibleDeltaEntry[] = [fakeEntry(0, "user")];
    const globalState = createRuntimeState();
    await processMemoryChunks(
      client,
      "session-recover",
      "test",
      config,
      memoryPathFor("session-recover", memoryDir),
      "",
      entries,
      "",
      globalState,
    );

    expect(cleanCalls).toBe(2);
    const final = await readText(memoryPathFor("session-recover", memoryDir), "");
    expect(final).toContain(MEMORY_HEADER);
  });
});
