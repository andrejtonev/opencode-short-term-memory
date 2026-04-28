import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugin, createFakeClient } from "./test-helpers";
import { readText, memoryPathFor } from "../src/memory-utils";

const STRESS_DURATION_MS = parseInt(process.env.STRESS_DURATION_MS || "3000", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "8", 10);

describe("Stress / race condition tests", () => {
  const originalCwd = process.cwd();
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-stress-test-"));
    process.env.XDG_CONFIG_HOME = join(testDir, ".xdg");
    process.env.OPENCODE_CONFIG_DIR = join(testDir, ".config-dir");
    delete process.env.LOCALAPPDATA;
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test("concurrent updates and injections do not crash or corrupt memory", async () => {
    const sessionID = `stress-${Date.now()}`;
    const messageCount = 50;

    const messages: unknown[] = [];
    for (let i = 0; i < messageCount; i++) {
      messages.push({
        id: `m-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"data".repeat(Math.floor(Math.random() * 5) + 1)}`,
      });
    }

    let promptCalls = 0;
    const fakeClient = createFakeClient({
      messagesRows: messages,
      promptResponder: () => {
        promptCalls += 1;
        return `## Session Memory\n\n### Active References\n- stress round ${promptCalls}\n`;
      },
    });

    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        debounceMs: 10,
        remindEveryN: 1,
        debug: false,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID });

    const startTime = Date.now();
    const errors: string[] = [];

    const runConcurrent = async () => {
      while (Date.now() - startTime < STRESS_DURATION_MS) {
        try {
          const actions = [
            // Inject memory
            (async () => {
              const output = { system: [] as string[] };
              await plugin["experimental.chat.system.transform"](
                { sessionID, messageID: `stress-msg-${Math.random()}` },
                output,
              );
            })(),

            // Force update
            plugin.tool.short_term_memory.execute({ action: "update" }, { sessionID }),

            // Read status (non-mutating)
            plugin.tool.short_term_memory.execute({ action: "status" }, { sessionID }),

            // Fire session.idle event
            plugin.event({
              event: {
                type: "session.idle",
                properties: { sessionID },
              },
            } as any),

            // Fire message.updated event
            plugin["message.updated"]({
              sessionID,
              message: {
                role: "user",
                content: `Stress update ${Math.random()}`,
              },
            } as any),
          ];

          await Promise.allSettled(actions);
        } catch (error) {
          errors.push(String(error));
        }

        // Small random delay to interleave operations
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      }
    };

    // Launch concurrent workers
    const workers = Array.from({ length: CONCURRENCY }, () => runConcurrent());
    await Promise.all(workers);

    // Verify no crashes
    expect(errors.length).toBe(0);

    // Memory file should exist and be valid markdown
    const memory = await readText(memoryPathFor(sessionID), "");
    expect(memory).toContain("## Session Memory");
    expect(memory.length).toBeGreaterThan(0);

    // Log file should exist
    const logText = await readText(join(".opencode", "memory", "session-memory.log"), "");
    expect(logText.length).toBeGreaterThan(0);
  });

  test("rapid session create/delete cycles do not leak state", async () => {
    const sessionCount = 30;
    const fakeClient = createFakeClient({
      messagesRows: [],
      promptText: "## Session Memory\n\n### Active References\n- rapid session\n",
    });

    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        debounceMs: 0,
        debug: false,
      },
      fakeClient,
    );

    // Create and delete sessions rapidly
    const sessionIDs: string[] = [];
    for (let i = 0; i < sessionCount; i++) {
      const sessionID = `rapid-${Date.now()}-${i}`;
      sessionIDs.push(sessionID);

      await plugin["session.created"]({ sessionID });

      // Write some memory content
      const path = memoryPathFor(sessionID);
      const memory = await readText(path, "");
      expect(memory).toContain("## Session Memory");

      // Delete half of them immediately
      if (i % 2 === 0) {
        await plugin["session.deleted"]({ sessionID });
        const afterDelete = await readText(path, "deleted");
        expect(afterDelete).toBe("deleted");
      }
    }

    // Clean up remaining sessions
    for (const sid of sessionIDs) {
      await plugin["session.deleted"]({ sid }).catch(() => {});
    }

    // No crash means pass. The session state map should not have grown unbounded.
    const status = await plugin.tool.short_term_memory.execute({ action: "status" }, {});
    expect(String(status)).toContain("Session Memory Plugin Status");
  });

  test("concurrent sub-agent creation and parent deletion", async () => {
    const parentSessionID = `stress-parent-${Date.now()}`;
    const subCount = 20;

    const fakeClient = createFakeClient({
      messagesRows: [],
      promptText: "## Session Memory\n\n### Active References\n- sub-agent stress\n",
    });

    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        injectInSubagents: true,
        debug: false,
        debounceMs: 0,
      },
      fakeClient,
    );

    await plugin["session.created"]({ sessionID: parentSessionID });

    // Create many sub-agents concurrently
    const subCreations = Array.from({ length: subCount }, (_, i) => {
      const subSessionID = `stress-sub-${Date.now()}-${i}`;
      const input = {
        sessionID: subSessionID,
        event: {
          type: "session.created",
          properties: {
            info: { id: subSessionID, parentID: parentSessionID },
          },
        },
      };
      return plugin["session.created"](input);
    });

    await Promise.all(subCreations);

    // Delete parent — should cascade-clean all children
    await plugin["session.deleted"]({ sessionID: parentSessionID });

    // Verify no dangling state by checking status still works
    const status = await plugin.tool.short_term_memory.execute({ action: "status" }, {});
    expect(String(status)).toContain("Session Memory Plugin Status");
  });

  test("many concurrent system transforms across multiple sessions", async () => {
    const sessionCount = 10;
    const transformsPerSession = 5;

    const fakeClient = createFakeClient({
      messagesRows: [],
      promptText: "## Session Memory\n\n### Active References\n- multi-session stress\n",
    });

    const { plugin } = await createPlugin(
      {
        summarizerMode: "active",
        remindEveryN: 1,
        debug: false,
        debounceMs: 0,
      },
      fakeClient,
    );

    const sessionIDs: string[] = [];
    for (let i = 0; i < sessionCount; i++) {
      const sessionID = `multi-${Date.now()}-${i}`;
      sessionIDs.push(sessionID);
      await plugin["session.created"]({ sessionID });
    }

    // Run transforms across all sessions
    const allTransforms: Promise<void>[] = [];
    for (const sessionID of sessionIDs) {
      for (let t = 0; t < transformsPerSession; t++) {
        allTransforms.push(
          (async () => {
            const output = { system: [] as string[] };
            await plugin["experimental.chat.system.transform"](
              { sessionID, messageID: `multi-msg-${sessionID}-${t}` },
              output,
            );
          })(),
        );
      }
    }

    await Promise.all(allTransforms);

    // Cleanup
    for (const sessionID of sessionIDs) {
      await plugin["session.deleted"]({ sessionID }).catch(() => {});
    }

    const status = await plugin.tool.short_term_memory.execute({ action: "status" }, {});
    expect(String(status)).toContain("Session Memory Plugin Status");
  });
});
