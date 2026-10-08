import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  STANDARD_MEMORY_TEMPLATE,
  checkpointPathFor,
  logPath,
  memoryPathFor,
  readRawFile,
  readText,
  resetBoundaryPathFor,
  sideSessionsStatePath,
  writeText,
} from "../src/memory-utils";
import type { V2Context, V2SessionContext } from "../src/v2-adapter";
import { childStatePath, readTaskChildMemory } from "../src/v2-child-memory";
import { createV2ContextInjection } from "../src/v2-context-injection";
import { createV2IdleUpdateScheduler } from "../src/v2-idle-update";
import { createV2MemoryActions } from "../src/v2-memory-tools";
import { createV2MemoryUpdater } from "../src/v2-memory-update";
import {
  getV2MemorySessionSignal,
  isV2MemorySessionDeleted,
  isV2MemoryUpdateInFlight,
  tryAcquireV2MemoryUpdate,
  withV2MemoryMutation,
} from "../src/v2-mutation-coordination";
import { resetV2MemoryPersistence } from "../src/v2-reset-persistence";
import { deleteV2SessionMemory } from "../src/v2-session-deletion";
import { deferred } from "./async-helpers";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("deletion test wait timed out")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function snapshot(sessionID: string): V2SessionContext {
  return {
    sessionID,
    agent: "agent",
    model: { providerID: "provider", id: "model" },
    system: [],
    messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: "question" }] },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "answer" }] },
    ],
    options: {},
    tools: {},
  } as unknown as V2SessionContext;
}

describe("V2 session deletion lifecycle", () => {
  let directory = "";
  let memoryDir = "";
  const environment = ["HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"] as const;
  const previousEnvironment = environment.map((key) => process.env[key]);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stm-v2-deletion-"));
    memoryDir = join(directory, "memory");
    for (const key of environment) process.env[key] = join(directory, key);
    await writeText(
      join(directory, ".opencode", "stm.json"),
      JSON.stringify({
        memoryDir,
        enabled: true,
        summarizerMode: "clean",
        memoryModel: "",
        sideSessionRetries: 0,
        cleanFallbackToActiveSession: false,
        debug: false,
        injectInSubagents: true,
        enableLegacyPeriodicSystemTransform: true,
      }),
    );
  });

  afterEach(async () => {
    for (const [index, key] of environment.entries()) {
      if (previousEnvironment[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[index];
    }
    await rm(directory, { recursive: true, force: true });
  });

  function context(
    generate: (signal?: AbortSignal) => Promise<{ text: string }> = async () => ({ text: STANDARD_MEMORY_TEMPLATE }),
    get: (sessionID: string) => Promise<unknown> = async (sessionID) => ({ id: sessionID, parentID: null }),
  ): V2Context {
    return {
      location: { directory, workspaceID: "workspace", project: { id: "project", directory, canonical: directory } },
      options: {},
      session: {
        get: async ({ sessionID }: { sessionID: string }) => get(sessionID),
        generate: async () => {
          throw new Error("unexpected active inference");
        },
      },
      generate: { text: async (_input: unknown, request?: { signal?: AbortSignal }) => generate(request?.signal) },
    } as unknown as V2Context;
  }

  function paths(sessionID: string): string[] {
    return [
      memoryPathFor(sessionID, memoryDir),
      checkpointPathFor(sessionID, memoryDir),
      resetBoundaryPathFor(sessionID, memoryDir),
      childStatePath(sessionID, memoryDir),
    ];
  }

  async function absent(sessionID: string): Promise<void> {
    expect(await Promise.all(paths(sessionID).map(readRawFile))).toEqual([null, null, null, null]);
  }

  test("removes exactly four artifacts, preserves related sessions/shared state, and is idempotent", async () => {
    const removed = paths("target");
    const preserved = [...paths("parent"), ...paths("sibling"), logPath(memoryDir), sideSessionsStatePath(memoryDir)];
    for (const path of [...removed, ...preserved]) await writeText(path, `sentinel:${path}`);
    await deleteV2SessionMemory(directory, "target");
    await absent("target");
    for (const path of preserved) expect(await readText(path)).toBe(`sentinel:${path}`);
    await deleteV2SessionMemory(directory, "target");
    await deleteV2SessionMemory(directory, "never-created");
    await absent("target");
    await absent("never-created");
    for (const path of preserved) expect(await readText(path)).toBe(`sentinel:${path}`);
  });

  test("tombstones synchronously and rejects queued/new normal mutations without running them", async () => {
    const sessionID = "queued";
    const signal = getV2MemorySessionSignal(directory, sessionID);
    const release = tryAcquireV2MemoryUpdate(directory, sessionID)!;
    expect(release).toBeFunction();
    let calls = 0;
    const queued = withV2MemoryMutation(directory, sessionID, () => calls++).catch((error: unknown) => error);
    let cleaned = false;
    const deletion = deleteV2SessionMemory(directory, sessionID).then(() => {
      cleaned = true;
    });
    try {
      expect(signal.aborted).toBe(true);
      expect(signal.reason.message).toBe("session_deleted");
      expect(isV2MemorySessionDeleted(directory, sessionID)).toBe(true);
      expect(tryAcquireV2MemoryUpdate(directory, sessionID)).toBeUndefined();
      await expect(withV2MemoryMutation(directory, sessionID, () => calls++)).rejects.toThrow("session_deleted");
      expect(cleaned).toBe(false);
      release();
      expect(await bounded(queued)).toBe(signal.reason);
      await bounded(deletion);
      expect(calls).toBe(0);
      await absent(sessionID);
    } finally {
      release();
      await bounded(Promise.allSettled([queued, deletion]));
    }
  });

  test("a filesystem cleanup failure still attempts other artifacts and can be retried", async () => {
    const sessionID = "cleanup-failure";
    const [blocked, ...others] = paths(sessionID);
    await mkdir(blocked!, { recursive: true });
    await writeText(join(blocked!, "keep"), "nonempty directory");
    for (const path of others) await writeText(path, "remove me");
    await expect(deleteV2SessionMemory(directory, sessionID)).rejects.toBeInstanceOf(AggregateError);
    expect(await readText(join(blocked!, "keep"))).toBe("nonempty directory");
    expect(await Promise.all(others.map(readRawFile))).toEqual([null, null, null]);
    expect(isV2MemorySessionDeleted(directory, sessionID)).toBe(true);
    await rm(blocked!, { recursive: true });
    await bounded(deleteV2SessionMemory(directory, sessionID));
    await absent(sessionID);
  });

  test("an abort-ignoring provider cannot recreate artifacts or start a second generation after deletion", async () => {
    const sessionID = "pending-provider";
    const generation = deferred<{ text: string }>();
    const entered = deferred();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const updater = createV2MemoryUpdater(
      context(async (requestSignal) => {
        calls++;
        signal = requestSignal;
        entered.resolve();
        return generation.promise;
      }),
      directory,
      { generationTimeoutMs: 2_000 },
    );
    const update = updater(snapshot(sessionID));
    try {
      await bounded(entered.promise);
      expect(isV2MemoryUpdateInFlight(directory, sessionID)).toBe(true);
      await bounded(deleteV2SessionMemory(directory, sessionID));
      expect(signal?.aborted).toBe(true);
      expect(await bounded(update)).toMatchObject({ status: "error", detail: "summarizer_cancelled" });
      await absent(sessionID);
      const afterDeletionWhileProviderPending = await bounded(updater(snapshot(sessionID)));
      generation.resolve({ text: STANDARD_MEMORY_TEMPLATE });
      await bounded(generation.promise);
      await Promise.resolve();
      await absent(sessionID);
      expect(await bounded(updater(snapshot(sessionID)))).toMatchObject({
        status: "skipped",
        reason: "session_deleted",
      });
      expect(calls).toBe(1);
      expect(afterDeletionWhileProviderPending).toMatchObject({ status: "skipped", reason: "session_deleted" });
    } finally {
      generation.resolve({ text: STANDARD_MEMORY_TEMPLATE });
      await bounded(update);
    }
  });

  test("deletion between memory and checkpoint commits fences checkpoint and waits for rollback", async () => {
    const sessionID = "checkpoint-race";
    const entered = deferred();
    const gate = deferred();
    let checkpointCalls = 0;
    const updater = createV2MemoryUpdater(context(), directory, {
      beforeCheckpoint: async () => {
        entered.resolve();
        await gate.promise;
      },
      writeCheckpoint: async () => {
        checkpointCalls++;
      },
    });
    const update = updater(snapshot(sessionID));
    let deletion: Promise<void> | undefined;
    try {
      await bounded(entered.promise);
      expect(await readText(memoryPathFor(sessionID, memoryDir))).toContain("## Session Memory");
      expect(await readRawFile(checkpointPathFor(sessionID, memoryDir))).toBeNull();
      let deleted = false;
      deletion = deleteV2SessionMemory(directory, sessionID).then(() => {
        deleted = true;
      });
      await Promise.resolve();
      expect(deleted).toBe(false);
      gate.resolve();
      expect(await bounded(update)).toMatchObject({
        status: "error",
        detail: "summarizer_cancelled",
        rollback: "restored",
        checkpointedChunks: 0,
      });
      await bounded(deletion);
      expect(checkpointCalls).toBe(0);
      await absent(sessionID);
    } finally {
      gate.resolve();
      await bounded(Promise.allSettled([update, ...(deletion ? [deletion] : [])]));
    }
  });

  test.each(["memory", "checkpoint"] as const)(
    "deletion waits for reset paused before %s commit and leaves no prepared files",
    async (kind) => {
      const sessionID = `reset-${kind}`;
      const entered = deferred();
      const gate = deferred();
      const reset = resetV2MemoryPersistence(sessionID, directory, "anchor", undefined, {
        beforeCommit: async (current) => {
          if (current === kind) {
            entered.resolve();
            await gate.promise;
          }
        },
      });
      let deletion: Promise<void> | undefined;
      try {
        await bounded(entered.promise);
        let deleted = false;
        deletion = deleteV2SessionMemory(directory, sessionID).then(() => {
          deleted = true;
        });
        expect(getV2MemorySessionSignal(directory, sessionID).aborted).toBe(true);
        await Promise.resolve();
        expect(deleted).toBe(false);
        gate.resolve();
        expect(await bounded(reset)).toBe("anchor");
        await bounded(deletion);
        await absent(sessionID);
        expect((await readdir(memoryDir, { recursive: true })).filter((path) => path.includes(".tmp-"))).toEqual([]);
      } finally {
        gate.resolve();
        await bounded(Promise.allSettled([reset, ...(deletion ? [deletion] : [])]));
      }
    },
  );

  test("read bootstrap queued before deletion and requested afterward refuses to recreate memory", async () => {
    const sessionID = "bootstrap";
    const actions = createV2MemoryActions(context());
    const release = tryAcquireV2MemoryUpdate(directory, sessionID)!;
    expect(release).toBeFunction();
    const read = actions.show(sessionID).catch((error: unknown) => error);
    const deletion = deleteV2SessionMemory(directory, sessionID);
    try {
      release();
      expect(await bounded(read)).toBe(getV2MemorySessionSignal(directory, sessionID).reason);
      await bounded(deletion);
      await expect(actions.show(sessionID)).rejects.toThrow("session_deleted");
      await absent(sessionID);
    } finally {
      release();
      await bounded(Promise.allSettled([read, deletion]));
    }
  });

  test("parent deletion preserves a frozen surviving child, blocks new capture, and child deletion removes its snapshot", async () => {
    const host = context(undefined, async (sessionID) => ({ id: sessionID, parentID: "parent" }));
    const config = { ...DEFAULT_CONFIG, memoryDir, injectInSubagents: true };
    await writeText(memoryPathFor("parent", memoryDir), STANDARD_MEMORY_TEMPLATE);
    expect(await readTaskChildMemory(host, snapshot("frozen-child"), config, directory)).toEqual({
      status: "injected",
      memory: STANDARD_MEMORY_TEMPLATE,
    });
    const frozen = await readRawFile(childStatePath("frozen-child", memoryDir));
    expect(frozen).not.toBeNull();
    await deleteV2SessionMemory(directory, "parent");
    expect(await readRawFile(childStatePath("frozen-child", memoryDir))).toEqual(frozen);
    expect(await readTaskChildMemory(host, snapshot("frozen-child"), config, directory)).toEqual({
      status: "injected",
      memory: STANDARD_MEMORY_TEMPLATE,
    });
    expect(await readTaskChildMemory(host, snapshot("new-child"), config, directory)).toEqual({ status: "suppressed" });
    await absent("new-child");
    await deleteV2SessionMemory(directory, "frozen-child");
    await absent("frozen-child");
    expect(await readTaskChildMemory(host, snapshot("frozen-child"), config, directory)).toEqual({
      status: "suppressed",
    });
  });

  test("parent deletion during child snapshot write suppresses capture and a concurrent child read", async () => {
    const host = context(undefined, async (sessionID) => ({ id: sessionID, parentID: "parent" }));
    const config = { ...DEFAULT_CONFIG, memoryDir, injectInSubagents: true };
    const entered = deferred();
    const gate = deferred();
    for (const path of paths("parent")) await writeText(path, STANDARD_MEMORY_TEMPLATE);
    const capture = readTaskChildMemory(host, snapshot("child"), config, directory, {
      afterSnapshotWrite: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    let concurrent: ReturnType<typeof readTaskChildMemory> | undefined;
    try {
      await bounded(entered.promise);
      expect(await readText(childStatePath("child", memoryDir))).toContain(JSON.stringify(STANDARD_MEMORY_TEMPLATE));
      await bounded(deleteV2SessionMemory(directory, "parent"));
      await absent("parent");
      let settled = false;
      concurrent = readTaskChildMemory(host, snapshot("child"), config, directory).finally(() => {
        settled = true;
      });
      await bounded(new Promise<void>((resolve) => setTimeout(resolve, 25)));
      expect(settled).toBe(false);
      gate.resolve();
      expect(await bounded(Promise.all([capture, concurrent]))).toEqual([
        { status: "suppressed" },
        { status: "suppressed" },
      ]);
      await absent("child");
      await absent("parent");
    } finally {
      gate.resolve();
      await bounded(Promise.allSettled([capture, ...(concurrent ? [concurrent] : [])]));
    }
  });

  test("injection paused in metadata lookup does not push after deletion", async () => {
    const sessionID = "injection";
    const entered = deferred();
    const metadata = deferred<unknown>();
    await writeText(memoryPathFor(sessionID, memoryDir), STANDARD_MEMORY_TEMPLATE);
    const input = snapshot(sessionID);
    const injection = createV2ContextInjection(
      context(undefined, async () => {
        entered.resolve();
        return metadata.promise;
      }),
      directory,
    )(input);
    try {
      await bounded(entered.promise);
      await bounded(deleteV2SessionMemory(directory, sessionID));
      metadata.resolve({ id: sessionID, parentID: null });
      await bounded(injection);
      expect(input.system).toEqual([]);
      await absent(sessionID);
    } finally {
      metadata.resolve({ id: sessionID, parentID: null });
      await bounded(injection);
    }
  });

  test("scheduler routes locationless and matching-location safe deletion events", async () => {
    const host = context();
    const consumed = deferred();
    const events = [
      {
        type: "session.deleted",
        data: { sessionID: "wrong-directory" },
        location: { directory: `${directory}-other`, workspaceID: "workspace" },
      },
      {
        type: "session.deleted",
        data: { sessionID: "wrong-workspace" },
        location: { directory, workspaceID: "other" },
      },
      { type: "session.deleted", data: { sessionID: "locationless" } },
      { type: "session.deleted", data: { sessionID: "../unsafe" }, location: host.location },
      { type: "session.deleted", data: { sessionID: 42 }, location: host.location },
      { type: "session.deleted", data: { sessionID: "" }, location: host.location },
      { type: "session.deleted", data: { sessionID: "matched" }, location: host.location },
    ];
    for (const sessionID of ["wrong-directory", "wrong-workspace", "locationless", "matched"]) {
      for (const path of paths(sessionID)) await writeText(path, "sentinel");
    }
    const source = {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
          consumed.resolve();
        },
      }),
    };
    const schedulerContext = { ...host, event: source } as unknown as V2Context;
    const scheduler = createV2IdleUpdateScheduler(
      schedulerContext,
      directory,
      createV2MemoryUpdater(schedulerContext, directory),
      new AbortController().signal,
    );
    try {
      await bounded(consumed.promise);
      await bounded(scheduler.dispose());
      for (const sessionID of ["locationless", "matched"]) {
        await absent(sessionID);
        expect(isV2MemorySessionDeleted(directory, sessionID)).toBe(true);
      }
      for (const sessionID of ["wrong-directory", "wrong-workspace"]) {
        expect(isV2MemorySessionDeleted(directory, sessionID)).toBe(false);
        for (const path of paths(sessionID)) expect(await readText(path)).toBe("sentinel");
      }
      expect(isV2MemorySessionDeleted(directory, "../unsafe")).toBe(false);
      expect(isV2MemorySessionDeleted(directory, "")).toBe(false);
      await expect(deleteV2SessionMemory(directory, "../unsafe")).rejects.toThrow("unsafe path");
      await expect(deleteV2SessionMemory(directory, "")).rejects.toThrow("nonempty");
    } finally {
      await bounded(scheduler.dispose());
    }
  });
});
