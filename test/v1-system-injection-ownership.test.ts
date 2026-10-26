import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, INJECTION_PREFIX, memoryPathFor, writeText } from "../src/memory-utils";
import { createFakeClient, createPlugin as createPluginFixture } from "./test-helpers";

const MEMORY_DIR = join(".opencode", "memory");
const MEMORY = "## Session Memory\n\n### Decisions\n- V1_INJECTION_OWNERSHIP_TOKEN\n";
const MODEL = { providerID: "provider", modelID: "model" };

describe("V1 active-summary system injection ownership", () => {
  const originalCwd = process.cwd();
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "stm-v1-system-injection-test-"));
    process.env.XDG_CONFIG_HOME = join(testDir, ".xdg");
    process.env.OPENCODE_CONFIG_DIR = join(testDir, ".config-dir");
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
    await rm(testDir, { recursive: true, force: true });
  });

  async function createPlugin(config: Partial<typeof DEFAULT_CONFIG>, client = createFakeClient()) {
    const fixture = await createPluginFixture({ memoryDir: MEMORY_DIR, ...config }, client);
    return { ...fixture, client };
  }

  async function sendUserTurn(
    plugin: any,
    sessionID: string,
    messageID: string,
    includeInputMessageID = true,
  ): Promise<void> {
    await plugin["chat.message"](
      { sessionID, ...(includeInputMessageID ? { messageID } : {}), agent: "default", model: MODEL },
      {
        message: { id: messageID, role: "user", agent: "default", model: MODEL },
        parts: [{ type: "text", text: `primary ${messageID}` }],
      },
    );
  }

  test("active legacy opt-in counts primary IDs and leaves summary requests without memory", async () => {
    const sessionID = "active-legacy-cadence";
    const client = createFakeClient({
      messagesRows: [
        { id: "history-user", role: "user", content: "Keep ACTIVE_SUMMARY_HISTORY." },
        { id: "history-assistant", role: "assistant", parentID: "history-user", content: "Kept." },
      ],
    });
    const { plugin } = await createPlugin(
      {
        enabled: true,
        summarizerMode: "active",
        enableLegacyPeriodicSystemTransform: true,
        remindEveryN: 2,
        debug: false,
      },
      client,
    );
    await writeText(memoryPathFor(sessionID, MEMORY_DIR), MEMORY);

    await plugin.tool.stm_memory_update.execute({}, { sessionID });
    const summaryRequest = client.calls.summarizerPrompts[0] as {
      body?: { messageID?: string };
    };
    const summaryMessageID = summaryRequest.body?.messageID;
    expect(typeof summaryMessageID).toBe("string");

    await sendUserTurn(plugin, sessionID, "primary-1", false);
    expect(client.calls.noReplyDeliveries).toHaveLength(0);

    await plugin["chat.message"](
      { sessionID, messageID: summaryMessageID, agent: "default", model: MODEL },
      {
        message: {
          id: summaryMessageID,
          role: "user",
          content: "STM generated summary request",
          agent: "default",
          model: MODEL,
        },
      },
    );
    expect(client.calls.noReplyDeliveries).toHaveLength(0);

    const primaryOutput = { system: [] as string[] };
    const summaryOutput = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, model: MODEL }, primaryOutput);
    await plugin["experimental.chat.system.transform"]({ sessionID, model: MODEL }, summaryOutput);
    expect(primaryOutput.system).toHaveLength(0);
    expect(summaryOutput.system).toHaveLength(0);

    await sendUserTurn(plugin, sessionID, "primary-2");
    expect(client.calls.noReplyDeliveries).toHaveLength(1);
    expect((client.calls.noReplyDeliveries[0] as any).body.parts[0].text).toContain(INJECTION_PREFIX);

    await sendUserTurn(plugin, sessionID, "primary-3");
    expect(client.calls.noReplyDeliveries).toHaveLength(1);

    const log = await Bun.file(join(MEMORY_DIR, "session-memory.log")).text();
    expect(log).toContain('"reason":"active_summary_requests_share_system_transform_without_message_identity"');
    expect(log).toContain('"effectiveTransport":"prompt_no_reply"');
  });

  test("active fallback retries the eligible primary ID without advancing cadence again", async () => {
    const sessionID = "active-legacy-retry";
    const client = createFakeClient({ noReplyFailures: 1 });
    const { plugin } = await createPlugin(
      {
        enabled: true,
        summarizerMode: "active",
        enableLegacyPeriodicSystemTransform: true,
        remindEveryN: 2,
        debug: false,
      },
      client,
    );
    await writeText(memoryPathFor(sessionID, MEMORY_DIR), MEMORY);

    await sendUserTurn(plugin, sessionID, "retry-primary-1");
    expect(client.calls.noReplyDeliveries).toHaveLength(0);
    await sendUserTurn(plugin, sessionID, "retry-primary-2");
    expect(client.calls.noReplyDeliveries).toHaveLength(1);
    await sendUserTurn(plugin, sessionID, "retry-primary-2");
    expect(client.calls.noReplyDeliveries).toHaveLength(2);
    await sendUserTurn(plugin, sessionID, "retry-primary-3");
    expect(client.calls.noReplyDeliveries).toHaveLength(2);
  });

  test("simultaneous primary admissions keep their own cadence slots", async () => {
    const sessionID = "active-legacy-concurrent";
    const { plugin, client } = await createPlugin({
      enabled: true,
      summarizerMode: "active",
      enableLegacyPeriodicSystemTransform: true,
      remindEveryN: 2,
      debug: false,
    });
    await writeText(memoryPathFor(sessionID, MEMORY_DIR), MEMORY);

    await Promise.all([
      sendUserTurn(plugin, sessionID, "concurrent-primary-1"),
      sendUserTurn(plugin, sessionID, "concurrent-primary-2"),
    ]);
    expect(client.calls.noReplyDeliveries).toHaveLength(1);

    await Promise.all([
      sendUserTurn(plugin, sessionID, "concurrent-primary-3"),
      sendUserTurn(plugin, sessionID, "concurrent-primary-4"),
    ]);
    expect(client.calls.noReplyDeliveries).toHaveLength(2);
  });

  test("active fallback reset restarts cadence and deleted prompt ownership does not leak", async () => {
    const sessionID = "active-legacy-reset-delete";
    const client = createFakeClient({
      messagesRows: [
        { id: "history-user", role: "user", content: "Keep RESET_DELETE_HISTORY." },
        { id: "history-assistant", role: "assistant", parentID: "history-user", content: "Kept." },
      ],
    });
    const { plugin } = await createPlugin(
      {
        enabled: true,
        summarizerMode: "active",
        enableLegacyPeriodicSystemTransform: true,
        remindEveryN: 2,
        debug: false,
      },
      client,
    );
    await writeText(memoryPathFor(sessionID, MEMORY_DIR), MEMORY);
    await plugin.tool.stm_memory_update.execute({}, { sessionID });
    const summaryID = (client.calls.summarizerPrompts[0] as { body?: { messageID?: string } }).body?.messageID;
    expect(typeof summaryID).toBe("string");

    await sendUserTurn(plugin, sessionID, "before-reset-1");
    await plugin.tool.short_term_memory.execute({ action: "reset" }, { sessionID });
    await plugin["chat.message"](
      { sessionID, messageID: summaryID, agent: "default", model: MODEL },
      { message: { id: summaryID, role: "user", content: "Late STM summary request" } },
    );
    await writeText(memoryPathFor(sessionID, MEMORY_DIR), MEMORY);
    await sendUserTurn(plugin, sessionID, "after-reset-1");
    expect(client.calls.noReplyDeliveries).toHaveLength(0);
    await sendUserTurn(plugin, sessionID, "after-reset-2");
    expect(client.calls.noReplyDeliveries).toHaveLength(1);

    await plugin["session.deleted"]({ sessionID });
    await plugin["session.created"]({ sessionID });
    await writeText(memoryPathFor(sessionID, MEMORY_DIR), MEMORY);
    await sendUserTurn(plugin, sessionID, "after-delete-1");
    await plugin["chat.message"](
      { sessionID, messageID: summaryID, agent: "default", model: MODEL },
      { message: { id: summaryID, role: "user", content: "Reused after deletion" } },
    );
    expect(client.calls.noReplyDeliveries).toHaveLength(2);
  });

  test("switching from clean legacy transform to active fallback starts a fresh cadence", async () => {
    const sessionID = "active-legacy-mode-switch";
    const originalDateNow = Date.now;
    let clockNow = originalDateNow();
    Date.now = () => clockNow;
    try {
      const { plugin, client } = await createPlugin({
        enabled: true,
        summarizerMode: "clean",
        enableLegacyPeriodicSystemTransform: true,
        remindEveryN: 2,
        debug: false,
      });
      await plugin["session.created"]({ sessionID });
      await writeText(memoryPathFor(sessionID, MEMORY_DIR), MEMORY);

      const oldTransform = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"](
        { sessionID, model: MODEL, messageID: "old-transform" },
        oldTransform,
      );
      expect(oldTransform.system).toHaveLength(0);

      await writeText(
        join(".opencode", "stm.json"),
        JSON.stringify({
          enabled: true,
          summarizerMode: "active",
          enableLegacyPeriodicSystemTransform: true,
          remindEveryN: 2,
          memoryDir: MEMORY_DIR,
          debug: false,
        }),
      );
      clockNow += 60_001;

      await sendUserTurn(plugin, sessionID, "after-switch-1");
      expect(client.calls.noReplyDeliveries).toHaveLength(0);
      await sendUserTurn(plugin, sessionID, "after-switch-2");
      expect(client.calls.noReplyDeliveries).toHaveLength(1);

      const log = await Bun.file(join(MEMORY_DIR, "session-memory.log")).text();
      expect(log).toContain('"event":"memory_inject_cadence_reset"');
      expect(log).toContain('"previousTransport":"legacy_system_transform"');
      expect(log).toContain('"nextTransport":"prompt_no_reply"');
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("clean legacy cadence remains unchanged", async () => {
    const cleanID = "clean-legacy-cadence";
    const { plugin, client } = await createPlugin({
      enabled: true,
      summarizerMode: "clean",
      enableLegacyPeriodicSystemTransform: true,
      remindEveryN: 2,
      debug: false,
    });
    await plugin["session.created"]({ sessionID: cleanID });
    await writeText(memoryPathFor(cleanID, MEMORY_DIR), MEMORY);

    const first = { system: [] as string[] };
    const second = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"](
      { sessionID: cleanID, model: MODEL, messageID: "clean-1" },
      first,
    );
    await plugin["experimental.chat.system.transform"](
      { sessionID: cleanID, model: MODEL, messageID: "clean-2" },
      second,
    );
    expect(first.system).toHaveLength(0);
    expect(second.system).toHaveLength(1);
    expect(second.system[0]).toContain(INJECTION_PREFIX);
    expect(client.calls.noReplyDeliveries).toHaveLength(0);
  });

  test("active-mode child startup system injection stays available", async () => {
    const childParentID = "active-child-parent";
    const childID = "active-child";
    const { plugin } = await createPlugin({
      enabled: true,
      summarizerMode: "active",
      enableLegacyPeriodicSystemTransform: true,
      injectInSubagents: true,
      debug: false,
    });
    await plugin["session.created"]({ sessionID: childParentID });
    await writeText(memoryPathFor(childParentID, MEMORY_DIR), MEMORY);
    await plugin["session.created"]({
      sessionID: childID,
      event: { properties: { info: { parentID: childParentID } } },
    });
    const childStartup = { system: [] as string[] };
    const childDuplicate = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, model: MODEL }, childStartup);
    await plugin["experimental.chat.system.transform"]({ sessionID: childID, model: MODEL }, childDuplicate);
    expect(childStartup.system).toHaveLength(1);
    expect(childStartup.system[0]).toContain("V1_INJECTION_OWNERSHIP_TOKEN");
    expect(childDuplicate.system).toHaveLength(0);
  });
});
