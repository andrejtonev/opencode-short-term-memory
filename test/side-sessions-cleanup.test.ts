import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin, createFakeClient } from "./test-helpers";
import {
  DEFAULT_CONFIG,
  readText,
  sideSessionsStatePath,
  loadActiveSideSessions,
  mutateActiveSideSessions,
  saveActiveSideSessions,
  writeText,
  writeTextAtomic,
} from "../src/memory-utils";

const originalCwd = process.cwd();
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalLocalAppData = process.env.LOCALAPPDATA;
let testDir = "";

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "opencode-side-session-cleanup-test-"));
  process.env.XDG_CONFIG_HOME = join(testDir, ".xdg");
  process.env.OPENCODE_CONFIG_DIR = join(testDir, ".config-dir");
  delete process.env.LOCALAPPDATA;
  process.chdir(testDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  rm(testDir, { recursive: true, force: true }).catch(() => {});
});

describe("Side session tracking and orphan cleanup", () => {
  test("clean summarizer records side session in state file and removes it on delete", async () => {
    const sessionID = `track-${Date.now()}`;
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "track me" },
        { id: "m2", role: "assistant", content: "ok" },
      ],
      promptText: "## Session Memory\n\n### Active References\n- tracked\n",
    });

    // The summarizer's flow is: create side session → ADD to tracking file →
    // prompt. We hook the prompt call (which is strictly after the tracking
    // add) and at that exact point the tracking file MUST contain the new
    // side-session ID. The previous test only checked before/after, which
    // passed vacuously when the add step was removed.
    let midFlightTracked: string[] = [];
    let midFlightNewID: string | undefined;
    const originalPrompt = fakeClient.session.prompt;
    fakeClient.session.prompt = async (args?: unknown) => {
      midFlightTracked = await loadActiveSideSessions(DEFAULT_CONFIG.memoryDir);
      const a = args as { path?: { id?: string } } | undefined;
      midFlightNewID = a?.path?.id;
      return originalPrompt(args);
    };

    const { plugin } = await createPlugin({ summarizerMode: "clean", debug: false }, fakeClient);
    await plugin["session.created"]({ sessionID });

    // Before the update runs, the state file should not exist (or be empty)
    const before = await loadActiveSideSessions(DEFAULT_CONFIG.memoryDir);
    expect(before).toEqual([]);

    await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID });

    // After successful update, state file should be empty (entry was added then removed)
    const after = await loadActiveSideSessions(DEFAULT_CONFIG.memoryDir);
    expect(after).toEqual([]);

    // At the time prompt() fired, the tracking file must have already
    // contained the new side-session ID (proving the ADD step ran).
    expect(midFlightNewID).toBeDefined();
    expect(midFlightTracked).toContain(midFlightNewID);

    // Confirm the summarizer actually created and deleted the side session.
    expect(fakeClient.calls.create.length).toBeGreaterThanOrEqual(1);
    expect(fakeClient.calls.delete.length).toBeGreaterThanOrEqual(1);
  });

  test("orphan side sessions in state file are cleaned up on next startup", async () => {
    // Simulate a previous run that crashed: leave two side-session IDs in the state file.
    const memoryDir = DEFAULT_CONFIG.memoryDir;
    const path = sideSessionsStatePath(memoryDir);
    await writeTextAtomic(path, JSON.stringify(["orphan-1", "orphan-2"]));

    const fakeClient = createFakeClient();
    // Pre-populate list with another orphan the plugin might find by title
    const originalList = fakeClient.session.list!.bind(fakeClient.session);
    fakeClient.session.list = async (args?: unknown) => {
      const result = (await originalList(args)) as { data?: unknown[] };
      return { data: [{ id: "live-orphan", title: "Session Memory Summarizer" }] };
    };

    const { plugin } = await createPlugin({ debug: false }, fakeClient);

    // Wait deterministically for the background init / cleanup to complete
    // (we poll for the log file rather than using a fixed sleep).
    const logPath = join(".opencode", "memory", "session-memory.log");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const txt = await readText(logPath, "");
      if (txt.includes("orphan_side_sessions_cleanup_done")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // All three orphans should have been deleted
    const deletedIds = fakeClient.calls.delete
      .map((c) => (c as { path?: { id?: string } })?.path?.id)
      .filter((id): id is string => typeof id === "string");
    expect(deletedIds).toContain("orphan-1");
    expect(deletedIds).toContain("orphan-2");
    expect(deletedIds).toContain("live-orphan");

    // State file should be empty now
    const remaining = await loadActiveSideSessions(memoryDir);
    expect(remaining).toEqual([]);

    // Verify the cleanup was logged
    const logText = await readText(logPath, "");
    expect(logText).toContain("orphan_side_sessions_cleanup_start");
    expect(logText).toContain("orphan_side_sessions_cleanup_done");

    await plugin["session.deleted"]({ sessionID: "noop" }).catch(() => {});
  });

  test("orphan side sessions that fail to delete are preserved in the tracking file", async () => {
    // Simulate a previous run that crashed: leave a side session in the state file.
    const memoryDir = DEFAULT_CONFIG.memoryDir;
    const path = sideSessionsStatePath(memoryDir);
    await writeTextAtomic(path, JSON.stringify(["will-fail-1", "will-succeed-1"]));

    const fakeClient = createFakeClient();
    // Make the delete for "will-fail-1" return a non-404 error so cleanup
    // treats it as a real failure (server unavailable, etc.) and keeps the
    // ID in the tracking file for retry. 404 / NotFoundError is special-cased
    // below as a successful "session is already gone".
    fakeClient.session.delete = async (args?: unknown) => {
      fakeClient.calls.delete.push(args);
      const a = args as { path?: { id?: string } } | undefined;
      if (a?.path?.id === "will-fail-1") {
        return { data: undefined, error: { name: "InternalServerError", message: "simulated" } };
      }
      return { data: true };
    };

    await createPlugin({ debug: false }, fakeClient);

    // Wait deterministically for the cleanup to complete.
    const logPath = join(".opencode", "memory", "session-memory.log");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const txt = await readText(logPath, "");
      if (txt.includes("orphan_side_sessions_cleanup_done")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The failed delete must remain in the tracking file for the next run.
    const remaining = await loadActiveSideSessions(memoryDir);
    expect(remaining).toEqual(["will-fail-1"]);

    // The cleanup log should reflect the partial failure.
    const logText = await readText(logPath, "");
    expect(logText).toContain("orphan_side_sessions_cleanup_failed");
    expect(logText).toContain("will-fail-1");
  });

  test("orphan side sessions that 404 on delete are cleared from the tracking file", async () => {
    // A NotFoundError means the session is already gone (e.g. it was
    // manually deleted, or the previous run's process exited before the
    // tracker could update). The cleanup must treat this as success and
    // drop the ID from the file — otherwise we leak entries forever.
    const memoryDir = DEFAULT_CONFIG.memoryDir;
    const path = sideSessionsStatePath(memoryDir);
    await writeTextAtomic(path, JSON.stringify(["already-gone-1", "already-gone-2"]));

    const fakeClient = createFakeClient();
    fakeClient.session.delete = async (args?: unknown) => {
      fakeClient.calls.delete.push(args);
      return { data: undefined, error: { name: "NotFoundError", message: "session not found" } };
    };

    await createPlugin({ debug: false }, fakeClient);

    const logPath = join(".opencode", "memory", "session-memory.log");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const txt = await readText(logPath, "");
      if (txt.includes("orphan_side_sessions_cleanup_done")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Both 404'd sessions should be dropped from the tracking file.
    const remaining = await loadActiveSideSessions(memoryDir);
    expect(remaining).toEqual([]);
  });

  test("plugin factory returns quickly without blocking on I/O", async () => {
    // Create a fresh temp dir under a slow-ish path
    const slowDir = await mkdtemp(join(tmpdir(), "opencode-startup-bench-"));
    process.chdir(slowDir);
    const fakeClient = createFakeClient();

    const t0 = performance.now();
    const factoryPromise = (await import("../src/session-memory")).default({
      client: fakeClient as unknown as Parameters<typeof import("../src/session-memory").default>[0]["client"],
      directory: slowDir,
    });
    // Factory itself is async; the body has no awaits, so the returned
    // promise resolves in one microtask. A setTimeout(0) yields to the
    // macrotask queue and guarantees resolution has happened.
    let returned = false;
    factoryPromise.then(() => {
      returned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const elapsed = performance.now() - t0;
    expect(returned).toBe(true);
    // Hard requirement: the factory must return in <10ms. Generous bound of
    // 50ms to account for slow CI / first-call JIT.
    expect(elapsed).toBeLessThan(50);

    const plugin = (await factoryPromise) as Awaited<ReturnType<typeof import("../src/session-memory").default>>;
    // Plugin should be usable right away (status command should work)
    const status = await plugin.tool.short_term_memory.execute({ action: "status" }, {});
    expect(String(status)).toContain("Session Memory Plugin Status");

    rm(slowDir, { recursive: true, force: true }).catch(() => {});
  });

  test("concurrent mutateActiveSideSessions does not lose entries", async () => {
    const memoryDir = "test-memory-concurrent";
    await mkdir(memoryDir, { recursive: true });

    // Fire 50 concurrent mutators each adding a unique ID; the lock must
    // serialize them so every entry is preserved.
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    await Promise.all(
      ids.map((id) =>
        mutateActiveSideSessions(memoryDir, (active) => {
          if (!active.includes(id)) active.push(id);
          return active;
        }),
      ),
    );

    const final = await loadActiveSideSessions(memoryDir);
    expect(final.sort()).toEqual([...ids].sort());

    rm(memoryDir, { recursive: true, force: true }).catch(() => {});
  });

  test("side session state file helpers round-trip correctly", async () => {
    const memoryDir = "test-memory-roundtrip";
    await mkdir(memoryDir, { recursive: true });

    await saveActiveSideSessions(memoryDir, ["a", "b", "c"]);
    const loaded = await loadActiveSideSessions(memoryDir);
    expect(loaded).toEqual(["a", "b", "c"]);

    await saveActiveSideSessions(memoryDir, ["b"]);
    const loaded2 = await loadActiveSideSessions(memoryDir);
    expect(loaded2).toEqual(["b"]);

    // Empty list works
    await saveActiveSideSessions(memoryDir, []);
    const loaded3 = await loadActiveSideSessions(memoryDir);
    expect(loaded3).toEqual([]);

    // Deduplication
    await saveActiveSideSessions(memoryDir, ["x", "x", "y"]);
    const loaded4 = await loadActiveSideSessions(memoryDir);
    expect(loaded4).toEqual(["x", "y"]);

    // Malformed JSON returns empty
    await writeText(sideSessionsStatePath(memoryDir), "not json");
    const loaded5 = await loadActiveSideSessions(memoryDir);
    expect(loaded5).toEqual([]);

    rm(memoryDir, { recursive: true, force: true }).catch(() => {});
  });

  test("mutateActiveSideSessions deduplicates entries added by the mutator", async () => {
    const memoryDir = "test-mutate-dedup";
    await mkdir(memoryDir, { recursive: true });
    await saveActiveSideSessions(memoryDir, ["id-1"]);

    await mutateActiveSideSessions(memoryDir, (active) => {
      active.push("id-1");
      active.push("id-2");
      active.push("id-2");
      return active;
    });

    const final = await loadActiveSideSessions(memoryDir);
    expect(final.sort()).toEqual(["id-1", "id-2"]);

    rm(memoryDir, { recursive: true, force: true }).catch(() => {});
  });

  test("concurrent clean summarizers do not lose tracking entries", async () => {
    // Two clean summarizers running in parallel for two different sessions
    // must both write to the tracking file (and then both remove their entry)
    // without losing each other. The atomic helper is what guarantees this.
    const fakeClient = createFakeClient({
      messagesRows: [
        { id: "m1", role: "user", content: "concurrent" },
        { id: "m2", role: "assistant", content: "ok" },
      ],
      promptText: "## Session Memory\n\n### Active References\n- parallel\n",
    });

    const { plugin } = await createPlugin({ summarizerMode: "clean", debug: false }, fakeClient);

    // Slow the prompt slightly so the two summarizers overlap.
    const originalPrompt = fakeClient.session.prompt;
    fakeClient.session.prompt = async (args?: unknown) => {
      await new Promise((r) => setTimeout(r, 20));
      return originalPrompt(args);
    };

    await plugin["session.created"]({ sessionID: "concurrent-A" });
    await plugin["session.created"]({ sessionID: "concurrent-B" });

    await Promise.all([
      plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID: "concurrent-A" }),
      plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID: "concurrent-B" }),
    ]);

    // Both should have created and deleted exactly one side session.
    expect(fakeClient.calls.create.length).toBe(2);
    expect(fakeClient.calls.delete.length).toBe(2);

    const remaining = await loadActiveSideSessions(DEFAULT_CONFIG.memoryDir);
    expect(remaining).toEqual([]);
  });

  test("clean summarizer aborts and times out a hung prompt", async () => {
    // A prompt that never resolves must be aborted within the configured
    // timeout. We shrink the timeout to keep the test fast.
    const summarizer = await import("../src/summarizer");
    const originalTimeout = summarizer.CLEAN_SUMMARIZER_TIMEOUT.ms;
    summarizer.CLEAN_SUMMARIZER_TIMEOUT.ms = 200;
    try {
      const fakeClient = createFakeClient({
        messagesRows: [
          { id: "m1", role: "user", content: "hang" },
          { id: "m2", role: "assistant", content: "..." },
        ],
        promptText: "",
      });
      // Hang the prompt, but respect the abort signal so the summarizer's
      // timeout can actually unblock the test.
      fakeClient.session.prompt = (args?: unknown) => {
        const a = args as { signal?: AbortSignal } | undefined;
        return new Promise((_resolve, reject) => {
          if (a?.signal) {
            if (a.signal.aborted) {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
              return;
            }
            a.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      };
      fakeClient.session.abort = async (args?: unknown) => {
        fakeClient.calls.abort.push(args);
        return { data: true };
      };

      const { plugin } = await createPlugin({ summarizerMode: "clean", debug: false }, fakeClient);
      await plugin["session.created"]({ sessionID: "hang-1" });

      // The outer try/catch in updateMemory() swallows the timeout, so the
      // tool call resolves normally. We assert the timeout path was taken
      // by checking that the abort was called and the log records the
      // timeout event.
      await plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID: "hang-1" });

      // The plugin should have asked the server to abort the side session
      // (proving the timeout fired and the catch branch ran).
      expect(fakeClient.calls.abort.length).toBeGreaterThanOrEqual(1);

      // The log should record the timeout and the per-session delete.
      const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
      expect(logText).toContain("side_session_prompt_timeout");

      // The side session must still be cleaned up even on timeout.
      const tracked = await loadActiveSideSessions(DEFAULT_CONFIG.memoryDir);
      expect(tracked).toEqual([]);
    } finally {
      summarizer.CLEAN_SUMMARIZER_TIMEOUT.ms = originalTimeout;
    }
  });

  test("reloadConfigLocal waits for the background init when called early", async () => {
    // The backgroundInitDone flag must only flip after the work completes.
    // We trigger an event before the background init finishes and verify
    // that reloadConfigLocal() waited long enough for the config to be
    // loaded (i.e. that the seeded stm.json was read).
    const fakeClient = createFakeClient();
    const { plugin, cleanup } = await createPlugin({ debug: false, memoryModel: "test/wait-model" }, fakeClient);

    // Fire many events in parallel. Each one calls reloadConfigLocal() at
    // the top. None of them should observe the DEFAULT_CONFIG model.
    const observed: string[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        plugin
          .event({ event: { type: "session.idle", properties: { sessionID: `s-${i}` } } } as never)
          .then(async () => {
            const status = await plugin.tool.short_term_memory.execute({ action: "settings" }, {});
            const model = (status.match(/"memoryModel":\s*"([^"]+)"/) || [])[1];
            if (model) observed.push(model);
          })
          .catch(() => {}),
      ),
    );

    // After the dust settles, every concurrent caller should have seen the
    // *seeded* model from .opencode/stm.json, never the DEFAULT_CONFIG
    // ("opencode/minimax-m2.5-free"). If backgroundInitDone flipped too
    // early, callers would see DEFAULT_CONFIG before the file was read.
    expect(observed.length).toBeGreaterThan(0);
    for (const m of observed) {
      expect(m).toBe("test/wait-model");
    }

    await cleanup();
  });
});
