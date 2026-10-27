import { boundedV2Operation as boundedAdmission } from "./v2-bounded-operation";
import { createHash } from "node:crypto";
import type { V2Context } from "./v2-adapter";
import { markV2ChildDcpInjectionPending, classifyV2Session } from "./v2-child-memory";
import { buildTaggedMemoryForInjection } from "./injection";
import { DEFAULT_CONFIG, logEvent, memoryPathFor, readConfig, readText, safeSessionID } from "./memory-utils";
import { readV2CurrentHistory } from "./v2-current-history";
import type { createV2MemoryUpdater } from "./v2-memory-update";
import {
  getV2MemoryReadRevision,
  getV2MemoryGenerationSignal,
  getV2MemorySessionSignal,
  isV2MemorySessionDeleted,
  withV2MemoryMutation,
} from "./v2-mutation-coordination";

type Updater = ReturnType<typeof createV2MemoryUpdater>;
type Timer = ReturnType<typeof setTimeout>;
type ToolExecuteAfterEvent = {
  readonly tool: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly id: string;
  readonly status: "completed" | "error";
};
type PendingDcp = {
  readonly sessionID: string;
  readonly messageID: string;
  readonly toolCallID: string;
  readonly readRevision: number;
  readonly busyReplayCount: number;
};
type SessionDcpState = {
  lastAcceptedAt: number;
  pending?: PendingDcp;
  timer?: Timer;
  running: boolean;
};

export type V2DcpCompletionRegistration = { readonly dispose: () => Promise<void> };

const MAX_SEEN_COMPLETIONS = 512;
const MAX_SESSION_STATES = 128;
const DISPOSE_DEADLINE_MS = 1_000;
const SYNTHETIC_DEADLINE_MS = 5_000;
type SyntheticID = NonNullable<Parameters<V2Context["session"]["synthetic"]>[0]["id"]>;

function safeID(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return safeSessionID(value) === value;
  } catch {
    return false;
  }
}

function syntheticID(sessionID: string, toolCallID: string, revision: number): SyntheticID {
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionID, toolCallID, revision]))
    .digest("hex")
    .slice(0, 26);
  return `msg_${digest}` as SyntheticID;
}

function sameHistory(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Bridges the native completed-compress tool hook to STM lifecycle handling.
 * It does not establish that an external DCP package is loaded or compatible.
 */
export async function registerV2DcpCompletion(
  context: V2Context,
  directory: string,
  updater: Updater,
  lifetimeSignal: AbortSignal,
): Promise<V2DcpCompletionRegistration> {
  const seen = new Set<string>();
  const states = new Map<string, SessionDcpState>();
  const tasks = new Set<Promise<void>>();
  let disposed = false;
  let registration: { dispose: () => Promise<void> } | undefined;
  let disposePromise: Promise<void> | undefined;

  const isLive = (event: PendingDcp): boolean =>
    !disposed &&
    !lifetimeSignal.aborted &&
    !isV2MemorySessionDeleted(directory, event.sessionID) &&
    getV2MemoryReadRevision(directory, event.sessionID) === event.readRevision;

  const track = (task: Promise<void>): void => {
    tasks.add(task);
    task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
  };

  const stateFor = (sessionID: string): SessionDcpState | undefined => {
    let state = states.get(sessionID);
    if (state) return state;
    if (states.size >= MAX_SESSION_STATES) {
      const evictable = [...states].find(([, candidate]) => !candidate.running);
      if (!evictable) return undefined;
      const [oldestID, oldest] = evictable;
      if (oldest.timer !== undefined) clearTimeout(oldest.timer);
      states.delete(oldestID);
    }
    state = { lastAcceptedAt: 0, running: false };
    states.set(sessionID, state);
    return state;
  };

  const schedule = (state: SessionDcpState, delayMs: number): void => {
    if (disposed || lifetimeSignal.aborted || !state.pending) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const pending = state.pending;
      if (!pending) return;
      state.pending = undefined;
      state.running = true;
      track(
        runPrimaryDcp(pending)
          .then(async (result) => {
            if (result !== "busy" || pending.busyReplayCount > 0 || state.pending || !isLive(pending)) return;
            state.pending = { ...pending, busyReplayCount: pending.busyReplayCount + 1 };
            try {
              await logEvent(await readConfig(undefined, directory), "v2_dcp_compress_queued_after_inflight", {
                sessionID: pending.sessionID,
                toolCallID: pending.toolCallID,
              });
            } catch {}
          })
          .catch(async (error: unknown) => {
            try {
              await logEvent(await readConfig(undefined, directory), "v2_dcp_refresh_error", {
                sessionID: pending.sessionID,
                toolCallID: pending.toolCallID,
                error: error instanceof Error ? error.message : String(error),
              });
            } catch {}
          })
          .finally(async () => {
            state.running = false;
            if (state.pending && !disposed && !lifetimeSignal.aborted) {
              try {
                schedule(state, (await readConfig(undefined, directory)).debounceMs * 2);
              } catch {
                schedule(state, DEFAULT_CONFIG.debounceMs * 2);
              }
            }
          }),
      );
    }, delayMs);
  };

  async function runPrimaryDcp(event: PendingDcp): Promise<"done" | "busy"> {
    if (!isLive(event)) return "done";
    const config = await readConfig(undefined, directory);
    if (!config.enabled || !isLive(event)) return "done";

    const current = await readV2CurrentHistory(context, event.sessionID, 5_000);
    if (current.status !== "ready" || current.history.stoppedBeforeMessageID !== undefined || !isLive(event))
      return "done";
    const lineage = await classifyV2Session(context, event.sessionID);
    if (lineage.kind !== "primary" || !isLive(event)) return "done";

    const update = await updater({ ...current.history, lifetimeSignal });
    if (!isLive(event)) return "done";
    if (update.status === "busy") return "busy";
    if (
      (update.status === "skipped" && update.reason !== "no_assistant_in_delta") ||
      (update.status === "error" && (update.rollback === "failed" || update.rollback === "conflict"))
    )
      return "done";

    const after = await readV2CurrentHistory(context, event.sessionID, 5_000);
    if (
      after.status !== "ready" ||
      after.history.stoppedBeforeMessageID !== undefined ||
      !sameHistory(current.history.messages, after.history.messages) ||
      !isLive(event)
    )
      return "done";
    const finalLineage = await classifyV2Session(context, event.sessionID);
    if (finalLineage.kind !== "primary" || !isLive(event)) return "done";
    const deliveryConfig = await readConfig(undefined, directory);
    if (!deliveryConfig.enabled || !isLive(event)) return "done";

    const sessionSignal = getV2MemorySessionSignal(directory, event.sessionID);
    const deliverySignal = AbortSignal.any([
      lifetimeSignal,
      sessionSignal,
      getV2MemoryGenerationSignal(directory, event.sessionID),
    ]);
    const delivered = await boundedAdmission(
      (admissionSignal) =>
        withV2MemoryMutation(directory, event.sessionID, async () => {
          if (!isLive(event) || admissionSignal.aborted) return false;
          const memory = await readText(memoryPathFor(event.sessionID, deliveryConfig.memoryDir), "");
          const tagged = buildTaggedMemoryForInjection(memory, deliveryConfig.maxMemoryLength);
          if (!tagged.trim() || !isLive(event) || admissionSignal.aborted) return false;
          const syntheticSignal = AbortSignal.any([admissionSignal, deliverySignal]);
          await boundedAdmission(
            (signal) =>
              context.session.synthetic(
                {
                  sessionID: event.sessionID,
                  id: syntheticID(event.sessionID, event.toolCallID, event.readRevision),
                  text: tagged,
                  description: "Short-term session memory after DCP compression",
                  metadata: {
                    source: "opencode-short-term-memory",
                    dcpToolCallID: event.toolCallID,
                    primaryMessageID: event.messageID,
                  },
                  delivery: "steer",
                  resume: false,
                },
                { signal },
              ),
            syntheticSignal,
            SYNTHETIC_DEADLINE_MS,
          );
          return true;
        }),
      deliverySignal,
      SYNTHETIC_DEADLINE_MS,
    );
    if (delivered && isLive(event)) {
      await logEvent(config, "v2_dcp_memory_delivery", {
        sessionID: event.sessionID,
        messageID: event.messageID,
        toolCallID: event.toolCallID,
        transport: "synthetic_steer",
      }).catch(() => undefined);
    }
    return "done";
  }

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    lifetimeSignal.removeEventListener("abort", onLifetimeAbort);
    for (const state of states.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
      state.pending = undefined;
    }
    states.clear();
    disposePromise = (async () => {
      await registration?.dispose();
      await Promise.race([
        Promise.allSettled([...tasks]).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_DEADLINE_MS)),
      ]);
    })();
    return disposePromise;
  };

  const onLifetimeAbort = () => {
    void dispose().catch(() => undefined);
  };
  if (lifetimeSignal.aborted) return { dispose: async () => undefined };
  lifetimeSignal.addEventListener("abort", onLifetimeAbort, { once: true });

  try {
    const toolDomain = context.tool as unknown as { hook?: unknown } | undefined;
    const hook = toolDomain?.hook;
    if (typeof hook !== "function") throw new Error("v2_dcp_execute_after_hook_unavailable");
    registration = await (
      hook as (
        name: "execute.after",
        callback: (input: ToolExecuteAfterEvent) => void | Promise<void>,
      ) => Promise<{ dispose: () => Promise<void> }>
    ).call(toolDomain, "execute.after", async (event) => {
      if (
        disposed ||
        lifetimeSignal.aborted ||
        event.status !== "completed" ||
        event.tool !== "compress" ||
        !safeID(event.sessionID) ||
        !safeID(event.messageID) ||
        !safeID(event.id) ||
        isV2MemorySessionDeleted(directory, event.sessionID)
      )
        return;
      const key = JSON.stringify([event.sessionID, event.id]);
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > MAX_SEEN_COMPLETIONS) seen.delete(seen.values().next().value as string);
      const eventReadRevision = getV2MemoryReadRevision(directory, event.sessionID);

      const config = await readConfig(undefined, directory).catch(() => undefined);
      if (
        !config?.enabled ||
        disposed ||
        lifetimeSignal.aborted ||
        isV2MemorySessionDeleted(directory, event.sessionID)
      )
        return;
      if (getV2MemoryReadRevision(directory, event.sessionID) !== eventReadRevision) return;
      const lineage = await classifyV2Session(context, event.sessionID);
      if (
        disposed ||
        lifetimeSignal.aborted ||
        isV2MemorySessionDeleted(directory, event.sessionID) ||
        getV2MemoryReadRevision(directory, event.sessionID) !== eventReadRevision
      )
        return;
      if (lineage.kind === "task-child") {
        if (config.injectInSubagents) markV2ChildDcpInjectionPending(directory, event.sessionID);
        return;
      }
      if (lineage.kind !== "primary") return;

      const state = stateFor(event.sessionID);
      if (!state) return;
      const now = Date.now();
      if (state.lastAcceptedAt && now - state.lastAcceptedAt < config.debounceMs * 2) {
        await logEvent(config, "v2_dcp_compress_skipped_duplicate", {
          sessionID: event.sessionID,
          toolCallID: event.id,
        }).catch(() => undefined);
        return;
      }
      state.lastAcceptedAt = now;
      state.pending = {
        sessionID: event.sessionID,
        messageID: event.messageID,
        toolCallID: event.id,
        readRevision: eventReadRevision,
        busyReplayCount: 0,
      };
      await logEvent(config, "v2_dcp_compress_scheduled", {
        sessionID: event.sessionID,
        messageID: event.messageID,
        toolCallID: event.id,
        delayMs: config.debounceMs * 2,
      }).catch(() => undefined);
      if (!state.running) schedule(state, config.debounceMs * 2);
    });
    if (disposed || lifetimeSignal.aborted) await registration.dispose();
    return { dispose };
  } catch (error) {
    lifetimeSignal.removeEventListener("abort", onLifetimeAbort);
    disposed = true;
    await registration?.dispose().catch(() => undefined);
    throw error;
  }
}
