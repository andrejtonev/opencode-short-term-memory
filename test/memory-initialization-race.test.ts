import { afterEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

type Gate = {
  targetPath: string;
  reached: () => void;
  reachedPromise: Promise<void>;
  resume: () => void;
  resumePromise: Promise<void>;
};

function createGate(targetPath: string): Gate {
  let signalReached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    targetPath,
    reached: signalReached,
    reachedPromise,
    resume: release,
    resumePromise,
  };
}

let publicationGate: Gate | undefined;
let temporaryWriteGate: Gate | undefined;
const realLink = realFs.link.bind(realFs);
const realOpen = realFs.open.bind(realFs);

mock.module("node:fs/promises", () => ({
  ...realFs,
  link: async (sourcePath: Parameters<typeof realFs.link>[0], destinationPath: Parameters<typeof realFs.link>[1]) => {
    const gate = publicationGate;
    if (gate && String(destinationPath) === gate.targetPath) {
      publicationGate = undefined;
      gate.reached();
      await gate.resumePromise;
    }
    return await realLink(sourcePath, destinationPath);
  },
  open: async (...args: Parameters<typeof realFs.open>) => {
    const handle = await realOpen(...args);
    const gate = temporaryWriteGate;
    const path = String(args[0]);
    const tempPrefix = gate ? join(dirname(gate.targetPath), `.${basename(gate.targetPath)}.init-`) : "";
    if (!gate || !path.startsWith(tempPrefix)) return handle;

    return {
      writeFile: async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        await handle.writeFile(...writeArgs);
        temporaryWriteGate = undefined;
        gate.reached();
        await gate.resumePromise;
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    } as typeof handle;
  },
}));

const { DEFAULT_CONFIG, STANDARD_MEMORY_TEMPLATE, ensureMemoryFile, memoryPathFor } =
  await import("../src/memory-utils");

describe("ensureMemoryFile initialization races", () => {
  let testDir = "";

  afterEach(async () => {
    publicationGate?.resume();
    temporaryWriteGate?.resume();
    publicationGate = undefined;
    temporaryWriteGate = undefined;
    if (testDir) await realFs.rm(testDir, { recursive: true, force: true });
    testDir = "";
  });

  async function setup(sessionID: string) {
    testDir = await realFs.mkdtemp(join(tmpdir(), "stm-memory-init-race-"));
    const config = { ...DEFAULT_CONFIG, memoryDir: join(testDir, "memory") };
    return { config, path: memoryPathFor(sessionID, config.memoryDir) };
  }

  test("preserves a writer that publishes after staging but before create-if-absent", async () => {
    const { config, path } = await setup("external-writer");
    const gate = createGate(path);
    publicationGate = gate;

    const initialization = ensureMemoryFile("external-writer", config);
    await gate.reachedPromise;

    const stagedPaths = (await realFs.readdir(dirname(path))).filter((entry) =>
      entry.startsWith(`.${basename(path)}.init-`),
    );
    expect(stagedPaths).toHaveLength(1);
    expect(await realFs.readFile(join(dirname(path), stagedPaths[0]!), "utf8")).toBe(STANDARD_MEMORY_TEMPLATE);

    const externalSeed = "## Session Memory\n\n- EXTERNAL_SEED_SENTINEL\n";
    await realFs.writeFile(path, externalSeed, "utf8");
    gate.resume();

    await expect(initialization).resolves.toBe(path);
    expect(await realFs.readFile(path, "utf8")).toBe(externalSeed);
    expect((await realFs.readdir(dirname(path))).filter((entry) => entry.includes(".init-"))).toEqual([]);
  });

  test("preserves existing empty and whitespace-only files byte for byte", async () => {
    testDir = await realFs.mkdtemp(join(tmpdir(), "stm-memory-init-race-"));
    const config = { ...DEFAULT_CONFIG, memoryDir: join(testDir, "memory") };
    for (const [sessionID, original] of [
      ["empty", ""],
      ["whitespace", " \r\n\t "],
    ] as const) {
      const path = memoryPathFor(sessionID, config.memoryDir);
      await realFs.mkdir(dirname(path), { recursive: true });
      await realFs.writeFile(path, original, "utf8");

      await expect(ensureMemoryFile(sessionID, config)).resolves.toBe(path);
      expect(await realFs.readFile(path, "utf8")).toBe(original);
    }
  });

  test("concurrent initializers leave one complete template and no staging files", async () => {
    const { config, path } = await setup("concurrent");

    const results = await Promise.all(Array.from({ length: 12 }, () => ensureMemoryFile("concurrent", config)));

    expect(new Set(results)).toEqual(new Set([path]));
    expect(await realFs.readFile(path, "utf8")).toBe(STANDARD_MEMORY_TEMPLATE);
    expect((await realFs.readdir(dirname(path))).filter((entry) => entry.includes(".init-"))).toEqual([]);
  });

  test("a stale operation removes its staged template without publishing it", async () => {
    const { config, path } = await setup("stale-operation");
    const gate = createGate(path);
    temporaryWriteGate = gate;
    let valid = true;

    const initialization = ensureMemoryFile("stale-operation", config, () => valid);
    await gate.reachedPromise;
    valid = false;
    gate.resume();

    await expect(initialization).rejects.toThrow("cancelled");
    await expect(realFs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await realFs.readdir(dirname(path))).filter((entry) => entry.includes(".init-"))).toEqual([]);
  });
});
