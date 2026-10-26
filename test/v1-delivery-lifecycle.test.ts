import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred } from "./async-helpers";

// Delay actual logging at the final delivery boundary, without changing reset,
// history selection, or the host delivery implementation. Run with --isolate.
const memoryUtils = await import("../src/memory-utils");
const actualLogEvent = memoryUtils.logEvent;
let gate:
  | { sessionID: string; started: ReturnType<typeof deferred<void>>; released: ReturnType<typeof deferred<void>> }
  | undefined;
mock.module("../src/memory-utils", () => ({
  ...memoryUtils,
  logEvent: async (...args: Parameters<typeof actualLogEvent>) => {
    const held = gate;
    if (held && args[1] === "memory_inject_start" && args[2]?.sessionID === held.sessionID) {
      held.started.resolve();
      await held.released.promise;
    }
    return actualLogEvent(...args);
  },
}));
const { createFakeClient, createPlugin } = await import("./test-helpers");
const originalCwd = process.cwd();
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stm-delivery-fence-"));
  process.chdir(root);
  process.env.XDG_CONFIG_HOME = join(root, "global");
  process.env.OPENCODE_CONFIG_DIR = join(root, "config");
});
afterEach(async () => {
  gate?.released.resolve();
  gate = undefined;
  process.chdir(originalCwd);
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
  await rm(root, { recursive: true, force: true });
});
const oldMemory = "## Session Memory\n\n### User Instructions\n- PRE_RESET_SECRET\n";
const history = [{ id: "u1", role: "user", text: "old conversation", time: { created: 1 } }];

for (const action of ["reset", "delete"] as const) {
  for (const transport of ["noReply", "legacy", "child"] as const) {
    test(`${action} prevents stale ${transport} delivery after an asynchronous log`, async () => {
      const client = createFakeClient({ messagesRows: history });
      const { plugin } = await createPlugin(
        { debounceMs: 120000, remindEveryN: 1, enableLegacyPeriodicSystemTransform: transport === "legacy" },
        client,
      );
      const parentID = "primary";
      const sessionID = transport === "child" ? "child" : parentID;
      await plugin["session.created"]({ sessionID: parentID });
      await memoryUtils.writeText(memoryUtils.memoryPathFor(parentID), oldMemory);
      if (transport === "child")
        await plugin["session.created"]({ sessionID, event: { properties: { info: { parentID } } } });
      gate = { sessionID, started: deferred<void>(), released: deferred<void>() };
      const output = { system: [] as string[] };
      const delivery =
        transport === "noReply"
          ? plugin["chat.message"](
              { sessionID, messageID: "u2", parts: [{ type: "text", text: "new turn" }] },
              { message: { id: "u2", role: "user" }, parts: [{ type: "text", text: "new turn" }] },
            )
          : plugin["experimental.chat.system.transform"]({ sessionID, messageID: "u2" }, output);
      await gate.started.promise;
      if (action === "reset") await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID });
      else await plugin["session.deleted"]({ sessionID });
      gate.released.resolve();
      await delivery;
      expect(client.calls.noReplyDeliveries).toHaveLength(0);
      expect(output.system).toEqual([]);
      const status = await plugin.tool.stm_memory_status.execute({}, { sessionID });
      expect(status).toContain("injectCount: 0");
      if (action === "reset")
        expect(await memoryUtils.readText(memoryUtils.memoryPathFor(sessionID))).not.toContain("PRE_RESET_SECRET");
      await plugin["session.deleted"]({ sessionID: parentID });
    });
  }
}

test("history failure is an Update error, while genuine empty history is a no-op", async () => {
  const client = createFakeClient();
  const { plugin } = await createPlugin({ debounceMs: 120000 }, client);
  const empty = await plugin.tool.stm_memory_update.execute({}, { sessionID: "primary" });
  expect(empty).toContain("Memory update skipped: no_visible_recent_messages.");
  client.session.messages = async () => {
    throw new Error("host unavailable");
  };
  const failed = await plugin.tool.stm_memory_update.execute({}, { sessionID: "primary" });
  expect(failed).toContain("Memory update failed:");
  expect(failed).toContain("host unavailable");
  expect(client.calls.summarizerPrompts).toHaveLength(0);
});

test("child status follows actual startup and DCP delivery transitions", async () => {
  const client = createFakeClient();
  const { plugin } = await createPlugin({ debounceMs: 120000 }, client);
  await plugin["session.created"]({ sessionID: "primary" });
  await memoryUtils.writeText(memoryUtils.memoryPathFor("primary"), oldMemory);
  await plugin["session.created"]({ sessionID: "child", event: { properties: { info: { parentID: "primary" } } } });
  const status = () => plugin.tool.stm_memory_status.execute({}, { sessionID: "child" });
  expect(await status()).toContain("childStartupInjectionPending: true");
  const startup = { system: [] as string[] };
  await plugin["experimental.chat.system.transform"]({ sessionID: "child", messageID: "first" }, startup);
  expect(startup.system[0]).toContain("PRE_RESET_SECRET");
  expect(await status()).toContain("childStartupInjectionPending: false");
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: { sessionID: "child", part: { type: "tool", tool: "compress", state: { status: "completed" } } },
    },
  });
  expect(await status()).toContain("childDcpInjectionPending: true");
  const afterDcp = { system: [] as string[] };
  await plugin["experimental.chat.system.transform"]({ sessionID: "child", messageID: "after-dcp" }, afterDcp);
  expect(afterDcp.system[0]).toContain("PRE_RESET_SECRET");
  expect(await status()).toContain("childDcpInjectionPending: false");
  await plugin["session.deleted"]({ sessionID: "primary" });
});

test("V1 memoryBytes reports UTF-8 byte length", async () => {
  const { plugin } = await createPlugin({ debounceMs: 120000 });
  const text = "## Session Memory\n\n### User Instructions\n- \u4e2d \u{1F680} caf\u00e9\n";
  await memoryUtils.writeText(memoryUtils.memoryPathFor("unicode"), text);
  const status = await plugin.tool.stm_memory_status.execute({}, { sessionID: "unicode" });
  expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(text.length);
  expect(status).toContain(`memoryBytes: ${Buffer.byteLength(text, "utf8")}`);
});

for (const action of ["reset", "delete"] as const) {
  test(`${action} invalidates compaction output while its fresh summary is pending`, async () => {
    const started = deferred<void>();
    const released = deferred<string>();
    const client = createFakeClient({
      messagesRows: history,
      promptResponder: async () => {
        started.resolve();
        return released.promise;
      },
    });
    const { plugin } = await createPlugin({ debounceMs: 0, summarizerMode: "active" }, client);
    await memoryUtils.writeText(memoryUtils.memoryPathFor("primary"), oldMemory);
    const output = { context: [] as string[] };
    const compaction = plugin["experimental.session.compacting"]({ sessionID: "primary" }, output);
    await started.promise;
    if (action === "reset") await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID: "primary" });
    else await plugin["session.deleted"]({ sessionID: "primary" });
    released.resolve("## Session Memory\n\n### User Instructions\n- OLD_GENERATED_SECRET\n");
    await compaction;
    expect(output.context).toEqual([]);
    expect(await memoryUtils.readText(memoryUtils.memoryPathFor("primary"))).not.toContain("OLD_GENERATED_SECRET");
  });
}

test("cleared delivery claims prevent standalone helper dispatch even when revision resets to the same number", async () => {
  const { deliverMemoryViaNoReply } = await import("../src/injection");
  const { createSessionRuntimeState, resetSessionDeliveryState } = await import("../src/session-state");
  const state = createSessionRuntimeState();
  let dispatched = false;
  gate = { sessionID: "primary", started: deferred<void>(), released: deferred<void>() };
  const delivery = deliverMemoryViaNoReply(
    {
      deliverContextNoReply: async () => {
        dispatched = true;
      },
    },
    "primary",
    "u2",
    0,
    oldMemory,
    memoryUtils.DEFAULT_CONFIG,
    memoryUtils.createRuntimeState(),
    state,
  );
  await gate.started.promise;
  resetSessionDeliveryState(state);
  gate.released.resolve();
  expect(await delivery).toBe(false);
  expect(dispatched).toBe(false);
  expect(state.memoryRevision).toBe(0);
});

test("fresh active pre-compaction update times out to stored memory without releasing generation ownership", async () => {
  const started = deferred<void>();
  const released = deferred<string>();
  const generated = "## Session Memory\n\n### User Instructions\n- LATE_GENERATED_FACT\n";
  const client = createFakeClient({
    messagesRows: history,
    promptResponder: async () => {
      started.resolve();
      return released.promise;
    },
  });
  const { plugin } = await createPlugin({ debounceMs: 0, summarizerMode: "active" }, client);
  await memoryUtils.writeText(memoryUtils.memoryPathFor("primary"), oldMemory);
  const output = { context: [] as string[] };
  const compaction = plugin["experimental.session.compacting"]({ sessionID: "primary" }, output);
  await started.promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const finished = await Promise.race([
      compaction.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 3600);
      }),
    ]);
    expect(finished).toBe(true);
    expect(output.context[0]).toContain("PRE_RESET_SECRET");
    expect(output.context[0]).not.toContain("LATE_GENERATED_FACT");
    const busy = await plugin.tool.stm_memory_update.execute({}, { sessionID: "primary" });
    expect(busy).toContain("deferred");
    expect(client.calls.summarizerPrompts).toHaveLength(1);
    expect(client.calls.abort).toHaveLength(0);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    released.resolve(generated);
    await compaction;
  }
  // The timed-out caller does not own settlement: the retained updater commits later.
  let saved = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    saved = await memoryUtils.readText(memoryUtils.memoryPathFor("primary"));
    if (saved.includes("LATE_GENERATED_FACT")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(saved).toContain("LATE_GENERATED_FACT");
  expect(client.calls.summarizerPrompts).toHaveLength(1);
  await plugin["session.deleted"]({ sessionID: "primary" });
}, 6000);
