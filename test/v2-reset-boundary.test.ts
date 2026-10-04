import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  MEMORY_HEADER,
  checkpointPathFor,
  memoryPathFor,
  readRawFile,
  readText,
  resetBoundaryPathFor,
  writeText,
} from "../src/memory-utils";
import type { V2Context, V2SessionContext } from "../src/v2-adapter";
import { createV2MemoryUpdater } from "../src/v2-memory-update";
import { resetV2MemoryPersistence } from "../src/v2-reset-persistence";

const VALID_MEMORY = `${MEMORY_HEADER}

### User Instructions
- Keep this.

### Long Horizon Context
- Keep this.

### Decisions
- Keep this.

### Conclusions
- Keep this.

### Active References
- Keep this.
`;

function message(id: string, role: string, text = "") {
  return { id, role, content: [{ type: "text", text }] };
}

function context(directory: string, calls: { prompts: string[] }) {
  const value = {
    location: { directory, project: { id: "p", directory, canonical: directory } },
    options: {},
    session: { generate: async () => ({ text: VALID_MEMORY }), hook: async () => ({ dispose: async () => undefined }) },
    generate: {
      text: async ({ prompt }: { prompt: string }) => {
        calls.prompts.push(prompt);
        return { text: VALID_MEMORY };
      },
    },
    tool: { transform: async () => ({ dispose: async () => undefined }) },
  };
  return value as unknown as V2Context;
}

function input(sessionID: string, messages: unknown[]): V2SessionContext {
  return {
    sessionID,
    agent: "agent",
    model: { providerID: "provider", id: "model" },
    system: [],
    messages,
    options: {},
    tools: {},
  } as unknown as V2SessionContext;
}

function conversation(prompt: string): string {
  const start = prompt.lastIndexOf("<conversation_update>");
  const end = prompt.lastIndexOf("</conversation_update>");
  return prompt.slice(start + "<conversation_update>".length, end);
}

describe("V2 reset boundary", () => {
  let directory = "";
  let memoryDir = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stm-v2-boundary-"));
    memoryDir = join(directory, "memory");
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
  });

  afterEach(async () => rm(directory, { recursive: true, force: true }));

  test("writes the exact versioned boundary and excludes old messages while accepting a tool-only anchor", async () => {
    await resetV2MemoryPersistence("causal", directory, "tool-anchor");
    const boundary = resetBoundaryPathFor("causal", memoryDir);
    expect(await readFile(boundary, "utf8")).toBe('{"version":1,"anchorID":"tool-anchor"}\n');
    const calls = { prompts: [] as string[] };
    await createV2MemoryUpdater(
      context(directory, calls),
      directory,
    )(
      input("causal", [
        message("old", "user", "OLD_SENTINEL"),
        message("tool-anchor", "tool", ""),
        message("new", "user", "NEW_SENTINEL"),
        message("answer", "assistant", "new answer"),
      ]),
    );
    expect(calls.prompts).toHaveLength(1);
    expect(conversation(calls.prompts[0]!)).not.toContain("OLD_SENTINEL");
    expect(conversation(calls.prompts[0]!)).toContain("NEW_SENTINEL");
    expect(await readFile(boundary, "utf8")).toBe('{"version":1,"anchorID":"tool-anchor"}\n');
  });

  test("keeps rebasing inside the post-anchor suffix and survives a fresh updater instance", async () => {
    await resetV2MemoryPersistence("restart", directory, "anchor");
    await writeFile(checkpointPathFor("restart", memoryDir), "checkpoint-before-anchor\n");
    const firstCalls = { prompts: [] as string[] };
    await createV2MemoryUpdater(
      context(directory, firstCalls),
      directory,
    )(
      input("restart", [message("old", "user", "OLD"), message("anchor", "user"), message("a1", "assistant", "FIRST")]),
    );
    expect(conversation(firstCalls.prompts[0]!)).not.toContain("OLD");
    expect(conversation(firstCalls.prompts[0]!)).toContain("FIRST");
    const secondCalls = { prompts: [] as string[] };
    await createV2MemoryUpdater(
      context(directory, secondCalls),
      directory,
    )(
      input("restart", [
        message("anchor", "user"),
        message("a1", "assistant", "FIRST"),
        message("a2", "assistant", "SECOND"),
      ]),
    );
    expect(secondCalls.prompts).toHaveLength(1);
    expect(conversation(secondCalls.prompts[0]!)).toContain("SECOND");
    expect(await readText(checkpointPathFor("restart", memoryDir))).toBe("a2\n");
    expect(await readRawFile(resetBoundaryPathFor("restart", memoryDir))).not.toBeNull();
  });

  test.each([
    ["missing", [message("other", "user", "before"), message("a", "assistant", "answer")]],
    ["compaction-like", []],
    ["duplicate", [message("anchor", "user"), message("anchor", "tool"), message("a", "assistant", "answer")]],
    [
      "numeric-coercion",
      [{ id: 42, role: "user", content: [{ type: "text", text: "before" }] }, message("a", "assistant", "answer")],
    ],
  ])("fails closed for %s anchor snapshots", async (_name, messages) => {
    await resetV2MemoryPersistence("closed", directory, "anchor");
    const memoryPath = memoryPathFor("closed", memoryDir);
    const checkpointPath = checkpointPathFor("closed", memoryDir);
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(memoryPath, Buffer.from("original memory\n"));
    await writeFile(checkpointPath, Buffer.from("original checkpoint\n"));
    const calls = { prompts: [] as string[] };
    expect(await createV2MemoryUpdater(context(directory, calls), directory)(input("closed", messages))).toEqual({
      status: "skipped",
      reason: _name === "duplicate" ? "reset_boundary_anchor_duplicate" : "reset_boundary_anchor_missing",
      checkpointedChunks: 0,
      checkpointedMessages: 0,
      persistedPartialFragments: 0,
    });
    expect(calls.prompts).toHaveLength(0);
    expect(await readFile(memoryPath, "utf8")).toBe("original memory\n");
    expect(await readFile(checkpointPath, "utf8")).toBe("original checkpoint\n");
  });

  test.each([
    ["empty", ""],
    ["malformed", "{"],
    ["extra-key", '{"version":1,"anchorID":"anchor","extra":true}'],
    ["wrong-version", '{"version":2,"anchorID":"anchor"}'],
  ])("fails closed for %s boundary data", async (_name, raw) => {
    const boundary = resetBoundaryPathFor("invalid", memoryDir);
    await writeText(boundary, raw);
    const memoryPath = memoryPathFor("invalid", memoryDir);
    const checkpointPath = checkpointPathFor("invalid", memoryDir);
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(memoryPath, "memory before\n");
    await writeFile(checkpointPath, "checkpoint before\n");
    const calls = { prompts: [] as string[] };
    await createV2MemoryUpdater(
      context(directory, calls),
      directory,
    )(input("invalid", [message("anchor", "user"), message("a", "assistant", "answer")]));
    expect(calls.prompts).toHaveLength(0);
    expect(await readFile(memoryPath, "utf8")).toBe("memory before\n");
    expect(await readFile(checkpointPath, "utf8")).toBe("checkpoint before\n");
  });

  test("fails closed for an unreadable boundary and rejects empty anchors before filesystem side effects", async () => {
    const unreadable = resetBoundaryPathFor("unreadable", memoryDir);
    await mkdir(unreadable, { recursive: true });
    const calls = { prompts: [] as string[] };
    await createV2MemoryUpdater(
      context(directory, calls),
      directory,
    )(input("unreadable", [message("anchor", "user"), message("a", "assistant", "answer")]));
    expect(calls.prompts).toHaveLength(0);
    await expect(resetV2MemoryPersistence("empty-anchor", directory, "   ")).rejects.toThrow("nonempty");
    expect(await readdir(memoryDir)).toEqual(["session-memory.log", "reset-boundaries"]);
  });

  test("second reset replaces the anchor and third-file rename failure restores every original byte", async () => {
    await resetV2MemoryPersistence("replace", directory, "first");
    await resetV2MemoryPersistence("replace", directory, "second");
    expect(await readFile(resetBoundaryPathFor("replace", memoryDir), "utf8")).toBe(
      '{"version":1,"anchorID":"second"}\n',
    );

    const memoryPath = memoryPathFor("rollback", memoryDir);
    const checkpointPath = checkpointPathFor("rollback", memoryDir);
    const boundaryPath = resetBoundaryPathFor("rollback", memoryDir);
    await writeText(memoryPath, "old memory\n");
    await writeText(checkpointPath, "old checkpoint\n");
    await writeText(boundaryPath, '{"version":1,"anchorID":"old"}\n');
    await expect(
      resetV2MemoryPersistence("rollback", directory, "new", undefined, {
        beforeCommit: async (kind) => {
          if (kind !== "boundary") return;
          const target = dirname(boundaryPath);
          const name = (await readdir(target)).find((entry) => entry.startsWith(`${basename(boundaryPath)}.tmp-`));
          if (!name) throw new Error("prepared boundary temp missing");
          await rm(join(target, name));
        },
      }),
    ).rejects.toBeDefined();
    expect(await readFile(memoryPath, "utf8")).toBe("old memory\n");
    expect(await readFile(checkpointPath, "utf8")).toBe("old checkpoint\n");
    expect(await readFile(boundaryPath, "utf8")).toBe('{"version":1,"anchorID":"old"}\n');
  });

  test("restores absence after a third commit failure", async () => {
    const memoryPath = memoryPathFor("absent-rollback", memoryDir);
    const checkpointPath = checkpointPathFor("absent-rollback", memoryDir);
    const boundaryPath = resetBoundaryPathFor("absent-rollback", memoryDir);
    await expect(
      resetV2MemoryPersistence("absent-rollback", directory, "anchor", undefined, {
        beforeCommit: async (kind) => {
          if (kind !== "boundary") return;
          const target = dirname(boundaryPath);
          const name = (await readdir(target)).find((entry) => entry.startsWith(`${basename(boundaryPath)}.tmp-`));
          if (!name) throw new Error("prepared boundary temp missing");
          await rm(join(target, name));
        },
      }),
    ).rejects.toBeDefined();
    expect(await readRawFile(memoryPath)).toBeNull();
    expect(await readRawFile(checkpointPath)).toBeNull();
    expect(await readRawFile(boundaryPath)).toBeNull();
  });

  test("cleans the first two preparations when the third preparation fails", async () => {
    const memoryPath = memoryPathFor("preparation-failure", memoryDir);
    const checkpointPath = checkpointPathFor("preparation-failure", memoryDir);
    const boundaryParent = dirname(resetBoundaryPathFor("preparation-failure", memoryDir));
    await expect(
      resetV2MemoryPersistence("preparation-failure", directory, "anchor", undefined, {
        beforePrepare: async () => {
          await mkdir(memoryDir, { recursive: true });
          await writeFile(boundaryParent, "not a directory\n");
        },
      }),
    ).rejects.toBeDefined();
    expect(await readRawFile(memoryPath)).toBeNull();
    expect(await readRawFile(checkpointPath)).toBeNull();
    expect(await readFile(boundaryParent, "utf8")).toBe("not a directory\n");
    expect((await readdir(memoryDir)).some((entry) => entry.includes(".tmp-"))).toBe(false);
  });
});
