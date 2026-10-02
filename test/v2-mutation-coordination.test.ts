import { describe, expect, test } from "bun:test";
import {
  isV2MemoryUpdateInFlight,
  tryAcquireV2MemoryUpdate,
  withV2MemoryMutation,
} from "../src/v2-mutation-coordination";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("process-local V2 mutation coordination", () => {
  test("queues explicit mutations FIFO behind an updater without barging at handoff", async () => {
    const release = tryAcquireV2MemoryUpdate("project", "fifo")!;
    expect(release).toBeFunction();
    expect(isV2MemoryUpdateInFlight("project", "fifo")).toBe(true);
    const events: number[] = [];
    const gate = deferred();
    const entered = deferred();
    const first = withV2MemoryMutation("project", "fifo", async () => {
      events.push(1);
      entered.resolve();
      await gate.promise;
    });
    const second = withV2MemoryMutation("project", "fifo", () => events.push(2));
    expect(events).toEqual([]);
    release();
    expect(isV2MemoryUpdateInFlight("project", "fifo")).toBe(false);
    expect(tryAcquireV2MemoryUpdate("project", "fifo")).toBeUndefined();
    const third = withV2MemoryMutation("project", "fifo", () => events.push(3));
    await entered.promise;
    expect(events).toEqual([1]);
    expect(tryAcquireV2MemoryUpdate("project", "fifo")).toBeUndefined();
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(events).toEqual([1, 2, 3]);
    const fresh = tryAcquireV2MemoryUpdate("project", "fifo")!;
    expect(fresh).toBeFunction();
    release(); // A stale release must not release the new owner.
    expect(tryAcquireV2MemoryUpdate("project", "fifo")).toBeUndefined();
    fresh();
  });

  test("explicit ownership and queued mutations are not updater activity", async () => {
    const gate = deferred();
    const first = withV2MemoryMutation("project", "manual", () => gate.promise);
    let ran = false;
    const second = withV2MemoryMutation("project", "manual", () => (ran = true));
    expect(isV2MemoryUpdateInFlight("project", "manual")).toBe(false);
    expect(tryAcquireV2MemoryUpdate("project", "manual")).toBeUndefined();
    expect(ran).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    expect(ran).toBe(true);
    const release = tryAcquireV2MemoryUpdate("project", "manual")!;
    expect(release).toBeFunction();
    release();
  });

  test.each(["throw", "reject"])("releases after callback %s and preserves failure", async (kind) => {
    const gate = deferred();
    const failure = new Error(kind);
    const blocker = withV2MemoryMutation("project", kind, () => gate.promise);
    const failed = withV2MemoryMutation("project", kind, () => {
      if (kind === "throw") throw failure;
      return Promise.reject(failure);
    });
    const outcome = failed.catch((error: unknown) => error);
    const next = withV2MemoryMutation("project", kind, () => "next");
    gate.resolve();
    await blocker;
    expect(await outcome).toBe(failure);
    expect(await next).toBe("next");
    const release = tryAcquireV2MemoryUpdate("project", kind)!;
    expect(release).toBeFunction();
    release();
  });

  test("isolates project/session tuples, including delimiter-like content", async () => {
    const release = tryAcquireV2MemoryUpdate("a", "b\u0000c")!;
    expect(release).toBeFunction();
    const keys = [
      ["other", "b\u0000c"],
      ["a", "other"],
      ["a\u0000b", "c"],
    ] as const;
    try {
      for (const [project, session] of keys) {
        expect(await withV2MemoryMutation(project, session, () => "independent")).toBe("independent");
        const otherRelease = tryAcquireV2MemoryUpdate(project, session)!;
        expect(otherRelease).toBeFunction();
        otherRelease();
      }
      expect(tryAcquireV2MemoryUpdate("a", "b\u0000c")).toBeUndefined();
    } finally {
      release();
    }
  });
});
