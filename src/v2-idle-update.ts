import type { V2Context } from "./v2-adapter";
import { classifyV2Session } from "./v2-child-memory";
import { readV2CurrentHistory } from "./v2-current-history";
import { isV2MemoryUpdateInFlight } from "./v2-memory-update";
import type { createV2MemoryUpdater } from "./v2-memory-update";
import { deleteV2SessionMemory } from "./v2-session-deletion";
import { DEFAULT_CONFIG, logEvent, readConfig, safeSessionID } from "./memory-utils";

type Updater = ReturnType<typeof createV2MemoryUpdater>;
type Timer = ReturnType<typeof setTimeout>;
type EventRecord = { readonly type?: unknown; readonly data?: unknown; readonly location?: unknown };
type SessionState = {
  readonly sessionID: string;
  epoch: number;
  timer?: Timer;
  running: boolean;
  pending: boolean;
  oneReplayBudget: boolean;
  runController?: AbortController;
};

const MAX_SESSIONS = 128;
const WAIT_DEADLINE_MS = 5_000;
const DISPOSE_DEADLINE_MS = 1_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sessionIDOf(event: EventRecord): string | undefined {
  const value = record(event.data)?.sessionID;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventType(event: EventRecord): string {
  return typeof event.type === "string" ? event.type : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, lifetimeSignal: AbortSignal, deadline: number) {
  const controller = new AbortController();
  let timer: Timer | undefined;
  let cancel: () => void;
  const cancellation = new Promise<never>((_, reject) => {
    cancel = () => {
      const reason = lifetimeSignal.reason ?? new Error("v2_idle_wait_aborted");
      controller.abort(reason);
      reject(reason);
    };
    if (lifetimeSignal.aborted) {
      cancel();
      return;
    }
    lifetimeSignal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      const reason = new Error("v2_idle_wait_timeout");
      controller.abort(reason);
      reject(reason);
    }, deadline);
  });
  const operationPromise = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return operation(controller.signal);
  });
  // The host may ignore abort and settle after the bounded wait has finished.
  operationPromise.catch(() => undefined);
  return Promise.race([operationPromise, cancellation]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    lifetimeSignal.removeEventListener("abort", cancel);
  });
}

export type V2IdleUpdateScheduler = { readonly dispose: () => Promise<void> };

export function createV2IdleUpdateScheduler(
  context: V2Context,
  directory: string,
  updater: Updater,
  lifetimeSignal: AbortSignal,
): V2IdleUpdateScheduler {
  const states = new Map<string, SessionState>();
  const epochs = new Map<string, number>();
  const tasks = new Set<Promise<void>>();
  const disposed = new AbortController();
  let iterator: AsyncIterator<unknown> | undefined;

  const valid = (state: SessionState, epoch: number): boolean =>
    !disposed.signal.aborted &&
    !lifetimeSignal.aborted &&
    states.get(state.sessionID) === state &&
    state.epoch === epoch;

  const track = (task: Promise<void>): void => {
    tasks.add(task);
    task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
  };

  const delayFor = async (): Promise<number> => {
    try {
      return (await readConfig(undefined, directory)).debounceMs;
    } catch {
      return DEFAULT_CONFIG.debounceMs;
    }
  };

  const arm = (state: SessionState, epoch: number, delay: number): void => {
    if (!valid(state, epoch)) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      track(run(state, epoch));
    }, delay);
  };

  const evict = (): boolean => {
    if (states.size < MAX_SESSIONS) return true;
    for (const [sessionID, state] of states) {
      if (state.running) continue;
      if (state.timer !== undefined) clearTimeout(state.timer);
      states.delete(sessionID);
      return true;
    }
    return false;
  };

  const getState = (sessionID: string): SessionState | undefined => {
    const existing = states.get(sessionID);
    if (existing) return existing;
    if (!evict()) return undefined;
    const state: SessionState = {
      sessionID,
      epoch: epochs.get(sessionID) ?? 0,
      running: false,
      pending: false,
      oneReplayBudget: false,
    };
    states.set(sessionID, state);
    return state;
  };

  const invalidate = (sessionID: string): void => {
    const epoch = (epochs.get(sessionID) ?? 0) + 1;
    epochs.set(sessionID, epoch);
    const state = states.get(sessionID);
    if (state) {
      state.epoch = epoch;
      state.pending = false;
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
      state.runController?.abort(new Error("v2_idle_run_invalidated"));
      state.runController = undefined;
      states.delete(sessionID);
    }
    while (epochs.size > MAX_SESSIONS * 2) epochs.delete(epochs.keys().next().value as string);
  };

  async function run(state: SessionState, epoch: number): Promise<void> {
    if (!valid(state, epoch)) return;
    state.running = true;
    const runController = new AbortController();
    state.runController = runController;
    let busy = false;
    try {
      await bounded(
        (signal) => context.session.wait({ sessionID: state.sessionID }, { signal }),
        runController.signal,
        WAIT_DEADLINE_MS,
      ).catch(() => undefined);
      if (!valid(state, epoch)) return;
      const current = await readV2CurrentHistory(context, state.sessionID);
      if (!valid(state, epoch)) return;
      if (current.status !== "ready" || current.history.stoppedBeforeMessageID !== undefined) return;
      const lineage = await classifyV2Session(context, state.sessionID);
      if (!valid(state, epoch)) return;
      if (lineage.kind !== "primary") return;
      if (isV2MemoryUpdateInFlight(directory, state.sessionID)) {
        busy = true;
        return;
      }
      const result = await updater({ ...current.history, lifetimeSignal: runController.signal });
      if (!valid(state, epoch)) return;
      busy = result.status === "busy";
    } finally {
      state.running = false;
      if (state.runController === runController) state.runController = undefined;
      if (!valid(state, epoch)) return;
      if ((state.pending || (busy && state.oneReplayBudget)) && state.timer === undefined) {
        state.pending = false;
        // Notifications and busy results share one replay, which cannot fund another replay.
        state.oneReplayBudget = false;
        void delayFor().then((delay) => arm(state, epoch, delay));
      } else if (state.timer === undefined) {
        states.delete(state.sessionID);
      }
    }
  }

  const schedule = (sessionID: string): void => {
    const state = getState(sessionID);
    if (!state) return;
    const epoch = state.epoch;
    state.oneReplayBudget = true;
    state.pending = true;
    if (state.running) return;
    void delayFor().then((delay) => {
      if (!valid(state, epoch)) return;
      state.pending = false;
      arm(state, epoch, delay);
    });
  };

  const consume = async (): Promise<void> => {
    try {
      const source = context.event.subscribe({ signal: lifetimeSignal });
      iterator = source[Symbol.asyncIterator]();
      while (!disposed.signal.aborted && !lifetimeSignal.aborted) {
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value as EventRecord;
        const type = eventType(event);
        const sessionID = sessionIDOf(event);
        if (!sessionID) continue;
        if (type === "session.deleted") {
          if (safeSessionID(sessionID) !== sessionID) continue;
          // Plugin subscription is already location-scoped; the public event location is optional.
          if (event.location !== undefined) {
            const location = record(event.location);
            if (
              !location ||
              location.directory !== context.location.directory ||
              location.workspaceID !== context.location.workspaceID
            )
              continue;
          }
          invalidate(sessionID);
          track(
            deleteV2SessionMemory(directory, sessionID).catch(async (error) => {
              try {
                await logEvent(await readConfig(undefined, directory), "v2_session_deletion_error", {
                  error: errorText(error),
                });
              } catch {
                // Configuration/logging failure is intentionally not redirected to a global default log.
              }
            }),
          );
          continue;
        }
        if (type === "session.execution.started" || type === "session.moved") {
          invalidate(sessionID);
          continue;
        }
        if (type === "session.execution.interrupted" && record(event.data)?.reason === "shutdown") {
          invalidate(sessionID);
          continue;
        }
        if (
          type === "session.execution.succeeded" ||
          type === "session.execution.failed" ||
          type === "session.execution.interrupted"
        )
          schedule(sessionID);
      }
    } catch (error) {
      if (!disposed.signal.aborted && !lifetimeSignal.aborted) {
        try {
          await logEvent(await readConfig(undefined, directory), "v2_idle_event_consumer_error", {
            error: errorText(error),
          });
        } catch {
          // Configuration/logging failure is intentionally not redirected to a global default log.
        }
      }
    }
  };

  const consumer = consume();
  consumer.catch(() => undefined);

  return {
    async dispose() {
      if (disposed.signal.aborted) return;
      disposed.abort();
      for (const state of states.values()) {
        state.epoch += 1;
        state.runController?.abort(new Error("v2_idle_disposed"));
        state.runController = undefined;
        if (state.timer !== undefined) clearTimeout(state.timer);
      }
      states.clear();
      const returned = Promise.resolve(iterator?.return?.()).then(
        () => undefined,
        () => undefined,
      );
      await Promise.race([
        Promise.allSettled([...tasks]).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_DEADLINE_MS)),
      ]);
      await Promise.race([
        consumer,
        returned,
        new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_DEADLINE_MS)),
      ]);
    },
  };
}
