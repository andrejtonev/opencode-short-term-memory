import { diagnosticErrorMessage } from "./diagnostics";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMemoryConfig } from "./memory-utils";
import {
  MEMORY_HEADER,
  MEMORY_FORMAT_VERSION,
  memoryPathFor,
  removeRawFileIfCurrent,
  resetBoundaryPathFor,
  readConfig,
  safeSessionID,
  writeTextAtomic,
} from "./memory-utils";
import type { V2Context, V2SessionContext } from "./v2-adapter";
import { getV2MemorySessionSignal, isV2MemorySessionDeleted, withV2MemoryMutation } from "./v2-mutation-coordination";
import { isV2OwnedSummarySession, isV2OwnedSummarySessionMetadata } from "./v2-native-generation";

type SessionRecord = { readonly id?: unknown; readonly parentID?: unknown; readonly metadata?: unknown };
export type V2SessionLineage =
  | { readonly kind: "primary" }
  | { readonly kind: "task-child"; readonly parentID: string }
  | { readonly kind: "internal-summary" }
  | { readonly kind: "metadata-error"; readonly detail: string };

type ChildState = {
  readonly version: 1;
  readonly sessionID: string;
  readonly parentID: string;
  readonly memory: string;
};

const CHILD_STATE_VERSION = 1;
const METADATA_TIMEOUT_MS = 5_000;

type ChildCaptureResult =
  | { readonly status: "captured" | "existing"; readonly memory: string }
  | { readonly status: "suppressed" | "invalid-state" | "disabled" };
type ChildMemoryReadResult = {
  readonly status: "injected" | "suppressed" | "invalid-state" | "missing-snapshot";
  readonly memory?: string;
};
type ChildInitialization = { readonly parentID: string; readonly promise: Promise<ChildCaptureResult> };
type ChildRuntimeState = {
  readonly initializing: Map<string, ChildInitialization>;
  readonly childrenByParent: Map<string, Set<string>>;
  readonly startupDelivered: Set<string>;
  readonly startupClaimed: Set<string>;
  readonly dcpPending: Set<string>;
  readonly dcpVersion: Map<string, number>;
  readonly dcpClaimed: Map<string, number>;
};

const childRuntime = new Map<string, ChildRuntimeState>();

function runtimeFor(directory: string): ChildRuntimeState {
  let state = childRuntime.get(directory);
  if (!state) {
    state = {
      initializing: new Map(),
      childrenByParent: new Map(),
      startupDelivered: new Set(),
      startupClaimed: new Set(),
      dcpPending: new Set(),
      dcpVersion: new Map(),
      dcpClaimed: new Map(),
    };
    childRuntime.set(directory, state);
  }
  return state;
}

function rememberParent(directory: string, childID: string, parentID: string): void {
  const children = runtimeFor(directory).childrenByParent;
  let siblings = children.get(parentID);
  if (!siblings) {
    siblings = new Set();
    children.set(parentID, siblings);
  }
  siblings.add(childID);
}

export type V2ChildSystemDelivery = "startup" | "dcp";

/** A child create event installs this barrier synchronously before capture awaits I/O. */
export function captureV2ChildMemoryAtCreation(
  context: V2Context,
  input: { readonly sessionID: string; readonly parentID: string; readonly metadata?: unknown },
  directory: string,
  hooks: { readonly afterSnapshotWrite?: () => void | Promise<void> } = {},
  lifetimeSignal?: AbortSignal,
): Promise<ChildCaptureResult> {
  const { sessionID, parentID } = input;
  const runtime = runtimeFor(directory);
  const existingInitialization = runtime.initializing.get(sessionID);
  if (existingInitialization) {
    return existingInitialization.parentID === parentID
      ? existingInitialization.promise
      : Promise.resolve({ status: "invalid-state" });
  }
  if (
    !sessionID.trim() ||
    !parentID.trim() ||
    sessionID === parentID ||
    !isSafeID(sessionID) ||
    !isSafeID(parentID) ||
    isV2OwnedSummarySession(context, sessionID) ||
    isV2OwnedSummarySessionMetadata(input.metadata) ||
    isV2MemorySessionDeleted(directory, sessionID) ||
    isV2MemorySessionDeleted(directory, parentID) ||
    lifetimeSignal?.aborted
  ) {
    return Promise.resolve({ status: "suppressed" });
  }
  rememberParent(directory, sessionID, parentID);

  let resolveInitialization!: (result: ChildCaptureResult) => void;
  const promise = new Promise<ChildCaptureResult>((resolve) => {
    resolveInitialization = resolve;
  });
  const initialization: ChildInitialization = { parentID, promise };
  runtime.initializing.set(sessionID, initialization);

  void (async () => {
    let result: ChildCaptureResult = { status: "suppressed" };
    try {
      const config = await readConfig(undefined, directory);
      if (!config.enabled || !config.injectInSubagents) {
        result = { status: "disabled" };
        return;
      }
      const cancelled = () =>
        lifetimeSignal?.aborted ||
        isV2MemorySessionDeleted(directory, sessionID) ||
        isV2MemorySessionDeleted(directory, parentID);
      if (cancelled()) return;
      const stateDirectory = await childStateDirectory(config.memoryDir, true);
      if (!stateDirectory) {
        result = { status: "invalid-state" };
        return;
      }
      const path = join(stateDirectory, `${sessionID}.json`);
      const childSignal = getV2MemorySessionSignal(directory, sessionID);
      const maxBytes = config.maxMemoryLength * 6 + 4096;

      let captured: ChildCaptureResult | undefined;
      try {
        captured = await withV2MemoryMutation(directory, sessionID, async () => {
          if (cancelled()) return { status: "suppressed" };
          const existingRaw = await readBoundedText(path, maxBytes);
          if (existingRaw !== undefined && !existingRaw.trim()) return { status: "invalid-state" };
          const existing = parseState(existingRaw ?? "", sessionID);
          if (existing === null || (existing !== undefined && existing.parentID !== parentID))
            return { status: "invalid-state" };
          const boundary = await readBoundedText(resetBoundaryPathFor(sessionID, config.memoryDir), 4096);
          if (cancelled() || boundary !== undefined) return { status: "suppressed" };
          if (existing) return { status: "existing", memory: existing.memory };
          return undefined;
        });
      } catch (error: unknown) {
        if (childSignal.aborted || cancelled()) return;
        throw error;
      }
      if (captured) {
        result = captured;
        return;
      }

      let parentMemory: string | undefined;
      try {
        parentMemory = await withV2MemoryMutation(directory, parentID, () =>
          cancelled()
            ? undefined
            : readBoundedText(memoryPathFor(parentID, config.memoryDir), config.maxMemoryLength * 4 + 4096),
        );
      } catch {
        if (cancelled()) return;
        result = { status: "invalid-state" };
        return;
      }
      if (cancelled()) return;
      const memory = parentMemory?.slice(0, config.maxMemoryLength) ?? "";
      if (!validMemory(memory)) {
        result = { status: "invalid-state" };
        return;
      }

      try {
        result = await withV2MemoryMutation(directory, sessionID, async () => {
          if (cancelled()) return { status: "suppressed" };
          const currentRaw = await readBoundedText(path, maxBytes);
          if (currentRaw !== undefined && !currentRaw.trim()) return { status: "invalid-state" };
          const current = parseState(currentRaw ?? "", sessionID);
          if (current === null || (current !== undefined && current.parentID !== parentID))
            return { status: "invalid-state" };
          const boundary = await readBoundedText(resetBoundaryPathFor(sessionID, config.memoryDir), 4096);
          if (cancelled() || boundary !== undefined) return { status: "suppressed" };
          if (current) return { status: "existing", memory: current.memory };
          const state: ChildState = { version: CHILD_STATE_VERSION, sessionID, parentID, memory };
          if (cancelled()) return { status: "suppressed" };
          const raw = JSON.stringify(state) + "\n";
          await writeTextAtomic(path, raw);
          if (hooks.afterSnapshotWrite) await hooks.afterSnapshotWrite();
          if (cancelled()) {
            await removeRawFileIfCurrent(path, Buffer.from(raw, "utf8"));
            return { status: "suppressed" };
          }
          return { status: "captured", memory };
        });
      } catch (error: unknown) {
        if (childSignal.aborted || cancelled()) return;
        throw error;
      }
    } catch {
      result = { status: "invalid-state" };
    } finally {
      if (result.status === "captured" || result.status === "existing") {
        runtime.startupDelivered.delete(sessionID);
      } else if (runtime.initializing.get(sessionID) === initialization) {
        // A failed or disabled observed capture must not poison later plugin
        // instances, but readTaskChildMemory still never performs a late capture.
        runtime.initializing.delete(sessionID);
      }
      resolveInitialization(result);
    }
  })();
  return promise;
}

export async function awaitV2ChildInitialization(
  directory: string,
  sessionID: string,
): Promise<ChildCaptureResult | undefined> {
  return runtimeFor(directory).initializing.get(sessionID)?.promise;
}

export function getV2ChildSystemDelivery(directory: string, sessionID: string): V2ChildSystemDelivery | undefined {
  const runtime = runtimeFor(directory);
  if (!runtime.startupDelivered.has(sessionID)) return "startup";
  if (runtime.dcpPending.has(sessionID)) return "dcp";
  return undefined;
}

/** Claim one child system delivery so overlapping context hooks cannot inject twice. */
export function claimV2ChildSystemDelivery(directory: string, sessionID: string): V2ChildSystemDelivery | undefined {
  const runtime = runtimeFor(directory);
  if (!runtime.startupDelivered.has(sessionID)) {
    if (runtime.startupClaimed.has(sessionID)) return undefined;
    runtime.startupClaimed.add(sessionID);
    return "startup";
  }
  if (runtime.dcpPending.has(sessionID) && !runtime.dcpClaimed.has(sessionID)) {
    runtime.dcpClaimed.set(sessionID, runtime.dcpVersion.get(sessionID) ?? 0);
    return "dcp";
  }
  return undefined;
}

export function completeV2ChildSystemDelivery(
  directory: string,
  sessionID: string,
  delivery: V2ChildSystemDelivery,
): void {
  const runtime = runtimeFor(directory);
  if (delivery === "startup") {
    runtime.startupClaimed.delete(sessionID);
    runtime.startupDelivered.add(sessionID);
  } else {
    const claimedVersion = runtime.dcpClaimed.get(sessionID);
    runtime.dcpClaimed.delete(sessionID);
    if (claimedVersion === runtime.dcpVersion.get(sessionID)) {
      runtime.dcpPending.delete(sessionID);
      runtime.dcpVersion.delete(sessionID);
    }
  }
}

export function releaseV2ChildSystemDelivery(
  directory: string,
  sessionID: string,
  delivery: V2ChildSystemDelivery,
): void {
  const runtime = runtimeFor(directory);
  if (delivery === "startup") runtime.startupClaimed.delete(sessionID);
  else runtime.dcpClaimed.delete(sessionID);
}

export function markV2ChildDcpInjectionPending(directory: string, sessionID: string): void {
  if (isV2MemorySessionDeleted(directory, sessionID)) return;
  const runtime = runtimeFor(directory);
  runtime.dcpPending.add(sessionID);
  runtime.dcpVersion.set(sessionID, (runtime.dcpVersion.get(sessionID) ?? 0) + 1);
}

export async function v2ChildSessionIDsForParent(
  directory: string,
  parentID: string,
  memoryDir: string,
): Promise<readonly string[]> {
  const result = new Set(runtimeFor(directory).childrenByParent.get(parentID) ?? []);
  try {
    const stateDirectory = await childStateDirectory(memoryDir, false);
    if (!stateDirectory) return [...result].filter((sessionID) => sessionID !== parentID);
    const entries = await readdir(stateDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const sessionID = entry.name.slice(0, -5);
      if (!sessionID || !isSafeID(sessionID)) continue;
      try {
        const raw = await readBoundedText(join(stateDirectory, entry.name), 1_000_000);
        if (raw === undefined) continue;
        const state = parseState(raw, sessionID);
        if (state?.parentID === parentID) result.add(sessionID);
      } catch {
        // Ignore corrupt/unreadable child state while cleaning a parent family.
      }
    }
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== "ENOENT") throw error;
  }
  return [...result].filter((sessionID) => sessionID !== parentID);
}

export function forgetV2ChildSession(directory: string, sessionID: string): void {
  const runtime = runtimeFor(directory);
  runtime.startupDelivered.delete(sessionID);
  runtime.startupClaimed.delete(sessionID);
  runtime.dcpPending.delete(sessionID);
  runtime.dcpClaimed.delete(sessionID);
  runtime.dcpVersion.delete(sessionID);
  runtime.initializing.delete(sessionID);
  for (const [parentID, children] of runtime.childrenByParent) {
    children.delete(sessionID);
    if (!children.size) runtime.childrenByParent.delete(parentID);
  }
  runtime.childrenByParent.delete(sessionID);
}

/** Drop process-local barriers and delivery claims when the plugin instance is disposed. */
export function resetV2ChildMemoryRuntime(directory: string): void {
  childRuntime.delete(directory);
}

function isSafeID(value: string): boolean {
  try {
    return safeSessionID(value) === value;
  } catch {
    return false;
  }
}

export function childStatePath(sessionID: string, memoryDir: string): string {
  return join(memoryDir, "task-children", `${safeSessionID(sessionID)}.json`);
}

function validMemory(memory: unknown): memory is string {
  return (
    typeof memory === "string" &&
    (memory.startsWith(MEMORY_HEADER) || memory.startsWith(`${MEMORY_FORMAT_VERSION}\n${MEMORY_HEADER}`))
  );
}

async function readBoundedText(path: string, maxBytes: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("child_memory_file_oversize_or_nonregular");
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function childStateDirectory(memoryDir: string, create: boolean): Promise<string | undefined> {
  const path = join(memoryDir, "task-children");
  if (create) await mkdir(path, { recursive: true });
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe_child_state_directory");
    return path;
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function removeV2ChildStateFile(sessionID: string, memoryDir: string): Promise<void> {
  const directory = await childStateDirectory(memoryDir, false);
  if (!directory) return;
  const path = join(directory, `${safeSessionID(sessionID)}.json`);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("unsafe_child_state_file");
    await rm(path, { force: true });
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== "ENOENT") throw error;
  }
}

function parseState(raw: string, sessionID: string): ChildState | null | undefined {
  if (!raw.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ChildState>;
    if (
      value.version !== CHILD_STATE_VERSION ||
      value.sessionID !== sessionID ||
      typeof value.parentID !== "string" ||
      !value.parentID.trim() ||
      !validMemory(value.memory)
    ) {
      return null;
    }
    return value as ChildState;
  } catch {
    return null;
  }
}

function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("session_metadata_timeout"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    operation().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function classifyV2Session(context: V2Context, sessionID: string): Promise<V2SessionLineage> {
  try {
    if (!sessionID.trim() || safeSessionID(sessionID) !== sessionID) {
      return { kind: "metadata-error", detail: "unsafe_session_id" };
    }
    const signal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
    const getter = (context.session as unknown as { get?: (input: unknown, options?: unknown) => Promise<unknown> })
      .get;
    if (typeof getter !== "function") return { kind: "metadata-error", detail: "session_get_unavailable" };
    const value = await bounded(() => getter.call(context.session, { sessionID }, { signal }), signal);
    if (!value || typeof value !== "object") return { kind: "metadata-error", detail: "invalid_session_record" };
    const record = value as SessionRecord;
    if (record.id !== sessionID) return { kind: "metadata-error", detail: "session_id_mismatch" };
    if (isV2OwnedSummarySession(context, sessionID) || isV2OwnedSummarySessionMetadata(record.metadata))
      return { kind: "internal-summary" };
    if (record.parentID === undefined || record.parentID === null) return { kind: "primary" };
    if (typeof record.parentID === "string" && record.parentID.trim()) {
      if (record.parentID === sessionID) return { kind: "metadata-error", detail: "self_parent" };
      if (safeSessionID(record.parentID) !== record.parentID) {
        return { kind: "metadata-error", detail: "unsafe_parent_id" };
      }
      return { kind: "task-child", parentID: record.parentID };
    }
    return { kind: "metadata-error", detail: "invalid_parent_id" };
  } catch (error: unknown) {
    return { kind: "metadata-error", detail: diagnosticErrorMessage(error) };
  }
}

export async function readTaskChildMemory(
  context: V2Context,
  input: Pick<V2SessionContext, "sessionID">,
  config: Pick<SessionMemoryConfig, "memoryDir" | "maxMemoryLength" | "injectInSubagents">,
  directory: string,
  hooks: { readonly afterSnapshotWrite?: () => void | Promise<void> } = {},
  lifetimeSignal?: AbortSignal,
): Promise<{
  readonly status: "injected" | "suppressed" | "metadata-error" | "invalid-state" | "missing-snapshot";
  readonly memory?: string;
}> {
  void hooks;
  const cancelled = () => lifetimeSignal?.aborted || isV2MemorySessionDeleted(directory, input.sessionID);
  if (cancelled()) return { status: "suppressed" };
  const initialization = await awaitV2ChildInitialization(directory, input.sessionID);
  if (cancelled()) return { status: "suppressed" };
  if (initialization?.status === "invalid-state") return { status: "invalid-state" };
  if (initialization && initialization.status !== "captured" && initialization.status !== "existing")
    return { status: "suppressed" };
  const lineage = await classifyV2Session(context, input.sessionID);
  if (cancelled()) return { status: "suppressed" };
  if (lineage.kind === "metadata-error") return { status: "metadata-error" };
  if (lineage.kind === "internal-summary") return { status: "suppressed" };
  if (lineage.kind === "primary") return { status: "injected" };
  if (!config.injectInSubagents) return { status: "suppressed" };
  const childSignal = getV2MemorySessionSignal(directory, input.sessionID);
  try {
    const result = await withV2MemoryMutation<ChildMemoryReadResult>(directory, input.sessionID, async () => {
      if (cancelled() || isV2MemorySessionDeleted(directory, lineage.parentID)) return { status: "suppressed" };
      let raw: string | undefined;
      try {
        const stateDirectory = await childStateDirectory(config.memoryDir, false);
        if (stateDirectory) {
          raw = await readBoundedText(
            join(stateDirectory, `${input.sessionID}.json`),
            config.maxMemoryLength * 6 + 4096,
          );
        }
      } catch {
        if (cancelled()) return { status: "suppressed" };
        return { status: "invalid-state" };
      }
      if (cancelled()) return { status: "suppressed" };
      const boundary = await readBoundedText(resetBoundaryPathFor(input.sessionID, config.memoryDir), 4096);
      if (cancelled() || boundary !== undefined) return { status: "suppressed" };
      if (raw === undefined) return { status: "missing-snapshot" };
      if (!raw.trim()) return { status: "invalid-state" };
      const saved = parseState(raw, input.sessionID);
      if (!saved || saved.parentID !== lineage.parentID) return { status: "invalid-state" };
      return { status: "injected", memory: saved.memory };
    });
    if (cancelled()) return { status: "suppressed" };
    return result;
  } catch (error: unknown) {
    if (childSignal.aborted && error === childSignal.reason) return { status: "suppressed" };
    throw error;
  }
}

export async function taskChildUpdaterSkip(context: V2Context, sessionID: string): Promise<string | undefined> {
  const lineage = await classifyV2Session(context, sessionID);
  if (lineage.kind === "task-child") return "task_child_inheritance";
  if (lineage.kind === "internal-summary") return "internal_session";
  if (lineage.kind === "metadata-error") return "session_metadata_unavailable";
  return undefined;
}
