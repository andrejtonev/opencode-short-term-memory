import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred } from "./async-helpers";

const memoryUtils = await import("../src/memory-utils");
const actualLogEvent = memoryUtils.logEvent;
let readGate: { started: ReturnType<typeof deferred<void>>; released: ReturnType<typeof deferred<void>> } | undefined;
mock.module("../src/memory-utils", () => ({
  ...memoryUtils,
  logEvent: async (...args: Parameters<typeof actualLogEvent>) => {
    const gate = readGate;
    if (gate && args[1] === "tool_memory" && args[2]?.action === "show") {
      gate.started.resolve();
      await gate.released.promise;
    }
    return actualLogEvent(...args);
  },
}));
const { createPlugin, createFakeClient } = await import("./test-helpers");
const { runCleanOpencodeSummarizer, CLEAN_SUMMARIZER_CLEANUP_TIMEOUT } = await import("../src/summarizer");
const originalCwd = process.cwd();
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalCleanupTimeout = CLEAN_SUMMARIZER_CLEANUP_TIMEOUT.ms;
let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stm-v1-read-cleanup-"));
  process.chdir(root);
  process.env.XDG_CONFIG_HOME = join(root, "global");
  process.env.OPENCODE_CONFIG_DIR = join(root, "config");
  CLEAN_SUMMARIZER_CLEANUP_TIMEOUT.ms = 20;
});
afterEach(async () => {
  readGate?.released.resolve();
  readGate = undefined;
  CLEAN_SUMMARIZER_CLEANUP_TIMEOUT.ms = originalCleanupTimeout;
  process.chdir(originalCwd);
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
  await rm(root, { recursive: true, force: true });
});

async function withinDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cleanup prevented caller settlement")), 500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

for (const tool of ["named", "legacy"] as const) {
  test(`${tool} V1 read reports missing memory without creating a file`, async () => {
    const { plugin } = await createPlugin({ debounceMs: 120000 });
    const id = `missing-${tool}`;
    const result =
      tool === "named"
        ? await plugin.tool.stm_memory_read.execute({}, { sessionID: id })
        : await plugin.tool.short_term_memory.execute({ action: "show" }, { sessionID: id });
    expect(result).toContain("No memory file");
    expect(await memoryUtils.readText(memoryUtils.memoryPathFor(id), "MISSING")).toBe("MISSING");
  });
}

test("a V1 read admitted before deletion cannot recreate the deleted memory", async () => {
  const { plugin } = await createPlugin({ debounceMs: 120000 });
  const id = "deleted-read";
  await plugin["session.created"]({ sessionID: id });
  readGate = { started: deferred<void>(), released: deferred<void>() };
  const pending = plugin.tool.stm_memory_read.execute({}, { sessionID: id });
  await readGate.started.promise;
  await plugin["session.deleted"]({ sessionID: id });
  readGate.released.resolve();
  expect(await pending).toContain("No memory file");
  expect(await memoryUtils.readText(memoryUtils.memoryPathFor(id), "MISSING")).toBe("MISSING");
});

test("clean Update commits before stalled cleanup and late success removes only its own tracking entry", async () => {
  const released = deferred<void>();
  const deleted = deferred<void>();
  const client = createFakeClient({ messagesRows: [{ id: "u1", role: "user", text: "Retain this instruction" }] });
  client.session.delete = async () => {
    try {
      await released.promise;
      return { data: true };
    } finally {
      deleted.resolve();
    }
  };
  const { plugin } = await createPlugin({ debounceMs: 120000 }, client);
  const pending = plugin.tool.stm_memory_update.execute({}, { sessionID: "primary" });
  try {
    const result = await withinDeadline(pending);
    expect(result).toContain("updated from prompt");
    expect(await memoryUtils.readText(memoryUtils.checkpointPathFor("primary"))).toBe("u1\n");
    expect(await withinDeadline(plugin.tool.stm_memory_update.execute({}, { sessionID: "primary" }))).toContain(
      "no_visible_recent_messages",
    );
    const tracked = await memoryUtils.loadActiveSideSessions(memoryUtils.DEFAULT_CONFIG.memoryDir);
    expect(tracked).toHaveLength(1);
    await memoryUtils.mutateActiveSideSessions(memoryUtils.DEFAULT_CONFIG.memoryDir, (ids) => [
      ...ids,
      "other-owned-side",
    ]);
    released.resolve();
    await deleted.promise;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!(await memoryUtils.loadActiveSideSessions(memoryUtils.DEFAULT_CONFIG.memoryDir)).includes(tracked[0]!))
        break;
      await Bun.sleep(10);
    }
    expect(await memoryUtils.loadActiveSideSessions(memoryUtils.DEFAULT_CONFIG.memoryDir)).toEqual([
      "other-owned-side",
    ]);
  } finally {
    released.resolve();
    await deleted.promise;
    await pending.catch(() => undefined);
  }
});

test("stalled cleanup preserves a generation failure and retains its side-session ownership", async () => {
  const released = deferred<void>();
  const deleted = deferred<void>();
  const config = { ...memoryUtils.DEFAULT_CONFIG, memoryDir: join(root, "memory") };
  const pending = runCleanOpencodeSummarizer(
    {
      createTemporarySession: async () => ({ id: "failed-generation" }),
      deliverGeneratedPrompt: async () => {
        throw new Error("Generation failed");
      },
      abortTemporarySession: async () => {},
      deleteTemporarySession: async () => {
        try {
          await released.promise;
        } finally {
          deleted.resolve();
        }
      },
    },
    "prompt",
    config,
  );
  try {
    await expect(withinDeadline(pending)).rejects.toThrow("Generation failed");
    expect(await memoryUtils.loadActiveSideSessions(config.memoryDir)).toEqual(["failed-generation"]);
  } finally {
    released.resolve();
    await deleted.promise;
    await pending.catch(() => undefined);
  }
});

test("late cleanup rejection retains ownership and does not replace a valid summary", async () => {
  const released = deferred<void>();
  const deleted = deferred<void>();
  const config = { ...memoryUtils.DEFAULT_CONFIG, memoryDir: join(root, "memory") };
  const pending = runCleanOpencodeSummarizer(
    {
      createTemporarySession: async () => ({ id: "late-failure" }),
      deliverGeneratedPrompt: async () => ({
        data: {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "## Session Memory\n\n### User Instructions\n- valid result" }],
        },
      }),
      abortTemporarySession: async () => {},
      deleteTemporarySession: async () => {
        try {
          await released.promise;
          throw new Error("Late delete failure");
        } finally {
          deleted.resolve();
        }
      },
    },
    "prompt",
    config,
  );
  try {
    expect(await withinDeadline(pending)).toContain("valid result");
    expect(await memoryUtils.loadActiveSideSessions(config.memoryDir)).toEqual(["late-failure"]);
    released.resolve();
    await deleted.promise;
    await Bun.sleep(10);
    expect(await memoryUtils.loadActiveSideSessions(config.memoryDir)).toEqual(["late-failure"]);
  } finally {
    released.resolve();
    await deleted.promise;
    await pending.catch(() => undefined);
  }
});
