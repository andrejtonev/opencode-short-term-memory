import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointPathFor, memoryPathFor, readText } from "../src/memory-utils";
import { createPlugin } from "./test-helpers";

type Row = {
  info: { id: string; role: "user" | "assistant"; time: { created: number }; parentID?: string };
  parts: [{ type: "text"; text: string }];
};

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
let root = "";
let current: { plugin: any; testDir: string; sessionID: string } | undefined;

function row(id: string, role: Row["info"]["role"], text: string, created: number, parentID?: string): Row {
  return {
    info: { id, role, time: { created }, ...(parentID ? { parentID } : {}) },
    parts: [{ type: "text", text }],
  };
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}

async function drain(ms = 350): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function conversationUpdate(prompt: string): string {
  return prompt.match(/<conversation_update>([\s\S]*?)<\/conversation_update>/i)?.[1] ?? prompt;
}

function idle(sessionID: string) {
  return { event: { type: "session.idle", properties: { sessionID } } } as never;
}

function makeClient(
  initialRows: Row[],
  options: {
    malformed?: boolean;
    malformedAttempts?: number;
    rejectPromptBeforePersist?: boolean;
    holdFirst?: boolean;
    maxPrompts?: number;
    onPrompt?: (prompt: Record<string, unknown>) => Promise<void>;
  } = {},
) {
  const rows = [...initialRows];
  const calls = {
    messages: [] as unknown[],
    prompt: [] as unknown[],
    create: [] as unknown[],
    delete: [] as unknown[],
    summarizerPrompts: [] as unknown[],
  };
  let promptCount = 0;
  let releaseFirst!: () => void;
  const firstPromptStarted = new Promise<void>((resolve) => (releaseFirst = resolve));
  let plugin: any;
  const generated = [] as Array<{ id: string; parentID: string }>;
  const setPlugin = (value: any) => (plugin = value);
  let firstStarted = false;

  const client = {
    session: {
      messages: async (args?: unknown) => {
        calls.messages.push(args);
        const sessionID = String((args as { path?: { id?: string } })?.path?.id ?? "");
        const limit = Number((args as { query?: { limit?: number } })?.query?.limit ?? rows.length);
        return { data: sessionID.startsWith("side-") ? [] : rows.slice(-limit) };
      },
      prompt: async (args?: unknown) => {
        calls.prompt.push(args);
        const body = (args as { body?: Record<string, unknown> })?.body ?? {};
        const sessionID = String((args as { path?: { id?: string } })?.path?.id ?? "");
        const isSummary = typeof body.system === "string";
        if (isSummary) calls.summarizerPrompts.push(args);
        if (body.noReply === true) return { data: { parts: [] } };
        promptCount += 1;
        if (promptCount > (options.maxPrompts ?? 3)) throw new Error("bounded test prompt limit exceeded");
        const messageID = String(body.messageID ?? `missing-${promptCount}`);
        const promptText = String((body.parts as Array<{ text?: unknown }> | undefined)?.[0]?.text ?? "");
        if (options.rejectPromptBeforePersist && promptCount === 1) {
          throw new Error("transport rejected before history persistence");
        }
        const created = Date.now() + promptCount;
        const assistantID = `generated-assistant-${promptCount}`;
        rows.push(row(messageID, "user", promptText, created, undefined));
        rows.push(row(assistantID, "assistant", `generated assistant sentinel ${promptCount}`, created + 1, messageID));
        generated.push({ id: assistantID, parentID: messageID });
        const dispatch = async (type: string, info: Row["info"]) => {
          if (!plugin) return;
          await plugin.event({ event: { type, properties: { sessionID, info } } });
        };
        await dispatch("message.updated", { ...rows.at(-1)!.info, parts: rows.at(-1)!.parts });
        await plugin?.event({
          event: { type: "session.updated", properties: { info: { id: sessionID, title: "ordinary" } } },
        });
        if (options.onPrompt) await options.onPrompt(body);
        await plugin?.["chat.message"]?.(
          {
            sessionID,
            messageID,
            message: { id: messageID, role: "user", parts: [{ type: "text", text: promptText }] },
          },
          { message: { id: messageID, role: "user" }, parts: [{ type: "text", text: promptText }] },
        );
        await dispatch("session.idle", { id: sessionID, role: "assistant", time: { created: created + 1 } });
        if (options.holdFirst && !firstStarted) {
          firstStarted = true;
          releaseFirst?.();
          await new Promise<void>((resolve) => {
            (client as any).releasePrompt = resolve;
          });
        }
        const text =
          options.malformed || promptCount <= (options.malformedAttempts ?? 0)
            ? `malformed assistant response sentinel ${promptCount} without the required header`
            : "## Session Memory\n\n### Conclusions\n- retained";
        const response = {
          data: { info: { id: `response-${promptCount}`, role: "assistant" }, parts: [{ type: "text", text }] },
        };
        await dispatch("message.updated", {
          id: `response-${promptCount}`,
          role: "assistant",
          time: { created: Date.now() },
          parts: response.data.parts,
        });
        await plugin?.event({
          event: { type: "session.updated", properties: { info: { id: sessionID, title: "ordinary" } } },
        });
        await dispatch("session.idle", { id: sessionID, role: "assistant", time: { created: Date.now() } });
        return response;
      },
      create: async (args?: unknown) => {
        calls.create.push(args);
        return { data: { id: `side-${calls.create.length}` } };
      },
      delete: async (args?: unknown) => {
        calls.delete.push(args);
        return { data: true };
      },
      list: async () => ({ data: [] }),
      get: async (args?: unknown) => ({ data: { id: String((args as { path?: { id?: string } })?.path?.id ?? "") } }),
      abort: async () => ({ data: true }),
    },
    calls,
    rows,
    firstPromptStarted,
    generated,
    setPlugin,
    get promptCount() {
      return promptCount;
    },
    releasePrompt: undefined as (() => void) | undefined,
  } as any;
  return client;
}

async function setup(
  rows: Row[],
  options: Parameters<typeof makeClient>[1] | undefined,
  config: Record<string, unknown>,
  sessionID: string,
) {
  const testDir = await mkdtemp(join(root, "v1-self-generation-"));
  process.env.HOME = join(testDir, "home");
  process.env.XDG_CONFIG_HOME = join(testDir, "xdg");
  process.env.OPENCODE_CONFIG_DIR = join(testDir, "config");
  process.chdir(testDir);
  const client = makeClient(rows, options);
  const { plugin } = await createPlugin({ debounceMs: 100, debug: false, remindEveryN: 1, ...config }, client);
  client.setPlugin(plugin);
  current = { plugin, testDir, sessionID };
  return { testDir, client, plugin };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stm-v1-loop-suite-"));
});

afterEach(async () => {
  if (current) {
    await current.plugin["session.deleted"]({ sessionID: current.sessionID }).catch(() => {});
    await drain();
  }
  current = undefined;
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
  await rm(root, { recursive: true, force: true });
});

describe.serial("V1 self-generation boundaries", () => {
  for (const config of [
    { summarizerMode: "active" },
    { summarizerMode: "clean", cleanFallbackToActiveSession: true, sideSessionRetries: 0 },
  ]) {
    test(`busy manual update defers ${config.summarizerMode} generation until idle`, async () => {
      const sessionID = `busy-manual-${config.summarizerMode}`;
      const { plugin, client } = await setup(
        [row("external-user", "user", "retain this instruction", Date.now())],
        { rejectPromptBeforePersist: config.summarizerMode === "clean" },
        config,
        sessionID,
      );
      await plugin.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } });
      // Model a host that cannot service another prompt while its tool is running.
      const originalPrompt = client.session.prompt;
      client.session.prompt = async () => {
        throw new Error("re-entrant prompt while tool is running");
      };
      for (const [name, args] of [
        ["stm_memory_update", {}],
        ["short_term_memory", { action: "update" }],
      ] as const) {
        const result = await plugin.tool[name].execute(args, { sessionID });
        expect(result).toContain("deferred until the current session becomes idle");
        expect(result).toContain("has not refreshed");
      }
      expect(client.calls.summarizerPrompts).toHaveLength(0);
      expect(await readText(checkpointPathFor(sessionID), "")).toBe("");
      client.session.prompt = originalPrompt;
      await plugin.event(idle(sessionID));
      const expectedAttempts = config.summarizerMode === "clean" ? 2 : 1;
      await waitFor(() => client.calls.summarizerPrompts.length === expectedAttempts);
      await drain();
      expect(await readText(memoryPathFor(sessionID), "")).toContain("retained");
      expect(await readText(checkpointPathFor(sessionID), "")).toContain("external-user");
      await plugin.event(idle(sessionID));
      await drain();
      expect(client.calls.summarizerPrompts).toHaveLength(expectedAttempts);
    });
  }

  test("side-session registration fences a title-less create event already awaiting config", async () => {
    const sessionID = "create-registration-race";
    const { plugin, client } = await setup(
      [row("external-user", "user", "summarize this", Date.now())],
      {},
      { summarizerMode: "clean" },
      sessionID,
    );
    let created: Promise<void> | undefined;
    client.session.create = async () => {
      created = plugin.event({
        event: { type: "session.created", properties: { info: { id: "side-race" } } },
      } as never);
      return { data: { id: "side-race" } };
    };
    const originalPrompt = client.session.prompt;
    client.session.prompt = async (args: unknown) => {
      await created;
      expect(await Bun.file(memoryPathFor("side-race")).exists()).toBe(false);
      return originalPrompt(args);
    };
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    await created;
    await drain();
    expect(client.calls.messages.filter((call: any) => call.path?.id === "side-race")).toHaveLength(0);
    expect(await readText(memoryPathFor(sessionID), "")).toContain("retained");
  });

  // Eighteen sequential retries exercise owned-message eviction and real disk
  // writes; allow bounded headroom for Windows filesystem scheduling.
  test("malformed active response does not repeat or advance the checkpoint", async () => {
    const sessionID = "malformed-active";
    const { plugin, client } = await setup(
      [row("external-user", "user", "remember this", Date.now())],
      { malformed: true, maxPrompts: 20 },
      { summarizerMode: "active" },
      sessionID,
    );
    await plugin.event(idle(sessionID));
    await waitFor(() => client.promptCount === 1);
    await plugin.event(idle(sessionID));
    await drain();
    expect(client.promptCount).toBe(1);
    expect(await readText(checkpointPathFor(sessionID), "")).toBe("");
    for (let attempt = 0; attempt < 17; attempt += 1) {
      await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    }
    expect(client.promptCount).toBe(18);
    const lastPrompt = String((client.calls.summarizerPrompts.at(-1) as any).body.parts[0].text);
    const lastConversation = conversationUpdate(lastPrompt);
    expect(lastConversation).toContain("remember this");
    expect(lastPrompt).not.toContain("summary prompt");
    for (let attempt = 1; attempt <= 18; attempt += 1) {
      expect(lastConversation).not.toContain(`generated assistant sentinel ${attempt}`);
    }
    expect(await readText(checkpointPathFor(sessionID), "")).toBe("");
    for (let attempt = 0; attempt < 3; attempt += 1) await plugin.event(idle(sessionID));
    await drain();
    expect(client.promptCount).toBe(18);
  }, 10_000);

  test("valid generation commits once and excludes its own prompt and parent assistant", async () => {
    const sessionID = "valid-active";
    const now = Date.now();
    const { plugin, client } = await setup(
      [
        row("external-user", "user", "remember this", now),
        row("external-assistant", "assistant", "ordinary response", now + 1),
      ],
      {},
      { summarizerMode: "active" },
      sessionID,
    );
    await plugin.event(idle(sessionID));
    await waitFor(() => client.promptCount === 1);
    await drain(350);
    expect(client.promptCount).toBe(1);
    const checkpoint = await readText(checkpointPathFor(sessionID), "");
    expect(checkpoint).toContain("external-assistant");
    expect(checkpoint).not.toContain("generated-assistant");
    expect(
      client.generated.every(
        (entry: { id: string; parentID: string }) =>
          entry.id.startsWith("generated-assistant-") && entry.parentID.startsWith("msg_"),
      ),
    ).toBe(true);
    client.rows.push(row("external-next", "user", "new external request", Date.now() + 10));
    await plugin["chat.message"](
      {
        sessionID,
        messageID: "external-next",
        message: { id: "external-next", role: "user", parts: [{ type: "text", text: "new external request" }] },
      },
      { message: { id: "external-next", role: "user" }, parts: [{ type: "text", text: "new external request" }] },
    );
    const beforeUpdate = client.calls.summarizerPrompts.length;
    expect(await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID })).toContain("deferred");
    expect(client.calls.summarizerPrompts).toHaveLength(beforeUpdate);
    await plugin.event(idle(sessionID));
    await waitFor(() => client.calls.summarizerPrompts.length > beforeUpdate);
    await drain();
    const systems = client.calls.summarizerPrompts.map((call: any) => String(call.body?.parts?.[0]?.text ?? ""));
    expect(systems.at(-1)).toContain("new external request");
    expect(systems.at(-1)).not.toContain("summary prompt");
    expect(systems.at(-1)).not.toContain("generated assistant");
    expect(await readText(memoryPathFor(sessionID), "")).toContain("retained");
  });

  test("external work arriving during active generation is replayed without using self parent metadata", async () => {
    const sessionID = "queued-external";
    const { plugin, client } = await setup(
      [row("external-user", "user", "first request", Date.now())],
      { holdFirst: true },
      { summarizerMode: "active" },
      sessionID,
    );
    const first = plugin.event(idle(sessionID));
    await client.firstPromptStarted;
    client.rows.push(row("external-late", "user", "late external request", Date.now() + 10));
    await plugin["message.updated"]({
      sessionID,
      message: { id: "external-late", role: "user", parts: [{ type: "text", text: "late external request" }] },
    });
    await plugin.event(idle(sessionID));
    client.releasePrompt?.();
    await first;
    await waitFor(() => client.promptCount === 2);
    await drain();
    expect(client.promptCount).toBe(2);
    expect(client.calls.summarizerPrompts.at(-1)).toBeDefined();
    expect(String((client.calls.summarizerPrompts.at(-1) as any).body.parts[0].text)).toContain(
      "late external request",
    );
  });

  test("a late settled assistant after a failed active attempt is not dropped behind the owned prompt", async () => {
    const sessionID = "late-settled-assistant";
    const created = Date.now();
    const lateAssistant = row("external-assistant", "assistant", "", created + 1, "external-user");
    const { plugin, client } = await setup(
      [row("external-user", "user", "first request", created), lateAssistant],
      { malformedAttempts: 1 },
      { summarizerMode: "active" },
      sessionID,
    );

    await plugin.event(idle(sessionID));
    await waitFor(() => client.promptCount === 1);
    await drain();
    expect(await readText(checkpointPathFor(sessionID), "")).toBe("");

    lateAssistant.parts[0].text = "late settled assistant text";
    await plugin.event({
      event: { type: "message.updated", properties: { sessionID, info: lateAssistant.info } },
    } as never);
    await plugin.event({
      event: { type: "session.updated", properties: { info: { id: sessionID, title: "ordinary" } } },
    } as never);
    await plugin.event(idle(sessionID));
    await waitFor(() => client.promptCount === 2);
    await drain();

    expect(
      client.rows.filter((entry: Row) => entry.info.role === "user" && entry.info.id === "external-user"),
    ).toHaveLength(1);
    const lastPrompt = String((client.calls.summarizerPrompts.at(-1) as any).body.parts[0].text);
    expect(conversationUpdate(lastPrompt)).toContain("late settled assistant text");
    expect(conversationUpdate(lastPrompt)).not.toContain("malformed assistant response sentinel 1");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await plugin.event({
        event: { type: "session.updated", properties: { info: { id: sessionID, title: "ordinary" } } },
      } as never);
      await plugin.event(idle(sessionID));
    }
    await drain();
    expect(client.promptCount).toBe(2);
  });

  test("clean direct temporary sessions have no lifecycle-event dependency or temp history read", async () => {
    const sessionID = "clean-direct";
    let pluginRef: any;
    const { plugin, client } = await setup(
      [row("external-user", "user", "clean request", Date.now())],
      {
        onPrompt: async () => {
          await pluginRef?.event(idle("side-1"));
          await pluginRef?.tool.short_term_memory.execute({ action: "update" }, { sessionID: "side-1" });
          expect(await Bun.file(memoryPathFor("side-1")).exists()).toBe(false);
          expect(await Bun.file(checkpointPathFor("side-1")).exists()).toBe(false);
        },
      },
      { summarizerMode: "clean" },
      sessionID,
    );
    pluginRef = plugin;
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    // Native events may arrive after the SDK deletion completes. They must
    // not revive the internal session or leave empty memory files behind.
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "side-1", title: "ordinary" } } },
    } as never);
    await plugin.event(idle("side-1"));
    await plugin["session.updated"]({
      sessionID: "side-1",
      event: { properties: { info: { title: "unrelated" } } },
    } as any);
    expect(client.calls.create).toHaveLength(1);
    expect(client.calls.delete).toHaveLength(1);
    await drain();
    expect(client.calls.messages.filter((call: any) => call.path?.id === "side-1")).toHaveLength(0);
    expect(await Bun.file(memoryPathFor("side-1")).exists()).toBe(false);
    expect(await Bun.file(checkpointPathFor("side-1")).exists()).toBe(false);
    expect((await readText(join(".opencode", "memory", "session-memory.log"), "")).toLowerCase()).not.toContain(
      "error",
    );
    expect(await readText(memoryPathFor(sessionID), "")).toContain("retained");
  });

  test("does not summarize while the genuine primary reply is busy", async () => {
    const sessionID = "primary-reply-busy";
    const created = Date.now();
    const { plugin, client } = await setup(
      [row("primary-user", "user", "genuine primary request", created)],
      {},
      { summarizerMode: "active" },
      sessionID,
    );
    const metadata = { providerID: "provider", modelID: "model" };

    await plugin["chat.message"](
      {
        sessionID,
        messageID: "primary-user",
        agent: "primary-agent",
        model: metadata,
        message: { id: "primary-user", role: "user", parts: [{ type: "text", text: "genuine primary request" }] },
        parts: [{ type: "text", text: "genuine primary request" }],
      },
      {
        message: { id: "primary-user", role: "user", agent: "primary-agent", model: metadata },
        parts: [{ type: "text", text: "genuine primary request" }],
      },
    );
    await plugin.event({
      event: { type: "session.updated", properties: { info: { id: sessionID, title: "ordinary" } } },
    } as never);
    await plugin.event({
      event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
    } as never);
    await drain(300);
    let log = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(client.promptCount).toBe(0);
    expect(log.match(/"detail":"awaiting_session_idle"/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(log).not.toContain('"event":"active_session_summarizer_start"');

    const ordinaryAssistant = row("ordinary-assistant", "assistant", "ACK", created + 1, "primary-user");
    (ordinaryAssistant.info.time as { created: number; completed?: number }).completed = Date.now();
    client.rows.push(ordinaryAssistant);
    await plugin.event({
      event: {
        type: "message.updated",
        properties: { sessionID, info: { ...ordinaryAssistant.info, parts: ordinaryAssistant.parts } },
      },
    } as never);
    await plugin.event({
      event: {
        type: "session.updated",
        properties: { info: { id: sessionID, title: "ordinary" }, status: { type: "busy" } },
      },
    } as never);
    await drain(300);
    expect(client.promptCount).toBe(0);

    await plugin.event({
      event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
    } as never);
    await plugin.event(idle(sessionID));
    await waitFor(() => client.promptCount === 1);
    await drain();
    expect(client.promptCount).toBe(1);
    expect(await readText(checkpointPathFor(sessionID), "")).toContain("ordinary-assistant");
    const prompt = String((client.calls.summarizerPrompts.at(-1) as any).body.parts[0].text);
    expect(conversationUpdate(prompt)).toContain("genuine primary request");
    expect(conversationUpdate(prompt)).toContain("ACK");
  });

  test("does not automatically retry a pre-persistence transport failure, but allows manual and new-data retries", async () => {
    const sessionID = "pre-persist-transport-failure";
    const initialRows = [row("initial-user", "user", "unchanged input", Date.now())];
    const { plugin, client } = await setup(
      initialRows,
      { rejectPromptBeforePersist: true, maxPrompts: 4 },
      { summarizerMode: "active" },
      sessionID,
    );

    await plugin.event(idle(sessionID));
    await waitFor(() => client.promptCount === 1);
    await drain();
    expect(client.rows).toHaveLength(initialRows.length);
    expect(String((client.calls.prompt[0] as any).body.messageID)).toMatch(/^msg_/);
    expect(await readText(checkpointPathFor(sessionID), "")).toBe("");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await plugin.event({
        event: { type: "session.updated", properties: { info: { id: sessionID, title: "ordinary" } } },
      } as never);
      await plugin.event(idle(sessionID));
    }
    await drain();
    expect(client.promptCount).toBe(1);

    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    expect(client.promptCount).toBe(2);

    const now = Date.now();
    client.rows.push(row("new-external-user", "user", "new genuine input", now));
    client.rows.push(row("new-external-assistant", "assistant", "new genuine ACK", now + 1, "new-external-user"));
    await plugin.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: "new-external-assistant",
            role: "assistant",
            time: { created: now + 1, completed: now + 2 },
            parts: [{ type: "text", text: "new genuine ACK" }],
          },
        },
      },
    } as never);
    await plugin.event(idle(sessionID));
    await waitFor(() => client.promptCount === 3);
    await drain();
    expect(client.promptCount).toBe(3);
    expect(await readText(checkpointPathFor(sessionID), "")).toContain("new-external-assistant");
  });
});
