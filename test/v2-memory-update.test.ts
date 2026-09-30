import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Root from "../src/index";
import {
  MEMORY_HEADER,
  MEMORY_FORMAT_VERSION,
  checkpointPathFor,
  logPath,
  memoryPathFor,
  readText,
  writeText,
} from "../src/memory-utils";
import { CLEAN_SUMMARIZER_TIMEOUT } from "../src/summarizer";
import type { V2Context, V2SessionContext } from "../src/v2-adapter";
import { createV2MemoryUpdater, isV2MemoryUpdateInFlight } from "../src/v2-memory-update";

const VALID_MEMORY = `${MEMORY_HEADER}

### User Instructions
- Keep the instruction.

### Long Horizon Context
- Keep the context.

### Decisions
- Keep the decision.

### Conclusions
- Keep the conclusion.

### Active References
- Keep the reference.
`;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function message(id: string | undefined, role: "user" | "assistant" | "system" | "tool", text: string) {
  return { ...(id === undefined ? {} : { id }), role, content: [{ type: "text", text }] };
}

function makeContext(
  directory: string,
  options: {
    active?: (input: { sessionID: string; prompt: string }, signal?: AbortSignal) => Promise<{ text: string }>;
    clean?: (input: { prompt: string; model?: unknown }, signal?: AbortSignal) => Promise<{ text: string }>;
  } = {},
) {
  const calls = { active: [] as unknown[], clean: [] as unknown[] };
  const value = {
    location: {
      directory,
      project: { id: "project", directory, canonical: directory },
    },
    options: {},
    session: {
      generate: async (input: { sessionID: string; prompt: string }, request?: { signal?: AbortSignal }) => {
        calls.active.push({ input, request });
        return options.active ? options.active(input, request?.signal) : { text: VALID_MEMORY };
      },
      hook: async () => ({ dispose: async () => undefined }),
    },
    generate: {
      text: async (input: { prompt: string; model?: unknown }, request?: { signal?: AbortSignal }) => {
        calls.clean.push({ input, request });
        return options.clean ? options.clean(input, request?.signal) : { text: VALID_MEMORY };
      },
    },
    tool: {
      transform: async () => ({ dispose: async () => undefined }),
    },
  };
  return { context: value as unknown as V2Context, calls };
}

function input(sessionID: string, messages: unknown[], model = { providerID: "provider", id: "model" }) {
  return {
    sessionID,
    agent: "agent",
    model,
    system: [],
    messages,
    options: {},
    tools: {},
  } as unknown as V2SessionContext;
}

function conversationBody(prompt: string): string {
  const start = prompt.indexOf("<conversation_update>");
  const end = prompt.indexOf("</conversation_update>");
  return start >= 0 && end > start ? prompt.slice(start + "<conversation_update>".length, end) : "";
}

describe("V2 fresh memory updater", () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalConfig = process.env.OPENCODE_CONFIG_DIR;
  let directory = "";
  let memoryDir = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stm-v2-update-"));
    memoryDir = join(directory, "memory");
    process.chdir(directory);
    process.env.HOME = join(directory, "home");
    process.env.XDG_CONFIG_HOME = join(directory, "xdg");
    process.env.OPENCODE_CONFIG_DIR = join(directory, "config");
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfig;
    CLEAN_SUMMARIZER_TIMEOUT.ms = 90_000;
    await rm(directory, { recursive: true, force: true });
  });

  test("active mode generates, validates, writes memory, and advances checkpoint", async () => {
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir, summarizerMode: "active" }));
    const { context, calls } = makeContext(directory);
    await createV2MemoryUpdater(context)(
      input("active", [message("u1", "user", "Remember this"), message("a1", "assistant", "Done")]),
    );
    expect(calls.active).toHaveLength(1);
    expect(calls.clean).toHaveLength(0);
    expect(await readText(memoryPathFor("active", memoryDir))).toContain(MEMORY_HEADER);
    expect(await readText(checkpointPathFor("active", memoryDir))).toBe("a1\n");
  });

  test("clean mode passes the exact current model to standalone generation", async () => {
    const model = { providerID: "exact-provider", id: "exact-model" };
    const { context, calls } = makeContext(directory);
    await createV2MemoryUpdater(context)(
      input("clean", [message("u1", "user", "Question"), message("a1", "assistant", "Answer")], model),
    );
    expect(calls.active).toHaveLength(0);
    expect(calls.clean).toHaveLength(1);
    expect((calls.clean[0] as { input: { model: unknown } }).input.model).toBe(model);
  });

  test.each([
    ["user-only", [message("u1", "user", "Question")], "no_assistant_in_delta"],
    [
      "missing-id",
      [message(undefined, "user", "Question"), message("a1", "assistant", "Answer")],
      "invalid_visible_ids",
    ],
    [
      "duplicate-id",
      [message("same", "user", "Question"), message("same", "assistant", "Answer")],
      "invalid_visible_ids",
    ],
  ])("skips %s snapshots without generating", async (name, messages, reason) => {
    const { context, calls } = makeContext(directory);
    await createV2MemoryUpdater(context)(input(name, messages));
    expect(calls.active).toHaveLength(0);
    expect(calls.clean).toHaveLength(0);
    expect(await readText(logPath(memoryDir))).toContain(`"reason":"${reason}"`);
  });

  test("rebases when a nonempty checkpoint is absent from the visible snapshot", async () => {
    await writeText(checkpointPathFor("missing", memoryDir), "gone\n");
    const { context, calls } = makeContext(directory);
    await createV2MemoryUpdater(context)(
      input("missing", [message("u1", "user", "Current question"), message("a1", "assistant", "Current answer")]),
    );
    expect(calls.clean).toHaveLength(1);
    const prompt = (calls.clean[0] as { input: { prompt: string } }).input.prompt;
    expect(conversationBody(prompt)).toContain("Current question");
    expect(await readText(memoryPathFor("missing", memoryDir))).toContain(MEMORY_HEADER);
    expect(await readText(checkpointPathFor("missing", memoryDir))).toBe("a1\n");
    expect(await readText(logPath(memoryDir))).toContain('"reason":"checkpoint_rebase"');
    expect(await readText(logPath(memoryDir))).toContain('"absentCheckpoint":"gone"');
  });

  test("processes oversized entries as lossless continuation fragments", async () => {
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir, maxUpdateInputLength: 500 }));
    await writeText(checkpointPathFor("oversized", memoryDir), "before\n");
    const checkpointAtGeneration: string[] = [];
    const { context, calls } = makeContext(directory, {
      clean: async ({ prompt }) => {
        checkpointAtGeneration.push(await readText(checkpointPathFor("oversized", memoryDir), ""));
        return { text: VALID_MEMORY };
      },
    });
    await createV2MemoryUpdater(context)(
      input("oversized", [
        message("before", "user", "old"),
        message("large", "user", `BEGIN_SENTINEL${"x".repeat(800)}MIDDLE_SENTINEL${"y".repeat(800)}END_SENTINEL`),
        message("answer", "assistant", "answered"),
      ]),
    );
    expect(calls.clean.length).toBeGreaterThan(1);
    const prompts = calls.clean.map((call) => (call as { input: { prompt: string } }).input.prompt);
    expect(prompts.join("\n")).toContain("BEGIN_SENTINEL");
    expect(prompts.join("\n")).toContain("MIDDLE_SENTINEL");
    expect(prompts.join("\n")).toContain("END_SENTINEL");
    const fragmentPrompts = prompts.filter((prompt) =>
      conversationBody(prompt).includes("OVERSIZED_ENTRY_CONTINUATION"),
    );
    const normalPrompts = prompts.filter(
      (prompt) => !conversationBody(prompt).includes("OVERSIZED_ENTRY_CONTINUATION"),
    );
    expect(fragmentPrompts.length).toBeGreaterThan(1);
    expect(normalPrompts).toHaveLength(1);
    expect(conversationBody(normalPrompts[0]!)).toContain("answered");
    expect(conversationBody(normalPrompts[0]!)).not.toContain("OVERSIZED_ENTRY_CONTINUATION");
    expect(prompts.findIndex((prompt) => prompt === normalPrompts[0])).toBe(fragmentPrompts.length);
    expect(
      checkpointAtGeneration.slice(0, fragmentPrompts.length).every((checkpoint) => checkpoint === "before\n"),
    ).toBe(true);
    expect(checkpointAtGeneration[fragmentPrompts.length]).toBe("large\n");
    expect(await readText(checkpointPathFor("oversized", memoryDir))).toBe("answer\n");
  });

  test("does not advance checkpoint when a later oversized fragment fails", async () => {
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir, maxUpdateInputLength: 500 }));
    await writeText(checkpointPathFor("fragment-failure", memoryDir), "before\n");
    let callsSeen = 0;
    const { context, calls } = makeContext(directory, {
      clean: async () => {
        callsSeen += 1;
        return callsSeen === 1 ? { text: VALID_MEMORY } : { text: "malformed" };
      },
    });
    await createV2MemoryUpdater(context)(
      input("fragment-failure", [
        message("before", "user", "old"),
        message("large", "user", `BEGIN${"x".repeat(1800)}END`),
        message("answer", "assistant", "answered"),
      ]),
    );
    expect(calls.clean.length).toBe(2);
    expect(await readText(checkpointPathFor("fragment-failure", memoryDir))).toBe("before\n");
  });

  test("applies the assistant gate to the bounded chunk", async () => {
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir, maxDeltaMessages: 20 }));
    const messages = Array.from({ length: 20 }, (_, index) => message(`u${index}`, "user", `user-${index}`));
    messages.push(message("a20", "assistant", "answer outside bounded chunk"));
    const { context, calls } = makeContext(directory);
    await createV2MemoryUpdater(context)(input("bounded-assistant", messages));
    expect(calls.clean).toHaveLength(2);
    expect(await readText(checkpointPathFor("bounded-assistant", memoryDir))).toBe("a20\n");
  });

  test("builds the prompt from only entries after the checkpoint and excludes internal content", async () => {
    await writeText(checkpointPathFor("delta", memoryDir), "old\n");
    const { context, calls } = makeContext(directory);
    await createV2MemoryUpdater(context)(
      input("delta", [
        message("old", "user", "Earlier"),
        message("u1", "user", "Visible question"),
        message("tool", "tool", "tool-output-sentinel"),
        message("sys", "system", "system-sentinel"),
        message("internal", "assistant", "thinking: secret"),
        message("injected", "assistant", "[MEMORY_SYSTEM] old memory"),
        {
          id: "parts",
          role: "assistant",
          content: [
            { type: "reasoning", text: "private reasoning" },
            { type: "text", text: "Part answer" },
          ],
        },
        message("a1", "assistant", "Visible answer"),
      ]),
    );
    const prompt = (calls.clean[0] as { input: { prompt: string } }).input.prompt;
    const conversation = conversationBody(prompt);
    expect(conversation).toContain("Visible question");
    expect(conversation).toContain("Visible answer");
    expect(conversation).not.toContain("Earlier");
    expect(conversation).not.toContain("tool-output-sentinel");
    expect(conversation).not.toContain("system-sentinel");
    expect(conversation).not.toContain("secret");
    expect(conversation).not.toContain("private reasoning");
    expect(conversation).toContain("Part answer");
    expect(conversation).not.toContain("old memory");
  });

  test.each([
    ["", "empty_generation"],
    ["not memory", "missing_memory_header"],
    [`${VALID_MEMORY}\n<existing_memory>bad</existing_memory>`, "raw_template_marker"],
  ])("leaves files unchanged for malformed generation %s", async (text, detail) => {
    const existing = `${MEMORY_FORMAT_VERSION}\n${VALID_MEMORY}`;
    await writeText(memoryPathFor("bad", memoryDir), existing);
    await writeText(checkpointPathFor("bad", memoryDir), "before\n");
    const { context, calls } = makeContext(directory, { clean: async () => ({ text }) });
    await createV2MemoryUpdater(context)(
      input("bad", [
        message("before", "user", "Earlier checkpoint"),
        message("u1", "user", "Question"),
        message("a1", "assistant", "Answer"),
      ]),
    );
    expect(calls.clean).toHaveLength(1);
    expect(await readText(memoryPathFor("bad", memoryDir))).toBe(existing);
    expect(await readText(checkpointPathFor("bad", memoryDir))).toBe("before\n");
    const entries = (await readText(logPath(memoryDir)))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.at(-1)).toMatchObject({ event: "v2_memory_update_error", reason: "operational_failure" });
    expect(entries.at(-1)).toMatchObject({ detail: detail });
  });

  test("allows separate sessions while excluding a concurrent same-session callback", async () => {
    const gate = deferred<{ text: string }>();
    const sameEntered = deferred<void>();
    const otherEntered = deferred<void>();
    let generationEntries = 0;
    const { context, calls } = makeContext(directory, {
      clean: async (_request, signal) => {
        generationEntries += 1;
        if (generationEntries === 1) sameEntered.resolve();
        else otherEntered.resolve();
        signal?.addEventListener("abort", () => undefined);
        return gate.promise;
      },
    });
    const updater = createV2MemoryUpdater(context);
    const secondInstance = makeContext(directory);
    const secondUpdater = createV2MemoryUpdater(secondInstance.context);
    const first = updater(input("same", [message("u1", "user", "Q"), message("a1", "assistant", "A")]));
    await sameEntered.promise;
    const second = secondUpdater(input("same", [message("u1", "user", "Q"), message("a1", "assistant", "A")]));
    const other = updater(
      input("other", [message("u2", "user", "Other question"), message("a2", "assistant", "Other answer")]),
    );
    await otherEntered.promise;
    expect(calls.clean).toHaveLength(2);
    expect(secondInstance.calls.clean).toHaveLength(0);
    gate.resolve({ text: VALID_MEMORY });
    await Promise.all([first, second, other]);
  });

  test("does not suppress the same session ID in a different project directory", async () => {
    const otherDirectory = await mkdtemp(join(tmpdir(), "stm-v2-other-project-"));
    try {
      const first = makeContext(directory);
      const second = makeContext(otherDirectory);
      await writeText(
        join(otherDirectory, ".opencode", "stm.json"),
        JSON.stringify({ memoryDir: join(otherDirectory, "memory") }),
      );
      await Promise.all([
        createV2MemoryUpdater(first.context)(
          input("shared-session", [message("u1", "user", "Q"), message("a1", "assistant", "A")]),
        ),
        createV2MemoryUpdater(second.context)(
          input("shared-session", [message("u1", "user", "Q"), message("a1", "assistant", "A")]),
        ),
      ]);
      expect(first.calls.clean).toHaveLength(1);
      expect(second.calls.clean).toHaveLength(1);
    } finally {
      await rm(otherDirectory, { recursive: true, force: true });
    }
  });

  test("swallows generation rejection and timeout while logging the failure", async () => {
    const { context, calls } = makeContext(directory, {
      clean: async () => Promise.reject(new Error("generation rejected")),
    });
    await expect(
      createV2MemoryUpdater(context)(input("reject", [message("u1", "user", "Q"), message("a1", "assistant", "A")])),
    ).resolves.toBeUndefined();
    expect(calls.clean).toHaveLength(1);
    expect(await readText(logPath(memoryDir))).toContain('"detail":"generation rejected"');
    CLEAN_SUMMARIZER_TIMEOUT.ms = 1;
    const timeoutEntered = deferred<void>();
    const lateOperation = deferred<{ text: string }>();
    let timeoutCalls = 0;
    const timeoutContext = makeContext(directory, {
      clean: async () => {
        timeoutCalls += 1;
        timeoutEntered.resolve();
        return lateOperation.promise;
      },
    });
    const timeoutUpdate = createV2MemoryUpdater(timeoutContext.context)(
      input("timeout", [message("u1", "user", "Q"), message("a1", "assistant", "A")]),
    );
    await timeoutEntered.promise;
    await expect(timeoutUpdate).resolves.toBeUndefined();
    expect(timeoutCalls).toBe(1);
    expect(await readText(logPath(memoryDir))).toContain('"detail":"summarizer_timeout:1ms"');
    lateOperation.reject(new Error("late timeout rejection"));
    await Promise.resolve();
  });

  test("does not move checkpoint after a concurrent memory change", async () => {
    const gate = deferred<{ text: string }>();
    const entered = deferred<void>();
    const { context, calls } = makeContext(directory, {
      clean: async () => {
        entered.resolve();
        return gate.promise;
      },
    });
    await writeText(memoryPathFor("stale", memoryDir), `${MEMORY_FORMAT_VERSION}\n${VALID_MEMORY}`);
    const update = createV2MemoryUpdater(context)(
      input("stale", [message("u1", "user", "Q"), message("a1", "assistant", "A")]),
    );
    await entered.promise;
    expect(calls.clean).toHaveLength(1);
    await writeText(memoryPathFor("stale", memoryDir), "changed externally\n");
    gate.resolve({ text: VALID_MEMORY });
    await update;
    expect(await readText(memoryPathFor("stale", memoryDir))).toBe("changed externally\n");
    expect(await readText(checkpointPathFor("stale", memoryDir))).toBe("");
  });

  test("restores memory when checkpoint persistence fails", async () => {
    const existing = `${MEMORY_FORMAT_VERSION}\n${VALID_MEMORY}`;
    await writeText(memoryPathFor("rollback", memoryDir), existing);
    await writeFile(join(memoryDir, "checkpoints"), "not a directory");
    const { context, calls } = makeContext(directory);
    await createV2MemoryUpdater(context)(
      input("rollback", [message("u1", "user", "Q"), message("a1", "assistant", "A")]),
    );
    expect(calls.clean).toHaveLength(1);
    expect(await readText(memoryPathFor("rollback", memoryDir))).toBe(existing);
    const entries = (await readText(logPath(memoryDir)))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.at(-1)).toMatchObject({ event: "v2_memory_update_error", reason: "operational_failure" });
    expect(entries.at(-1).detail).toBeString();
  });

  test("logs a restore conflict and preserves an intervening memory writer", async () => {
    const existing = `${MEMORY_FORMAT_VERSION}\n${VALID_MEMORY}`;
    await writeText(memoryPathFor("rollback-conflict", memoryDir), existing);
    const { context, calls } = makeContext(directory);
    await createV2MemoryUpdater(context, undefined, {
      writeCheckpoint: async () => {
        throw new Error("checkpoint failure");
      },
      beforeRollback: async () => {
        await writeText(memoryPathFor("rollback-conflict", memoryDir), "external writer\n");
      },
    })(input("rollback-conflict", [message("u1", "user", "Q"), message("a1", "assistant", "A")]));
    expect(calls.clean).toHaveLength(1);
    expect(await readText(memoryPathFor("rollback-conflict", memoryDir))).toBe("external writer\n");
    expect(await readText(checkpointPathFor("rollback-conflict", memoryDir))).toBe("");
    const entries = (await readText(logPath(memoryDir)))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.some((entry) => entry.reason === "checkpoint_write_failed_restore_conflict")).toBe(true);
    expect(entries.at(-1)).toMatchObject({ reason: "operational_failure", detail: "checkpoint failure" });
  });

  test("does not recurse through a combined active context callback", async () => {
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir, summarizerMode: "active" }));
    const hooks: Array<{ name: string; callback: (value: unknown) => Promise<void> }> = [];
    let nestedCallback: ((value: unknown) => Promise<void>) | undefined;
    let nestedCheckpoint = "";
    let nestedInvocations = 0;
    let nestedSystemLength = -1;
    const base = makeContext(directory, {
      active: async ({ sessionID }) => {
        nestedInvocations += 1;
        const nestedInput = input(sessionID, [message("u1", "user", "Q"), message("a1", "assistant", "A")]);
        await nestedCallback?.(nestedInput);
        nestedSystemLength = nestedInput.system.length;
        nestedCheckpoint = await readText(checkpointPathFor(sessionID, memoryDir));
        return { text: VALID_MEMORY };
      },
    });
    (
      base.context.session as unknown as {
        hook: (name: string, callback: (value: unknown) => Promise<void>) => Promise<{ dispose: () => Promise<void> }>;
      }
    ).hook = async (name, callback) => {
      hooks.push({ name, callback });
      return { dispose: async () => undefined };
    };
    const cleanup = await Root.setup(base.context);
    nestedCallback = hooks.find((hook) => hook.name === "context")?.callback;
    await nestedCallback!(input("recursive", [message("u1", "user", "Q"), message("a1", "assistant", "A")]));
    expect(nestedInvocations).toBe(1);
    expect(base.calls.clean).toHaveLength(0);
    expect(base.calls.active).toHaveLength(1);
    expect(nestedSystemLength).toBe(0);
    expect(isV2MemoryUpdateInFlight(directory, "recursive")).toBe(false);
    expect(nestedCheckpoint).toBe("");
    expect(await readText(checkpointPathFor("recursive", memoryDir))).toBe("a1\n");
    await cleanup?.();
  });

  test("combined setup updates before injection while compaction remains injection-only", async () => {
    const hooks: Array<{ name: string; callback: (value: unknown) => Promise<void> }> = [];
    const base = makeContext(directory);
    (
      base.context.session as unknown as {
        hook: (name: string, callback: (value: unknown) => Promise<void>) => Promise<{ dispose: () => Promise<void> }>;
      }
    ).hook = async (name: string, callback: (value: unknown) => Promise<void>) => {
      hooks.push({ name, callback });
      return { dispose: async () => undefined };
    };
    const cleanup = await Root.setup(base.context);
    const contextHook = hooks.find((hook) => hook.name === "context")!;
    const compactionHook = hooks.find((hook) => hook.name === "compaction")!;
    const contextInput = input("setup", [message("u1", "user", "Q"), message("a1", "assistant", "A")]);
    await contextHook.callback(contextInput);
    expect(contextInput.system.some((part) => part.text.includes("[MEMORY_SYSTEM]"))).toBe(true);
    const generationCount = base.calls.clean.length;
    const compactionInput = input("setup", []);
    await compactionHook.callback(compactionInput);
    expect(base.calls.clean).toHaveLength(generationCount);
    expect(compactionInput.system.some((part) => part.text.includes("[MEMORY_SYSTEM]"))).toBe(true);
    await cleanup?.();
  });
});
