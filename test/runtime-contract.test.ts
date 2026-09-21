import { describe, expect, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import type { RuntimeCapabilities, RuntimeContract } from "../src/runtime-contract";
import { RuntimeCapabilityError } from "../src/runtime-contract";
import { createV1RuntimeContractFixture, type V1RuntimeContractFixture } from "./runtime-contract-v1-fixture";

type SessionMethod = "abort" | "create" | "delete" | "get" | "list" | "messages" | "prompt";

const expectedCapabilities = {
  readSessionMetadata: true,
  readSessionHistory: true,
  readSessionMessages: true,
  readSessionContext: false,
  deliverGeneratedPrompt: true,
  deliverContextNoReply: true,
  createTemporarySession: true,
  abortTemporarySession: true,
  deleteTemporarySession: true,
  deleteTemporarySessionForCleanup: true,
  listTemporarySessions: true,
  getTemporarySession: true,
  registerSystemContextMutation: true,
  registerCompactionMutation: true,
  registerTool: true,
  registerCommand: true,
  dispose: true,
} as const satisfies RuntimeCapabilities;

function createFakeInput() {
  const calls: Record<SessionMethod, unknown[]> = {
    abort: [],
    create: [],
    delete: [],
    get: [],
    list: [],
    messages: [],
    prompt: [],
  };
  const responses: Record<SessionMethod, unknown> = {
    abort: {},
    create: { data: { id: "created", parentID: "parent", title: "Created", retained: 1 } },
    delete: {},
    get: { data: { id: "session", parentID: "parent", title: "Session", retained: 2 } },
    list: {
      data: [
        { id: "child-a", parentID: "parent", title: "A" },
        { id: "child-b", parentID: "other", title: "B" },
        { id: "root", title: "Root" },
      ],
    },
    messages: { data: [{ info: { id: "message" }, parts: [] }] },
    prompt: {},
  };

  const session = Object.fromEntries(
    (Object.keys(calls) as SessionMethod[]).map((method) => [
      method,
      async (request?: unknown) => {
        calls[method].push(request);
        return responses[method];
      },
    ]),
  );
  const input = {
    client: { session },
    directory: "/repo",
    worktree: "/repo-worktree",
    serverUrl: new URL("http://127.0.0.1:4096"),
  } as unknown as PluginInput;

  return {
    calls,
    input,
    respond(method: SessionMethod, response: unknown) {
      responses[method] = response;
    },
  };
}

function createFixture() {
  const fake = createFakeInput();
  const runtime: V1RuntimeContractFixture = createV1RuntimeContractFixture(fake.input);
  const contract: RuntimeContract = runtime;
  void contract;
  return { fake, runtime };
}

describe("runtime contract V1 conformance", () => {
  test("exposes immutable exact capabilities and normalized runtime identity", () => {
    const { runtime } = createFixture();

    expect(runtime.capabilities).toEqual(expectedCapabilities);
    expect(Object.keys(runtime.capabilities)).toEqual(Object.keys(expectedCapabilities));
    expect(Object.isFrozen(runtime.capabilities)).toBe(true);
    expect(runtime.identity).toEqual({
      generation: "v1",
      location: {
        directory: "/repo",
        worktree: "/repo-worktree",
        serverUrl: "http://127.0.0.1:4096/",
      },
    });
    expect(Object.isFrozen(runtime.identity)).toBe(true);
    expect(Object.isFrozen(runtime.identity.location)).toBe(true);
    expect(runtime.config).toEqual({ options: undefined });
    expect(Object.isFrozen(runtime.config)).toBe(true);
  });

  test("delegates metadata and history reads and normalizes parentID", async () => {
    const { fake, runtime } = createFixture();

    const metadata = await runtime.readSessionMetadata("metadata-id");
    expect(fake.calls.get).toEqual([{ path: { id: "metadata-id" } }]);
    expect(metadata).toEqual({ id: "session", parentId: "parent", title: "Session", retained: 2 });
    expect(metadata).not.toHaveProperty("parentID");
    expect(Object.isFrozen(metadata)).toBe(true);

    const history = await runtime.readSessionHistory("history-id");
    expect(fake.calls.get[1]).toEqual({ path: { id: "history-id" } });
    expect(fake.calls.messages).toEqual([{ path: { id: "history-id" } }]);
    expect(history.session).toEqual({ id: "session", parentId: "parent", title: "Session", retained: 2 });
    expect(history.messages as readonly unknown[]).toEqual([{ info: { id: "message" }, parts: [] }]);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history.messages)).toBe(true);
  });

  test("delegates message reads with an optional limit without reading session metadata", async () => {
    const { fake, runtime } = createFixture();
    const messages = [{ info: { id: "message" }, parts: [] }];
    fake.respond("messages", { data: messages });

    const withoutLimit = await runtime.readSessionMessages("messages-id");
    const withLimit = await runtime.readSessionMessages("limited-messages-id", { limit: 7 });

    expect(fake.calls.messages).toEqual([
      { path: { id: "messages-id" } },
      { path: { id: "limited-messages-id" }, query: { limit: 7 } },
    ]);
    expect(fake.calls.get).toEqual([]);
    expect(withoutLimit).toEqual(messages);
    expect(withoutLimit).not.toBe(messages);
    expect(withLimit).toEqual(messages);
    expect(withLimit).not.toBe(messages);
    expect(Object.isFrozen(withoutLimit)).toBe(true);
    expect(Object.isFrozen(withLimit)).toBe(true);
  });

  test("delegates prompt delivery with exact generated and noReply payloads", async () => {
    const { fake, runtime } = createFixture();
    const generated = { parts: [{ type: "text", text: "generated" }] } satisfies Parameters<
      typeof runtime.deliverGeneratedPrompt
    >[0]["prompt"];
    const generatedResponse = { data: { id: "generated-response" } };
    const controller = new AbortController();
    const context = { parts: [{ type: "text", text: "context" }] } satisfies Parameters<
      typeof runtime.deliverContextNoReply
    >[0]["context"];
    fake.respond("prompt", generatedResponse);

    await expect(
      runtime.deliverGeneratedPrompt({ sessionId: "generated-id", prompt: generated, signal: controller.signal }),
    ).resolves.toBe(generatedResponse);
    await runtime.deliverContextNoReply({ sessionId: "context-id", context, noReply: true });

    expect(fake.calls.prompt).toEqual([
      { path: { id: "generated-id" }, body: generated, signal: controller.signal },
      { path: { id: "context-id" }, body: { ...context, noReply: true } },
    ]);
    expect(fake.calls.prompt[0]).not.toHaveProperty("body.signal");
    expect(fake.calls.prompt[1]).toEqual({ path: { id: "context-id" }, body: { ...context, noReply: true } });
  });

  test("delegates temporary session lifecycle and filters list locally", async () => {
    const { fake, runtime } = createFixture();

    expect(await runtime.createTemporarySession({ parentId: "parent", options: { title: "Temporary" } })).toEqual({
      id: "created",
      parentId: "parent",
      title: "Created",
      retained: 1,
    });
    await runtime.abortTemporarySession({ id: "abort-id" });
    await runtime.deleteTemporarySession({ id: "delete-id" });
    const filtered = await runtime.listTemporarySessions({ parentId: "parent" });
    const all = await runtime.listTemporarySessions({});
    expect(await runtime.getTemporarySession({ id: "get-id" })).toEqual({
      id: "session",
      parentId: "parent",
      title: "Session",
      retained: 2,
    });

    expect(fake.calls.create).toEqual([{ body: { title: "Temporary", parentID: "parent" } }]);
    expect(fake.calls.abort).toEqual([{ path: { id: "abort-id" } }]);
    expect(fake.calls.delete).toEqual([{ path: { id: "delete-id" } }]);
    expect(fake.calls.list).toEqual([undefined, undefined]);
    expect(fake.calls.get).toEqual([{ path: { id: "get-id" } }]);
    expect(filtered).toEqual([{ id: "child-a", parentId: "parent", title: "A" }]);
    expect(all).toEqual([
      { id: "child-a", parentId: "parent", title: "A" },
      { id: "child-b", parentId: "other", title: "B" },
      { id: "root", title: "Root" },
    ]);
    expect(Object.isFrozen(filtered)).toBe(true);
    expect(Object.isFrozen(all)).toBe(true);
  });

  test("returns frozen cleanup deletion outcomes with exact request and error identity", async () => {
    const success = createFixture();

    const deleted = await success.runtime.deleteTemporarySessionForCleanup({ id: "cleanup-id" });

    expect(success.fake.calls.delete).toEqual([{ path: { id: "cleanup-id" } }]);
    expect(deleted).toEqual({ deleted: true });
    expect(Object.isFrozen(deleted)).toBe(true);

    const resolvedError = createFixture();
    const error = { code: "already-gone" };
    resolvedError.fake.respond("delete", { error });

    const failed = await resolvedError.runtime.deleteTemporarySessionForCleanup({ id: "resolved-error-id" });

    expect(resolvedError.fake.calls.delete).toEqual([{ path: { id: "resolved-error-id" } }]);
    expect(failed).toEqual({ deleted: false, error });
    expect(failed.error).toBe(error);
    expect(Object.isFrozen(failed)).toBe(true);

    const rejected = createFixture();
    const rejection = new Error("SDK rejection");
    rejected.fake.respond("delete", Promise.reject(rejection));

    await expect(rejected.runtime.deleteTemporarySessionForCleanup({ id: "rejected-id" })).rejects.toBe(rejection);
    expect(rejected.fake.calls.delete).toEqual([{ path: { id: "rejected-id" } }]);
  });

  test("normalizes envelope and bare-array session lists with optional parent filtering", async () => {
    const envelope = createFixture();
    const envelopeRows = [
      { id: "child", parentID: "parent", title: "Child" },
      { id: "root", title: "Root" },
    ];
    envelope.fake.respond("list", { data: envelopeRows });

    const filtered = await envelope.runtime.listTemporarySessions({ parentId: "parent" });

    expect(envelope.fake.calls.list).toEqual([undefined]);
    expect(filtered).toEqual([{ id: "child", parentId: "parent", title: "Child" }]);
    expect(Object.isFrozen(filtered)).toBe(true);
    expect(Object.isFrozen(filtered[0])).toBe(true);

    const bareArray = createFixture();
    const bareRows = [
      { id: "child-a", parentID: "parent", title: "A" },
      { id: "child-b", parentID: "other", title: "B" },
    ];
    bareArray.fake.respond("list", bareRows as unknown);

    const all = await bareArray.runtime.listTemporarySessions({});

    expect(bareArray.fake.calls.list).toEqual([undefined]);
    expect(all).toEqual([
      { id: "child-a", parentId: "parent", title: "A" },
      { id: "child-b", parentId: "other", title: "B" },
    ]);
    expect(Object.isFrozen(all)).toBe(true);
    expect(Object.isFrozen(all[0])).toBe(true);
    expect(Object.isFrozen(all[1])).toBe(true);
  });

  test("propagates resolved SDK errors for every delegated operation", async () => {
    const cases: readonly [SessionMethod, (runtime: V1RuntimeContractFixture) => Promise<unknown>][] = [
      ["get", (runtime) => runtime.readSessionMetadata("id")],
      ["messages", (runtime) => runtime.readSessionHistory("id")],
      ["messages", (runtime) => runtime.readSessionMessages("id", { limit: 2 })],
      ["prompt", (runtime) => runtime.deliverGeneratedPrompt({ sessionId: "id", prompt: { parts: [] } })],
      [
        "prompt",
        (runtime) => runtime.deliverContextNoReply({ sessionId: "id", context: { parts: [] }, noReply: true }),
      ],
      ["create", (runtime) => runtime.createTemporarySession({})],
      ["abort", (runtime) => runtime.abortTemporarySession({ id: "id" })],
      ["delete", (runtime) => runtime.deleteTemporarySession({ id: "id" })],
      ["list", (runtime) => runtime.listTemporarySessions({})],
      ["get", (runtime) => runtime.getTemporarySession({ id: "id" })],
    ];

    for (const [method, invoke] of cases) {
      const { fake, runtime } = createFixture();
      const error = new Error(`${method} resolved error`);
      fake.respond(method, { error });
      await expect(invoke(runtime)).rejects.toBe(error);
    }
  });

  test("reports unsupported session context with exact capability and operation", async () => {
    const { runtime } = createFixture();

    try {
      await runtime.readSessionContext("session-id");
      throw new Error("readSessionContext unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeCapabilityError);
      expect(error).toMatchObject({
        name: "RuntimeCapabilityError",
        capability: "readSessionContext",
        operation: "session.context",
        message: 'Runtime capability "readSessionContext" does not support operation "session.context".',
      });
    }
  });

  test("collects registrations and supports individual, aggregate, and post-disposal behavior", async () => {
    const { runtime } = createFixture();
    const systemCalls: unknown[] = [];
    const compactionCalls: unknown[] = [];
    const systemMutation = (input: unknown, output: unknown) => {
      systemCalls.push([input, output]);
    };
    const compactionMutation = async (input: unknown, output: unknown) => {
      compactionCalls.push([input, output]);
    };
    const toolDefinition = { description: "tool", args: {}, execute: async () => "result" } as never;
    const commandDefinition = { description: "command", template: "run" };

    const systemDisposer = await runtime.registerSystemContextMutation(systemMutation);
    const compactionDisposer = await runtime.registerCompactionMutation(compactionMutation);
    const toolDisposer = await runtime.registerTool({ name: "test_tool", definition: toolDefinition });
    const commandDisposer = await runtime.registerCommand({ name: "test.command", definition: commandDefinition });

    expect(runtime.registrations.systemContextMutations).toEqual([systemMutation]);
    expect(runtime.registrations.compactionMutations).toEqual([compactionMutation]);
    expect(runtime.registrations.tools).toEqual([{ name: "test_tool", definition: toolDefinition }]);
    expect(runtime.registrations.commands).toEqual([{ name: "test.command", definition: commandDefinition }]);
    expect(Object.isFrozen(runtime.registrations.systemContextMutations)).toBe(true);
    expect(Object.isFrozen(runtime.registrations.tools[0])).toBe(true);

    await runtime.registrations.systemContextMutations[0]("system-input", "system-output");
    await runtime.registrations.compactionMutations[0]("compaction-input", "compaction-output");
    expect(systemCalls).toEqual([["system-input", "system-output"]]);
    expect(compactionCalls).toEqual([["compaction-input", "compaction-output"]]);

    await systemDisposer.dispose();
    await toolDisposer.dispose();
    await systemDisposer.dispose();
    await toolDisposer.dispose();
    expect(runtime.registrations.systemContextMutations).toEqual([]);
    expect(runtime.registrations.compactionMutations).toEqual([compactionMutation]);
    expect(runtime.registrations.tools).toEqual([]);
    expect(runtime.registrations.commands).toHaveLength(1);

    await runtime.dispose();
    expect(runtime.registrations.systemContextMutations).toEqual([]);
    expect(runtime.registrations.compactionMutations).toEqual([]);
    expect(runtime.registrations.tools).toEqual([]);
    expect(runtime.registrations.commands).toEqual([]);

    await compactionDisposer.dispose();
    await commandDisposer.dispose();
    const postDisposeMutation = () => {};
    const postDisposeDisposer = await runtime.registerSystemContextMutation(postDisposeMutation);
    expect(runtime.registrations.systemContextMutations).toEqual([postDisposeMutation]);
    await postDisposeDisposer.dispose();
    expect(runtime.registrations.systemContextMutations).toEqual([]);
  });
});
