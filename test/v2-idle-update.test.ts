import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Session } from "@opencode/schema/session";
import { SessionEvent } from "@opencode/schema/session-event";
import type { V2Context } from "../src/v2-adapter";
import { createV2IdleUpdateScheduler } from "../src/v2-idle-update";
import { tryAcquireV2MemoryUpdate } from "../src/v2-mutation-coordination";
import { createV2MemoryUpdater } from "../src/v2-memory-update";
import { memoryPathFor } from "../src/memory-utils";
import { deferred } from "./async-helpers";

type Event = { type: string; data: { sessionID: string; reason?: string } };

const { Schema } = createRequire(import.meta.resolve("@opencode/schema/session"))("effect");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function eventually(predicate: () => boolean, timeout = 1_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

function eventSource() {
  const queue: Event[] = [];
  const waiters: Array<(result: IteratorResult<Event>) => void> = [];
  let closed = false;
  return {
    push(event: Event) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value: event });
      else queue.push(event);
    },
    subscribe({ signal }: { signal: AbortSignal }) {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              if (queue.length) return Promise.resolve({ done: false, value: queue.shift()! });
              if (closed || signal.aborted) return Promise.resolve({ done: true, value: undefined });
              return new Promise<IteratorResult<Event>>((resolve) => {
                const finish = () => resolve({ done: true, value: undefined });
                signal.addEventListener("abort", finish, { once: true });
                waiters.push(resolve);
              });
            },
            return: async () => {
              closed = true;
              return { done: true, value: undefined } as const;
            },
          };
        },
      };
    },
  };
}

function makeContext(
  directory: string,
  source: ReturnType<typeof eventSource>,
  options: { child?: boolean; unfinished?: boolean } = {},
) {
  const model = { providerID: "provider", id: "model" };
  const records = [
    { id: "msg_user", type: "user", time: { created: 1 }, text: "question" },
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "agent",
      model,
      time: options.unfinished ? { created: 2 } : { created: 2, completed: 3 },
      content: [{ type: "text", text: "answer" }],
    },
  ];
  return {
    location: { directory, project: { id: "project", directory, canonical: directory } },
    options: {},
    event: source,
    session: {
      wait: async () => undefined,
      context: async () => records,
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: options.child ? "parent" : null,
        model,
      }),
    },
  } as unknown as V2Context;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "stm-idle-"));
  directories.push(directory);
  await mkdir(join(directory, ".opencode"));
  await writeFile(
    join(directory, ".opencode", "stm.jsonc"),
    JSON.stringify({ debounceMs: 20, memoryDir: join(directory, ".opencode", "memory") }),
  );
  return directory;
}

describe("V2 idle update scheduler", () => {
  test("calls the updater for a native schema-encoded execution event with primary metadata omitting parentID", async () => {
    const directory = await setup();
    const source = eventSource();
    const sessionID = "ses_primary";
    const metadata = Schema.encodeSync(Session.Info)(
      Schema.decodeUnknownSync(Session.Info)({
        id: sessionID,
        projectID: "global",
        model: { providerID: "provider", id: "model" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        outcome: "succeeded",
        time: { created: 1, updated: 3, idle: 3 },
        title: "Primary session",
        location: { directory },
      }),
    );
    expect(metadata).not.toHaveProperty("parentID");
    const base = makeContext(directory, source);
    const calls: unknown[] = [];
    const scheduler = createV2IdleUpdateScheduler(
      {
        ...base,
        session: { ...base.session, get: async () => metadata },
      } as unknown as V2Context,
      directory,
      async (input) => {
        calls.push(input);
        return { status: "committed", checkpointedChunks: 1, checkpointedMessages: 1, persistedPartialFragments: 0 };
      },
      new AbortController().signal,
    );
    try {
      source.push(
        Schema.encodeSync(SessionEvent.Execution.Succeeded)(
          Schema.decodeUnknownSync(SessionEvent.Execution.Succeeded)({
            id: "evt_primary_idle",
            created: 3,
            type: "session.execution.succeeded",
            durable: { aggregateID: sessionID, seq: 1, version: 1 },
            data: { sessionID },
          }),
        ),
      );
      await eventually(() => calls.length === 1);
      expect(calls[0]).toMatchObject({ sessionID });
    } finally {
      await scheduler.dispose();
    }
  });

  test("aborts a real updater on invalidation without a late memory commit", async () => {
    const directory = await setup();
    const source = eventSource();
    const generation = deferred<{ text: string }>();
    const generationStarted = deferred<void>();
    const original = "## Session Memory\n\n### User Instructions\n- original\n";
    await mkdir(join(directory, ".opencode", "memory"), { recursive: true });
    await writeFile(memoryPathFor("session", join(directory, ".opencode", "memory")), original);
    const base = makeContext(directory, source);
    const context = {
      ...base,
      generate: {
        text: async () => {
          generationStarted.resolve();
          return generation.promise;
        },
      },
    } as unknown as V2Context;
    const scheduler = createV2IdleUpdateScheduler(
      context,
      directory,
      createV2MemoryUpdater(context, directory),
      new AbortController().signal,
    );
    source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
    await generationStarted.promise;
    source.push({ type: "session.execution.started", data: { sessionID: "session" } });
    generation.resolve({
      text: "## Session Memory\n\n### User Instructions\n- late\n\n### Long Horizon Context\n- late\n\n### Decisions\n- late\n\n### Conclusions\n- late\n\n### Active References\n- late\n",
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await Bun.file(memoryPathFor("session", join(directory, ".opencode", "memory"))).text()).toBe(original);
    source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
    await scheduler.dispose();
    expect(await Bun.file(memoryPathFor("session", join(directory, ".opencode", "memory"))).text()).toBe(original);
  });

  test("accepts exact native terminal events and ignores guessed aliases", async () => {
    const directory = await setup();
    const source = eventSource();
    const calls: unknown[] = [];
    const scheduler = createV2IdleUpdateScheduler(
      makeContext(directory, source),
      directory,
      async (input) => {
        calls.push(input);
        return { status: "committed", checkpointedChunks: 1, checkpointedMessages: 1, persistedPartialFragments: 0 };
      },
      new AbortController().signal,
    );

    source.push({ type: "execution.succeeded", data: { sessionID: "session" } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toHaveLength(0);
    source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
    await eventually(() => calls.length === 1);
    await scheduler.dispose();
  });

  test("started invalidates a pending terminal update and disposal prevents late commits", async () => {
    const directory = await setup();
    const source = eventSource();
    const calls: unknown[] = [];
    const scheduler = createV2IdleUpdateScheduler(
      makeContext(directory, source),
      directory,
      async (input) => {
        calls.push(input);
        return { status: "committed", checkpointedChunks: 1, checkpointedMessages: 1, persistedPartialFragments: 0 };
      },
      new AbortController().signal,
    );
    source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
    source.push({ type: "session.execution.started", data: { sessionID: "session" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toHaveLength(0);
    await scheduler.dispose();
    expect(calls).toHaveLength(0);
  });

  test("skips shutdown interruptions, unfinished history, and child sessions", async () => {
    for (const options of [{ unfinished: true }, { child: true }]) {
      const directory = await setup();
      const source = eventSource();
      const calls: unknown[] = [];
      const scheduler = createV2IdleUpdateScheduler(
        makeContext(directory, source, options),
        directory,
        async (input) => {
          calls.push(input);
          return { status: "committed", checkpointedChunks: 1, checkpointedMessages: 1, persistedPartialFragments: 0 };
        },
        new AbortController().signal,
      );
      source.push({ type: "session.execution.interrupted", data: { sessionID: "session", reason: "shutdown" } });
      source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(calls).toHaveLength(0);
      await scheduler.dispose();
    }
  });

  test("a held lock permits exactly two fresh reads until a new terminal notification", async () => {
    const directory = await setup();
    const source = eventSource();
    const calls: unknown[] = [];
    const release = tryAcquireV2MemoryUpdate(directory, "session");
    expect(release).toBeDefined();
    const base = makeContext(directory, source);
    let waits = 0;
    let histories = 0;
    const scheduler = createV2IdleUpdateScheduler(
      {
        ...base,
        session: {
          ...base.session,
          wait: async () => {
            waits += 1;
          },
          context: async (...args) => {
            histories += 1;
            return base.session.context(...args);
          },
        },
      },
      directory,
      async (input) => {
        calls.push(input);
        return { status: "committed", checkpointedChunks: 1, checkpointedMessages: 1, persistedPartialFragments: 0 };
      },
      new AbortController().signal,
    );
    try {
      source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
      await eventually(() => histories === 2);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(waits).toBe(2);
      expect(histories).toBe(2);
      expect(calls).toHaveLength(0);
      release!();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(histories).toBe(2);
      expect(calls).toHaveLength(0);
      source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
      await eventually(() => calls.length === 1);
      expect(waits).toBe(3);
      expect(histories).toBe(3);
    } finally {
      release!();
      await scheduler.dispose();
    }
  });

  test("replays an updater busy result once with a fresh history snapshot", async () => {
    const directory = await setup();
    const source = eventSource();
    const base = makeContext(directory, source);
    let waits = 0;
    let histories = 0;
    const snapshots: string[] = [];
    const scheduler = createV2IdleUpdateScheduler(
      {
        ...base,
        session: {
          ...base.session,
          wait: async () => {
            waits += 1;
          },
          context: async () => [
            { id: "msg_user", type: "user", time: { created: 1 }, text: `snapshot ${++histories}` },
          ],
        },
      } as unknown as V2Context,
      directory,
      async (input) => {
        snapshots.push(input.messages[0]!.content[0]!.text);
        return snapshots.length === 1
          ? {
              status: "busy",
              reason: "update_in_flight",
              checkpointedChunks: 0,
              checkpointedMessages: 0,
              persistedPartialFragments: 0,
            }
          : { status: "committed", checkpointedChunks: 1, checkpointedMessages: 1, persistedPartialFragments: 0 };
      },
      new AbortController().signal,
    );
    try {
      source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
      await eventually(() => snapshots.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(snapshots).toEqual(["snapshot 1", "snapshot 2"]);
      expect(waits).toBe(2);
      expect(histories).toBe(2);
    } finally {
      await scheduler.dispose();
    }
  });

  test("notifications during an updater reserve one bounded replay, not repeated busy polling", async () => {
    const directory = await setup();
    const source = eventSource();
    const first = deferred<void>();
    let calls = 0;
    const scheduler = createV2IdleUpdateScheduler(
      makeContext(directory, source),
      directory,
      async () => {
        calls += 1;
        if (calls === 1) await first.promise;
        return {
          status: "busy",
          reason: "update_in_flight",
          checkpointedChunks: 0,
          checkpointedMessages: 0,
          persistedPartialFragments: 0,
        };
      },
      new AbortController().signal,
    );
    try {
      source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
      await eventually(() => calls === 1);
      for (let i = 0; i < 5; i += 1)
        source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      first.resolve();
      await eventually(() => calls === 2);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(calls).toBe(2);
      source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
      await eventually(() => calls === 4);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(calls).toBe(4);
    } finally {
      first.resolve();
      await scheduler.dispose();
    }
  });

  test("a terminal notification during the wait survives a successful update as one pending replay", async () => {
    const directory = await setup();
    const source = eventSource();
    const base = makeContext(directory, source);
    const firstWait = deferred<void>();
    let waits = 0;
    let calls = 0;
    const scheduler = createV2IdleUpdateScheduler(
      {
        ...base,
        session: {
          ...base.session,
          wait: async () => {
            waits += 1;
            if (waits === 1) await firstWait.promise;
          },
        },
      },
      directory,
      async () => {
        calls += 1;
        return { status: "committed", checkpointedChunks: 0, checkpointedMessages: 0, persistedPartialFragments: 0 };
      },
      new AbortController().signal,
    );
    try {
      source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
      await eventually(() => waits === 1);
      source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      firstWait.resolve();
      await eventually(() => calls === 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls).toBe(2);
      expect(waits).toBe(2);
    } finally {
      firstWait.resolve();
      await scheduler.dispose();
    }
  });

  test("invalidation and disposal settle abort-ignoring waits immediately without downstream reads", async () => {
    for (const invalidate of [true, false]) {
      const directory = await setup();
      const source = eventSource();
      const base = makeContext(directory, source);
      const wait = deferred<void>();
      let waitSignal: AbortSignal | undefined;
      let reads = 0;
      let calls = 0;
      const scheduler = createV2IdleUpdateScheduler(
        {
          ...base,
          session: {
            ...base.session,
            wait: async (_input, { signal }) => {
              waitSignal = signal;
              return wait.promise;
            },
            context: async (...args) => {
              reads += 1;
              return base.session.context(...args);
            },
            get: async (...args) => {
              reads += 1;
              return base.session.get(...args);
            },
          },
        },
        directory,
        async () => {
          calls += 1;
          return { status: "committed", checkpointedChunks: 0, checkpointedMessages: 0, persistedPartialFragments: 0 };
        },
        new AbortController().signal,
      );
      try {
        source.push({ type: "session.execution.succeeded", data: { sessionID: "session" } });
        await eventually(() => waitSignal !== undefined);
        if (invalidate) {
          source.push({ type: "session.execution.started", data: { sessionID: "session" } });
          await eventually(() => waitSignal!.aborted);
        }
        const started = Date.now();
        await scheduler.dispose();
        expect(Date.now() - started).toBeLessThan(300);
        expect(waitSignal!.aborted).toBe(true);
        wait.reject(new Error("late ignored host failure"));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(reads).toBe(0);
        expect(calls).toBe(0);
      } finally {
        wait.resolve();
        await scheduler.dispose();
      }
    }
  });

  test("bounds disposal when the host iterator ignores abort", async () => {
    const directory = await setup();
    const scheduler = createV2IdleUpdateScheduler(
      {
        ...makeContext(directory, eventSource()),
        event: {
          subscribe: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise<IteratorResult<never>>(() => undefined),
              return: () => new Promise<IteratorResult<never>>(() => undefined),
            }),
          }),
        },
      } as unknown as V2Context,
      directory,
      async () => ({
        status: "committed",
        checkpointedChunks: 0,
        checkpointedMessages: 0,
        persistedPartialFragments: 0,
      }),
      new AbortController().signal,
    );
    const started = Date.now();
    await scheduler.dispose();
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});
