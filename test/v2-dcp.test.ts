import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V2Context } from "../src/v2-adapter";
import { captureV2ChildMemoryAtCreation, getV2ChildSystemDelivery } from "../src/v2-child-memory";
import { createV2ContextInjection } from "../src/v2-context-injection";
import { registerV2DcpCompletion } from "../src/v2-dcp";
import { MEMORY_HEADER, STANDARD_MEMORY_TEMPLATE, memoryPathFor, writeText } from "../src/memory-utils";
import { resetV2MemoryPersistence } from "../src/v2-reset-persistence";
import { deleteV2SessionMemory } from "../src/v2-session-deletion";
import { deferred } from "./async-helpers";

type NativeEvent = {
  tool: string;
  sessionID: string;
  messageID: string;
  id: string;
  status: "completed" | "error";
};
type Hook = (event: NativeEvent) => void | Promise<void>;
type SyntheticCall = Record<string, unknown>;
type SyntheticOptions = { readonly signal?: AbortSignal };

const directories: string[] = [];
const memory = `${MEMORY_HEADER}\n\n### User Instructions\n- preserved\n`;
const model = { providerID: "provider", id: "model" };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "stm-v2-dcp-"));
  directories.push(directory);
  const memoryDir = join(directory, ".opencode", "memory");
  await mkdir(join(directory, ".opencode"), { recursive: true });
  await writeFile(
    join(directory, ".opencode", "stm.json"),
    JSON.stringify({ enabled: true, memoryDir, debounceMs: 100, injectInSubagents: true }),
  );
  return { directory, memoryDir };
}

function makeContext(
  directory: string,
  options: {
    parentID?: string | null;
    metadata?: Record<string, unknown>;
    toolHook?: boolean;
    synthetic?: (input: SyntheticCall, request?: SyntheticOptions) => Promise<void>;
  } = {},
) {
  let handler: Hook | undefined;
  let hookDisposed = false;
  const synthetics: SyntheticCall[] = [];
  const messages = [
    { id: "msg_user", type: "user", time: { created: 1 }, text: "question" },
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model,
      time: { created: 2, completed: 3 },
      content: [{ type: "text", text: "answer" }],
    },
  ];
  const context = {
    location: { directory, project: { id: "project", directory, canonical: directory } },
    options: {},
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: options.parentID ?? null,
        model,
        metadata: options.metadata ?? {},
      }),
      context: async () => messages,
      synthetic: async (input: SyntheticCall, request?: SyntheticOptions) => {
        synthetics.push(input);
        await options.synthetic?.(input, request);
      },
    },
    tool:
      options.toolHook === false
        ? {}
        : {
            hook: async (name: string, callback: Hook) => {
              if (name !== "execute.after") throw new Error(`unexpected_hook:${name}`);
              handler = callback;
              return {
                async dispose() {
                  hookDisposed = true;
                  handler = undefined;
                },
              };
            },
          },
  } as unknown as V2Context;
  return {
    context,
    synthetics,
    setAssistantText(text: string) {
      const assistant = messages[1] as { content: Array<{ text: string }> };
      assistant.content[0]!.text = text;
    },
    get hookDisposed() {
      return hookDisposed;
    },
    async emit(event: NativeEvent) {
      await handler?.(event);
    },
  };
}

function completed(sessionID: string, id = "call_compress_1"): NativeEvent {
  return { tool: "compress", sessionID, messageID: "msg_assistant", id, status: "completed" };
}

const updateResult = {
  status: "committed" as const,
  checkpointedChunks: 1,
  checkpointedMessages: 1,
  persistedPartialFragments: 0,
};

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DCP test wait timed out")), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("V2 completed-compress bridge", () => {
  test("refreshes one settled primary prefix and delivers with native steer without resuming", async () => {
    const { directory, memoryDir } = await setup();
    const host = makeContext(directory);
    await writeText(memoryPathFor("primary", memoryDir), memory);
    const updates: unknown[] = [];
    const lifetime = new AbortController();
    const dcp = await registerV2DcpCompletion(
      host.context,
      directory,
      async (input) => {
        updates.push(input);
        return updateResult;
      },
      lifetime.signal,
    );
    try {
      await host.emit(completed("primary"));
      await host.emit(completed("primary"));
      await host.emit(completed("primary", "call_compress_2"));
      await eventually(() => host.synthetics.length === 1);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ sessionID: "primary", source: "durable-visible-text" });
      expect(host.synthetics[0]).toMatchObject({
        sessionID: "primary",
        text: expect.stringContaining("preserved"),
        description: "Short-term session memory after DCP compression",
        delivery: "steer",
        resume: false,
        metadata: { source: "opencode-short-term-memory", dcpToolCallID: "call_compress_1" },
      });
      expect(host.synthetics[0]?.id as string).toMatch(/^msg_[a-f0-9]{26}$/);
    } finally {
      await dcp.dispose();
    }
  });

  test("child compress marks one pending snapshot delivery and never runs an updater", async () => {
    const { directory, memoryDir } = await setup();
    const host = makeContext(directory, { parentID: "parent" });
    await writeText(memoryPathFor("parent", memoryDir), memory);
    await captureV2ChildMemoryAtCreation(host.context, { sessionID: "child", parentID: "parent" }, directory);
    const updates: unknown[] = [];
    const dcp = await registerV2DcpCompletion(
      host.context,
      directory,
      async (input) => {
        updates.push(input);
        return updateResult;
      },
      new AbortController().signal,
    );
    try {
      const first = { sessionID: "child", system: [] } as never;
      await createV2ContextInjection(host.context, directory)(first);
      expect(first.system).toHaveLength(1);
      await host.emit(completed("child"));
      expect(getV2ChildSystemDelivery(directory, "child")).toBe("dcp");
      const afterDcp = { sessionID: "child", system: [] } as never;
      await createV2ContextInjection(host.context, directory)(afterDcp);
      expect(afterDcp.system).toHaveLength(1);
      expect(getV2ChildSystemDelivery(directory, "child")).toBeUndefined();
      expect(updates).toHaveLength(0);
    } finally {
      await dcp.dispose();
    }
  });

  test("busy refresh receives one bounded retry with a fresh settled prefix", async () => {
    const { directory, memoryDir } = await setup();
    const host = makeContext(directory);
    await writeText(memoryPathFor("primary", memoryDir), memory);
    const snapshots: string[] = [];
    const dcp = await registerV2DcpCompletion(
      host.context,
      directory,
      async (input) => {
        const history = input as {
          readonly messages: readonly { readonly content: readonly [{ readonly text: string }] }[];
        };
        snapshots.push(history.messages.at(-1)!.content[0]!.text);
        if (snapshots.length === 1) {
          host.setAssistantText("fresh answer after busy result");
          return {
            status: "busy",
            reason: "update_in_flight",
            checkpointedChunks: 0,
            checkpointedMessages: 0,
            persistedPartialFragments: 0,
          };
        }
        return updateResult;
      },
      new AbortController().signal,
    );
    try {
      await host.emit(completed("primary"));
      await eventually(() => host.synthetics.length === 1);
      expect(snapshots).toEqual(["answer", "fresh answer after busy result"]);
      expect(host.synthetics).toHaveLength(1);
    } finally {
      await dcp.dispose();
    }
  });

  test("reset before the debounce window closes cancels both refresh and delivery", async () => {
    const { directory, memoryDir } = await setup();
    const host = makeContext(directory);
    await writeText(memoryPathFor("primary", memoryDir), memory);
    const updates: unknown[] = [];
    const dcp = await registerV2DcpCompletion(
      host.context,
      directory,
      async (input) => {
        updates.push(input);
        return updateResult;
      },
      new AbortController().signal,
    );
    try {
      await host.emit(completed("primary"));
      await resetV2MemoryPersistence("primary", directory, null);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(updates).toHaveLength(0);
      expect(host.synthetics).toHaveLength(0);
    } finally {
      await dcp.dispose();
    }
  });

  test("disposal cancels delayed work and releases the native hook", async () => {
    const { directory } = await setup();
    const host = makeContext(directory);
    const updates: unknown[] = [];
    const dcp = await registerV2DcpCompletion(
      host.context,
      directory,
      async (input) => {
        updates.push(input);
        return updateResult;
      },
      new AbortController().signal,
    );
    await host.emit(completed("primary"));
    await dcp.dispose();
    expect(host.hookDisposed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(updates).toHaveLength(0);
    expect(host.synthetics).toHaveLength(0);
  });

  test.each(["deletion", "reset"] as const)(
    "session %s aborts an unresolved synthetic request and releases its mutation lock",
    async (operation) => {
      const { directory, memoryDir } = await setup();
      const entered = deferred<void>();
      const releaseHost = deferred<void>();
      let syntheticSignal: AbortSignal | undefined;
      const host = makeContext(directory, {
        synthetic: async (_input, request) => {
          syntheticSignal = request?.signal;
          entered.resolve();
          await releaseHost.promise;
        },
      });
      await writeText(memoryPathFor("primary", memoryDir), memory);
      const dcp = await registerV2DcpCompletion(
        host.context,
        directory,
        async () => updateResult,
        new AbortController().signal,
      );
      try {
        await host.emit(completed("primary"));
        await entered.promise;
        if (operation === "deletion") await bounded(deleteV2SessionMemory(directory, "primary"));
        else await bounded(resetV2MemoryPersistence("primary", directory, null));
        expect(syntheticSignal?.aborted).toBe(true);
        if (operation === "deletion") expect(await Bun.file(memoryPathFor("primary", memoryDir)).exists()).toBe(false);
        else expect(await Bun.file(memoryPathFor("primary", memoryDir)).text()).toBe(STANDARD_MEMORY_TEMPLATE);
      } finally {
        releaseHost.resolve();
        await dcp.dispose();
      }
    },
  );

  test("reports the optional hook capability as unavailable without partially registering", async () => {
    const { directory } = await setup();
    const host = makeContext(directory, { toolHook: false });
    await expect(
      registerV2DcpCompletion(host.context, directory, async () => updateResult, new AbortController().signal),
    ).rejects.toThrow("v2_dcp_execute_after_hook_unavailable");
  });

  test("ignores errors, unrelated tools, and owned summary sessions", async () => {
    const { directory } = await setup();
    const host = makeContext(directory, { metadata: { stmInternalSummary: "v1" } });
    const updates: unknown[] = [];
    const dcp = await registerV2DcpCompletion(
      host.context,
      directory,
      async (input) => {
        updates.push(input);
        return updateResult;
      },
      new AbortController().signal,
    );
    try {
      await host.emit({ ...completed("summary"), status: "error" });
      await host.emit({ ...completed("summary"), tool: "shell" });
      await host.emit(completed("summary"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(updates).toHaveLength(0);
      expect(host.synthetics).toHaveLength(0);
    } finally {
      await dcp.dispose();
    }
  });
});
