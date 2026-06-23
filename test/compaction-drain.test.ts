// ── Test for the experimental.session.compacting drain-timeout path ─
//
// (#6 in OPEN_GAPS.md)
//
// When `updateMemory` is in flight when the compaction hook fires
// (e.g. a session.idle update is still running), the hook must:
//   1. wait for the in-flight update to complete, up to the drain
//      timeout (3s + 6s retry = 9s)
//   2. log `compaction_drain_timeout_using_stale_memory` if still busy
//   3. push the on-disk memory into the compaction context
//   4. NOT throw
//
// The trick: the in-flight update must be set up BEFORE the compaction
// hook fires. We do this by firing `session.created` (which triggers
// a bootstrap update via maybeBootstrapSessionHistory) and waiting
// for the in-flight to start.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SessionMemoryPlugin from "../src/session-memory";
import { createFakeClient } from "./test-helpers";
import { DEFAULT_CONFIG, logPath, writeText, memoryPathFor } from "../src/memory-utils";
import type { Client } from "../src/types";

describe("experimental.session.compacting drain timeout (#6)", () => {
  const originalCwd = process.cwd();
  let testDir = "";
  let memoryDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-drain-test-"));
    process.chdir(testDir);
    memoryDir = join(testDir, ".opencode", "memory");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test("a long-running in-flight update causes the hook to log drain_timeout and still push on-disk memory", async () => {
    const sessionID = "drain-timeout";

    // The prompt hangs forever. We do NOT register an abort listener
    // because the active-mode summarizer does not pass an abort
    // signal. The prompt truly hangs.
    const fake = createFakeClient({
      messagesRows: [{ id: "m1", role: "user", content: "trigger summarization" }],
      promptResponder: () => new Promise<unknown>(() => {}),
    });

    // Write a config with debounceMs: 0 so the bootstrap update fires
    // on the next tick, and a short maxUpdateInputLength to avoid
    // timeout issues. The drain timeout floor is 3s.
    const configPath = join(testDir, ".opencode", "stm.jsonc");
    await writeText(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        memoryDir,
        debounceMs: 0,
        maxUpdateInputLength: 50000,
        summarizerMode: "active",
        logMaxLines: 20000,
      }),
    );

    const plugin = await SessionMemoryPlugin({
      client: fake as unknown as Client,
      directory: testDir,
    });

    // Fire session.created. The plugin creates the default skeleton
    // (so shouldBootstrapFromHistory returns true) and schedules a
    // bootstrap update. With debounceMs: 0, the setTimeout fires on
    // the next tick and the update is now in flight, hung on our
    // never-resolving prompt.
    await plugin["session.created"]({ sessionID });
    // Give the setTimeout a chance to fire and the prompt to start
    // hanging.
    await new Promise((r) => setTimeout(r, 200));

    // Now pollute the memory file with content that the hook should
    // push into the compaction context. The in-flight update is hung
    // so it cannot overwrite our pollution.
    await writeText(
      memoryPathFor(sessionID, memoryDir),
      "## Session Memory\n\n### Long Horizon Context\n- on-disk content that must be pushed\n",
    );

    // Now fire the compaction hook. It should:
    // 1. see the in-flight update
    // 2. wait up to 3s, then 6s
    // 3. log drain_timeout
    // 4. push the on-disk memory
    const output: { context: string[] } = { context: [] };
    const start = Date.now();
    let threw: unknown = null;
    try {
      await plugin["experimental.session.compacting"]({ sessionID }, output);
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - start;

    // The hook must not throw.
    expect(threw).toBeNull();
    // The hook waited for the drain timeout (3s + 6s = 9s). Add some slack.
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(elapsed).toBeLessThan(15_000);
    // The on-disk memory was pushed into the compaction context.
    expect(output.context.length).toBeGreaterThan(0);
    expect(output.context.join("\n")).toContain("on-disk content that must be pushed");

    // The log records the drain timeout.
    const logText = await readFile(logPath(memoryDir), "utf8");
    expect(logText).toContain("compaction_drain_timeout_using_stale_memory");
  }, 30_000);
});
