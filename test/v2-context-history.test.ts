import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Root from "../src/index";
import type { V2CommandDefinition, V2Context, V2SessionContext } from "../src/v2-adapter";
import { createV2MemoryActions } from "../src/v2-memory-tools";
import { createV2MemoryUpdater } from "../src/v2-memory-update";
import { readV2CurrentHistory } from "../src/v2-current-history";
import { createV2ContextInjection } from "../src/v2-context-injection";
import * as MemoryUtils from "../src/memory-utils";
import {
  STANDARD_MEMORY_TEMPLATE,
  DEFAULT_CONFIG,
  checkpointPathFor,
  memoryPathFor,
  logPath,
  readText,
  writeText,
  readRawFile,
  resetBoundaryPathFor,
} from "../src/memory-utils";
import { withV2MemoryMutation } from "../src/v2-mutation-coordination";
import { resetV2MemoryPersistence } from "../src/v2-reset-persistence";
import { deferred } from "./async-helpers";
import { installV2NativeGenerationHarness } from "./v2-native-generation-harness";

const model = { providerID: "offline", id: "test" };
const memory = STANDARD_MEMORY_TEMPLATE.replace("### Decisions", "### Decisions\n- SAVED_MEMORY_SENTINEL");
const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 1 } });
const assistant = (id: string, text: string) => ({
  id,
  type: "assistant",
  agent: "build",
  model,
  content: [{ type: "text", text }],
  time: { created: 2, completed: 3 },
});
const idle = (id: string) => ({ id, type: "idle", outcome: "succeeded", time: { created: 4 } });
const message = (id: string, role: "user" | "assistant", text: string) => ({
  id,
  role,
  content: [{ type: "text" as const, text }],
});
const snapshot = (messages: ReturnType<typeof message>[]): V2SessionContext =>
  ({ sessionID: "session", agent: "build", model, system: [], messages, options: {}, tools: {} }) as V2SessionContext;

function host(directory: string, records: unknown[]) {
  const hooks = new Map<string, (input: any) => Promise<void>>();
  const commands: V2CommandDefinition[] = [];
  const prompts: Array<{ prompt: string; model?: unknown }> = [];
  let durable = records;
  let rpc: {
    claim: (input: unknown) => unknown;
    acknowledge: (input: unknown) => unknown;
  };
  const context = {
    location: { directory, project: { id: "p", directory, canonical: directory } },
    options: {},
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: null, model }),
      context: async () => durable,
      hook: async (name: string, callback: (input: any) => Promise<void>) => {
        hooks.set(name, callback);
        return { dispose: async () => undefined };
      },
      wait: async () => undefined,
    },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    generate: {
      text: async (input: { prompt: string; model?: unknown }, _request?: { signal?: AbortSignal }) => {
        prompts.push(input);
        return { text: memory };
      },
    },
    tool: { transform: async () => ({ dispose: async () => undefined }) },
    command: {
      transform: async (callback: (editor: { add: (definition: V2CommandDefinition) => void }) => void) => {
        callback({ add: (definition) => commands.push(definition) });
        return { dispose: async () => undefined };
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: typeof rpc) => {
        rpc = handlers;
        return {
          events: {
            emit: async (name: string, data: Record<string, unknown>) => {
              if (name === "offer") await rpc.claim({ ...data, receiverID: "test-reader" });
              if (name === "output") await rpc.acknowledge(data);
            },
          },
          dispose: async () => undefined,
        };
      },
    },
  };
  installV2NativeGenerationHarness(context as unknown as V2Context, {
    clean: (input, signal) => context.generate.text(input, { signal }),
    active: async () => ({ text: memory }),
  });
  return {
    context,
    hooks,
    commands,
    prompts,
    action: (input: unknown) => (rpc as any).action(input),
    setRecords: (values: unknown[]) => (durable = values),
  };
}

async function refresh(h: ReturnType<typeof host>) {
  const current = await readV2CurrentHistory(h.context as unknown as V2Context, "session");
  if (current.status !== "ready") throw new Error(`history_${current.status}`);
  return createV2MemoryUpdater(h.context as unknown as V2Context)({ sessionID: "session", ...current.history });
}

describe("V2 native context provenance and lifecycle", () => {
  let directory: string;
  let memoryDir: string;
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stm-v2-context-history-"));
    memoryDir = join(directory, "memory");
    await writeText(
      join(directory, ".opencode", "stm.json"),
      JSON.stringify({ ...DEFAULT_CONFIG, memoryDir, enableLegacyPeriodicSystemTransform: true, remindEveryN: 1 }),
    );
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  test.each(["disabled", "task-child"] as const)("does not fetch update history for %s contexts", async (kind) => {
    const h = host(directory, []);
    let historyReads = 0;
    h.context.session.context = async () => {
      historyReads += 1;
      throw new Error("history must not be read");
    };
    if (kind === "disabled") {
      await writeText(
        join(directory, ".opencode", "stm.json"),
        JSON.stringify({ ...DEFAULT_CONFIG, memoryDir, enabled: false }),
      );
    } else {
      Object.assign(h.context.session, {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: "parent", model }),
      });
    }
    cleanup = await Root.setup(h.context as unknown as V2Context);
    await h.hooks.get("context")!(snapshot([message("msg_user", "user", "instruction")]));
    expect(historyReads).toBe(0);
    expect(h.prompts).toHaveLength(0);
  });

  test("uses a durable settled prefix without summarizing an unfinished assistant placeholder", async () => {
    const h = host(directory, [
      user("msg_user", "old instruction"),
      assistant("msg_answer", "settled answer"),
      { ...assistant("msg_pending", "UNFINISHED_SENTINEL"), time: { created: 5 } },
    ]);
    cleanup = await Root.setup(h.context as unknown as V2Context);
    await refresh(h);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.prompt).toContain("settled answer");
    expect(h.prompts[0]!.prompt).not.toContain("UNFINISHED_SENTINEL");
    expect(await readText(checkpointPathFor("session", memoryDir))).toBe("msg_answer\n");
  });

  test("primary context injects saved memory without depending on available durable history", async () => {
    const h = host(directory, []);
    h.context.session.context = async () => {
      throw new Error("offline history unavailable");
    };
    await writeText(memoryPathFor("session", memoryDir), memory);
    cleanup = await Root.setup(h.context as unknown as V2Context);
    await h.hooks.get("prompt")!({ sessionID: "session", messageID: "msg_user", prompt: { text: "instruction" } });
    const input = snapshot([message("msg_user", "user", "instruction")]);
    await h.hooks.get("context")!(input);
    expect(h.prompts).toHaveLength(0);
    expect(JSON.stringify(input.system)).toContain("SAVED_MEMORY_SENTINEL");
    expect(await readText(logPath(memoryDir))).not.toContain("v2_context_refresh_failed");
  });

  test.each(["reset", "dispose"] as const)("does not publish an old memory read after %s", async (operation) => {
    const h = host(directory, [user("msg_user", "instruction"), assistant("msg_answer", "answer"), idle("msg_idle")]);
    const lifetime = new AbortController();
    const injection = createV2ContextInjection(
      h.context as unknown as V2Context,
      directory,
      undefined,
      lifetime.signal,
    );
    const started = deferred<void>();
    const pendingRead = deferred<string>();
    const actualRead = MemoryUtils.readText;
    const path = memoryPathFor("session", memoryDir);
    const read = spyOn(MemoryUtils, "readText").mockImplementation(async (file, fallback) => {
      if (file !== path) return actualRead(file, fallback);
      started.resolve();
      return pendingRead.promise;
    });
    const input = snapshot([message("msg_user", "user", "instruction")]);
    const injecting = injection(input);
    try {
      await started.promise;
      if (operation === "reset") {
        expect(
          await createV2MemoryActions(h.context as unknown as V2Context).reset("session", { confirm: true }),
        ).toContain("reset: completed");
      } else lifetime.abort();
      pendingRead.resolve(memory);
      await injecting;
      expect(input.system).toHaveLength(0);
    } finally {
      read.mockRestore();
      pendingRead.resolve(memory);
      await injecting;
    }
  });

  test("summarizes durable visible text despite native synthetic/skill/shell projections looking like users", async () => {
    // OpenCode v2.0.32 toLLMMessage maps these durable records into ordinary
    // role:user text with no synthetic:true marker; idle maps to no message.
    const h = host(directory, [
      user("msg_user", "HUMAN_INSTRUCTION"),
      { id: "msg_synthetic", type: "synthetic", text: "SYNTHETIC_SENTINEL", time: { created: 1 } },
      { id: "msg_skill", type: "skill", skill: "skill", name: "skill", text: "SKILL_SENTINEL", time: { created: 1 } },
      {
        id: "msg_shell",
        type: "shell",
        shellID: "shell",
        command: "echo SHELL_SENTINEL",
        status: "exited",
        time: { created: 1 },
      },
      assistant("msg_answer", "VISIBLE_ANSWER"),
      idle("msg_idle"),
    ]);
    cleanup = await Root.setup(h.context as unknown as V2Context);
    const input = snapshot([
      message("msg_user", "user", "HUMAN_INSTRUCTION"),
      message("msg_synthetic", "user", "SYNTHETIC_SENTINEL"),
      message("msg_skill", "user", "SKILL_SENTINEL"),
      message("msg_shell", "user", "SHELL_SENTINEL"),
      message("msg_answer", "assistant", "VISIBLE_ANSWER"),
    ]);
    const selectedModel = { providerID: "primary-provider", id: "primary-model", variant: "fast" };
    Object.assign(input, { model: selectedModel });
    await h.hooks.get("prompt")!({ sessionID: "session", messageID: "msg_user", prompt: { text: "instruction" } });
    await refresh(h);
    await h.hooks.get("context")!(input);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.model).toBeUndefined();
    expect(h.prompts[0]!.prompt).toContain("HUMAN_INSTRUCTION");
    expect(h.prompts[0]!.prompt).toContain("VISIBLE_ANSWER");
    for (const sentinel of ["SYNTHETIC_SENTINEL", "SKILL_SENTINEL", "SHELL_SENTINEL"]) {
      expect(h.prompts[0]!.prompt).not.toContain(sentinel);
    }
    expect(await readText(checkpointPathFor("session", memoryDir))).toBe("msg_answer\n");
    expect(JSON.stringify(input.system)).toContain("SAVED_MEMORY_SENTINEL");
  });

  test("native idle reset anchor admits only new durable users and preserves cadence through tool continuations", async () => {
    const h = host(directory, [
      user("msg_old", "PRE_RESET_SENTINEL"),
      assistant("msg_old_answer", "old answer"),
      idle("msg_reset"),
    ]);
    cleanup = await Root.setup(h.context as unknown as V2Context);
    await h.hooks.get("prompt")!({ sessionID: "session", messageID: "msg_old", prompt: { text: "old instruction" } });
    expect(
      await createV2MemoryActions(h.context as unknown as V2Context).reset("session", { confirm: true }),
    ).toContain("reset: completed");
    h.setRecords([
      user("msg_old", "PRE_RESET_SENTINEL"),
      assistant("msg_old_answer", "old answer"),
      idle("msg_reset"),
      user("msg_new", "POST_RESET_SENTINEL"),
      assistant("msg_new_answer", "new answer"),
    ]);
    await h.hooks.get("prompt")!({ sessionID: "session", messageID: "msg_new", prompt: { text: "new instruction" } });
    await refresh(h);
    const input = snapshot([
      message("msg_old", "user", "PRE_RESET_SENTINEL"),
      message("msg_new", "user", "POST_RESET_SENTINEL"),
    ]);
    await h.hooks.get("context")!(input);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.prompt).toContain("POST_RESET_SENTINEL");
    expect(h.prompts[0]!.prompt).not.toContain("PRE_RESET_SENTINEL");
    expect(JSON.stringify(input.system)).toContain("SAVED_MEMORY_SENTINEL");
    const continuation = snapshot(input.messages as ReturnType<typeof message>[]);
    await h.hooks.get("context")!(continuation);
    expect(h.prompts).toHaveLength(1);
    expect(JSON.stringify(continuation.system)).toContain("SAVED_MEMORY_SENTINEL");
    const stale = snapshot([message("msg_old", "user", "PRE_RESET_SENTINEL")]);
    await h.hooks.get("context")!(stale);
    expect(stale.system).toHaveLength(0);
  });

  test("an actual outstanding clean updater does not suppress existing memory for a primary request", async () => {
    const h = host(directory, [user("msg_user", "instruction"), assistant("msg_answer", "answer")]);
    const started = deferred<void>();
    const generation = deferred<{ text: string }>();
    h.context.generate.text = async (input) => {
      h.prompts.push(input);
      started.resolve();
      return generation.promise;
    };
    await writeText(memoryPathFor("session", memoryDir), memory);
    cleanup = await Root.setup(h.context as unknown as V2Context);
    await h.hooks.get("prompt")!({ sessionID: "session", messageID: "msg_user", prompt: { text: "instruction" } });
    const running = refresh(h);
    await started.promise;
    const concurrent = snapshot([message("msg_user", "user", "instruction")]);
    try {
      await h.hooks.get("context")!(concurrent);
      expect(h.prompts).toHaveLength(1);
      expect(JSON.stringify(concurrent.system)).toContain("SAVED_MEMORY_SENTINEL");
    } finally {
      generation.resolve({ text: memory });
      await running;
    }
  });

  test("native command Update is aborted on plugin cleanup and ignores a late provider result", async () => {
    const h = host(directory, [user("msg_user", "instruction"), assistant("msg_answer", "answer")]);
    const started = deferred<void>();
    const generation = deferred<{ text: string }>();
    let signal: AbortSignal | undefined;
    h.context.generate.text = async (_input, request) => {
      signal = request?.signal;
      started.resolve();
      return generation.promise;
    };
    cleanup = await Root.setup(h.context as unknown as V2Context);
    const result = h
      .action({ requestID: "update-test", sessionID: "session", action: "update" })
      .catch((error: Error) => error.message);
    await started.promise;
    await cleanup();
    cleanup = undefined;
    expect(signal?.aborted).toBe(true);
    expect(await result).toContain("disposed");
    generation.resolve({ text: memory });
    await generation.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await readText(memoryPathFor("session", memoryDir))).not.toContain("SAVED_MEMORY_SENTINEL");
    expect(await readText(checkpointPathFor("session", memoryDir))).toBe("");
  });

  test("native Reset waiting for its snapshot cannot mutate after plugin cleanup", async () => {
    const records = [user("msg_user", "instruction"), assistant("msg_answer", "answer"), idle("msg_idle")];
    const h = host(directory, records);
    const started = deferred<void>();
    const history = deferred<unknown[]>();
    h.context.session.context = async () => {
      started.resolve();
      return history.promise;
    };
    const paths = [
      memoryPathFor("session", memoryDir),
      checkpointPathFor("session", memoryDir),
      resetBoundaryPathFor("session", memoryDir),
    ];
    await writeText(paths[0]!, memory);
    await writeText(paths[1]!, "msg_original\n");
    await writeText(paths[2]!, '{"version":1,"anchorID":"msg_original"}\n');
    const before = await Promise.all(paths.map(readRawFile));
    cleanup = await Root.setup(h.context as unknown as V2Context);
    const result = h
      .action({
        requestID: "reset-test",
        sessionID: "session",
        action: "reset",
        confirm: true,
      })
      .catch((error: Error) => error.message);
    await started.promise;
    await cleanup();
    cleanup = undefined;
    expect(await result).toContain("disposed");
    history.resolve(records);
    // Wait behind the actual reset owner, rather than sleeping for persistence.
    await withV2MemoryMutation(directory, "session", () => undefined);
    expect(await Promise.all(paths.map(readRawFile))).toEqual(before);
  });

  test("reset abort after a conditional commit restores prior memory, checkpoint and boundary", async () => {
    const paths = [
      memoryPathFor("session", memoryDir),
      checkpointPathFor("session", memoryDir),
      resetBoundaryPathFor("session", memoryDir),
    ];
    await writeText(paths[0]!, memory);
    await writeText(paths[1]!, "msg_original\n");
    await writeText(paths[2]!, '{"version":1,"anchorID":"msg_original"}\n');
    const before = await Promise.all(paths.map(readRawFile));
    const lifetime = new AbortController();
    const prepare = MemoryUtils.prepareRawFile;
    let aborted = false;
    const pause = spyOn(MemoryUtils, "prepareRawFile").mockImplementation(async (path, bytes) => {
      const prepared = await prepare(path, bytes);
      return {
        ...prepared,
        commit: async (expected) => {
          const committed = await prepared.commit(expected);
          if (path === paths[0] && committed && !aborted) {
            aborted = true;
            lifetime.abort();
          }
          return committed;
        },
      };
    });
    try {
      await expect(
        resetV2MemoryPersistence("session", directory, "msg_reset", { memoryDir }, undefined, lifetime.signal),
      ).rejects.toThrow();
      expect(aborted).toBe(true);
      expect(await Promise.all(paths.map(readRawFile))).toEqual(before);
    } finally {
      pause.mockRestore();
    }
  });

  test("a memory read started during reset cannot publish its old snapshot after reset completes", async () => {
    const h = host(directory, []);
    const resetStarted = deferred<void>();
    const commit = deferred<void>();
    const resetting = resetV2MemoryPersistence(
      "session",
      directory,
      "msg_reset",
      { memoryDir },
      {
        beforeCommit: async (kind) => {
          if (kind === "memory") {
            resetStarted.resolve();
            await commit.promise;
          }
        },
      },
    );
    await resetStarted.promise;
    const readStarted = deferred<void>();
    const value = deferred<string>();
    const actualRead = MemoryUtils.readText;
    const path = memoryPathFor("session", memoryDir);
    const read = spyOn(MemoryUtils, "readText").mockImplementation(async (file, fallback) => {
      if (file !== path) return actualRead(file, fallback);
      readStarted.resolve();
      return value.promise;
    });
    const input = snapshot([]);
    const injecting = createV2ContextInjection(h.context as unknown as V2Context, directory)(input);
    try {
      await readStarted.promise;
      commit.resolve();
      await resetting;
      value.resolve(memory);
      await injecting;
      expect(input.system).toHaveLength(0);
    } finally {
      read.mockRestore();
      commit.resolve();
      value.resolve(memory);
      await resetting;
      await injecting;
    }
  });

  test.each(["show", "setup"] as const)("disposed actions cannot start %s creation", async (action) => {
    const h = host(directory, []);
    const lifetime = new AbortController();
    const actions = createV2MemoryActions(h.context as unknown as V2Context, lifetime.signal);
    lifetime.abort();
    const pending = action === "show" ? actions.show("session") : actions.setup("session", { confirm: true });
    await expect(pending).rejects.toThrow();
    expect(await readRawFile(memoryPathFor("session", memoryDir))).toBeNull();
  });
});
