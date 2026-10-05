import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session";
import type { Info as ToolDefinition } from "@opencode/plugin/promise/tool";
import type { V2Context } from "../src/v2-adapter";
import { createV2Adapter, createV2RuntimeContract } from "../src/v2-adapter";
import { RuntimeCapabilityError, type RuntimeDisposer } from "../src/runtime-contract";
import RootDefault, { SessionMemoryPlugin as RootNamed } from "../index";
import SrcDefault, { SessionMemoryPlugin as SrcNamed } from "../src";
import { deferred } from "./async-helpers";

function createContext() {
  const hooks: { name: string; callback: (input: unknown) => unknown }[] = [];
  const transforms: { kind: "tool" | "command"; callback: (editor: unknown) => void }[] = [];
  const context = {
    location: {
      directory: "/workspace/current",
      workspaceID: "workspace-1",
      project: { id: "project-1", directory: "/workspace", canonical: "/workspace/canonical" },
    },
    options: { enabled: true },
    session: {
      hook: async (name: string, callback: (input: unknown) => unknown) => {
        hooks.push({ name, callback });
        return { dispose: async () => undefined };
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push({ kind: "tool", callback });
        return { dispose: async () => undefined };
      },
    },
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push({ kind: "command", callback });
        return { dispose: async () => undefined };
      },
    },
    rpc: { register: async () => ({ events: { emit: async () => undefined }, dispose: async () => undefined }) },
  };
  return { context: context as unknown as V2Context, hooks, transforms };
}

const toolInput = Schema.Struct({});
const toolDefinition = {
  name: "stm_tool",
  input: toolInput,
  description: "test tool",
  execute: () => Effect.succeed({}),
} satisfies ToolDefinition;
const commandDefinition = {
  name: "stm_command",
  description: "test command",
  execute: async () => undefined,
} satisfies CommandDefinition;

describe("V2 adapter", () => {
  test("advertises the exact frozen capability and identity/config snapshots", () => {
    const { context } = createContext();
    const runtime = createV2RuntimeContract(context);

    expect(runtime.capabilities).toEqual({
      readSessionMetadata: false,
      readSessionHistory: false,
      readSessionMessages: false,
      readSessionContext: false,
      deliverGeneratedPrompt: false,
      deliverContextNoReply: false,
      createTemporarySession: false,
      abortTemporarySession: false,
      deleteTemporarySession: false,
      deleteTemporarySessionForCleanup: false,
      listTemporarySessions: false,
      getTemporarySession: false,
      registerSystemContextMutation: true,
      registerCompactionMutation: true,
      registerTool: true,
      registerCommand: true,
      dispose: true,
    });
    expect(Object.isFrozen(runtime.capabilities)).toBe(true);
    expect(runtime.identity).toEqual({
      generation: "v2",
      location: {
        directory: "/workspace/current",
        workspaceID: "workspace-1",
        project: { id: "project-1", directory: "/workspace", canonical: "/workspace/canonical" },
      },
    });
    expect(Object.isFrozen(runtime.identity)).toBe(true);
    expect(Object.isFrozen(runtime.identity.location)).toBe(true);
    expect(Object.isFrozen(runtime.identity.location.project)).toBe(true);
    expect(runtime.config).toEqual({ options: context.options });
    expect(Object.isFrozen(runtime.config)).toBe(true);
    expect(runtime.config.options).toBe(context.options);
    const typed: typeof runtime = runtime;
    expect(typed).toBe(runtime);
  });

  test("rejects every unsupported operation with stable typed diagnostics", async () => {
    const { context } = createContext();
    const runtime = createV2RuntimeContract(context);
    const unsupported = [
      ["readSessionMetadata", "session.get", () => runtime.readSessionMetadata("s")],
      ["readSessionHistory", "session.messages", () => runtime.readSessionHistory("s")],
      ["readSessionMessages", "session.messages", () => runtime.readSessionMessages("s")],
      ["readSessionContext", "session.context", () => runtime.readSessionContext("s")],
      ["deliverGeneratedPrompt", "session.prompt", () => runtime.deliverGeneratedPrompt({} as never)],
      ["deliverContextNoReply", "session.prompt.noReply", () => runtime.deliverContextNoReply({} as never)],
      ["createTemporarySession", "session.create.parent", () => runtime.createTemporarySession({})],
      ["abortTemporarySession", "session.interrupt", () => runtime.abortTemporarySession({ id: "s" })],
      ["deleteTemporarySession", "session.remove", () => runtime.deleteTemporarySession({ id: "s" })],
      [
        "deleteTemporarySessionForCleanup",
        "session.remove.cleanup",
        () => runtime.deleteTemporarySessionForCleanup({ id: "s" }),
      ],
      ["listTemporarySessions", "session.list", () => runtime.listTemporarySessions({})],
      ["getTemporarySession", "session.get", () => runtime.getTemporarySession({ id: "s" })],
    ] as const;

    for (const [capability, operation, call] of unsupported) {
      const error = await call().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(RuntimeCapabilityError);
      expect(error).toMatchObject({
        name: "RuntimeCapabilityError",
        capability,
        operation,
        message: `Runtime capability "${capability}" does not support operation "${operation}".`,
      });
    }
  });

  test("registers exact hook names and preserves mutable callback identity", async () => {
    const { context, hooks } = createContext();
    const runtime = createV2RuntimeContract(context);
    let seenContext: SessionContext | undefined;
    let seenCompaction: SessionCompaction | undefined;
    await runtime.registerSystemContextMutation((input) => {
      seenContext = input;
      input.system.push({ type: "text", text: "injected" });
    });
    await runtime.registerCompactionMutation((input) => {
      seenCompaction = input;
      input.result = { summary: "kept" };
    });
    expect(hooks.map(({ name }) => name)).toEqual(["context", "compaction"]);
    const contextInput = { system: [] } as unknown as SessionContext;
    const compactionInput = {} as SessionCompaction;
    await hooks[0]!.callback(contextInput);
    await hooks[1]!.callback(compactionInput);
    expect(seenContext).toBe(contextInput);
    expect(seenCompaction).toBe(compactionInput);
    expect(contextInput.system).toEqual([{ type: "text", text: "injected" }]);
    expect(compactionInput.result).toEqual({ summary: "kept" });
  });

  test("adds exact tool/command definitions and rejects mismatched names before host calls", async () => {
    const { context, transforms } = createContext();
    const runtime = createV2RuntimeContract(context);
    const toolEditor = {
      added: [] as unknown[],
      add(definition: unknown) {
        this.added.push(definition);
      },
    };
    const commandEditor = {
      added: [] as unknown[],
      add(definition: unknown) {
        this.added.push(definition);
      },
    };
    await runtime.registerTool({ name: toolDefinition.name, definition: toolDefinition });
    await runtime.registerCommand({ name: commandDefinition.name, definition: commandDefinition });
    transforms[0]!.callback(toolEditor);
    transforms[1]!.callback(commandEditor);
    expect(toolEditor.added).toEqual([toolDefinition]);
    expect(toolEditor.added[0]).toBe(toolDefinition);
    expect(commandEditor.added).toEqual([commandDefinition]);
    expect(commandEditor.added[0]).toBe(commandDefinition);
    const before = transforms.length;
    expect(() => runtime.registerTool({ name: "wrong", definition: toolDefinition })).toThrow(
      'V2 tool registration name mismatch: "wrong".',
    );
    expect(() => runtime.registerCommand({ name: "wrong", definition: commandDefinition })).toThrow(
      'V2 command registration name mismatch: "wrong".',
    );
    expect(transforms).toHaveLength(before);
  });

  test("individual disposer is idempotent", async () => {
    let disposed = 0;
    const { context } = createContext();
    context.session.hook = async () => ({ dispose: async () => void disposed++ });
    const disposer = await createV2RuntimeContract(context).registerSystemContextMutation(() => undefined);
    await Promise.all([disposer.dispose(), disposer.dispose()]);
    expect(disposed).toBe(1);
  });

  test("concurrent individual and aggregate disposal share one blocked host disposal result", async () => {
    const hostDisposal = deferred<void>();
    let hostDisposals = 0;
    const { context } = createContext();
    context.session.hook = async () => ({
      dispose: async () => {
        hostDisposals++;
        await hostDisposal.promise;
      },
    });
    const runtime = createV2RuntimeContract(context);
    const disposer = await runtime.registerSystemContextMutation(() => undefined);

    const individualDisposal = disposer.dispose();
    const aggregateDisposal = runtime.dispose();
    await Promise.resolve();
    expect(hostDisposals).toBe(1);
    hostDisposal.resolve();

    const results = await Promise.allSettled([individualDisposal, aggregateDisposal]);
    expect(results).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    expect(hostDisposals).toBe(1);
  });

  test("aggregate disposal preserves undefined rejection and continues reverse cleanup", async () => {
    const events: string[] = [];
    const { context } = createContext();
    context.session.hook = async (name) => ({
      dispose: async () => {
        events.push(name);
        if (name === "context") throw undefined;
      },
    });
    const runtime = createV2RuntimeContract(context);
    await runtime.registerSystemContextMutation(() => undefined);
    await runtime.registerCompactionMutation(() => undefined);

    await expect(runtime.dispose()).rejects.toBeUndefined();
    expect(events).toEqual(["compaction", "context"]);
  });

  test("aggregate disposal preserves pending null failure before later reverse-order disposal errors", async () => {
    const pending = deferred<{ dispose: () => Promise<void> }>();
    const events: string[] = [];
    const laterFailure = new Error("later disposal failure");
    const { context } = createContext();
    context.session.hook = async (name) => {
      if (name === "context") return pending.promise;
      return {
        dispose: async () => {
          events.push(name);
          if (name === "compaction") throw laterFailure;
        },
      };
    };
    context.tool.transform = async () => ({
      dispose: async () => {
        events.push("tool");
      },
    });
    const runtime = createV2RuntimeContract(context);
    void runtime.registerSystemContextMutation(() => undefined).catch(() => undefined);
    await runtime.registerCompactionMutation(() => undefined);
    await runtime.registerTool({ name: toolDefinition.name, definition: toolDefinition });
    const disposal = runtime.dispose();
    pending.reject(null);

    await expect(disposal).rejects.toBe(null);
    expect(events).toEqual(["tool", "compaction"]);
  });

  test("aggregate disposal awaits pending registration, reverses order, is idempotent, and reports first failure", async () => {
    const first = deferred<{ dispose: () => Promise<void> }>();
    const events: string[] = [];
    const { context } = createContext();
    context.session.hook = async (name) => {
      if (name === "context") return first.promise;
      return {
        dispose: async () => {
          events.push("second");
          throw new Error("second failure");
        },
      };
    };
    const runtime = createV2RuntimeContract(context);
    void runtime.registerSystemContextMutation(() => undefined);
    await runtime.registerCompactionMutation(() => undefined);
    const disposal = runtime.dispose();
    first.resolve({
      dispose: async () => {
        events.push("first");
        throw new Error("first failure");
      },
    });
    await expect(disposal).rejects.toThrow("second failure");
    await expect(runtime.dispose()).rejects.toThrow("second failure");
    expect(events).toEqual(["second", "first"]);
  });

  test("registration rejection is surfaced while acquired registrations still dispose in entry order accounting", async () => {
    const failure = new Error("registration failure");
    let disposed = 0;
    const { context } = createContext();
    context.session.hook = async (name) =>
      name === "context" ? Promise.reject(failure) : { dispose: async () => void disposed++ };
    const runtime = createV2RuntimeContract(context);
    void runtime.registerSystemContextMutation(() => undefined).catch(() => undefined);
    await runtime.registerCompactionMutation(() => undefined);
    await expect(runtime.dispose()).rejects.toBe(failure);
    expect(disposed).toBe(1);
  });

  test("rejects new registrations after aggregate disposal starts before host calls", async () => {
    const pending = deferred<{ dispose: () => Promise<void> }>();
    let hostCalls = 0;
    const { context } = createContext();
    context.session.hook = async () => {
      hostCalls++;
      return pending.promise;
    };
    const runtime = createV2RuntimeContract(context);
    void runtime.registerSystemContextMutation(() => undefined);
    const disposal = runtime.dispose();
    expect(() => runtime.registerCompactionMutation(() => undefined)).toThrow("V2 runtime disposal has begun.");
    expect(hostCalls).toBe(1);
    pending.resolve({ dispose: async () => undefined });
    await disposal;
  });

  test("returns a frozen adapter and delegates disposal", async () => {
    const { context } = createContext();
    const adapter = createV2Adapter(context);
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(adapter.runtime.identity.generation).toBe("v2");
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });

  test("exports one dual loader with isolated V1 and registration-only V2 entrypoints", async () => {
    const { context, hooks, transforms } = createContext();
    const contextRegistration = deferred<{ dispose: () => Promise<void> }>();
    const compactionRegistration = deferred<{ dispose: () => Promise<void> }>();
    const compactionAttempted = deferred<void>();
    const hostDisposals: string[] = [];
    context.session.hook = async (name, callback) => {
      hooks.push({ name, callback });
      if (name === "context") return contextRegistration.promise;
      compactionAttempted.resolve();
      return compactionRegistration.promise;
    };

    expect(RootDefault).toBe(SrcDefault);
    expect(Object.keys(RootDefault)).toEqual(["id", "server", "setup"]);
    expect(RootDefault.id).toBe("opencode-short-term-memory");
    expect(RootDefault.server).toBe(RootNamed);
    expect(RootNamed).toBe(SrcNamed);
    expect(typeof RootNamed).toBe("function");

    let setupResolved = false;
    const setup = RootDefault.setup(context);
    void setup.then(() => {
      setupResolved = true;
    });
    await Promise.resolve();

    expect(setupResolved).toBe(false);
    expect(hooks.map(({ name }) => name)).toEqual(["context"]);
    expect(transforms).toHaveLength(0);

    contextRegistration.resolve({
      dispose: async () => {
        hostDisposals.push("context");
      },
    });
    await compactionAttempted.promise;
    expect(setupResolved).toBe(false);
    expect(hooks.map(({ name }) => name)).toEqual(["context", "compaction"]);
    expect(transforms).toHaveLength(0);

    compactionRegistration.resolve({
      dispose: async () => {
        hostDisposals.push("compaction");
      },
    });
    const cleanup = await setup;
    expect(typeof cleanup).toBe("function");
    expect(transforms).toHaveLength(8);
    expect(transforms.map(({ kind }) => kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "command",
    ]);
    await expect(cleanup()).resolves.toBeUndefined();
    await expect(cleanup()).resolves.toBeUndefined();
    expect(hostDisposals).toEqual(["compaction", "context"]);
  });

  test("dual-loader setup preserves context registration rejection without attempting compaction", async () => {
    const failure = new Error("context registration failure");
    const { context, hooks, transforms } = createContext();
    context.session.hook = async (name, callback) => {
      hooks.push({ name, callback });
      throw failure;
    };

    await expect(RootDefault.setup(context)).rejects.toBe(failure);
    expect(hooks.map(({ name }) => name)).toEqual(["context"]);
    expect(transforms).toHaveLength(0);
  });

  test("dual-loader setup disposes acquired context and preserves compaction registration rejection", async () => {
    const failure = new Error("compaction registration failure");
    const { context, hooks, transforms } = createContext();
    let contextDisposals = 0;
    context.session.hook = async (name, callback) => {
      hooks.push({ name, callback });
      if (name === "compaction") throw failure;
      return { dispose: async () => void contextDisposals++ };
    };

    await expect(RootDefault.setup(context)).rejects.toBe(failure);
    expect(hooks.map(({ name }) => name)).toEqual(["context", "compaction"]);
    expect(transforms).toHaveLength(0);
    expect(contextDisposals).toBe(1);
  });

  const _disposerConformance: RuntimeDisposer = { dispose: async () => undefined };
  void _disposerConformance;
  const _contextConformance: Context | V2Context = {} as V2Context;
  void _contextConformance;
});
