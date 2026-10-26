import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  STANDARD_MEMORY_TEMPLATE,
  checkpointPathFor,
  memoryPathFor,
  readText,
  writeText,
} from "../src/memory-utils";
import { collectVisibleMessagesSinceCheckpoint } from "../src/message-collector";
import {
  persistV1Reset,
  readV1ResetBoundary,
  selectV1ResetBoundary,
  v1ResetBoundaryPathFor,
} from "../src/v1-reset-boundary";
import { createFakeClient, createPlugin } from "./test-helpers";
import { deferred } from "./async-helpers";

function row(id: string, text: string, time: number, role = "user") {
  return { id, role, text, time: { created: time } };
}

describe("V1 persistent reset boundaries", () => {
  const originalCwd = process.cwd();
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stm-v1-reset-"));
    process.chdir(root);
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    process.env.OPENCODE_CONFIG_DIR = join(root, "config");
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    await rm(root, { recursive: true, force: true });
  });

  for (const action of ["named", "legacy"] as const) {
    test(`${action} reset stops unchanged-history updates and summarizes only new conversation after restart`, async () => {
      const sessionID = `reset-${action}`;
      const rows = [
        row("old-u", "OLD_CONVERSATION_SENTINEL", 1),
        row("old-a", "OLD_ASSISTANT_SENTINEL", 2, "assistant"),
      ];
      const client = createFakeClient({ messagesRows: rows });
      const { plugin } = await createPlugin({ debounceMs: 100 }, client);
      await writeText(memoryPathFor(sessionID), "OLD_MEMORY_SENTINEL");
      await writeText(checkpointPathFor(sessionID), "old-a\n");
      const result =
        action === "named"
          ? await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID })
          : await plugin.tool.short_term_memory.execute({ action: "reset" }, { sessionID });
      expect(result).toContain("saved reset boundary");
      expect(await readText(memoryPathFor(sessionID))).toBe(STANDARD_MEMORY_TEMPLATE);
      expect(await readText(checkpointPathFor(sessionID))).toBe("");
      expect(await readV1ResetBoundary(sessionID, DEFAULT_CONFIG.memoryDir)).toEqual({ version: 1, anchorID: "old-a" });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID } } });
      await Bun.sleep(180);
      await plugin.tool.stm_memory_update.execute({}, { sessionID });
      expect(client.calls.summarizerPrompts).toHaveLength(0);

      // A new plugin instance has no process-local reset state. Losing the
      // normal checkpoint must still not make the pre-reset history eligible.
      const restarted = (await createPlugin({ debounceMs: 120000 }, client)).plugin;
      rows.push(row("new-u", "NEW_CONVERSATION_SENTINEL", 3), row("new-a", "NEW_ASSISTANT_SENTINEL", 4, "assistant"));
      await restarted.tool.stm_memory_update.execute({}, { sessionID });
      expect(client.calls.summarizerPrompts).toHaveLength(1);
      const prompt = JSON.stringify(client.calls.summarizerPrompts[0]);
      expect(prompt).toContain("NEW_CONVERSATION_SENTINEL");
      expect(prompt).toContain("NEW_ASSISTANT_SENTINEL");
      expect(prompt).not.toContain("OLD_CONVERSATION_SENTINEL");
      expect(prompt).not.toContain("OLD_ASSISTANT_SENTINEL");
      expect(prompt).not.toContain("OLD_MEMORY_SENTINEL");
      expect(await readText(checkpointPathFor(sessionID))).toBe("new-a\n");
    });
  }

  test("reset in a verified empty session admits its first later conversation", async () => {
    const rows: unknown[] = [];
    const client = createFakeClient({ messagesRows: rows });
    const { plugin } = await createPlugin({}, client);
    await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID: "empty" });
    expect(await readV1ResetBoundary("empty", DEFAULT_CONFIG.memoryDir)).toEqual({ version: 1, anchorID: null });
    rows.push(row("u1", "first post-reset instruction", 1));
    await plugin.tool.stm_memory_update.execute({}, { sessionID: "empty" });
    expect(JSON.stringify(client.calls.summarizerPrompts)).toContain("first post-reset instruction");
  });

  test("an anchor outside the recent window is located before limiting post-reset history", async () => {
    const rows = [
      row("old", "OLD_SENTINEL", 1),
      ...Array.from({ length: 35 }, (_, i) => row(`new-${i}`, `post-reset ${i}`, i + 2)),
    ];
    const config = { ...DEFAULT_CONFIG, memoryDir: join(root, "memory"), maxDeltaMessages: 20 };
    await persistV1Reset("window", config, { version: 1, anchorID: "old" });
    const calls: unknown[] = [];
    const reader = {
      readSessionMessages: async (_id: string, options?: { limit?: number }) => {
        calls.push(options);
        return options?.limit ? rows.slice(-options.limit) : rows;
      },
    };
    const result = await collectVisibleMessagesSinceCheckpoint(reader, "window", config);
    expect(calls).toEqual([undefined]);
    expect(result.entries).toHaveLength(20);
    expect(result.entries[0]?.rendered).toContain("post-reset 15");
    expect(JSON.stringify(result.entries)).not.toContain("OLD_SENTINEL");
    // An ordinary checkpoint can disappear too: the reset boundary continues
    // to restrict the fallback window independently of that checkpoint.
    await writeText(checkpointPathFor("window", config.memoryDir), "lost-checkpoint\n");
    expect((await collectVisibleMessagesSinceCheckpoint(reader, "window", config)).entries).toHaveLength(20);
  });

  for (const invalid of ["missing-anchor", "malformed-marker"] as const) {
    test(`${invalid} refuses generation without changing saved memory or checkpoint`, async () => {
      const sessionID = invalid;
      const client = createFakeClient({ messagesRows: [row("new", "must never summarize", 1)] });
      const { plugin } = await createPlugin({}, client);
      await writeText(memoryPathFor(sessionID), "PRESERVE_MEMORY");
      await writeText(checkpointPathFor(sessionID), "PRESERVE_CHECKPOINT\n");
      await writeText(
        v1ResetBoundaryPathFor(sessionID, DEFAULT_CONFIG.memoryDir),
        invalid === "malformed-marker" ? "{broken" : JSON.stringify({ version: 1, anchorID: "absent" }),
      );
      const result = await plugin.tool.stm_memory_update.execute({}, { sessionID });
      expect(result).toContain("Memory update failed:");
      expect(result).toContain(
        invalid === "malformed-marker" ? "malformed_v1_reset_boundary" : "v1_reset_anchor_absent",
      );
      expect(client.calls.summarizerPrompts).toHaveLength(0);
      expect(await readText(memoryPathFor(sessionID))).toBe("PRESERVE_MEMORY");
      expect(await readText(checkpointPathFor(sessionID))).toBe("PRESERVE_CHECKPOINT\n");
    });
  }

  for (const rows of [
    [{ role: "user", text: "missing ID" }],
    [{ id: 123, role: "user", text: "invalid ID" }],
    [row("duplicate", "first", 1), row("duplicate", "second", 2)],
  ]) {
    test(`ambiguous reset history ${JSON.stringify(rows)} preserves existing state`, async () => {
      const client = createFakeClient({ messagesRows: rows });
      const { plugin } = await createPlugin({}, client);
      await writeText(memoryPathFor("invalid"), "EXISTING_MEMORY");
      await writeText(checkpointPathFor("invalid"), "checkpoint\n");
      await expect(plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID: "invalid" })).rejects.toThrow(
        "reset_history_ambiguous_ids",
      );
      expect(await readText(memoryPathFor("invalid"))).toBe("EXISTING_MEMORY");
      expect(await readText(checkpointPathFor("invalid"))).toBe("checkpoint\n");
      await expect(access(v1ResetBoundaryPathFor("invalid", DEFAULT_CONFIG.memoryDir))).rejects.toThrow();
      expect(client.calls.summarizerPrompts).toHaveLength(0);
    });
  }

  test("an unavailable reset history does not erase memory", async () => {
    const client = createFakeClient();
    client.session.messages = async () => {
      throw new Error("history unavailable");
    };
    const { plugin } = await createPlugin({}, client);
    await writeText(memoryPathFor("error"), "EXISTING_MEMORY");
    await expect(plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID: "error" })).rejects.toThrow(
      "history unavailable",
    );
    expect(await readText(memoryPathFor("error"))).toBe("EXISTING_MEMORY");
  });

  test("a failed forward reset rolls back memory, checkpoint and earlier boundary bytes", async () => {
    const config = { ...DEFAULT_CONFIG, memoryDir: join(root, "memory") };
    const memory = memoryPathFor("rollback", config.memoryDir);
    const checkpoint = checkpointPathFor("rollback", config.memoryDir);
    const marker = v1ResetBoundaryPathFor("rollback", config.memoryDir);
    await writeText(memory, "previous memory\r\n");
    await writeText(checkpoint, "old-checkpoint\r\n");
    await writeText(marker, '{ "version": 1, "anchorID": "earlier" }\r\n');
    const snapshots = await Promise.all([memory, checkpoint, marker].map((path) => readFile(path)));
    await expect(
      persistV1Reset(
        "rollback",
        config,
        { version: 1, anchorID: "new" },
        {
          beforeCommit: (kind) => {
            if (kind === "checkpoint") throw new Error("checkpoint write failure");
          },
        },
      ),
    ).rejects.toThrow("checkpoint write failure");
    expect(await Promise.all([memory, checkpoint, marker].map((path) => readFile(path)))).toEqual(snapshots);
  });

  test("reset fences an in-flight old summary and preserves its boundary", async () => {
    const started = deferred<void>();
    const release = deferred<string>();
    const client = createFakeClient({
      messagesRows: [row("old", "OLD_SENTINEL", 1)],
      promptResponder: async () => {
        started.resolve();
        return release.promise;
      },
    });
    const { plugin } = await createPlugin({}, client);
    const update = plugin.tool.stm_memory_update.execute({}, { sessionID: "stale" });
    await started.promise;
    await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID: "stale" });
    release.resolve("## Session Memory\n\n### User Instructions\n- STALE_RESULT\n");
    await update;
    expect(await readText(memoryPathFor("stale"))).toBe(STANDARD_MEMORY_TEMPLATE);
    expect(await readText(checkpointPathFor("stale"))).toBe("");
    expect(await readV1ResetBoundary("stale", DEFAULT_CONFIG.memoryDir)).toEqual({ version: 1, anchorID: "old" });
  });

  test("active summary prompt and reply cannot become an anchor absent from the filtered collector", async () => {
    const started = deferred<void>();
    const release = deferred<string>();
    const rows: unknown[] = [row("old-user", "OLD_ACTIVE_SENTINEL", 1)];
    let generations = 0;
    const client = createFakeClient({
      messagesRows: rows,
      promptResponder: async (args) => {
        if (++generations > 1) return "## Session Memory\n\n### User Instructions\n- post-reset only\n";
        const body = (args as { body: { messageID: string; parts: { text: string }[] } }).body;
        rows.push(row(body.messageID, body.parts[0]!.text, 2));
        rows.push({
          ...row("owned-reply", "## Session Memory\n\n### User Instructions\n- OWNED_REPLY_SENTINEL", 3, "assistant"),
          parentID: body.messageID,
        });
        started.resolve();
        return release.promise;
      },
    });
    const { plugin } = await createPlugin({ summarizerMode: "active" }, client);
    const update = plugin.tool.stm_memory_update.execute({}, { sessionID: "active" });
    await started.promise;
    await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID: "active" });
    expect(await readV1ResetBoundary("active", DEFAULT_CONFIG.memoryDir)).toEqual({ version: 1, anchorID: "old-user" });
    release.resolve("## Session Memory\n\n### User Instructions\n- stale active result\n");
    await update;
    rows.push(row("new-user", "NEW_ACTIVE_SENTINEL", 4));
    await plugin.tool.stm_memory_update.execute({}, { sessionID: "active" });
    expect(client.calls.summarizerPrompts).toHaveLength(2);
    const prompt = JSON.stringify(client.calls.summarizerPrompts[1]);
    expect(prompt).toContain("NEW_ACTIVE_SENTINEL");
    expect(prompt).not.toContain("OLD_ACTIVE_SENTINEL");
    expect(prompt).not.toContain("OWNED_REPLY_SENTINEL");
  });

  test("ordinary missing-checkpoint fallback stays bounded when there has been no reset", async () => {
    const config = { ...DEFAULT_CONFIG, memoryDir: join(root, "memory"), maxDeltaMessages: 20 };
    await writeText(checkpointPathFor("ordinary", config.memoryDir), "absent\n");
    const calls: unknown[] = [];
    const result = await collectVisibleMessagesSinceCheckpoint(
      {
        readSessionMessages: async (_id, options) => {
          calls.push(options);
          return [row("available", "ordinary recent history", 1)];
        },
      },
      "ordinary",
      config,
    );
    expect(calls).toEqual([{ limit: 20 }]);
    expect(result.entries[0]?.rendered).toContain("ordinary recent history");
  });

  test("recreated reset child does not capture old parent memory", async () => {
    const client = createFakeClient();
    const { plugin } = await createPlugin({ debounceMs: 120000 }, client);
    await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID: "child" });
    await writeText(memoryPathFor("parent"), "## Session Memory\n\n### User Instructions\n- OLD_PARENT_SENTINEL\n");
    await plugin["session.created"]({ sessionID: "child", event: { properties: { info: { parentID: "parent" } } } });
    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID: "child" }, output);
    expect(JSON.stringify(output)).not.toContain("OLD_PARENT_SENTINEL");
    expect(client.calls.noReplyDeliveries).toHaveLength(0);
  });

  test("deletion removes parent and tracked child reset markers", async () => {
    const client = createFakeClient();
    const { plugin } = await createPlugin({ debounceMs: 120000 }, client);
    await plugin["session.created"]({ sessionID: "parent" });
    await plugin["session.created"]({ sessionID: "child", event: { properties: { info: { parentID: "parent" } } } });
    for (const sessionID of ["parent", "child"])
      await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID });
    await plugin["session.deleted"]({ sessionID: "parent" });
    for (const sessionID of ["parent", "child"])
      await expect(access(v1ResetBoundaryPathFor(sessionID, DEFAULT_CONFIG.memoryDir))).rejects.toThrow();
  });

  test("selecting a reset snapshot uses the same chronological ordering as collection", () => {
    expect(selectV1ResetBoundary([row("late", "last", 3), row("early", "first", 1)])).toEqual({
      version: 1,
      anchorID: "late",
    });
  });
});
