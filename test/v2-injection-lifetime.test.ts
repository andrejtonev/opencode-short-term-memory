import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V2Context, V2SessionContext } from "../src/v2-adapter";
import { captureV2ChildMemoryAtCreation, childStatePath, readTaskChildMemory } from "../src/v2-child-memory";
import { createV2ContextInjection } from "../src/v2-context-injection";
import { createV2ReminderCadence } from "../src/v2-reminder-cadence";
import * as Coordination from "../src/v2-mutation-coordination";
import { STANDARD_MEMORY_TEMPLATE, memoryPathFor, readRawFile, writeText } from "../src/memory-utils";
import { deferred } from "./async-helpers";

const OLD_MEMORY = STANDARD_MEMORY_TEMPLATE.replace("### Decisions", "### Decisions\n- OLD_PARENT_DECISION");
const NEW_MEMORY = STANDARD_MEMORY_TEMPLATE.replace("### Decisions", "### Decisions\n- NEW_PARENT_DECISION");
const snapshot = (sessionID: string): V2SessionContext =>
  ({
    sessionID,
    system: [],
    model: { providerID: "offline", id: "test" },
    messages: [],
  }) as unknown as V2SessionContext;

describe("V2 injection cancellation and metadata policy", () => {
  let directory: string;
  let memoryDir: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stm-v2-injection-lifetime-"));
    memoryDir = join(directory, "memory");
    await writeText(
      join(directory, ".opencode", "stm.json"),
      JSON.stringify({ memoryDir, enableLegacyPeriodicSystemTransform: true, remindEveryN: 5 }),
    );
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const childContext = (): V2Context =>
    ({
      location: { directory },
      session: { get: async () => ({ id: "child", parentID: "parent" }) },
    }) as unknown as V2Context;

  test("cancelled creation capture leaves no snapshot and a later context cannot recapture", async () => {
    await writeText(memoryPathFor("parent", memoryDir), OLD_MEMORY);
    const lifetime = new AbortController();
    const ownerEntered = deferred<void>();
    const releaseOwner = deferred<void>();
    const parentReadEntered = deferred<void>();
    const original = Coordination.withV2MemoryMutation;
    const owner = original(directory, "parent", async () => {
      ownerEntered.resolve();
      await releaseOwner.promise;
    });
    await ownerEntered.promise;
    const interception = spyOn(Coordination, "withV2MemoryMutation").mockImplementation(
      (base, sessionID, operation) => {
        if (sessionID === "parent") parentReadEntered.resolve();
        return original(base, sessionID, operation);
      },
    );
    const input = snapshot("child");
    const context = childContext();
    const capture = captureV2ChildMemoryAtCreation(
      context,
      { sessionID: "child", parentID: "parent" },
      directory,
      {},
      lifetime.signal,
    );
    const injection = createV2ContextInjection(context, directory, undefined, lifetime.signal)(input);
    try {
      await parentReadEntered.promise;
      lifetime.abort();
      releaseOwner.resolve();
      await owner;
      expect(await capture).toMatchObject({ status: "suppressed" });
      await injection;
      expect(input.system).toHaveLength(0);
      expect(await readRawFile(childStatePath("child", memoryDir))).toBeNull();
      await writeText(memoryPathFor("parent", memoryDir), NEW_MEMORY);
      const fresh = snapshot("child");
      await createV2ContextInjection(context, directory, undefined, new AbortController().signal)(fresh);
      expect(JSON.stringify(fresh.system)).not.toContain("NEW_PARENT_DECISION");
      expect(
        await readTaskChildMemory(
          context,
          fresh,
          { memoryDir, maxMemoryLength: 10_000, injectInSubagents: true },
          directory,
        ),
      ).toEqual({
        status: "missing-snapshot",
      });
    } finally {
      releaseOwner.resolve();
      await owner;
      await capture;
      await injection;
      interception.mockRestore();
    }
  });

  test.each([false, true])(
    "midwrite cancellation cleans only its own snapshot bytes (external replacement: %s)",
    async (externalReplacement) => {
      await writeText(memoryPathFor("parent", memoryDir), OLD_MEMORY);
      const lifetime = new AbortController();
      const path = childStatePath("child", memoryDir);
      const result = await captureV2ChildMemoryAtCreation(
        childContext(),
        { sessionID: "child", parentID: "parent" },
        directory,
        {
          afterSnapshotWrite: async () => {
            if (externalReplacement) await writeText(path, "externally replaced snapshot\n");
            lifetime.abort();
          },
        },
        lifetime.signal,
      );
      expect(result).toEqual({ status: "suppressed" });
      expect(await readRawFile(path)).toEqual(
        externalReplacement ? Buffer.from("externally replaced snapshot\n") : null,
      );
    },
  );

  test("cancellation preserves an existing valid frozen snapshot", async () => {
    await writeText(memoryPathFor("parent", memoryDir), OLD_MEMORY);
    const context = childContext();
    const config = { memoryDir, maxMemoryLength: 10_000, injectInSubagents: true };
    await captureV2ChildMemoryAtCreation(context, { sessionID: "child", parentID: "parent" }, directory);
    const path = childStatePath("child", memoryDir);
    const previous = await readRawFile(path);
    const lifetime = new AbortController();
    lifetime.abort();
    expect(await readTaskChildMemory(context, { sessionID: "child" }, config, directory, {}, lifetime.signal)).toEqual({
      status: "suppressed",
    });
    expect(await readRawFile(path)).toEqual(previous);
  });

  test("a failed lineage lookup cannot inject an ineligible primary turn after a second lookup recovers", async () => {
    await writeText(memoryPathFor("primary", memoryDir), OLD_MEMORY);
    let reads = 0;
    const context = {
      location: { directory },
      session: {
        get: async () => {
          reads += 1;
          if (reads === 1) throw new Error("temporary metadata failure");
          return { id: "primary" };
        },
      },
    } as unknown as V2Context;
    const cadence = createV2ReminderCadence(context, directory);
    cadence.record({ sessionID: "primary", messageID: "msg_user" });
    const input = snapshot("primary");
    input.messages.push({ id: "msg_user", role: "user", content: [{ type: "text", text: "first turn" }] } as never);
    try {
      await createV2ContextInjection(context, directory, cadence)(input);
      expect(input.system).toHaveLength(0);
      expect(reads).toBe(1);
      const recovered = { ...input, system: [] };
      await createV2ContextInjection(context, directory, cadence)(recovered);
      expect(recovered.system).toHaveLength(0);
    } finally {
      cadence.dispose();
    }
  });
});
