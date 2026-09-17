import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointPathFor, INJECTION_PREFIX, memoryPathFor, readText, writeText } from "../src/memory-utils";
import { MAX_SESSION_STATES } from "../src/session-state";
import { createFakeClient, createPlugin, extractTaggedChildSystemDeliveries } from "./test-helpers";

const MEMORY = "## Session Memory\n\n### Long Horizon Context\n- Preserve DELIVERY_TOKEN\n";

function childCreatedInput(sessionID: string, parentID: string) {
  return {
    sessionID,
    event: {
      type: "session.created",
      properties: { info: { id: sessionID, parentID } },
    },
  };
}

function dcpCompressEvent(sessionID: string) {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: { type: "tool", tool: "compress", state: { status: "completed" } },
      },
    },
  };
}

async function sendUserTurn(plugin: any, sessionID: string, messageID: string, text = "continue") {
  const output = { message: { role: "assistant", content: "ok" }, system: ["UNCHANGED_SYSTEM"] };
  await plugin["chat.message"](
    { sessionID, messageID, message: { id: messageID, role: "user", content: text } },
    output,
  );
  return output;
}

async function sendAnonymousUserTurn(plugin: any, sessionID: string, text = "continue") {
  const output = { message: { role: "assistant", content: "ok" }, system: ["UNCHANGED_SYSTEM"] };
  await plugin["chat.message"]({ sessionID, message: { role: "user", content: text } }, output);
  return output;
}

function expectTaggedNoReplyDelivery(delivery: unknown, sessionID: string) {
  const request = delivery as {
    path?: { id?: string };
    body?: { noReply?: boolean; parts?: Array<{ type?: string; text?: string }> };
  };
  expect(request.path).toEqual({ id: sessionID });
  expect(request.body?.noReply).toBe(true);
  expect(request.body?.parts).toHaveLength(1);
  expect(request.body?.parts?.[0]).toMatchObject({ type: "text" });
  expect(request.body?.parts?.[0]?.text).toContain(INJECTION_PREFIX);
  expect(request.body?.parts?.[0]?.text).toContain("DELIVERY_TOKEN");
}

describe("delivery conversion", () => {
  const originalCwd = process.cwd();
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-delivery-conversion-test-"));
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
    await rm(testDir, { recursive: true, force: true });
  });

  test("default main delivery uses noReply every N distinct user turns without mutating output.system", async () => {
    const sessionID = "main-cadence";
    const fakeClient = createFakeClient();
    const { plugin, client } = await createPlugin({ remindEveryN: 2, debug: false }, fakeClient);
    await writeText(memoryPathFor(sessionID), MEMORY);
    await plugin["session.created"]({ sessionID });

    const first = await sendUserTurn(plugin, sessionID, "user-1");
    const second = await sendUserTurn(plugin, sessionID, "user-2");
    const third = await sendUserTurn(plugin, sessionID, "user-3");
    const fourth = await sendUserTurn(plugin, sessionID, "user-4");

    expect(first.system).toEqual(["UNCHANGED_SYSTEM"]);
    expect(second.system).toEqual(["UNCHANGED_SYSTEM"]);
    expect(third.system).toEqual(["UNCHANGED_SYSTEM"]);
    expect(fourth.system).toEqual(["UNCHANGED_SYSTEM"]);
    expect(client.calls.noReplyDeliveries).toHaveLength(2);
    expect(client.calls.summarizerPrompts).toHaveLength(0);
    for (const delivery of client.calls.noReplyDeliveries) {
      expectTaggedNoReplyDelivery(delivery, sessionID);
    }
  });

  test("duplicate user identity neither advances cadence nor redelivers", async () => {
    const sessionID = "main-dedupe";
    const fakeClient = createFakeClient();
    const { plugin, client } = await createPlugin({ remindEveryN: 2, debug: false }, fakeClient);
    await writeText(memoryPathFor(sessionID), MEMORY);
    await plugin["session.created"]({ sessionID });

    await sendUserTurn(plugin, sessionID, "user-1", "same content");
    expect(client.calls.noReplyDeliveries).toHaveLength(0);

    await sendUserTurn(plugin, sessionID, "user-2", "same content");
    expect(client.calls.noReplyDeliveries).toHaveLength(1);

    await sendUserTurn(plugin, sessionID, "user-1", "same content");
    expect(client.calls.noReplyDeliveries).toHaveLength(1);
  });

  test("same-text anonymous user hook invocations count as distinct turns", async () => {
    const sessionID = "main-anonymous-identity";
    const fakeClient = createFakeClient();
    const { plugin, client } = await createPlugin({ remindEveryN: 2, debug: false }, fakeClient);
    await writeText(memoryPathFor(sessionID), MEMORY);
    await plugin["session.created"]({ sessionID });

    await sendAnonymousUserTurn(plugin, sessionID, "same content");
    await sendAnonymousUserTurn(plugin, sessionID, "same content");

    expect(client.calls.noReplyDeliveries).toHaveLength(1);
    expectTaggedNoReplyDelivery(client.calls.noReplyDeliveries[0], sessionID);
  });

  test("resolved noReply error retries the same explicit turn once and records only the successful injection", async () => {
    const sessionID = "main-retry";
    const fakeClient = createFakeClient({ noReplyResolvedErrors: 1 });
    const { plugin, client } = await createPlugin({ remindEveryN: 1, debug: false }, fakeClient);
    await writeText(memoryPathFor(sessionID), MEMORY);
    await plugin["session.created"]({ sessionID });

    await sendUserTurn(plugin, sessionID, "retry-turn");
    await sendUserTurn(plugin, sessionID, "retry-turn");
    await sendUserTurn(plugin, sessionID, "retry-turn");

    expect(client.calls.noReplyDeliveries).toHaveLength(2);
    expect(client.calls.summarizerPrompts).toHaveLength(0);
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText.match(/"event":"memory_inject_failed"/g) ?? []).toHaveLength(1);
    expect(logText.match(/"event":"memory_inject_done"/g) ?? []).toHaveLength(1);
  });

  test("main DCP with persisted memory and no collected messages still delivers without summarizing", async () => {
    const sessionID = "main-dcp-no-write";
    const fakeClient = createFakeClient({ messagesRows: [] });
    const { plugin, client } = await createPlugin({ debug: false }, fakeClient);
    await writeText(memoryPathFor(sessionID), MEMORY);
    await plugin["session.created"]({ sessionID });

    await plugin.event(dcpCompressEvent(sessionID) as any);

    expect(await readText(memoryPathFor(sessionID), "")).toBe(MEMORY);
    expect(client.calls.messages).toHaveLength(1);
    expect(client.calls.summarizerPrompts).toHaveLength(0);
    expect(client.calls.noReplyDeliveries).toHaveLength(1);
    expectTaggedNoReplyDelivery(client.calls.noReplyDeliveries[0], sessionID);
  });

  test("legacy opt-in keeps cadence in the system transform and chat does not noReply", async () => {
    const sessionID = "legacy-main";
    const fakeClient = createFakeClient();
    const { plugin, client } = await createPlugin(
      { enableLegacyPeriodicSystemTransform: true, remindEveryN: 2, debug: false },
      fakeClient,
    );
    await writeText(memoryPathFor(sessionID), MEMORY);
    await plugin["session.created"]({ sessionID });

    await sendUserTurn(plugin, sessionID, "chat-1");
    await sendUserTurn(plugin, sessionID, "chat-2");
    expect(client.calls.noReplyDeliveries).toHaveLength(0);

    const first = { system: [] as string[] };
    const second = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "legacy-1" }, first);
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "legacy-2" }, second);

    expect(first.system).toHaveLength(0);
    expect(second.system).toHaveLength(1);
    expect(second.system[0]).toContain(INJECTION_PREFIX);
    expect(second.system[0]).toContain("DELIVERY_TOKEN");
  });

  test("child startup injects its creation snapshot exactly once after the parent changes", async () => {
    const parentID = "snapshot-parent";
    const childID = "snapshot-child";
    const { plugin } = await createPlugin({ injectInSubagents: true, debug: false });
    await writeText(memoryPathFor(parentID), "## Session Memory\n\n### Decisions\n- ORIGINAL_PARENT\n");
    await plugin["session.created"]({ sessionID: parentID });
    await plugin["session.created"](childCreatedInput(childID, parentID));
    await writeText(memoryPathFor(parentID), "## Session Memory\n\n### Decisions\n- CHANGED_PARENT\n");

    const startup = { system: [] as string[] };
    const duplicate = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, messageID: "child-1" }, startup);
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, messageID: "child-2" }, duplicate);

    expect(extractTaggedChildSystemDeliveries(startup)).toHaveLength(1);
    expect(startup.system[0]).toContain("ORIGINAL_PARENT");
    expect(startup.system[0]).not.toContain("CHANGED_PARENT");
    expect(extractTaggedChildSystemDeliveries(duplicate)).toHaveLength(0);
  });

  test("child startup snapshot survives main-session state LRU churn", async () => {
    const parentID = "lru-parent";
    const childID = "lru-child";
    const fakeClient = createFakeClient();
    const { plugin } = await createPlugin(
      { injectInSubagents: true, remindEveryN: MAX_SESSION_STATES + 2, debug: false },
      fakeClient,
    );
    await writeText(memoryPathFor(parentID), "## Session Memory\n\n### Decisions\n- CHILD_LRU_SNAPSHOT\n");
    await plugin["session.created"]({ sessionID: parentID });
    await plugin["session.created"](childCreatedInput(childID, parentID));

    for (let i = 0; i <= MAX_SESSION_STATES; i += 1) {
      await sendUserTurn(plugin, `lru-main-${i}`, `turn-${i}`);
    }

    const startup = { system: [] as string[] };
    const duplicate = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, messageID: "startup" }, startup);
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, messageID: "duplicate" }, duplicate);

    expect(extractTaggedChildSystemDeliveries(startup)).toHaveLength(1);
    expect(startup.system[0]).toContain("CHILD_LRU_SNAPSHOT");
    expect(extractTaggedChildSystemDeliveries(duplicate)).toHaveLength(0);
  });

  test("child session.updated and session.idle do not bootstrap, collect, summarize, or deliver", async () => {
    const parentID = "child-hooks-parent";
    const childID = "child-hooks-child";
    const fakeClient = createFakeClient({
      messagesRows: [{ id: "existing-user", role: "user", content: "must not be collected" }],
    });
    const { plugin, client } = await createPlugin({ injectInSubagents: true, debug: false }, fakeClient);
    await writeText(memoryPathFor(parentID), MEMORY);
    await plugin["session.created"]({ sessionID: parentID });
    await plugin["session.created"](childCreatedInput(childID, parentID));

    await plugin["session.updated"]({ sessionID: childID } as any);
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: childID } } } as any);

    expect(client.calls.messages).toHaveLength(0);
    expect(client.calls.summarizerPrompts).toHaveLength(0);
    expect(client.calls.noReplyDeliveries).toHaveLength(0);
  });

  test("child DCP creates one pending snapshot injection without message collection or summarization", async () => {
    const parentID = "dcp-parent";
    const childID = "dcp-child";
    const fakeClient = createFakeClient();
    const { plugin, client } = await createPlugin({ injectInSubagents: true, debug: false }, fakeClient);
    await writeText(memoryPathFor(parentID), "## Session Memory\n\n### Decisions\n- CHILD_DCP_SNAPSHOT\n");
    await plugin["session.created"]({ sessionID: parentID });
    await plugin["session.created"](childCreatedInput(childID, parentID));

    const startup = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, messageID: "startup" }, startup);
    expect(extractTaggedChildSystemDeliveries(startup)).toHaveLength(1);

    await plugin.event(dcpCompressEvent(childID) as any);
    const dcp = { system: [] as string[] };
    const duplicate = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, messageID: "after-dcp" }, dcp);
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, messageID: "after-dcp-2" }, duplicate);

    expect(extractTaggedChildSystemDeliveries(dcp)).toHaveLength(1);
    expect(dcp.system[0]).toContain("CHILD_DCP_SNAPSHOT");
    expect(extractTaggedChildSystemDeliveries(duplicate)).toHaveLength(0);
    expect(client.calls.messages).toHaveLength(0);
    expect(client.calls.summarizerPrompts).toHaveLength(0);
    expect(client.calls.noReplyDeliveries).toHaveLength(0);
  });

  test("main compaction uses disk memory while child compaction uses its immutable snapshot", async () => {
    const mainID = "compact-main";
    const childID = "compact-child";
    const fakeClient = createFakeClient({ messagesRows: [] });
    const { plugin, client } = await createPlugin({ injectInSubagents: true, debug: false }, fakeClient);
    await writeText(memoryPathFor(mainID), "## Session Memory\n\n### Decisions\n- SNAPSHOT_VERSION\n");
    await plugin["session.created"]({ sessionID: mainID });
    await plugin["session.created"](childCreatedInput(childID, mainID));
    await writeText(memoryPathFor(mainID), "## Session Memory\n\n### Decisions\n- CURRENT_MAIN_VERSION\n");

    const childOutput = { context: [] as string[] };
    await plugin["experimental.session.compacting"]({ sessionID: childID }, childOutput);

    expect(childOutput.context).toHaveLength(1);
    expect(childOutput.context[0]).toContain("SNAPSHOT_VERSION");
    expect(childOutput.context[0]).not.toContain("CURRENT_MAIN_VERSION");
    expect(client.calls.messages).toHaveLength(0);
    expect(client.calls.summarizerPrompts).toHaveLength(0);
    expect(client.calls.noReplyDeliveries).toHaveLength(0);

    const mainOutput = { context: [] as string[] };
    await plugin["experimental.session.compacting"]({ sessionID: mainID }, mainOutput);
    expect(mainOutput.context).toHaveLength(1);
    expect(mainOutput.context[0]).toContain("CURRENT_MAIN_VERSION");
  });

  test("tagged memory is neither collected nor delivered back to the session", async () => {
    const sessionID = "self-filter";
    const tagged = `${INJECTION_PREFIX}\nDO_NOT_RECOLLECT`;
    const fakeClient = createFakeClient({ messagesRows: [{ id: "self-1", role: "user", content: tagged }] });
    const { plugin, client } = await createPlugin({ summarizerMode: "active", remindEveryN: 1, debug: false }, fakeClient);
    await writeText(memoryPathFor(sessionID), MEMORY);
    await plugin["session.created"]({ sessionID });

    await plugin["message.updated"]({ sessionID, message: { role: "user", content: tagged } });
    await sendUserTurn(plugin, sessionID, "self-1", tagged);
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(client.calls.noReplyDeliveries).toHaveLength(0);
    expect(client.calls.summarizerPrompts).toHaveLength(0);
  });

  test("reset clears main cadence and pending child startup delivery", async () => {
    const mainID = "reset-main";
    const childID = "reset-child";
    const fakeClient = createFakeClient();
    const { plugin, client } = await createPlugin(
      { remindEveryN: 2, injectInSubagents: true, debug: false },
      fakeClient,
    );
    await writeText(memoryPathFor(mainID), MEMORY);
    await plugin["session.created"]({ sessionID: mainID });
    await sendUserTurn(plugin, mainID, "before-reset");
    await plugin["session.created"](childCreatedInput(childID, mainID));

    await plugin.tool.short_term_memory.execute({ action: "reset" }, { sessionID: mainID });
    await writeText(memoryPathFor(mainID), MEMORY);
    await plugin.tool.short_term_memory.execute({ action: "reset" }, { sessionID: childID });
    await sendUserTurn(plugin, mainID, "after-reset");
    const childOutput = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, messageID: "after-reset" }, childOutput);

    expect(client.calls.noReplyDeliveries).toHaveLength(0);
    expect(extractTaggedChildSystemDeliveries(childOutput)).toHaveLength(0);
  });

  test("delete removes cadence and pending child state before IDs are reused", async () => {
    const sessionID = "deleted-and-recreated";
    const childID = "deleted-pending-child";
    const fakeClient = createFakeClient();
    const { plugin, client } = await createPlugin(
      { remindEveryN: 2, injectInSubagents: true, debug: false },
      fakeClient,
    );
    await writeText(memoryPathFor(sessionID), MEMORY);
    await plugin["session.created"]({ sessionID });
    await sendUserTurn(plugin, sessionID, "before-delete");
    await plugin["session.created"](childCreatedInput(childID, sessionID));
    await writeText(memoryPathFor(childID), "CHILD_MEMORY");
    await writeText(checkpointPathFor(childID), "child-checkpoint\n");

    await plugin["session.deleted"]({ sessionID });
    const deletedChildOutput = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"](
      { sessionID: childID, messageID: "after-parent-delete" },
      deletedChildOutput,
    );
    await writeText(memoryPathFor(sessionID), MEMORY);
    await plugin["session.created"]({ sessionID });
    await sendUserTurn(plugin, sessionID, "after-delete");

    expect(extractTaggedChildSystemDeliveries(deletedChildOutput)).toHaveLength(0);
    expect(await readText(memoryPathFor(childID), "missing")).toBe("missing");
    expect(await readText(checkpointPathFor(childID), "missing")).toBe("missing");
    expect(client.calls.noReplyDeliveries).toHaveLength(0);
    await sendUserTurn(plugin, sessionID, "second-after-delete");
    expect(client.calls.noReplyDeliveries).toHaveLength(1);
  });

  test("named tools and short_term_memory remain compatible while status and settings hide memory content", async () => {
    const sessionID = "tool-compatibility";
    const secret = "PRIVATE_MEMORY_CONTENT";
    const { plugin } = await createPlugin({ debug: false });
    await writeText(memoryPathFor(sessionID), `## Session Memory\n\n### Decisions\n- ${secret}\n`);
    await plugin["session.created"]({ sessionID });

    const namedRead = await plugin.tool.stm_memory_read.execute({}, { sessionID });
    const wrapperRead = await plugin.tool.short_term_memory.execute({ action: "show" }, { sessionID });
    const namedStatus = await plugin.tool.stm_memory_status.execute({}, { sessionID });
    const wrapperStatus = await plugin.tool.short_term_memory.execute({ action: "status" }, { sessionID });
    const namedSettings = await plugin.tool.stm_memory_settings.execute({}, { sessionID });
    const wrapperSettings = await plugin.tool.short_term_memory.execute({ action: "settings" }, { sessionID });

    expect(String(namedRead)).toBe(String(wrapperRead));
    expect(String(namedRead)).toContain(secret);
    expect(String(namedStatus)).toContain("- effectiveDeliveryMode: promptNoReply");
    expect(String(wrapperStatus)).toContain("- effectiveDeliveryMode: promptNoReply");
    expect(String(namedSettings)).toContain('"effectiveDeliveryMode": "promptNoReply"');
    expect(String(wrapperSettings)).toContain('"effectiveDeliveryMode": "promptNoReply"');
    for (const diagnostic of [namedStatus, wrapperStatus, namedSettings, wrapperSettings]) {
      expect(String(diagnostic)).not.toContain(secret);
    }
    expect(Object.keys(plugin.tool)).toEqual(
      expect.arrayContaining([
        "stm_memory_read",
        "stm_memory_status",
        "stm_memory_update",
        "stm_memory_logs",
        "stm_memory_settings",
        "stm_memory_reset",
        "short_term_memory",
      ]),
    );
  });
});
