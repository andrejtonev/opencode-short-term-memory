import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  MEMORY_FORMAT_VERSION,
  MEMORY_HEADER,
  STANDARD_MEMORY_TEMPLATE,
  DEFAULT_CONFIG,
  checkpointPathFor,
  ensureMemoryFile,
  memoryPathFor,
  readRawFile,
  readText,
  writeText,
} from "../src/memory-utils";
import { createV2MemoryUpdater } from "../src/v2-memory-update";
import { resetV2MemoryPersistence } from "../src/v2-reset-persistence";
import type { V2Context, V2SessionContext } from "../src/v2-adapter";
import { withV2MemoryMutation } from "../src/v2-mutation-coordination";

const VALID_MEMORY = `${MEMORY_FORMAT_VERSION}
${MEMORY_HEADER}

### User Instructions
- Existing instruction.

### Long Horizon Context
- Existing context.

### Decisions
- Existing decision.

### Conclusions
- Existing conclusion.

### Active References
- Existing reference.
`;
const ORIGINAL_MEMORY = `${MEMORY_FORMAT_VERSION}
${MEMORY_HEADER}

### User Instructions
- Different initial memory.
`;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function message(id: string, role: "user" | "assistant", text: string) {
  return { id, role, content: [{ type: "text", text }] };
}

function input(sessionID: string): V2SessionContext {
  return {
    sessionID,
    agent: "agent",
    model: { providerID: "provider", id: "model" },
    system: [],
    messages: [message("u1", "user", "Question"), message("a1", "assistant", "Answer")],
    options: {},
    tools: {},
  } as unknown as V2SessionContext;
}

function updaterContext(
  directory: string,
  result: Promise<{ text: string }>,
  started?: Deferred<void>,
  calls?: { count: number },
): V2Context {
  return {
    location: { directory, project: { id: "project", directory, canonical: directory } },
    options: {},
    session: {
      generate: async () => await result,
      hook: async () => ({ dispose: async () => undefined }),
    },
    generate: {
      text: async () => {
        if (calls) calls.count += 1;
        started?.resolve();
        return await result;
      },
    },
    tool: { transform: async () => ({ dispose: async () => undefined }) },
  } as unknown as V2Context;
}

describe("V2 reset persistence", () => {
  let directory = "";
  let memoryDir = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stm-v2-reset-"));
    memoryDir = join(directory, "memory");
  });

  afterEach(async () => {
    for (const sessionID of ["fault", "conflict", "rollback-error", "updater", "forward"]) {
      expect(await withV2MemoryMutation(directory, sessionID, () => "afterEach-released")).toBe("afterEach-released");
    }
    await rm(directory, { recursive: true, force: true });
  });

  test("uses config loaded inside the shared lock and writes the exact template plus empty checkpoint", async () => {
    const expectedTemplate = [
      MEMORY_FORMAT_VERSION,
      MEMORY_HEADER,
      "",
      "### User Instructions",
      "- None captured yet.",
      "",
      "### Long Horizon Context",
      "- None captured yet.",
      "",
      "### Decisions",
      "- None captured yet.",
      "",
      "### Conclusions",
      "- None captured yet.",
      "",
      "### Active References",
      "- None captured yet.",
      "",
    ].join("\n");
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    await writeText(memoryPathFor("reset", memoryDir), "old memory\n");
    await writeText(checkpointPathFor("reset", memoryDir), "old-checkpoint\n");
    await resetV2MemoryPersistence("reset", directory, "anchor");

    expect(STANDARD_MEMORY_TEMPLATE).toBe(expectedTemplate);
    expect(await readFile(memoryPathFor("reset", memoryDir), "utf8")).toBe(expectedTemplate);
    expect(await readFile(checkpointPathFor("reset", memoryDir))).toEqual(Buffer.alloc(0));
    const ensuredPath = await ensureMemoryFile("ensured", { ...DEFAULT_CONFIG, memoryDir });
    expect(await readFile(ensuredPath, "utf8")).toBe(expectedTemplate);
  });

  test("loads queued reset config after acquiring the shared lock", async () => {
    const firstMemoryDir = join(directory, "first-memory");
    const secondMemoryDir = join(directory, "second-memory");
    const configPath = join(directory, ".opencode", "stm.json");
    await writeText(configPath, JSON.stringify({ memoryDir: firstMemoryDir }));
    const gate = deferred<void>();
    const owner = withV2MemoryMutation(directory, "queued-config", () => gate.promise);
    const reset = resetV2MemoryPersistence("queued-config", directory, "anchor");
    await writeText(configPath, JSON.stringify({ memoryDir: secondMemoryDir }));
    gate.resolve();
    await owner;
    await reset;
    expect(await readRawFile(memoryPathFor("queued-config", firstMemoryDir))).toBeNull();
    expect(await readFile(memoryPathFor("queued-config", secondMemoryDir), "utf8")).toBe(STANDARD_MEMORY_TEMPLATE);
  });

  test("restores absent and empty memory plus null, empty, and binary checkpoints after first failure", async () => {
    const checkpoints = [null, Buffer.alloc(0), Buffer.from([255, 0, 254])];
    for (const previous of [null, Buffer.alloc(0)]) {
      for (const checkpoint of checkpoints) {
        const sessionID = `${previous === null ? "first-absent" : "first-empty"}-${
          checkpoint === null ? "null" : checkpoint.length
        }`;
        const memoryPath = memoryPathFor(sessionID, memoryDir);
        const checkpointPath = checkpointPathFor(sessionID, memoryDir);
        await mkdir(join(memoryDir, "checkpoints"), { recursive: true });
        if (checkpoint !== null) await writeFile(checkpointPath, checkpoint);
        if (previous !== null) await writeFile(memoryPath, previous);
        await expect(
          resetV2MemoryPersistence(
            sessionID,
            directory,
            "anchor",
            { memoryDir },
            {
              beforeCommit: (kind) => {
                if (kind === "memory") throw new Error("first commit failure");
              },
            },
          ),
        ).rejects.toThrow("first commit failure");
        expect(await readRawFile(memoryPath)).toEqual(previous);
        expect(await readRawFile(checkpointPath)).toEqual(checkpoint);
        expect(await withV2MemoryMutation(directory, sessionID, () => "released")).toBe("released");
      }
    }
  });

  test.each([
    ["absent", null, null],
    ["empty", Buffer.alloc(0), Buffer.alloc(0)],
    ["whitespace", Buffer.from("  \n\t", "utf8"), Buffer.from("  \n\t", "utf8")],
    ["utf8", Buffer.from([0xe2, 0x98, 0x83]), Buffer.from([0x31, 0x32])],
    ["binary", Buffer.from([0, 255, 1, 254, 10, 0]), Buffer.from([255, 0, 254])],
  ])(
    "restores %s memory after an actual second commit filesystem failure",
    async (name, previousMemory, previousCheckpoint) => {
      const sessionID = `second-${name}`;
      await mkdir(join(memoryDir, "checkpoints"), { recursive: true });
      const actualMemoryPath = memoryPathFor(sessionID, memoryDir);
      const actualCheckpointPath = checkpointPathFor(sessionID, memoryDir);
      if (previousMemory !== null) await writeFile(actualMemoryPath, previousMemory);
      if (previousCheckpoint !== null) await writeFile(actualCheckpointPath, previousCheckpoint);

      await expect(
        resetV2MemoryPersistence(
          sessionID,
          directory,
          "anchor",
          { memoryDir },
          {
            beforeCommit: async (kind) => {
              if (kind === "checkpoint") {
                const targetDirectory = dirname(actualCheckpointPath);
                const targetName = basename(actualCheckpointPath);
                const tempName = (await readdir(targetDirectory)).find((entry) =>
                  entry.startsWith(`${targetName}.tmp-`),
                );
                if (!tempName) throw new Error("prepared checkpoint temp missing");
                await rm(join(targetDirectory, tempName));
              }
            },
          },
        ),
      ).rejects.toBeDefined();
      expect(await readRawFile(actualMemoryPath)).toEqual(previousMemory === null ? null : previousMemory);
      expect(await readRawFile(actualCheckpointPath)).toEqual(previousCheckpoint);
      expect(await withV2MemoryMutation(directory, sessionID, () => "released")).toBe("released");
    },
  );

  test("restores the original pair after an actual first commit filesystem failure", async () => {
    const sessionID = "first-rename";
    const memoryPath = memoryPathFor(sessionID, memoryDir);
    const checkpointPath = checkpointPathFor(sessionID, memoryDir);
    await writeText(memoryPath, "original\n");
    await writeText(checkpointPath, "original checkpoint\n");
    await expect(
      resetV2MemoryPersistence(
        sessionID,
        directory,
        "anchor",
        { memoryDir },
        {
          beforeCommit: async (kind) => {
            if (kind === "memory") {
              const targetDirectory = dirname(memoryPath);
              const targetName = basename(memoryPath);
              const tempName = (await readdir(targetDirectory)).find((entry) => entry.startsWith(`${targetName}.tmp-`));
              if (!tempName) throw new Error("prepared memory temp missing");
              await rm(join(targetDirectory, tempName));
            }
          },
        },
      ),
    ).rejects.toBeDefined();
    expect(await readText(memoryPath)).toBe("original\n");
    expect(await readText(checkpointPath)).toBe("original checkpoint\n");
    expect(await withV2MemoryMutation(directory, sessionID, () => "released")).toBe("released");
  });

  test("aborts before writes on a non-ENOENT snapshot error and cleans prepared files on preparation failure", async () => {
    const memoryPath = memoryPathFor("fault", memoryDir);
    await mkdir(memoryPath, { recursive: true });
    await expect(resetV2MemoryPersistence("fault", directory, "anchor", { memoryDir })).rejects.toBeDefined();
    expect((await readdir(memoryDir)).filter((name) => name.includes(".tmp-")).length).toBe(0);

    await rm(memoryPath, { recursive: true, force: true });
    await expect(
      resetV2MemoryPersistence(
        "fault",
        directory,
        "anchor",
        { memoryDir },
        {
          beforePrepare: async () => {
            await writeText(join(memoryDir, "checkpoints"), "not a directory");
          },
        },
      ),
    ).rejects.toBeDefined();
    expect(await readRawFile(memoryPath)).toBeNull();
    expect((await readdir(memoryDir)).filter((name) => name.includes(".tmp-")).length).toBe(0);
  });

  test("reports original cause first and preserves an external rollback conflict", async () => {
    const memoryPath = memoryPathFor("conflict", memoryDir);
    await writeText(memoryPath, "original\n");

    const result = resetV2MemoryPersistence(
      "conflict",
      directory,
      "anchor",
      { memoryDir },
      {
        beforeCommit: async (kind) => {
          if (kind === "checkpoint") {
            await writeText(memoryPath, "external\n");
            throw new Error("original failure");
          }
        },
      },
    );
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    try {
      await result;
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect((aggregate.errors[0] as Error).message).toBe("original failure");
      expect((aggregate.errors[1] as Error).message).toContain("reset rollback conflict");
      expect((aggregate.cause as Error).message).toBe("original failure");
      expect(aggregate.message).toContain("original=original failure");
      expect(aggregate.message).toContain("rollback=reset rollback conflict");
    }
    expect(await readText(memoryPath)).toBe("external\n");
  });

  test("reports a rollback hook failure separately after the original failure", async () => {
    const memoryPath = memoryPathFor("rollback-error", memoryDir);
    await writeText(memoryPath, "original\n");
    const result = resetV2MemoryPersistence(
      "rollback-error",
      directory,
      "anchor",
      { memoryDir },
      {
        beforeCommit: (kind) => {
          if (kind === "checkpoint") throw new Error("original failure");
        },
        beforeRollback: () => {
          throw new Error("rollback failure");
        },
      },
    );
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    try {
      await result;
    } catch (error) {
      const aggregate = error as AggregateError;
      expect((aggregate.errors[0] as Error).message).toBe("original failure");
      expect((aggregate.errors[1] as Error).message).toBe("rollback failure");
      expect((aggregate.cause as Error).message).toBe("original failure");
    }
    expect(await readText(memoryPath)).toBe(STANDARD_MEMORY_TEMPLATE);
  });

  test("detects a forward conflict and releases the lock after every failure", async () => {
    const memoryPath = memoryPathFor("forward", memoryDir);
    await writeText(memoryPath, "before\n");
    await expect(
      resetV2MemoryPersistence(
        "forward",
        directory,
        "anchor",
        { memoryDir },
        {
          beforeCommit: async (kind) => {
            if (kind === "memory") await writeText(memoryPath, "forward external\n");
          },
        },
      ),
    ).rejects.toThrow("reset forward conflict");
    expect(await readText(memoryPath)).toBe("forward external\n");
    expect(await withV2MemoryMutation(directory, "forward", () => "released")).toBe("released");
  });

  test("waits for an updater pair, then rollback restores the updater-committed pair", async () => {
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    await writeText(memoryPathFor("updater", memoryDir), ORIGINAL_MEMORY);
    await writeText(checkpointPathFor("updater", memoryDir), "before\n");
    const generation = deferred<{ text: string }>();
    const started = deferred<void>();
    const updater = createV2MemoryUpdater(updaterContext(directory, generation.promise, started), directory);
    const update = updater(input("updater"));
    await started.promise;
    const reset = resetV2MemoryPersistence(
      "updater",
      directory,
      "anchor",
      { memoryDir },
      {
        beforeCommit: (kind) => {
          if (kind === "checkpoint") throw new Error("reset after updater");
        },
      },
    );
    expect(await readText(checkpointPathFor("updater", memoryDir))).toBe("before\n");
    generation.resolve({ text: VALID_MEMORY });
    await update;
    await expect(reset).rejects.toThrow("reset after updater");
    expect(await readFile(memoryPathFor("updater", memoryDir), "utf8")).toBe(VALID_MEMORY);
    expect(await readFile(checkpointPathFor("updater", memoryDir), "utf8")).toBe("a1\n");
  });

  test("a real updater skips while reset owns the shared mutation", async () => {
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    const generation = deferred<{ text: string }>();
    const calls = { count: 0 };
    const updater = createV2MemoryUpdater(updaterContext(directory, generation.promise, undefined, calls), directory);
    const resetEntered = deferred<void>();
    const releaseReset = deferred<void>();
    const reset = resetV2MemoryPersistence(
      "held",
      directory,
      "anchor",
      { memoryDir },
      {
        beforeCommit: async (kind) => {
          if (kind === "memory") {
            resetEntered.resolve();
            await releaseReset.promise;
          }
        },
      },
    );
    await resetEntered.promise;
    const update = updater(input("held"));
    await update;
    expect(calls.count).toBe(0);
    releaseReset.resolve();
    await reset;
  });
});
