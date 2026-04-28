import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin, createFakeClient } from "./test-helpers";
import { readText, writeText, memoryPathFor } from "../src/memory-utils";

describe("DCP compress event integration", () => {
  const originalCwd = process.cwd();
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-dcp-compress-test-"));
    process.env.XDG_CONFIG_HOME = join(testDir, ".xdg");
    process.env.OPENCODE_CONFIG_DIR = join(testDir, ".config-dir");
    delete process.env.LOCALAPPDATA;
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test("message.part.updated with compress tool completed triggers memory update", async () => {
    const sessionID = `dcp-compress-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "DCP compression just finished" },
        { id: "a1", role: "assistant", content: "Compressed context for /lib/auth.ts" },
      ],
      promptText: "## Session Memory\n\n### Active References\n- /lib/auth.ts via DCP compress trigger\n",
    });
    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
        debounceMs: 0,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });

    // Simulate what OpenCode sends when DCP's compress tool completes
    const dcpCompressEvent = {
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

    await plugin.event(dcpCompressEvent as any);

    // The DCP compress event triggers updateMemory synchronously (debounceMs=0)
    const memory = await readText(memoryPathFor(sessionID), "");
    expect(memory).toContain("/lib/auth.ts via DCP compress trigger");
    expect(client.calls.prompt.length).toBeGreaterThanOrEqual(1);

    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"event":"dcp_compress_triggered"');
    expect(logText).toContain('"event":"memory_update_done"');
  });

  test("DCP compress event skipped for duplicate within debounce window", async () => {
    const sessionID = `dcp-duplicate-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "First compress" },
        { id: "a1", role: "assistant", content: "Done" },
      ],
      promptText: "## Session Memory\n\n### Active References\n- first compress done\n",
    });
    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
        debounceMs: 50,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });

    const dcpCompressEvent = {
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

    // Fire twice rapidly — first should trigger, second should be debounced
    await plugin.event(dcpCompressEvent as any);
    await plugin.event(dcpCompressEvent as any);

    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"event":"dcp_compress_triggered"');
    expect(logText).toContain('"event":"dcp_compress_skipped_duplicate"');

    // Only one update should have happened (the first one)
    const updateLines = [...logText.matchAll(/"event":"memory_update_done"/g)];
    expect(updateLines.length).toBe(1);
  });

  test("DCP compress event queues replay when update is in flight", async () => {
    const sessionID = `dcp-inflight-${Date.now()}`;
    let firstPromptResolve: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      firstPromptResolve = resolve;
    });

    const messages = [
      { id: "m1", role: "user", content: "Initial request for in-flight test" },
      { id: "m2", role: "assistant", content: "Processing request" },
    ];

    let promptCalls = 0;
    const fakeClient = createFakeClient({
      messagesRows: messages,
      promptResponder: async () => {
        promptCalls += 1;
        if (promptCalls === 1) {
          await firstGate;
        }
        return "## Session Memory\n\n### Active References\n- inflight DCP handled\n";
      },
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
        debounceMs: 0,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });

    // Start a manual update (will be in-flight)
    const updatePromise = plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    // Give it a moment to enter the update path
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Fire DCP compress event while update is in-flight
    const dcpCompressEvent = {
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
    await plugin.event(dcpCompressEvent as any);

    // Release the first update
    firstPromptResolve?.();
    await updatePromise;

    // Wait for the queued replay update to run (it may produce output or skip if no new messages)
    await new Promise((resolve) => setTimeout(resolve, 300));

    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"event":"dcp_compress_queued_after_inflight"');
    expect(logText).toContain('"reason":"post_in_flight_replay"');
  });

  test("DCP compress event ignored for sub-agent sessions", async () => {
    const parentSessionID = `dcp-parent-${Date.now()}`;
    const subSessionID = `dcp-sub-${Date.now()}`;

    const fakeClient = createFakeClient({
      messagesRows: [{ id: "u1", role: "user", content: "Sub-agent task" }],
      promptText: "## Session Memory\n\n### Active References\n- ignored\n",
    });
    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
        injectInSubagents: true,
        remindEveryN: 1,
        debounceMs: 0,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID: parentSessionID });
    await writeText(memoryPathFor(parentSessionID), "## Session Memory\n\n### User Instructions\n- Parent context\n");

    // Create sub-agent session
    const subCreateInput = {
      sessionID: subSessionID,
      event: {
        type: "session.created",
        properties: {
          info: { id: subSessionID, parentID: parentSessionID },
        },
      },
    };
    await plugin["session.created"](subCreateInput);

    // Reset client calls
    client.calls.prompt = [];
    client.calls.messages = [];

    // Fire DCP compress event for the sub-agent session
    const dcpCompressEvent = {
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: subSessionID,
          part: {
            type: "tool",
            tool: "compress",
            state: { status: "completed" },
          },
        },
      },
    };
    await plugin.event(dcpCompressEvent as any);

    // Sub-agent should NOT trigger an update (no client calls)
    expect(client.calls.messages.length).toBe(0);
    expect(client.calls.prompt.length).toBe(0);

    // But sub-agent memory should still be injectable (inherited from parent)
    const systemOutput = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"](
      { sessionID: subSessionID, messageID: "sub-dcp-msg" },
      systemOutput,
    );
    expect(systemOutput.system.length).toBe(1);
    expect(systemOutput.system[0]).toContain("Parent context");
  });

  test("DCP compress event on non-compress tool part is ignored", async () => {
    const sessionID = `dcp-other-tool-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [],
      promptText: "",
    });
    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
        debounceMs: 0,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });

    // Fire an event for a non-compress tool
    const otherToolEvent = {
      event: {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            type: "tool",
            tool: "write",
            state: { status: "completed" },
          },
        },
      },
    };

    await plugin.event(otherToolEvent as any);

    // Should NOT trigger memory update
    expect(client.calls.messages.length).toBe(0);
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).not.toContain("dcp_compress");
  });

  test("DCP module is importable and has expected shape", async () => {
    // Dynamic import returns module namespace; destructure .default for the export
    const dcpPath = import.meta.resolve("@tarquinen/opencode-dcp");
    const dcpRaw = (await import(dcpPath)) as Record<string, unknown>;
    const dcpModule = dcpRaw.default ?? dcpRaw;
    // DCP's compiled output exports { id: string, server: Plugin }
    expect(typeof dcpModule.id).toBe("string");
    expect(typeof dcpModule.server).toBe("function");

    // Instantiate DCP plugin alongside fake client
    const fakeClient = createFakeClient({ messagesRows: [], promptText: "" });
    const factory = dcpModule.server;
    const dcpPluginInstance = await factory({
      client: fakeClient as Record<string, unknown>,
      directory: testDir,
    } as Record<string, unknown>);

    // DCP should register its compress tool
    expect(dcpPluginInstance.tool).toBeDefined();
    expect(dcpPluginInstance.tool.compress).toBeDefined();

    // DCP should register /dcp command
    const opencodeConfig: Record<string, unknown> = {};
    await dcpPluginInstance.config?.(opencodeConfig);
    expect(opencodeConfig.command?.dcp).toBeDefined();
  });

  test("STM plugin coexists without conflict when DCP is imported", async () => {
    const sessionID = `dcp-coexist-${Date.now()}`;

    // Import DCP to verify it loads without errors
    await import("@tarquinen/opencode-dcp");

    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "Coexistence test" },
        { id: "a1", role: "assistant", content: "Both plugins active" },
      ],
      promptText: "## Session Memory\n\n### Active References\n- coexistence verified\n",
    });

    const { plugin: stmPlugin } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
        debounceMs: 0,
      },
      fakeClient,
    );

    await stmPlugin["session.created"]({ sessionID });

    // STM should work normally
    const status = await stmPlugin.tool.short_term_memory.execute({ action: "status" }, { sessionID });
    expect(String(status)).toContain("Session Memory Plugin Status");

    // Memory update should work
    await stmPlugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    const memory = await readText(memoryPathFor(sessionID), "");
    expect(memory).toContain("coexistence verified");
  });
});
