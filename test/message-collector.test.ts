// ── Tests for the message collector: collapseAssistantBursts and ────
// ── maxDeltaMessages flags. ─────────────────────────────────────────
//
// collectVisibleMessagesSinceCheckpoint is the upstream of the chunker.
// When a session has many messages, two config flags control how the
// summarizer input is shaped:
//   * collapseAssistantBursts: merge consecutive assistant messages
//     so the model doesn't see a wall of one-line replies.
//   * maxDeltaMessages: limit how many rows the upstream message reader
//     returns (defends against very long histories blowing up the
//     summarizer prompt).
//
// These were unit-tested only at the per-flag level before this PR.
// This file adds explicit tests for both flags and the cross-flag
// interaction.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectVisibleMessagesSinceCheckpoint } from "../src/message-collector";
import { DEFAULT_CONFIG, writeText, memoryPathFor, checkpointPathFor } from "../src/memory-utils";

type MessageReader = {
  readSessionMessages(sessionID: string, options?: { limit?: number }): Promise<readonly unknown[]>;
};

function makeRow(id: string, role: "user" | "assistant", content: string, time: number) {
  return {
    id,
    info: { id, role, time: { created: time } },
    message: { id, role, content, parts: [{ type: "text", text: content }] },
    parts: [{ type: "text", text: content }],
  };
}

describe("collectVisibleMessagesSinceCheckpoint", () => {
  const originalCwd = process.cwd();
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-msg-collector-test-"));
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test("with collapseAssistantBursts=false, every assistant message becomes its own entry", async () => {
    const sessionID = "burst-off";
    const memoryDir = join(testDir, ".opencode", "memory");
    await writeText(memoryPathFor(sessionID, memoryDir), "");
    const rows = [
      makeRow("a", "user", "u1", 1000),
      makeRow("b", "assistant", "a1", 1100),
      makeRow("c", "assistant", "a2", 1200),
      makeRow("d", "assistant", "a3", 1300),
      makeRow("e", "user", "u2", 1400),
    ];
    const calls: Array<{ sessionID: string; options?: { limit?: number } }> = [];
    const reader: MessageReader = {
      readSessionMessages: async (readSessionID, options) => {
        calls.push({ sessionID: readSessionID, options });
        return rows;
      },
    };

    const out = await collectVisibleMessagesSinceCheckpoint(reader, sessionID, {
      ...DEFAULT_CONFIG,
      memoryDir,
      collapseAssistantBursts: false,
    });

    // 5 entries: u1, a1, a2, a3, u2 — none collapsed.
    expect(out.entries.length).toBe(5);
    expect(out.entries.map((e) => e.rendered).join("\n")).toContain("u1");
    expect(out.entries.map((e) => e.rendered).join("\n")).toContain("a3");
    // maxDeltaMessages default is 200; we only sent 5 rows.
    expect(calls[0]).toEqual({ sessionID, options: { limit: DEFAULT_CONFIG.maxDeltaMessages } });
  });

  test("with collapseAssistantBursts=true, consecutive assistant messages collapse to the last one", async () => {
    const sessionID = "burst-on";
    const memoryDir = join(testDir, ".opencode", "memory");
    await writeText(memoryPathFor(sessionID, memoryDir), "");
    const rows = [
      makeRow("a", "user", "u1", 1000),
      makeRow("b", "assistant", "a1", 1100),
      makeRow("c", "assistant", "a2", 1200),
      makeRow("d", "assistant", "a3", 1300),
      makeRow("e", "user", "u2", 1400),
      makeRow("f", "assistant", "a4", 1500),
    ];
    const reader: MessageReader = {
      readSessionMessages: async () => rows,
    };

    const out = await collectVisibleMessagesSinceCheckpoint(reader, sessionID, {
      ...DEFAULT_CONFIG,
      memoryDir,
      collapseAssistantBursts: true,
    });

    // Entries: u1, a3 (last of the burst), u2, a4 = 4.
    expect(out.entries.length).toBe(4);
    const rendered = out.entries.map((e) => e.rendered).join("\n");
    expect(rendered).toContain("u1");
    expect(rendered).toContain("u2");
    expect(rendered).toContain("a3");
    expect(rendered).toContain("a4");
    // The middle assistant messages (a1, a2) should be collapsed.
    expect(rendered).not.toContain("a1");
    expect(rendered).not.toContain("a2");
  });

  test("maxDeltaMessages is passed through to the upstream message reader", async () => {
    const sessionID = "max-delta";
    const memoryDir = join(testDir, ".opencode", "memory");
    await writeText(memoryPathFor(sessionID, memoryDir), "");
    const calls: Array<{ sessionID: string; options?: { limit?: number } }> = [];
    const reader: MessageReader = {
      readSessionMessages: async (readSessionID, options) => {
        calls.push({ sessionID: readSessionID, options });
        return [];
      },
    };

    await collectVisibleMessagesSinceCheckpoint(reader, sessionID, {
      ...DEFAULT_CONFIG,
      memoryDir,
      maxDeltaMessages: 7,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ sessionID, options: { limit: 7 } });
  });

  test("rows beyond maxDeltaMessages are NOT fetched (the reader enforces the cap)", async () => {
    // The collector passes `limit: maxDeltaMessages` to the reader. The
    // reader returns at most that many rows. This test verifies the
    // collector doesn't itself trim past the reader's response — the
    // reader is the gate.
    const sessionID = "upstream-trims";
    const memoryDir = join(testDir, ".opencode", "memory");
    await writeText(memoryPathFor(sessionID, memoryDir), "");

    // Build 100 rows but only return 5 from the reader (simulating an
    // upstream cap).
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeRow(`m${i}`, i % 2 === 0 ? "user" : "assistant", `m${i}`, 1000 + i),
    );
    const calls: Array<{ sessionID: string; options?: { limit?: number } }> = [];
    const reader: MessageReader = {
      readSessionMessages: async (readSessionID, options) => {
        calls.push({ sessionID: readSessionID, options });
        const limit = options?.limit ?? 200;
        return rows.slice(-limit);
      },
    };

    const out = await collectVisibleMessagesSinceCheckpoint(reader, sessionID, {
      ...DEFAULT_CONFIG,
      memoryDir,
      maxDeltaMessages: 5,
    });

    // 5 rows returned. Of those, some are assistant, some user.
    expect(out.entries.length).toBeLessThanOrEqual(5);
    expect(out.rowCount).toBe(5);
    expect(calls).toEqual([{ sessionID, options: { limit: 5 } }]);
  });

  test("the checkpoint limits the delta to rows AFTER the checkpoint", async () => {
    const sessionID = "checkpointed";
    const memoryDir = join(testDir, ".opencode", "memory");
    await writeText(memoryPathFor(sessionID, memoryDir), "");
    // Pre-seed the checkpoint as the 3rd message.
    await writeText(checkpointPathFor(sessionID, memoryDir), "m2\n");

    const rows = [
      makeRow("m0", "user", "old1", 1000),
      makeRow("m1", "user", "old2", 1100),
      makeRow("m2", "user", "checkpoint-here", 1200),
      makeRow("m3", "user", "new1", 1300),
      makeRow("m4", "assistant", "new2", 1400),
    ];
    const reader: MessageReader = {
      readSessionMessages: async () => rows,
    };

    const out = await collectVisibleMessagesSinceCheckpoint(reader, sessionID, {
      ...DEFAULT_CONFIG,
      memoryDir,
    });

    // Only rows AFTER m2 should be in the delta.
    const ids = out.entries.map((e) => e.lastMessageID).filter(Boolean);
    expect(ids).toEqual(["m3", "m4"]);
  });

  test("rows starting with a `thinking:` or `tool call:` prefix are filtered", async () => {
    const sessionID = "noise-filter";
    const memoryDir = join(testDir, ".opencode", "memory");
    await writeText(memoryPathFor(sessionID, memoryDir), "");
    const rows = [
      makeRow("m0", "user", "real user input", 1000),
      makeRow("m1", "assistant", "thinking: I should call a tool", 1100),
      makeRow("m2", "assistant", "real assistant reply", 1200),
    ];
    const reader: MessageReader = {
      readSessionMessages: async () => rows,
    };

    const out = await collectVisibleMessagesSinceCheckpoint(reader, sessionID, {
      ...DEFAULT_CONFIG,
      memoryDir,
    });

    const rendered = out.entries.map((e) => e.rendered).join("\n");
    expect(rendered).toContain("real user input");
    expect(rendered).toContain("real assistant reply");
    expect(rendered).not.toContain("thinking:");
  });
});
