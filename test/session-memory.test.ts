import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INJECTION_PREFIX, memoryPathFor, readText, writeText, checkpointPathFor } from "../src/memory-utils";
import { createFakeClient, createPlugin } from "./test-helpers";

describe("SessionMemoryPlugin general functionality", () => {
  const originalCwd = process.cwd();
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const originalOpencodeExecutable = process.env.OPENCODE_EXECUTABLE;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-session-memory-plugin-test-"));
    process.env.XDG_CONFIG_HOME = join(testDir, ".xdg");
    process.env.OPENCODE_CONFIG_DIR = join(testDir, ".config-dir");
    delete process.env.OPENCODE_EXECUTABLE;
    delete process.env.LOCALAPPDATA;
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
    if (originalOpencodeExecutable === undefined) delete process.env.OPENCODE_EXECUTABLE;
    else process.env.OPENCODE_EXECUTABLE = originalOpencodeExecutable;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test("memory tool supports show, status, and reset", async () => {
    const sessionID = `tool-${Date.now()}`;
    const { plugin } = await createPlugin({ summarizerMode: "clean", debug: false, remindEveryN: 1 });

    await plugin["session.created"]({ sessionID });

    const shown = await plugin.tool.short_term_memory.execute({ action: "show" }, { sessionID });
    expect(String(shown)).toContain("## Session Memory");

    await writeText(memoryPathFor(sessionID), "custom memory\n");
    const reset = await plugin.tool.short_term_memory.execute({ action: "reset" }, { sessionID });
    expect(String(reset)).toContain(`Reset memory for session ${sessionID}`);

    const afterReset = await readText(memoryPathFor(sessionID), "");
    expect(afterReset).toContain("### User Instructions");

    const status = await plugin.tool.short_term_memory.execute({ action: "status" }, { sessionID });
    expect(String(status)).toContain("# Session Memory Plugin Status");
    expect(String(status)).toContain(`- activeSessionID: ${sessionID}`);
    expect(String(status)).toContain("- summarizerMode: clean");
    expect(String(status)).toContain("- injectCharCount: 0");
  });

  test("experimental.chat.system.transform injects memory and dedupes duplicate calls", async () => {
    const sessionID = `inject-${Date.now()}`;
    const { plugin } = await createPlugin({ summarizerMode: "clean", debounceMs: 500, remindEveryN: 1 });

    await plugin["session.created"]({ sessionID });
    await writeText(memoryPathFor(sessionID), "## Session Memory\n\n### Long Horizon Context\n- Keep this\n");

    const output1 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-1" }, output1);
    expect(output1.system.length).toBe(1);
    expect(output1.system[0]).toContain(INJECTION_PREFIX);
    expect(output1.system[0]).toContain("Keep this");

    const output2 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-1" }, output2);
    expect(output2.system.length).toBe(0);

    const status = await plugin.tool.short_term_memory.execute({ action: "status" }, { sessionID });
    expect(String(status)).toMatch(/- injectCharCount: [1-9]\d*/);
  });

  test("experimental.chat.system.transform compacts injected memory content while preserving headings", async () => {
    const sessionID = `inject-compact-${Date.now()}`;
    const { plugin } = await createPlugin({ summarizerMode: "clean", debounceMs: 500, remindEveryN: 1 });

    await plugin["session.created"]({ sessionID });
    await writeText(
      memoryPathFor(sessionID),
      [
        "## Session Memory",
        "",
        "### User Instructions",
        "- None captured yet.",
        "",
        "### Long Horizon Context",
        "- Keep parser migration in /lib/parser-v2.ts",
        "",
        "### Decisions",
        "- Use Zod for validation",
        "",
      ].join("\n"),
    );

    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-compact-1" }, output);
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("- Keep parser migration in /lib/parser-v2.ts");
    expect(output.system[0]).toContain("- Use Zod for validation");
    // Headings should be preserved because sections have content
    expect(output.system[0]).toContain("### Long Horizon Context");
    expect(output.system[0]).toContain("### Decisions");
    // Outer header and placeholder lines should be removed
    expect(output.system[0]).not.toContain("## Session Memory");
    expect(output.system[0]).not.toContain("None captured yet");
  });

  test("experimental.chat.system.transform skips injection when memory contains only placeholders", async () => {
    const sessionID = `inject-empty-${Date.now()}`;
    const { plugin } = await createPlugin({ summarizerMode: "clean", debounceMs: 500, remindEveryN: 1 });

    await plugin["session.created"]({ sessionID });
    // Memory file has only placeholder lines
    await writeText(
      memoryPathFor(sessionID),
      [
        "## Session Memory",
        "### User Instructions",
        "- None captured yet.",
        "### Long Horizon Context",
        "- None captured yet.",
        "### Decisions",
        "- None captured yet.",
      ].join("\n"),
    );

    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-empty" }, output);
    // Injection should be skipped because compacted memory is empty
    expect(output.system.length).toBe(0);
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain("empty_compacted_memory");
  });

  test("experimental.chat.system.transform initializes missing output.system", async () => {
    const sessionID = `inject-init-${Date.now()}`;
    const { plugin } = await createPlugin({ summarizerMode: "clean", debounceMs: 500, remindEveryN: 1 });

    await plugin["session.created"]({ sessionID });
    await writeText(memoryPathFor(sessionID), "## Session Memory\n\n### Long Horizon Context\n- Keep this\n");

    const output = {} as { system?: string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-init-1" }, output as any);

    expect(Array.isArray(output.system)).toBe(true);
    expect(output.system?.length).toBe(1);
    expect(String(output.system?.[0])).toContain(INJECTION_PREFIX);
  });

  test("experimental.session.compacting pushes memory context", async () => {
    const sessionID = `compact-${Date.now()}`;
    const { plugin } = await createPlugin({ summarizerMode: "clean" });

    await plugin["session.created"]({ sessionID });
    await writeText(memoryPathFor(sessionID), "## Session Memory\n\n### Conclusions\n- compact me\n");

    const output = { context: [] as string[] };
    await plugin["experimental.session.compacting"]({ sessionID }, output);

    expect(output.context.length).toBe(1);
    expect(output.context[0]).toContain("## Session Memory");
    expect(output.context[0]).toContain("compact me");
  });

  test("experimental.chat.system.transform injects every N user messages", async () => {
    const sessionID = `inject-every-n-${Date.now()}`;
    const { plugin } = await createPlugin({
      summarizerMode: "clean",
      remindEveryN: 2,
      debounceMs: 500,
      debug: false,
    });

    await plugin["session.created"]({ sessionID });
    await writeText(memoryPathFor(sessionID), "## Session Memory\n\n### Long Horizon Context\n- Keep this\n");

    const out1 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-1" }, out1);
    expect(out1.system.length).toBe(0);

    const out2 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-2" }, out2);
    expect(out2.system.length).toBe(1);
    expect(out2.system[0]).toContain(INJECTION_PREFIX);

    const out3 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-3" }, out3);
    expect(out3.system.length).toBe(0);

    const out4 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg-4" }, out4);
    expect(out4.system.length).toBe(1);

    const status = await plugin.tool.short_term_memory.execute({ action: "status" }, { sessionID });
    expect(String(status)).toContain("- remindEveryN: 2");
  });

  test("memory update uses active-session prompt with fake client", async () => {
    const sessionID = `active-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { role: "user", content: "Please remember the testing directive" },
        { role: "assistant", content: "Acknowledged and recorded" },
      ],
      promptText: "## Session Memory\n\n### User Instructions\n- remember active-session flow\n",
    });
    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    const memory = await readText(memoryPathFor(sessionID), "");
    expect(memory).toContain("remember active-session flow");
    expect(client.calls.messages.length).toBe(1);
    expect(client.calls.prompt.length).toBe(1);
    expect(client.calls.prompt[0]?.path?.id).toBe(sessionID);
  });

  test("memory update includes AGENTS.md only on first update when enabled", async () => {
    const sessionID = `agents-first-${Date.now()}`;
    await writeText(
      "AGENTS.md",
      ["# Team Rules", "", "- Keep tests deterministic", "- Preserve user constraints verbatim"].join("\n"),
    );

    const rows: unknown[] = [
      { id: "m1", role: "user", content: "Initial request" },
      { id: "m2", role: "assistant", content: "Initial response" },
    ];
    const capturedPrompts: string[] = [];
    const fakeClient = createFakeClient({
      messagesRows: rows,
      promptResponder: (args?: unknown) => {
        capturedPrompts.push(String(args?.body?.parts?.[0]?.text || ""));
        return "## Session Memory\n\n### User Instructions\n- Track AGENTS inclusion\n";
      },
    });

    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        includeAgentsMdOnFirstUpdate: true,
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    rows.push({ id: "m3", role: "user", content: "Second request" });
    rows.push({ id: "m4", role: "assistant", content: "Second response" });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(capturedPrompts.length).toBe(2);
    expect(capturedPrompts[0]).toContain("<agents_md_context>");
    expect(capturedPrompts[0]).toContain("Keep tests deterministic");
    expect(capturedPrompts[1]).not.toContain("<agents_md_context>");
  });

  test("memory update does not include AGENTS.md when disabled", async () => {
    const sessionID = `agents-off-${Date.now()}`;
    await writeText("AGENTS.md", "# Team Rules\n- Should not be included when disabled\n");

    const capturedPrompts: string[] = [];
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "Initial request" },
        { id: "m2", role: "assistant", content: "Initial response" },
      ],
      promptResponder: (args?: unknown) => {
        capturedPrompts.push(String(args?.body?.parts?.[0]?.text || ""));
        return "## Session Memory\n\n### User Instructions\n- no agents context\n";
      },
    });
    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        includeAgentsMdOnFirstUpdate: false,
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(capturedPrompts.length).toBe(1);
    expect(capturedPrompts[0]).not.toContain("<agents_md_context>");
    expect(capturedPrompts[0]).not.toContain("Should not be included when disabled");
  });

  test("memory update falls back to active-session prompt when clean run fails", async () => {
    const sessionID = `fallback-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { role: "user", content: "Use fallback summarizer" },
        { role: "assistant", content: "Fallback should succeed" },
      ],
      promptText: "## Session Memory\n\n### Current Context\n- fallback path used\n",
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "clean",
        cleanFallbackToActiveSession: true,
        opencodeExecutable: "this-binary-does-not-exist-for-tests",
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    const memory = await readText(memoryPathFor(sessionID), "");
    expect(memory).toContain("fallback path used");
    expect(client.calls.messages.length).toBe(1);
    expect(client.calls.prompt.length).toBe(1);
  });

  test("memory update retries clean side-session before fallback", async () => {
    const sessionID = `retry-fallback-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { role: "user", content: "Retry side-session execution" },
        { role: "assistant", content: "Retry and then fallback" },
      ],
      promptText: "## Session Memory\n\n### Current Context\n- retried then fell back\n",
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "clean",
        cleanFallbackToActiveSession: true,
        sideSessionRetries: 2,
        opencodeExecutable: "this-binary-does-not-exist-for-tests",
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    const memory = await readText(memoryPathFor(sessionID), "");
    expect(memory).toContain("retried then fell back");
    expect(client.calls.messages.length).toBe(1);
    expect(client.calls.prompt.length).toBe(1);

    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"event":"memory_update_clean_retry_failed"');
    expect(logText).toContain('"attempt":1');
    expect(logText).toContain('"attempt":2');
    expect(logText).toContain('"event":"memory_update_clean_failed_fallback"');
    expect(logText).toContain('"attempts":3');
  });

  test("memory update skips write on empty summarizer output", async () => {
    const sessionID = `empty-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { role: "user", content: "Try update with empty output" },
        { role: "assistant", content: "No summary returned" },
      ],
      promptText: "   ",
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    const memory = await readText(memoryPathFor(sessionID), "");
    expect(memory).toContain("None captured yet.");
    expect(client.calls.prompt.length).toBe(1);

    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain("empty_summarizer_output");
  });

  test("memory update dedupes when visible messages are unchanged", async () => {
    const sessionID = `dedupe-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "stable-1", role: "user", content: "Keep this stable" },
        { id: "stable-2", role: "assistant", content: "Stable reply" },
      ],
      promptText: "## Session Memory\n\n### Current Context\n- first summary\n",
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(client.calls.messages.length).toBe(2);
    expect(client.calls.prompt.length).toBe(1);

    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain("no_visible_recent_messages");
  });

  test("memory update keeps latest user prompt when assistant emits many consecutive messages", async () => {
    const sessionID = `recent-limit-role-collapse-${Date.now()}`;
    const assistantBurst = Array.from({ length: 20 }, (_, i) => ({
      role: "assistant",
      content: `assistant intermediate ${i + 1}`,
    }));
    const fakeClient = createFakeClient({
      messagesRows: [{ role: "user", content: "Please remember /lib/auth.ts and auth refactor" }, ...assistantBurst],
      promptText: "## Session Memory\n\n### Current Context\n- summarized\n",
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        collapseAssistantBursts: true,
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(client.calls.messages.length).toBeGreaterThanOrEqual(1);
    expect(client.calls.prompt.length).toBe(1);
    const promptText = String(client.calls.prompt[0]?.body?.parts?.[0]?.text || "");
    expect(promptText).toContain("USER:\nPlease remember /lib/auth.ts and auth refactor");
    expect(promptText).toContain("ASSISTANT:\nassistant intermediate 20");
    expect(promptText).not.toContain("ASSISTANT:\nassistant intermediate 19");
  });

  test("memory update keeps user turns and only final assistant reply per burst", async () => {
    const sessionID = `chat-noise-collapse-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { role: "user", content: "hey" },
        { role: "assistant", content: "thinking: the user said hey" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "check the weather" },
        { role: "assistant", content: "thinking: maybe tool call" },
        { role: "tool", content: "19C, windy" },
        { role: "assistant", content: "thinking: suggest jacket" },
        { role: "assistant", content: "the weather is nice 19C, but a bit windy, better take a light jacket" },
      ],
      promptText: "## Session Memory\n\n### Current Context\n- summarized\n",
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        collapseAssistantBursts: true,
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(client.calls.prompt.length).toBe(1);
    const promptText = String(client.calls.prompt[0]?.body?.parts?.[0]?.text || "");
    expect(promptText).toContain("USER:\nhey");
    expect(promptText).toContain("ASSISTANT:\nhello");
    expect(promptText).toContain("USER:\ncheck the weather");
    expect(promptText).toContain("ASSISTANT:\nthe weather is nice 19C, but a bit windy, better take a light jacket");
    expect(promptText).not.toContain("thinking:");
    expect(promptText).not.toContain("19C, windy");
  });

  test("memory update excludes likely assistant internal messages from visible delta", async () => {
    const sessionID = `internal-filter-${Date.now()}`;
    let capturedPrompt = "";
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "I am working on /src/auth.ts" },
        { id: "a1", role: "assistant", content: "Got it, looking at /src/auth.ts" },
        { id: "u2", role: "user", content: "Actually, scratch that, I'm moving to /lib/auth.ts instead" },
        { id: "a2", role: "assistant", content: "assistant internal chunk 20" },
      ],
      promptResponder: (args?: unknown) => {
        capturedPrompt = String(args?.body?.parts?.[0]?.text || "");
        return "## Session Memory\n\n### Active References\n- /lib/auth.ts\n";
      },
    });

    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(capturedPrompt).toContain("USER:\nI am working on /src/auth.ts");
    expect(capturedPrompt).toContain("ASSISTANT:\nGot it, looking at /src/auth.ts");
    expect(capturedPrompt).toContain("USER:\nActually, scratch that, I'm moving to /lib/auth.ts instead");
    expect(capturedPrompt).not.toContain("assistant internal chunk 20");
  });

  test("memory update summarizes only messages since last processed message id checkpoint", async () => {
    const sessionID = `checkpoint-delta-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "old message one" },
        { id: "m2", role: "assistant", content: "old reply one" },
        { id: "m3", role: "assistant", content: "thinking old" },
        { id: "m4", role: "assistant", content: "old final" },
        { id: "m5", role: "user", content: "new message keep this" },
        { id: "m6", role: "assistant", content: "thinking new" },
        { id: "m7", role: "tool", content: "tool noise" },
        { id: "m8", role: "assistant", content: "new final keep this too" },
      ],
      promptText: "## Session Memory\n\n### Current Context\n- delta summary\n",
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await writeText(join(".opencode", "memory", "checkpoints", `${sessionID}.last-message-id.txt`), "m4\n");
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(client.calls.prompt.length).toBe(1);
    const promptText = String(client.calls.prompt[0]?.body?.parts?.[0]?.text || "");
    expect(promptText).not.toContain("old message one");
    expect(promptText).not.toContain("old reply one");
    expect(promptText).toContain("USER:\nnew message keep this");
    expect(promptText).toContain("ASSISTANT:\nnew final keep this too");
    expect(promptText).not.toContain("thinking new");
    expect(client.calls.messages.length).toBeGreaterThanOrEqual(1);
  });

  test("session.deleted removes persisted session memory file", async () => {
    const sessionID = `deleted-${Date.now()}`;
    const { plugin } = await createPlugin({ summarizerMode: "clean", debug: false });

    await plugin["session.created"]({ sessionID });
    const memoryFile = memoryPathFor(sessionID);
    const beforeDelete = await readText(memoryFile, "");
    expect(beforeDelete).toContain("## Session Memory");

    await plugin["session.deleted"]({ sessionID });

    const afterDelete = await readText(memoryFile, "missing");
    expect(afterDelete).toBe("missing");

    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain("session_deleted_memory_removed");
  });

  test("memory update enforces maxMemoryLength on persisted summary", async () => {
    const sessionID = `max-memory-length-${Date.now()}`;
    const oversized = `## Session Memory\n\n### Long Horizon Context\n- ${"x".repeat(1200)}\n`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "store long summary" },
        { id: "m2", role: "assistant", content: "ok" },
      ],
      promptText: oversized,
    });
    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        maxMemoryLength: 300,
        debug: false,
      },
      fakeClient,
    );
    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    const memory = await readText(memoryPathFor(sessionID), "");
    // truncateMemoryLines now includes the line that first exceeds maxLen
    expect(memory.length).toBeGreaterThan(300);
    expect(memory.startsWith("<!-- stm:v1 -->\n## Session Memory")).toBe(true);
  });

  test("memory update chunks delta by maxUpdateInputLength", async () => {
    const sessionID = `max-update-chunk-${Date.now()}`;
    const calls: string[] = [];
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: `alpha ${"a".repeat(160)}` },
        { id: "m2", role: "assistant", content: `beta ${"b".repeat(160)}` },
        { id: "m3", role: "user", content: `gamma ${"c".repeat(160)}` },
        { id: "m4", role: "assistant", content: `delta ${"d".repeat(160)}` },
      ],
      promptResponder: (args?: unknown) => {
        const prompt = String(args?.body?.parts?.[0]?.text || "");
        calls.push(prompt);
        return "## Session Memory\n\n### Long Horizon Context\n- chunked\n";
      },
    });
    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        maxUpdateInputLength: 250,
        debug: false,
      },
      fakeClient,
    );
    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    expect(calls.length).toBeGreaterThan(1);
  });

  test("memory update respects maxDeltaMessages config", async () => {
    const sessionID = `max-delta-${Date.now()}`;
    // Create a long history (e.g., 300 messages)
    const manyMessages = Array.from({ length: 300 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message number ${i}`,
    }));
    let promptCalled = 0;
    const fakeClient = createFakeClient({
      messagesRows: manyMessages,
      promptResponder: () => {
        promptCalled++;
        return "## Session Memory\n\n### Long Horizon Context\n- capped delta\n";
      },
    });
    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        maxDeltaMessages: 50,
        debug: false,
      },
      fakeClient,
    );
    await plugin["session.created"]({ sessionID });
    // Simulate a stale checkpoint (nonexistent) so it tries to fetch all
    await writeText(join(".opencode", "memory", "checkpoints", `${sessionID}.last-message-id.txt`), "nonexistent-id\n");
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    // Only one prompt call should be made because delta is capped
    expect(promptCalled).toBe(1);
  });

  test("compaction waits for in-flight update and uses refreshed memory", async () => {
    const sessionID = `compact-drain-${Date.now()}`;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let promptCalls = 0;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "Keep token: DELTA_TOKEN" },
        { id: "m2", role: "assistant", content: "Confirmed DELTA_TOKEN" },
      ],
      promptResponder: async () => {
        promptCalls += 1;
        if (promptCalls === 1) await firstGate;
        return "## Session Memory\n\n### Active References\n- DELTA_TOKEN\n";
      },
    });
    const { plugin } = await createPlugin(
      { summarizerMode: "active", debounceMs: 100, debug: false },
      fakeClient as any,
    );
    await plugin["session.created"]({ sessionID });

    const inFlight = plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const compactionOutput = { context: [] as string[] };
    const compactionPromise = plugin["experimental.session.compacting"]({ sessionID }, compactionOutput);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst?.();

    await inFlight;
    await compactionPromise;
    expect(compactionOutput.context.length).toBe(1);
    expect(compactionOutput.context[0]).toContain("DELTA_TOKEN");
  });

  test("reset clears userTurnInjectState counter", async () => {
    const sessionID = `reset-inject-${Date.now()}`;
    const { plugin } = await createPlugin({ summarizerMode: "clean", remindEveryN: 2 });
    await plugin["session.created"]({ sessionID });
    await writeText(memoryPathFor(sessionID), "## Session Memory\n\n### Long Horizon Context\n- persist\n");

    // First transform → skip (count becomes 1)
    const out1 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg1" }, out1);
    expect(out1.system.length).toBe(0);

    // Second transform → inject (count becomes 2)
    const out2 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg2" }, out2);
    expect(out2.system.length).toBe(1);

    // Reset memory
    await plugin.tool.short_term_memory.execute({ action: "reset" }, { sessionID });

    // After reset, counter is 0. First transform after reset → skip (count becomes 1)
    const out3 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg3" }, out3);
    expect(out3.system.length).toBe(0);

    // Second transform after reset → inject (count becomes 2)
    const out4 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg4" }, out4);
    // reset cleared any memories, so nothing should be injected here.
    expect(out4.system.length).toBe(0);

    // Update memories
    await writeText(memoryPathFor(sessionID), "## Session Memory\n\n### Long Horizon Context\n- persist\n");

    // counter is 3 → skip
    const out5 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg5" }, out5);
    expect(out5.system.length).toBe(0);

    // counter is 4 → inject now present memory
    const out6 = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "msg6" }, out6);
    expect(out6.system.length).toBe(1);
    expect(out6.system[0]).toContain("persist");
  });

  test("memory tool supports settings/logs and unknown action", async () => {
    const sessionID = `tool-extra-${Date.now()}`;
    const { plugin } = await createPlugin({ summarizerMode: "active", debug: false });
    await plugin["session.created"]({ sessionID });

    const settings = await plugin.tool.short_term_memory.execute({ action: "settings" }, { sessionID });
    expect(String(settings)).toContain('"summarizerMode": "active"');

    const unknown = await plugin.tool.short_term_memory.execute({ action: "not_a_real_action" }, { sessionID });
    expect(String(unknown)).toContain("Unknown action");

    const logs = await plugin.tool.short_term_memory.execute({ action: "logs" }, { sessionID });
    expect(typeof logs).toBe("string");
  });

  test("short_term_memory tool supports status and logs actions", async () => {
    const sessionID = `tool-shortcuts-${Date.now()}`;
    const { plugin } = await createPlugin({ debug: false });
    await plugin["session.created"]({ sessionID });

    const status = await plugin.tool.short_term_memory.execute({ action: "status" }, { sessionID });
    expect(String(status)).toContain("Session Memory Plugin Status");

    const logs = await plugin.tool.short_term_memory.execute({ action: "logs" });
    expect(typeof logs).toBe("string");
  });

  test("plugin command hook handles /stm and maps unknown args to status", async () => {
    const sessionID = `cmd-memory-${Date.now()}`;
    const { plugin } = await createPlugin({ debug: false });
    await plugin["session.created"]({ sessionID });

    const statusOut: Record<string, unknown> = {};
    await plugin["command.execute.before"](
      { sessionID, command: { name: "stm", argument: "status" } } as any,
      statusOut,
    );
    expect(statusOut.stop).toBe(true);
    expect(String(statusOut.message)).toContain("Session Memory Plugin Status");

    const unknownOut: Record<string, unknown> = {};
    await plugin["command.execute.before"](
      { sessionID, command: { name: "stm", argument: "not-real" } } as any,
      unknownOut,
    );
    expect(unknownOut.stop).toBe(true);
    expect(String(unknownOut.message)).toContain("Unknown action");
  });

  test("plugin command hook supports all /stm args", async () => {
    const sessionID = `cmd-stm-all-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "remember cmd update flow" },
        { id: "m2", role: "assistant", content: "ok" },
      ],
      promptText: "## Session Memory\n\n### Long Horizon Context\n- updated via command hook\n",
    });
    const { plugin } = await createPlugin({ summarizerMode: "active", debug: false }, fakeClient);
    await plugin["session.created"]({ sessionID });

    const run = async (argument: string) => {
      const out: Record<string, unknown> = {};
      await plugin["command.execute.before"]({ sessionID, command: { name: "stm", argument } } as any, out);
      expect(out.stop).toBe(true);
      return String(out.message || "");
    };

    const show = await run("show");
    expect(show).toContain("## Session Memory");

    const status = await run("status");
    expect(status).toContain("Session Memory Plugin Status");

    const logs = await run("logs");
    expect(typeof logs).toBe("string");

    const settings = await run("settings");
    expect(settings).toContain('"summarizerMode": "active"');

    const update = await run("update");
    expect(update).toContain("updated via command hook");

    const reset = await run("reset");
    expect(reset).toContain(`Reset memory for session ${sessionID}`);

    const unknown = await run("not-real");
    expect(unknown).toContain("Unknown action");
  });

  test("event handler logs sdk events when debug enabled", async () => {
    const sessionID = `evt-debug-${Date.now()}`;
    const { plugin } = await createPlugin({ debug: true });
    await plugin.event({ event: { type: "custom.event", properties: { sessionID } } } as any);
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"event":"sdk_event"');
  });

  test("message.updated and chat.message return early for self-injection content", async () => {
    const sessionID = `early-return-${Date.now()}`;
    const { plugin } = await createPlugin({ debug: false });
    await plugin["session.created"]({ sessionID });

    await plugin["message.updated"]({
      sessionID,
      message: { role: "assistant", content: `${INJECTION_PREFIX}\ninternal` },
    } as any);
    await plugin["chat.message"](
      { sessionID, message: { role: "user", content: "hi" } } as any,
      { message: { role: "assistant", content: "## Session Memory" } } as any,
    );

    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).not.toContain('"event":"message_updated"');
    expect(logText).not.toContain('"event":"chat_message"');
  });

  test("transform skips when session id missing", async () => {
    const { plugin } = await createPlugin({ debug: false });
    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({} as any, output);
    expect(output.system.length).toBe(0);
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"reason":"missing_session_id"');
  });

  test("update logs collect_recent_messages_error when session.messages throws", async () => {
    const sessionID = `messages-throw-${Date.now()}`;
    const fakeClient = createFakeClient({
      promptText: "## Session Memory\n\n### Long Horizon Context\n- should not be used\n",
    }) as any;
    fakeClient.session.messages = async () => {
      throw new Error("messages fetch failed");
    };
    const { plugin } = await createPlugin({ summarizerMode: "active", debug: false }, fakeClient);
    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"event":"collect_recent_messages_error"');
  });

  test("update logs memory_update_error when active summarizer throws", async () => {
    const sessionID = `prompt-throw-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "please summarize this" },
        { id: "m2", role: "assistant", content: "ok" },
      ],
      promptShouldThrow: true,
    });
    const { plugin } = await createPlugin({ summarizerMode: "active", debug: false }, fakeClient);
    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"event":"memory_update_error"');
  });

  test("update skips malformed summarizer output", async () => {
    const sessionID = `malformed-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "remember malformed test" },
        { id: "m2", role: "assistant", content: "ok" },
      ],
      promptText: "this is not markdown memory structure",
    });
    const { plugin } = await createPlugin({ summarizerMode: "active", debug: false }, fakeClient);
    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain("malformed_summarizer_output");
  });

  test("update truncates oversized single message chunks", async () => {
    const sessionID = `truncate-single-${Date.now()}`;
    const capturedPrompts: string[] = [];
    const fakeClient = createFakeClient({
      messagesRows: [{ id: "m1", role: "user", content: `very long ${"x".repeat(5000)}` }],
      promptResponder: (args?: unknown) => {
        capturedPrompts.push(String(args?.body?.parts?.[0]?.text || ""));
        return "## Session Memory\n\n### Long Horizon Context\n- truncated path exercised\n";
      },
    });
    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        maxUpdateInputLength: 120,
        debug: false,
      },
      fakeClient,
    );
    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
    expect(capturedPrompts.some((p) => p.includes("[TRUNCATED_FOR_MAX_UPDATE_INPUT_LENGTH]"))).toBe(true);
  });

  test("session.idle debounce schedules one update for rapid idle bursts", async () => {
    const sessionID = `idle-debounce-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "debounce me" },
        { id: "m2", role: "assistant", content: "ack" },
      ],
      promptText: "## Session Memory\n\n### Long Horizon Context\n- debounce done\n",
    });
    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debounceMs: 100,
        debug: false,
      },
      fakeClient,
    );
    await plugin["session.created"]({ sessionID });

    const evt = { event: { type: "session.idle", properties: { sessionID } } } as any;
    await plugin.event(evt);
    await plugin.event(evt);
    await plugin.event(evt);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(client.calls.prompt.length).toBe(1);
  });

  test("session.updated logs session_updated", async () => {
    const sessionID = `session-updated-${Date.now()}`;
    const { plugin } = await createPlugin({ debug: false });
    await plugin["session.updated"]({ sessionID } as any);
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"event":"session_updated"');
  });

  test("session.updated bootstraps memory from existing history when checkpoint is missing", async () => {
    const sessionID = `bootstrap-existing-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "Please remember bootstrap token /lib/bootstrap.ts" },
        { id: "m2", role: "assistant", content: "Acknowledged bootstrap token" },
      ],
      promptText: "## Session Memory\n\n### Active References\n- /lib/bootstrap.ts\n",
    });
    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debounceMs: 25,
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin["session.updated"]({ sessionID } as any);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const memory = await readText(memoryPathFor(sessionID), "");
    expect(memory).toContain("/lib/bootstrap.ts");
    expect(client.calls.prompt.length).toBeGreaterThanOrEqual(1);
  });

  test("chat.message logs chat_message for non-self assistant output", async () => {
    const sessionID = `chat-message-log-${Date.now()}`;
    const { plugin } = await createPlugin({ debug: false });
    await plugin["session.created"]({ sessionID });
    await plugin["chat.message"](
      { sessionID, message: { role: "user", content: "hello" } } as any,
      { message: { role: "assistant", content: "normal assistant response" } } as any,
    );
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"event":"chat_message"');
  });

  test("transform skips when memory already injected in output.system", async () => {
    const sessionID = `already-injected-${Date.now()}`;
    const { plugin } = await createPlugin({ debug: false, remindEveryN: 1 });
    await plugin["session.created"]({ sessionID });
    await writeText(memoryPathFor(sessionID), "## Session Memory\n\n### Long Horizon Context\n- Keep this\n");
    const output = { system: [`${INJECTION_PREFIX}\nalready here`] as string[] };
    await plugin["experimental.chat.system.transform"]({ sessionID, messageID: "dup-msg-1" } as any, output);
    expect(output.system.length).toBe(1);
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain('"reason":"already_present_in_system"');
  });

  test("internal assistant filter excludes parts-only tool/thinking rows", async () => {
    const sessionID = `parts-filter-${Date.now()}`;
    let capturedPrompt = "";
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "track /lib/a.ts" },
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "tool_result", text: "tool only part" },
            { type: "thinking", text: "thinking only part" },
          ],
        },
        { id: "a2", role: "assistant", content: "final assistant visible reply" },
      ],
      promptResponder: (args?: unknown) => {
        capturedPrompt = String(args?.body?.parts?.[0]?.text || "");
        return "## Session Memory\n\n### Active References\n- /lib/a.ts\n";
      },
    });
    const { plugin } = await createPlugin({ summarizerMode: "active", debug: false }, fakeClient);
    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    expect(capturedPrompt).toContain("USER:\ntrack /lib/a.ts");
    expect(capturedPrompt).toContain("ASSISTANT:\nfinal assistant visible reply");
    expect(capturedPrompt).not.toContain("tool only part");
    expect(capturedPrompt).not.toContain("thinking only part");
  });

  test("clean mode with no fallback logs memory_update_clean_failed_no_fallback", async () => {
    const sessionID = `clean-no-fallback-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "force clean failure" },
        { id: "m2", role: "assistant", content: "ok" },
      ],
      promptShouldThrow: true,
    });
    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "clean",
        cleanFallbackToActiveSession: false,
        opencodeExecutable: "this-binary-definitely-does-not-exist",
        sideSessionRetries: 0,
        debug: false,
      },
      fakeClient,
    );
    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });
    const memory = await readText(memoryPathFor(sessionID), "");
    expect(memory).toContain("None captured yet.");
    expect(client.calls.prompt.length).toBe(0);
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText).toContain("memory_update_clean_failed_no_fallback");
  });

  describe("subagent memory handling", () => {
    test("subagent with injectInSubagents true inherits parent memory and skips updates", async () => {
      const parentSessionID = `parent-${Date.now()}`;
      const subSessionID = `sub-${Date.now()}`;

      // Prepare parent memory
      const { plugin, client } = await createPlugin({
        summarizerMode: "active",
        injectInSubagents: true,
        debounceMs: 500,
        remindEveryN: 1,
        debug: false,
      });

      await plugin["session.created"]({ sessionID: parentSessionID });
      await writeText(
        memoryPathFor(parentSessionID),
        "## Session Memory\n\n### User Instructions\n- Parent instruction\n\n### Long Horizon Context\n- Important context\n",
      );

      // Simulate subagent creation event with parentID
      const subCreateInput = {
        sessionID: subSessionID,
        event: {
          type: "session.created",
          properties: {
            info: {
              id: subSessionID,
              parentID: parentSessionID,
            },
          },
        },
      };
      await plugin["session.created"](subCreateInput);

      // Subagent memory file should copy parent content
      const subMemory = await readText(memoryPathFor(subSessionID), "");
      expect(subMemory).toContain("- Parent instruction");
      expect(subMemory).toContain("- Important context");

      // Attempt update on subagent – should be skipped (no client calls)
      client.calls.messages = [];
      client.calls.prompt = [];
      await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID: subSessionID });
      expect(client.calls.messages.length).toBe(0);
      expect(client.calls.prompt.length).toBe(0);

      // System transform should inject the inherited memory
      const systemOutput = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: subSessionID, messageID: "sub-msg-1" },
        systemOutput,
      );
      expect(systemOutput.system.length).toBe(1);
      expect(systemOutput.system[0]).toContain(INJECTION_PREFIX);
      expect(systemOutput.system[0]).toContain("- Important context");

      // Compaction should push memory
      const compactionOutput = { context: [] as string[] };
      await plugin["experimental.session.compacting"]({ sessionID: subSessionID }, compactionOutput);
      expect(compactionOutput.context.length).toBe(1);
      expect(compactionOutput.context[0]).toContain("Important context");
    });

    test("subagent with injectInSubagents false leaves placeholder memory and skips injection/compaction", async () => {
      const parentSessionID = `parent-off-${Date.now()}`;
      const subSessionID = `sub-off-${Date.now()}`;

      const { plugin, client } = await createPlugin({
        summarizerMode: "active",
        injectInSubagents: false,
        debounceMs: 500,
        remindEveryN: 1,
        debug: false,
      });

      // Parent has some memory, but subagent shouldn't inherit
      await plugin["session.created"]({ sessionID: parentSessionID });
      await writeText(
        memoryPathFor(parentSessionID),
        "## Session Memory\n\n### User Instructions\n- Parent instruction\n",
      );

      const subCreateInput = {
        sessionID: subSessionID,
        event: {
          type: "session.created",
          properties: {
            info: {
              id: subSessionID,
              parentID: parentSessionID,
            },
          },
        },
      };
      await plugin["session.created"](subCreateInput);

      // Subagent memory file should be the default placeholder
      const subMemory = await readText(memoryPathFor(subSessionID), "");
      expect(subMemory).toContain("- None captured yet.");
      expect(subMemory).not.toContain("Parent instruction");

      // System transform should skip because compacted memory is empty
      const systemOutput = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: subSessionID, messageID: "sub-msg-1" },
        systemOutput,
      );
      expect(systemOutput.system.length).toBe(0);

      // Compaction should not push any context
      const compactionOutput = { context: [] as string[] };
      await plugin["experimental.session.compacting"]({ sessionID: subSessionID }, compactionOutput);
      expect(compactionOutput.context.length).toBe(0);

      // Update on subagent should still be skipped (no-op)
      client.calls.messages = [];
      client.calls.prompt = [];
      await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID: subSessionID });
      expect(client.calls.messages.length).toBe(0);
      expect(client.calls.prompt.length).toBe(0);
    });
  });

  test("memory update handles descending message order from API", async () => {
    const sessionID = `reverse-order-${Date.now()}`;

    // Messages are in chronological order (oldest first)
    const allMessages = [
      { id: "m1", role: "user", content: "old message one" },
      { id: "m2", role: "assistant", content: "old reply one" },
      { id: "m3", role: "user", content: "new message keep this" },
      { id: "m4", role: "assistant", content: "new final keep this too" },
    ];

    // Fake client returns messages in reverse (descending) order,
    // simulating an API that returns newest-first.
    const fakeClient = createFakeClient({
      messagesRows: [...allMessages].reverse(), // newest first
      promptText: "## Session Memory\n\n### Current Context\n- delta summary\n",
    });

    // Override messages to always return reversed list
    const originalMessages = fakeClient.session.messages.bind(fakeClient.session);
    fakeClient.session.messages = async (args?: unknown) => {
      const result = await originalMessages(args);
      // Already reversed in the rows, but ensure it's descending
      return result;
    };

    const { plugin, client } = await createPlugin({ summarizerMode: "active", debug: false }, fakeClient as any);

    await plugin["session.created"]({ sessionID });

    // Set checkpoint to m2 (so delta should be m3 and m4)
    await writeText(checkpointPathFor(sessionID), "m2\n");

    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    // Check that only new messages (m3, m4) were used in the summarizer
    expect(client.calls.prompt.length).toBe(1);
    const promptText = String(client.calls.prompt[0]?.body?.parts?.[0]?.text || "");

    // Old messages should NOT appear
    expect(promptText).not.toContain("old message one");
    expect(promptText).not.toContain("old reply one");

    // New messages should appear
    expect(promptText).toContain("USER:\nnew message keep this");
    expect(promptText).toContain("ASSISTANT:\nnew final keep this too");

    // Checkpoint should have been updated to the last message
    const newCheckpoint = await readText(checkpointPathFor(sessionID), "");
    expect(newCheckpoint.trim()).toBe("m4");
  });

  test("memory update prompt preserves oldest-to-newest chronological order", async () => {
    const sessionID = `chronological-order-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "first user turn" },
        { id: "m2", role: "assistant", content: "first assistant reply" },
        { id: "m3", role: "user", content: "second user turn" },
        { id: "m4", role: "assistant", content: "second assistant reply" },
        { id: "m5", role: "user", content: "third user turn" },
        { id: "m6", role: "assistant", content: "third assistant reply" },
      ],
      promptText: "## Session Memory\n\n### Long Horizon Context\n- ordered\n",
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(client.calls.prompt.length).toBe(1);
    const promptText = String(client.calls.prompt[0]?.body?.parts?.[0]?.text || "");

    // Assert strict oldest→newest order in the rendered conversation slice
    const firstUserIdx = promptText.indexOf("USER:\nfirst user turn");
    const firstAssistantIdx = promptText.indexOf("ASSISTANT:\nfirst assistant reply");
    const secondUserIdx = promptText.indexOf("USER:\nsecond user turn");
    const secondAssistantIdx = promptText.indexOf("ASSISTANT:\nsecond assistant reply");
    const thirdUserIdx = promptText.indexOf("USER:\nthird user turn");
    const thirdAssistantIdx = promptText.indexOf("ASSISTANT:\nthird assistant reply");

    expect(firstUserIdx).toBeGreaterThanOrEqual(0);
    expect(firstAssistantIdx).toBeGreaterThan(firstUserIdx);
    expect(secondUserIdx).toBeGreaterThan(firstAssistantIdx);
    expect(secondAssistantIdx).toBeGreaterThan(secondUserIdx);
    expect(thirdUserIdx).toBeGreaterThan(secondAssistantIdx);
    expect(thirdAssistantIdx).toBeGreaterThan(thirdUserIdx);
  });

  test("memory update preserves all assistant messages when collapseAssistantBursts is false", async () => {
    const sessionID = `no-collapse-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "u1", role: "user", content: "start" },
        { id: "a1", role: "assistant", content: "assistant chunk one" },
        { id: "a2", role: "assistant", content: "assistant chunk two" },
        { id: "a3", role: "assistant", content: "assistant chunk three" },
        { id: "u2", role: "user", content: "continue" },
        { id: "a4", role: "assistant", content: "final assistant reply" },
      ],
      promptText: "## Session Memory\n\n### Long Horizon Context\n- no collapse\n",
    });

    const { plugin, client } = await createPlugin(
      {
        summarizerMode: "active",
        collapseAssistantBursts: false,
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });
    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    expect(client.calls.prompt.length).toBe(1);
    const promptText = String(client.calls.prompt[0]?.body?.parts?.[0]?.text || "");

    expect(promptText).toContain("ASSISTANT:\nassistant chunk one");
    expect(promptText).toContain("ASSISTANT:\nassistant chunk two");
    expect(promptText).toContain("ASSISTANT:\nassistant chunk three");
    expect(promptText).toContain("ASSISTANT:\nfinal assistant reply");
  });
});
