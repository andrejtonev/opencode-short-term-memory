import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V2Context, V2SessionContext } from "../src/v2-adapter";
import { createV2ReminderCadence } from "../src/v2-reminder-cadence";
import { resetBoundaryPathFor, writeText } from "../src/memory-utils";

function context(directory: string, records: unknown[] = []): V2Context {
  return {
    location: { directory },
    session: {
      context: async () => records,
      get: async () => ({ id: "session", model: { providerID: "offline", id: "test" } }),
    },
  } as unknown as V2Context;
}

function input(messages: unknown[]): V2SessionContext {
  return { sessionID: "session", messages } as unknown as V2SessionContext;
}

describe("V2 reminder cadence", () => {
  test("counts admitted IDs, injects on N, and deduplicates one array", async () => {
    const directory = await mkdtemp(join(tmpdir(), "v2-cadence-"));
    try {
      const cadence = createV2ReminderCadence(context(directory), directory);
      cadence.record({ sessionID: "session", messageID: "u1" });
      expect(await cadence.shouldInject(input([{ id: "u1", role: "user" }]), 2, directory)).toBe(false);
      cadence.record({ sessionID: "session", messageID: "u2" });
      const messages = [
        { id: "u1", role: "user" },
        { id: "u2", role: "user" },
      ];
      expect(await cadence.shouldInject(input(messages), 2, directory)).toBe(true);
      expect(await cadence.shouldInject(input(messages), 2, directory)).toBe(true);
      cadence.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not count unadmitted, tool, or duplicate-text messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "v2-cadence-"));
    try {
      const cadence = createV2ReminderCadence(context(directory), directory);
      const messages = [
        { id: "tool", role: "tool", text: "same" },
        { id: "u-unadmitted", role: "user", text: "same" },
      ];
      expect(await cadence.shouldInject(input(messages), 1, directory)).toBe(false);
      cadence.record({ sessionID: "session", messageID: "u-admitted" });
      expect(await cadence.shouldInject(input([{ id: "u-admitted", role: "user", text: "same" }]), 1, directory)).toBe(
        true,
      );
      cadence.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("resolves a durable idle reset anchor and keeps post-reset candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "v2-cadence-"));
    try {
      const records: unknown[] = [];
      const cadence = createV2ReminderCadence(context(directory, records), directory);
      cadence.record({ sessionID: "session", messageID: "msg_old" });
      cadence.record({ sessionID: "session", messageID: "msg_new" });
      await writeText(
        resetBoundaryPathFor("session", directory),
        JSON.stringify({ version: 1, anchorID: "msg_reset" }),
      );
      expect(await cadence.shouldInject(input([{ id: "msg_new", role: "user" }]), 1, directory)).toBe(false);
      records.push(
        { id: "msg_old", type: "user", text: "old", time: { created: 1 } },
        { id: "msg_reset", type: "idle", outcome: "succeeded", time: { created: 2 } },
        { id: "msg_new", type: "user", text: "new", time: { created: 3 } },
      );
      const messages = [
        { id: "msg_old", role: "user" },
        { id: "msg_synthetic", role: "user" },
        { id: "msg_new", role: "user" },
      ];
      expect(await cadence.shouldInject(input(messages), 1, directory)).toBe(true);
      expect(await cadence.shouldInject(input(messages), 1, directory)).toBe(true);
      cadence.dispose();
      cadence.record({ sessionID: "session", messageID: "after-dispose" });
      expect(await cadence.shouldInject(input([{ id: "after-dispose", role: "user" }]), 1, directory)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps tool continuations eligible but rejects snapshots without the latest admitted turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "v2-cadence-"));
    try {
      const cadence = createV2ReminderCadence(context(directory), directory);
      cadence.record({ sessionID: "session", messageID: "u1" });
      const admitted = [{ id: "u1", role: "user" }];
      expect(await cadence.shouldInject(input(admitted), 1, directory)).toBe(true);
      expect(await cadence.shouldInject(input([...admitted, { id: "tool", role: "tool" }]), 1, directory)).toBe(true);
      expect(await cadence.shouldInject(input([{ id: "other", role: "assistant" }]), 1, directory)).toBe(false);
      expect(await cadence.shouldInject(input([...admitted, { id: "synthetic", role: "user" }]), 1, directory)).toBe(
        true,
      );
      cadence.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses the final admitted candidate's modulo result for a multi-steer batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "v2-cadence-"));
    try {
      const cadence = createV2ReminderCadence(context(directory), directory);
      cadence.record({ sessionID: "session", messageID: "u1" });
      cadence.record({ sessionID: "session", messageID: "u2" });
      cadence.record({ sessionID: "session", messageID: "u3" });
      expect(
        await cadence.shouldInject(
          input([
            { id: "u1", role: "user" },
            { id: "u2", role: "user" },
          ]),
          2,
          directory,
        ),
      ).toBe(true);
      expect(
        await cadence.shouldInject(
          input([
            { id: "u1", role: "user" },
            { id: "u2", role: "user" },
            { id: "u3", role: "user" },
          ]),
          2,
          directory,
        ),
      ).toBe(false);
      cadence.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
