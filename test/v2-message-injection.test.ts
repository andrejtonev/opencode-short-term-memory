import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPrompt } from "@opencode/plugin/promise/session";
import type { V2Context } from "../src/v2-adapter";
import { INJECTION_PREFIX, MEMORY_HEADER, memoryPathFor, writeText } from "../src/memory-utils";
import { createV2MessageInjection } from "../src/v2-message-injection";
import { readV2MemoryStatus } from "../src/v2-memory-tools";
import { createV2ReminderCadence } from "../src/v2-reminder-cadence";
import { resetV2MemoryPersistence } from "../src/v2-reset-persistence";
import { deferred } from "./async-helpers";
import { deleteV2MemorySession, invalidateV2MemoryReads, withV2MemoryMutation } from "../src/v2-mutation-coordination";

const MEMORY = `${MEMORY_HEADER}\n\n### Decisions\n- Keep the native prompt request alive.\n`;

type SyntheticRequest = {
  sessionID: string;
  id: string;
  text: string;
  description?: string;
  metadata?: Record<string, unknown>;
  delivery: "steer" | "queue";
  resume: boolean;
};

function prompt(sessionID: string, messageID: string, text = "Continue the task"): SessionPrompt {
  return {
    sessionID,
    messageID,
    prompt: { text },
    delivery: "steer",
  } as SessionPrompt;
}

function messageContext(
  directory: string,
  synthetic: (input: SyntheticRequest) => Promise<unknown> = async () => ({}),
  parentID: string | null = null,
): V2Context {
  return {
    location: { directory, project: { id: "project", directory, canonical: directory } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID }),
      synthetic,
    },
  } as unknown as V2Context;
}

describe("V2 appended no-reply memory injection", () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let testDir = "";
  let projectDir = "";
  let memoryDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-v2-message-injection-"));
    projectDir = join(testDir, "project");
    memoryDir = join(testDir, "memory");
    process.env.HOME = join(testDir, "home");
    process.env.XDG_CONFIG_HOME = join(testDir, "xdg");
    process.env.OPENCODE_CONFIG_DIR = join(testDir, "config");
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
    await rm(testDir, { recursive: true, force: true });
  });

  async function configure(
    values: Record<string, unknown> = {},
    sessionID = "message-session",
    memory = MEMORY,
  ): Promise<void> {
    await writeText(
      join(projectDir, ".opencode", "stm.json"),
      JSON.stringify({ memoryDir, remindEveryN: 1, ...values }),
    );
    await writeText(memoryPathFor(sessionID, memoryDir), memory);
  }

  test("uses durable steer synthetic admission with resume false for the default selector", async () => {
    const sessionID = "default-message-session";
    const calls: SyntheticRequest[] = [];
    await configure({}, sessionID);
    const context = messageContext(projectDir, async (input) => {
      calls.push(input);
      return { id: input.id, type: "synthetic", delivery: input.delivery };
    });
    const cadence = createV2ReminderCadence(context, projectDir);
    const inject = createV2MessageInjection(context, projectDir, cadence);

    await inject(prompt(sessionID, "msg_default"));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionID,
      text: expect.stringContaining(INJECTION_PREFIX),
      description: "Short-term session memory",
      metadata: { source: "opencode-short-term-memory", primaryMessageID: "msg_default" },
      delivery: "steer",
      resume: false,
    });
    expect(calls[0]?.id).toMatch(/^msg_/);
    const status = await readV2MemoryStatus(sessionID, projectDir, context);
    expect(status).toContain("injectCount: 1");
    expect(status).toMatch(/injectCharCount: [1-9]\d*/);
    expect(status).not.toContain("lastInjectAt: never");
    cadence.dispose();
    inject.dispose();
  });

  test.each(["reset", "dispose", "delete"] as const)(
    "%s releases a pending synthetic admission even when the host ignores abort",
    async (operation) => {
      const sessionID = `pending-${operation}`;
      await configure({}, sessionID);
      const started = deferred<void>();
      const pending = deferred<never>();
      const context = messageContext(projectDir);
      let requestSignal: AbortSignal | null | undefined;
      context.session.synthetic = async (_input, options) => {
        requestSignal = options?.signal;
        started.resolve();
        return pending.promise;
      };
      const lifetime = new AbortController();
      const injection = createV2MessageInjection(context, projectDir, undefined, lifetime.signal);
      const delivery = injection(prompt(sessionID, "msg_pending"));
      await started.promise;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const cancelled =
          operation === "reset"
            ? resetV2MemoryPersistence(sessionID, projectDir, null, { memoryDir })
            : operation === "delete"
              ? deleteV2MemorySession(projectDir, sessionID, async () => undefined)
              : Promise.resolve(lifetime.abort());
        await Promise.race([
          Promise.all([cancelled, delivery]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("admission held mutation lock")), 1_000);
          }),
        ]);
        expect(requestSignal?.aborted).toBe(true);
        await withV2MemoryMutation(projectDir, sessionID, async () => undefined).catch(() => undefined);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        lifetime.abort();
        pending.reject(new Error("late native rejection"));
        await delivery;
        injection.dispose();
      }
    },
  );

  test("retains the clean system selector and applies the V1 active fallback", async () => {
    const cleanSession = "clean-system-session";
    const activeSession = "active-fallback-session";
    const calls: SyntheticRequest[] = [];
    await configure({ enableLegacyPeriodicSystemTransform: true, summarizerMode: "clean" }, cleanSession);
    await writeText(memoryPathFor(activeSession, memoryDir), MEMORY);
    const context = messageContext(projectDir, async (input) => {
      calls.push(input);
      return { id: input.id };
    });
    const cadence = createV2ReminderCadence(context, projectDir);
    const inject = createV2MessageInjection(context, projectDir, cadence);

    await inject(prompt(cleanSession, "msg_clean"));
    await writeText(
      join(projectDir, ".opencode", "stm.json"),
      JSON.stringify({
        memoryDir,
        remindEveryN: 1,
        enableLegacyPeriodicSystemTransform: true,
        summarizerMode: "active",
      }),
    );
    await inject(prompt(activeSession, "msg_active"));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionID).toBe(activeSession);
    expect(calls[0]?.metadata?.primaryMessageID).toBe("msg_active");
    cadence.dispose();
    inject.dispose();
  });

  test("applies cadence once per canonical prompt and ignores duplicate callbacks", async () => {
    const sessionID = "cadence-message-session";
    const calls: SyntheticRequest[] = [];
    await configure({ remindEveryN: 2 }, sessionID);
    const context = messageContext(projectDir, async (input) => {
      calls.push(input);
      return { id: input.id };
    });
    const cadence = createV2ReminderCadence(context, projectDir);
    const inject = createV2MessageInjection(context, projectDir, cadence);

    await inject(prompt(sessionID, "msg_turn_1"));
    await inject(prompt(sessionID, "msg_turn_1"));
    await inject(prompt(sessionID, "msg_turn_2"));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.metadata?.primaryMessageID).toBe("msg_turn_2");
    cadence.dispose();
    inject.dispose();
  });

  test("skips task children and sessions owned by summary generation", async () => {
    const childSession = "message-child-session";
    const ownedSession = "owned-summary-session";
    const calls: SyntheticRequest[] = [];
    await configure({}, childSession);
    await writeText(memoryPathFor(ownedSession, memoryDir), MEMORY);
    const childContext = messageContext(
      projectDir,
      async (input) => {
        calls.push(input);
        return {};
      },
      "parent-session",
    );
    const childCadence = createV2ReminderCadence(childContext, projectDir);
    const childInject = createV2MessageInjection(childContext, projectDir, childCadence);
    await childInject(prompt(childSession, "msg_child"));

    const primaryContext = messageContext(projectDir, async (input) => {
      calls.push(input);
      return {};
    });
    const ownedCadence = createV2ReminderCadence(primaryContext, projectDir);
    const ownedInject = createV2MessageInjection(
      primaryContext,
      projectDir,
      ownedCadence,
      undefined,
      (id) => id === ownedSession,
    );
    await ownedInject(prompt(ownedSession, "msg_owned"));

    expect(calls).toHaveLength(0);
    childCadence.dispose();
    childInject.dispose();
    ownedCadence.dispose();
    ownedInject.dispose();
  });

  test("serializes concurrent prompt admissions and retries an ambiguous failure with the same synthetic ID", async () => {
    const sessionID = "ordered-message-session";
    const calls: SyntheticRequest[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => (markFirst = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let failNext = true;
    await configure({}, sessionID);
    const context = messageContext(projectDir, async (input) => {
      calls.push(input);
      if (input.metadata?.primaryMessageID === "msg_order_1") {
        markFirst?.();
        await firstGate;
      }
      if (input.metadata?.primaryMessageID === "msg_retry" && failNext) {
        failNext = false;
        throw new Error("simulated admission response loss");
      }
      return { id: input.id };
    });
    const cadence = createV2ReminderCadence(context, projectDir);
    const inject = createV2MessageInjection(context, projectDir, cadence);

    const first = inject(prompt(sessionID, "msg_order_1"));
    await firstStarted;
    const second = inject(prompt(sessionID, "msg_order_2"));
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls.slice(0, 2).map((call) => call.metadata?.primaryMessageID)).toEqual(["msg_order_1", "msg_order_2"]);

    await inject(prompt(sessionID, "msg_retry"));
    const status = await readV2MemoryStatus(sessionID, projectDir, context);
    expect(status).toContain("injectCount: 2");
    expect(status).toContain("lastError: simulated admission response loss");
    const failedID = calls.at(-1)?.id;
    const failedText = calls.at(-1)?.text;
    await writeText(memoryPathFor(sessionID, memoryDir), `${MEMORY}\n- Changed after the response was lost.\n`);
    await inject(prompt(sessionID, "msg_retry"));
    expect(calls.slice(-2).map((call) => call.id)).toEqual([failedID, failedID]);
    expect(calls.slice(-2).map((call) => call.text)).toEqual([failedText, failedText]);
    cadence.dispose();
    inject.dispose();
  });

  test("checks lifetime and deletion before dispatch", async () => {
    const sessionID = "disposed-message-session";
    const calls: SyntheticRequest[] = [];
    await configure({}, sessionID);
    const context = messageContext(projectDir, async (input) => {
      calls.push(input);
      return {};
    });
    const cadence = createV2ReminderCadence(context, projectDir);
    const controller = new AbortController();
    const inject = createV2MessageInjection(context, projectDir, cadence, controller.signal);
    inject.dispose();
    await inject(prompt(sessionID, "msg_disposed"));
    expect(calls).toHaveLength(0);
    cadence.dispose();
  });

  test("rechecks reset revision and deletion after waiting for memory ownership", async () => {
    const resetSession = "reset-during-dispatch";
    const deletedSession = "delete-during-dispatch";
    const calls: SyntheticRequest[] = [];
    await configure({}, resetSession);
    await writeText(memoryPathFor(deletedSession, memoryDir), MEMORY);
    const context = messageContext(projectDir, async (input) => {
      calls.push(input);
      return {};
    });

    for (const sessionID of [resetSession, deletedSession]) {
      let unlock: (() => void) | undefined;
      let markLocked: (() => void) | undefined;
      let markCadence: (() => void) | undefined;
      const locked = new Promise<void>((resolve) => (markLocked = resolve));
      const cadenceReached = new Promise<void>((resolve) => (markCadence = resolve));
      const lockGate = new Promise<void>((resolve) => (unlock = resolve));
      const holder = withV2MemoryMutation(projectDir, sessionID, async () => {
        markLocked?.();
        await lockGate;
      });
      await locked;
      const cadence = {
        record() {},
        selectTransport() {},
        shouldInjectPrompt: async () => {
          markCadence?.();
          return true;
        },
        dispose() {},
      } as unknown as ReturnType<typeof createV2ReminderCadence>;
      const inject = createV2MessageInjection(context, projectDir, cadence);
      const delivery = inject(prompt(sessionID, `msg_${sessionID}`));
      await cadenceReached;
      await Promise.resolve();

      let deletion: Promise<void> | undefined;
      if (sessionID === resetSession) invalidateV2MemoryReads(projectDir, sessionID);
      else deletion = deleteV2MemorySession(projectDir, sessionID, async () => undefined);
      unlock?.();
      await delivery;
      await holder;
      await deletion;
      expect(calls.filter((call) => call.sessionID === sessionID)).toHaveLength(0);
      inject.dispose();
    }
  });
});
