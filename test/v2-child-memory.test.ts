import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { V2Context } from "../src/v2-adapter";
import { classifyV2Session, readTaskChildMemory, taskChildUpdaterSkip } from "../src/v2-child-memory";
import { createV2ContextInjection } from "../src/v2-context-injection";
import { createV2MemoryActions } from "../src/v2-memory-tools";
import {
  MEMORY_FORMAT_VERSION,
  MEMORY_HEADER,
  memoryPathFor,
  resetBoundaryPathFor,
  writeText,
} from "../src/memory-utils";

const MEMORY = `${MEMORY_HEADER}\n\n### User Instructions\n- parent\n\n### Long Horizon Context\n- context\n`;
const config = (memoryDir: string, maxMemoryLength = 10_000, injectInSubagents = true) => ({
  memoryDir,
  maxMemoryLength,
  injectInSubagents,
});

function context(directory: string, record: Record<string, unknown>): V2Context {
  return {
    location: { directory, project: { id: "project", directory, canonical: directory } },
    session: { get: async () => record },
  } as unknown as V2Context;
}

describe("V2 task-child memory", () => {
  let directory = "";
  let memoryDir = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stm-v2-child-memory-"));
    memoryDir = join(directory, "memory");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("inherits task children but leaves omitted-parent primaries and explicit forks primary", async () => {
    await writeText(memoryPathFor("parent", memoryDir), MEMORY);
    const child = await readTaskChildMemory(
      context(directory, { id: "child", parentID: "parent" }),
      { sessionID: "child" },
      config(memoryDir),
      directory,
    );
    expect(child).toMatchObject({ status: "injected", memory: MEMORY });
    for (const record of [
      { id: "primary" },
      { id: "primary", parentID: undefined },
      { id: "primary", parentID: null },
      { id: "fork", fork: { sessionID: "parent", boundary: { type: "through", messageID: "msg_parent" } } },
    ]) {
      const primaryContext = context(directory, record);
      expect(await classifyV2Session(primaryContext, record.id)).toEqual({ kind: "primary" });
      expect(await readTaskChildMemory(primaryContext, { sessionID: record.id }, config(memoryDir), directory)).toEqual(
        {
          status: "injected",
        },
      );
      expect(await taskChildUpdaterSkip(primaryContext, record.id)).toBeUndefined();
      expect(await Bun.file(join(memoryDir, "task-children", `${record.id}.json`)).exists()).toBe(false);
    }
    expect(await taskChildUpdaterSkip(context(directory, { id: "child", parentID: "parent" }), "child")).toBe(
      "task_child_inheritance",
    );
  });

  test("requires an exact ID before accepting absent lineage and rejects malformed parent IDs", async () => {
    for (const record of [{}, { id: "other" }, { id: null }, { id: 1 }]) {
      expect(await classifyV2Session(context(directory, record), "child")).toEqual({
        kind: "metadata-error",
        detail: "session_id_mismatch",
      });
    }
    for (const parentID of ["", " ", 0, false, {}, [], "child", "parent/unsafe"]) {
      const invalidContext = context(directory, { id: "child", parentID });
      expect((await classifyV2Session(invalidContext, "child")).kind).toBe("metadata-error");
      expect(await taskChildUpdaterSkip(invalidContext, "child")).toBe("session_metadata_unavailable");
    }
  });

  test("freezes the first parent snapshot across updates and reloads", async () => {
    await writeText(memoryPathFor("parent", memoryDir), MEMORY);
    const first = await readTaskChildMemory(
      context(directory, { id: "child", parentID: "parent" }),
      { sessionID: "child" },
      config(memoryDir),
      directory,
    );
    await writeText(memoryPathFor("parent", memoryDir), `${MEMORY}\nnew parent content`);
    const second = await readTaskChildMemory(
      context(directory, { id: "child", parentID: "parent" }),
      { sessionID: "child" },
      config(memoryDir),
      directory,
    );
    expect(second).toEqual(first);
  });

  test("fails closed for metadata, self-parent, and corrupt state", async () => {
    await writeText(memoryPathFor("parent", memoryDir), MEMORY);
    expect(
      await readTaskChildMemory(
        context(directory, { parentID: "parent" }),
        { sessionID: "child" },
        config(memoryDir),
        directory,
      ),
    ).toMatchObject({ status: "metadata-error" });
    expect(
      await readTaskChildMemory(
        context(directory, { id: "child", parentID: "child" }),
        { sessionID: "child" },
        config(memoryDir),
        directory,
      ),
    ).toMatchObject({ status: "metadata-error" });
    await writeText(join(memoryDir, "task-children", "child.json"), "not json");
    expect(
      await readTaskChildMemory(
        context(directory, { id: "child", parentID: "parent" }),
        { sessionID: "child" },
        config(memoryDir),
        directory,
      ),
    ).toEqual({ status: "invalid-state" });
  });

  test("rejects unsafe IDs before deriving either memory path", async () => {
    const result = await readTaskChildMemory(
      context(directory, { id: "child/one", parentID: "parent" }),
      { sessionID: "child/one" },
      config(memoryDir),
      directory,
    );
    expect(result).toEqual({ status: "metadata-error" });
  });

  test("rejects a header buried in a parent prefix and oversized files without recapture", async () => {
    await writeText(memoryPathFor("parent", memoryDir), `untrusted prefix\n${MEMORY}`);
    expect(
      await readTaskChildMemory(
        context(directory, { id: "child", parentID: "parent" }),
        { sessionID: "child" },
        config(memoryDir),
        directory,
      ),
    ).toEqual({ status: "invalid-state" });

    await writeText(memoryPathFor("parent", memoryDir), `${MEMORY}${"x".repeat(10_000)}`);
    expect(
      await readTaskChildMemory(
        context(directory, { id: "child", parentID: "parent" }),
        { sessionID: "child" },
        config(memoryDir, 40),
        directory,
      ),
    ).toEqual({ status: "invalid-state" });

    await writeText(join(memoryDir, "task-children", "child.json"), `${"x".repeat(5_000)}`);
    expect(
      await readTaskChildMemory(
        context(directory, { id: "child", parentID: "parent" }),
        { sessionID: "child" },
        config(memoryDir, 40),
        directory,
      ),
    ).toEqual({ status: "invalid-state" });
  });

  test("accepts the canonical versioned memory prefix", async () => {
    const versioned = `${MEMORY_FORMAT_VERSION}\n${MEMORY}`;
    await writeText(memoryPathFor("parent", memoryDir), versioned);
    const result = await readTaskChildMemory(
      context(directory, { id: "child", parentID: "parent" }),
      { sessionID: "child" },
      config(memoryDir),
      directory,
    );
    expect(result).toMatchObject({ status: "injected", memory: versioned });
  });

  test("reset boundary permanently suppresses child injection", async () => {
    await writeText(memoryPathFor("parent", memoryDir), MEMORY);
    await writeText(resetBoundaryPathFor("child", memoryDir), '{"version":1,"anchorID":"a1"}\n');
    expect(
      await readTaskChildMemory(
        context(directory, { id: "child", parentID: "parent" }),
        { sessionID: "child" },
        config(memoryDir),
        directory,
      ),
    ).toEqual({ status: "suppressed" });
  });

  test("bounds persisted snapshots", async () => {
    await writeText(memoryPathFor("parent", memoryDir), MEMORY);
    await readTaskChildMemory(
      context(directory, { id: "child", parentID: "parent" }),
      { sessionID: "child" },
      config(memoryDir, 40),
      directory,
    );
    const saved = await readFile(join(memoryDir, "task-children", "child.json"), "utf8");
    expect(JSON.parse(saved).memory.length).toBeLessThanOrEqual(40);
  });

  test("uses the same frozen snapshot for fresh context arrays and honors injectInSubagents false", async () => {
    await writeText(memoryPathFor("parent", memoryDir), MEMORY);
    const childContext = context(directory, { id: "child", parentID: "parent" });
    const injection = createV2ContextInjection(childContext, directory);
    const first = { sessionID: "child", system: [] } as never;
    await injection(first);
    await writeText(memoryPathFor("parent", memoryDir), `${MEMORY}\nnew parent content`);
    const second = { sessionID: "child", system: [] } as never;
    await injection(second);
    expect(second.system).toEqual(first.system);

    const disabled = await readTaskChildMemory(
      context(directory, { id: "disabled-child", parentID: "parent" }),
      { sessionID: "disabled-child" },
      config(memoryDir, 10_000, false),
      directory,
    );
    expect(disabled).toEqual({ status: "suppressed" });
  });

  test("actual reset action creates durable suppression without a child snapshot", async () => {
    await writeText(memoryPathFor("parent", memoryDir), MEMORY);
    await writeText(join(directory, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    const childContext = context(directory, { id: "child", parentID: "parent" });
    const actions = createV2MemoryActions(childContext);
    const result = await actions.reset("child", { confirm: true, messageID: "anchor-1" });
    expect(result).toContain("reset: completed");
    expect(await Bun.file(resetBoundaryPathFor("child", memoryDir)).exists()).toBe(true);
    expect(await readTaskChildMemory(childContext, { sessionID: "child" }, config(memoryDir), directory)).toEqual({
      status: "suppressed",
    });
    expect(await Bun.file(join(memoryDir, "task-children", "child.json")).exists()).toBe(false);
  });
});
