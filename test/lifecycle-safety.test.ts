import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_HEADER, checkpointPathFor, memoryPathFor, readText, writeText } from "../src/memory-utils";
import { createFakeClient, createPlugin } from "./test-helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const messageRows = [{ id: "m1", role: "user", text: "remember lifecycle safety", time: { created: 1 } }];
const updatedMemory = `${MEMORY_HEADER}\n\n### User Instructions\n- lifecycle update\n`;

async function expectMissing(path: string) {
  await expect(access(path)).rejects.toThrow();
}

describe("session lifecycle generation safety", () => {
  const originalCwd = process.cwd();
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-lifecycle-safety-test-"));
    process.env.XDG_CONFIG_HOME = join(testDir, ".xdg");
    process.env.OPENCODE_CONFIG_DIR = join(testDir, ".config-dir");
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
    await rm(testDir, { recursive: true, force: true });
  });

  for (const lifecycleAction of ["reset", "delete"] as const) {
    test(`${lifecycleAction} wins over an update held after collection`, async () => {
      const sessionID = `${lifecycleAction}-after-collection`;
      const collectionStarted = deferred<void>();
      const releaseCollection = deferred<unknown>();
      const client = createFakeClient({ promptText: updatedMemory });
      client.session.messages = async () => {
        collectionStarted.resolve();
        return await releaseCollection.promise;
      };
      const { plugin } = await createPlugin({ summarizerMode: "active", debounceMs: 100 }, client);

      const update = plugin.tool.stm_memory_update.execute({}, { sessionID });
      await collectionStarted.promise;
      if (lifecycleAction === "reset") {
        await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID });
      } else {
        await plugin["session.deleted"]({ sessionID });
      }
      releaseCollection.resolve({ data: messageRows });
      await update;

      const memoryPath = memoryPathFor(sessionID);
      const checkpointPath = checkpointPathFor(sessionID);
      if (lifecycleAction === "reset") {
        expect(await readText(memoryPath, "")).not.toContain("lifecycle update");
        expect(await readText(checkpointPath, "")).toBe("");
      } else {
        await expectMissing(memoryPath);
        await expectMissing(checkpointPath);
      }
    });

    test(`${lifecycleAction} wins over an update held after summary`, async () => {
      const sessionID = `${lifecycleAction}-after-summary`;
      const summaryStarted = deferred<void>();
      const releaseSummary = deferred<string>();
      const client = createFakeClient({
        messagesRows: messageRows,
        promptResponder: async () => {
          summaryStarted.resolve();
          return await releaseSummary.promise;
        },
      });
      const { plugin } = await createPlugin({ summarizerMode: "active", debounceMs: 100 }, client);

      const update = plugin.tool.stm_memory_update.execute({}, { sessionID });
      await summaryStarted.promise;
      if (lifecycleAction === "reset") {
        await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID });
      } else {
        await plugin["session.deleted"]({ sessionID });
      }
      releaseSummary.resolve(updatedMemory);
      await update;

      const memoryPath = memoryPathFor(sessionID);
      const checkpointPath = checkpointPathFor(sessionID);
      if (lifecycleAction === "reset") {
        expect(await readText(memoryPath, "")).not.toContain("lifecycle update");
        expect(await readText(checkpointPath, "")).toBe("");
      } else {
        await expectMissing(memoryPath);
        await expectMissing(checkpointPath);
      }
    });

    test(`${lifecycleAction} drops a queued replay from the invalidated generation`, async () => {
      const sessionID = `${lifecycleAction}-queued-replay`;
      const summaryStarted = deferred<void>();
      const releaseSummary = deferred<string>();
      const client = createFakeClient({
        messagesRows: messageRows,
        promptResponder: async () => {
          summaryStarted.resolve();
          return await releaseSummary.promise;
        },
      });
      const { plugin } = await createPlugin({ summarizerMode: "active", debounceMs: 100 }, client);

      const firstUpdate = plugin.tool.stm_memory_update.execute({}, { sessionID });
      await summaryStarted.promise;
      await plugin.tool.stm_memory_update.execute({}, { sessionID });
      if (lifecycleAction === "reset") {
        await plugin.tool.stm_memory_reset.execute({ confirm: true }, { sessionID });
      } else {
        await plugin["session.deleted"]({ sessionID });
      }
      releaseSummary.resolve(updatedMemory);
      await firstUpdate;
      await Bun.sleep(200);

      expect(client.calls.summarizerPrompts).toHaveLength(1);
      if (lifecycleAction === "delete") {
        await expectMissing(memoryPathFor(sessionID));
        await expectMissing(checkpointPathFor(sessionID));
      }
    });
  }

  test("an external memory mutation discards generated output", async () => {
    const sessionID = "external-mutation";
    const summaryStarted = deferred<void>();
    const releaseSummary = deferred<string>();
    const client = createFakeClient({
      messagesRows: messageRows,
      promptResponder: async () => {
        summaryStarted.resolve();
        return await releaseSummary.promise;
      },
    });
    const { plugin } = await createPlugin({ summarizerMode: "active" }, client);
    const update = plugin.tool.stm_memory_update.execute({}, { sessionID });
    await summaryStarted.promise;

    const externalMemory = `${MEMORY_HEADER}\n\n### User Instructions\n- external edit\n`;
    await writeText(memoryPathFor(sessionID), externalMemory);
    releaseSummary.resolve(updatedMemory);
    await update;

    expect(await readText(memoryPathFor(sessionID), "")).toBe(externalMemory);
    expect(await readText(checkpointPathFor(sessionID), "")).toBe("");
  });

  test("checkpoint failure restores exact previous memory and reports no successful update", async () => {
    const sessionID = "checkpoint-rollback";
    const client = createFakeClient({ messagesRows: messageRows, promptText: updatedMemory });
    const { plugin } = await createPlugin({ summarizerMode: "active" }, client);
    const previousMemory = `${MEMORY_HEADER}\n\n### Decisions\n- exact previous content\n`;
    await writeText(memoryPathFor(sessionID), previousMemory);
    await mkdir(checkpointPathFor(sessionID), { recursive: true });

    await plugin.tool.stm_memory_update.execute({}, { sessionID });

    expect(await readText(memoryPathFor(sessionID), "")).toBe(previousMemory);
    const status = String(await plugin.tool.stm_memory_status.execute({}, { sessionID }));
    expect(status).toContain("- updateCount: 0");
    expect(status).not.toContain("- lastError: none");
  });
});
