import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMemoryConfig } from "./memory-utils";
import {
  MEMORY_HEADER,
  MEMORY_FORMAT_VERSION,
  memoryPathFor,
  removeRawFileIfCurrent,
  resetBoundaryPathFor,
  safeSessionID,
  writeTextAtomic,
} from "./memory-utils";
import type { V2Context, V2SessionContext } from "./v2-adapter";
import { getV2MemorySessionSignal, isV2MemorySessionDeleted, withV2MemoryMutation } from "./v2-mutation-coordination";

type SessionRecord = { readonly id?: unknown; readonly parentID?: unknown };
export type V2SessionLineage =
  | { readonly kind: "primary" }
  | { readonly kind: "task-child"; readonly parentID: string }
  | { readonly kind: "metadata-error"; readonly detail: string };

type ChildState = {
  readonly version: 1;
  readonly sessionID: string;
  readonly parentID: string;
  readonly memory: string;
};

const CHILD_STATE_VERSION = 1;
const METADATA_TIMEOUT_MS = 5_000;

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
    return { kind: "metadata-error", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function readTaskChildMemory(
  context: V2Context,
  input: Pick<V2SessionContext, "sessionID">,
  config: Pick<SessionMemoryConfig, "memoryDir" | "maxMemoryLength" | "injectInSubagents">,
  directory: string,
  hooks: { readonly afterSnapshotWrite?: () => void | Promise<void> } = {},
): Promise<{
  readonly status: "injected" | "suppressed" | "metadata-error" | "invalid-state";
  readonly memory?: string;
}> {
  if (isV2MemorySessionDeleted(directory, input.sessionID)) return { status: "suppressed" };
  const lineage = await classifyV2Session(context, input.sessionID);
  if (isV2MemorySessionDeleted(directory, input.sessionID)) return { status: "suppressed" };
  if (lineage.kind === "metadata-error") return { status: "metadata-error" };
  if (lineage.kind === "primary") return { status: "injected" };
  if (!config.injectInSubagents) return { status: "suppressed" };
  const path = childStatePath(input.sessionID, config.memoryDir);
  const childSignal = getV2MemorySessionSignal(directory, input.sessionID);
  try {
    const result = await withV2MemoryMutation<Awaited<ReturnType<typeof readTaskChildMemory>> | undefined>(
      directory,
      input.sessionID,
      async () => {
        let existingRaw: string | undefined;
        try {
          existingRaw = await readBoundedText(path, config.maxMemoryLength * 6 + 4096);
        } catch {
          if (isV2MemorySessionDeleted(directory, input.sessionID)) return { status: "suppressed" };
          return { status: "invalid-state" };
        }
        if (isV2MemorySessionDeleted(directory, input.sessionID)) return { status: "suppressed" };
        if (existingRaw !== undefined && !existingRaw.trim()) return { status: "invalid-state" };
        const existing = parseState(existingRaw ?? "", input.sessionID);
        if (existing === null || (existing !== undefined && existing.parentID !== lineage.parentID)) {
          return { status: "invalid-state" };
        }
        const boundary = await readBoundedText(resetBoundaryPathFor(input.sessionID, config.memoryDir), 4096);
        if (isV2MemorySessionDeleted(directory, input.sessionID) || boundary !== undefined) {
          return { status: "suppressed" };
        }
        if (existing) return { status: "injected", memory: existing.memory };
        return undefined;
      },
    );
    if (isV2MemorySessionDeleted(directory, input.sessionID)) return { status: "suppressed" };
    if (result) return result;
  } catch (error: unknown) {
    if (childSignal.aborted && error === childSignal.reason) return { status: "suppressed" };
    throw error;
  }

  let parentMemory: string | undefined;
  try {
    parentMemory = await withV2MemoryMutation(directory, lineage.parentID, () =>
      readBoundedText(memoryPathFor(lineage.parentID, config.memoryDir), config.maxMemoryLength * 4 + 4096),
    );
  } catch {
    if (isV2MemorySessionDeleted(directory, input.sessionID) || isV2MemorySessionDeleted(directory, lineage.parentID)) {
      return { status: "suppressed" };
    }
    return { status: "invalid-state" };
  }
  if (isV2MemorySessionDeleted(directory, input.sessionID) || isV2MemorySessionDeleted(directory, lineage.parentID)) {
    return { status: "suppressed" };
  }
  const memory = parentMemory?.slice(0, config.maxMemoryLength) ?? "";
  if (!validMemory(memory)) return { status: "invalid-state" };
  try {
    const result = await withV2MemoryMutation<Awaited<ReturnType<typeof readTaskChildMemory>>>(
      directory,
      input.sessionID,
      async () => {
        let currentRaw: string | undefined;
        try {
          currentRaw = await readBoundedText(path, config.maxMemoryLength * 6 + 4096);
        } catch {
          if (isV2MemorySessionDeleted(directory, input.sessionID)) return { status: "suppressed" };
          return { status: "invalid-state" };
        }
        if (isV2MemorySessionDeleted(directory, input.sessionID)) return { status: "suppressed" };
        if (currentRaw !== undefined && !currentRaw.trim()) return { status: "invalid-state" };
        const current = parseState(currentRaw ?? "", input.sessionID);
        if (current === null || (current !== undefined && current.parentID !== lineage.parentID)) {
          return { status: "invalid-state" };
        }
        const currentBoundary = await readBoundedText(resetBoundaryPathFor(input.sessionID, config.memoryDir), 4096);
        if (isV2MemorySessionDeleted(directory, input.sessionID) || currentBoundary !== undefined) {
          return { status: "suppressed" };
        }
        if (current) return { status: "injected", memory: current.memory };
        const state: ChildState = {
          version: CHILD_STATE_VERSION,
          sessionID: input.sessionID,
          parentID: lineage.parentID,
          memory,
        };
        if (
          isV2MemorySessionDeleted(directory, input.sessionID) ||
          isV2MemorySessionDeleted(directory, lineage.parentID)
        ) {
          return { status: "suppressed" };
        }
        const raw = JSON.stringify(state) + "\n";
        await writeTextAtomic(path, raw);
        if (hooks.afterSnapshotWrite) await hooks.afterSnapshotWrite();
        if (isV2MemorySessionDeleted(directory, lineage.parentID)) {
          await removeRawFileIfCurrent(path, Buffer.from(raw, "utf8"));
          return { status: "suppressed" };
        }
        if (isV2MemorySessionDeleted(directory, input.sessionID)) return { status: "suppressed" };
        return { status: "injected", memory };
      },
    );
    if (isV2MemorySessionDeleted(directory, input.sessionID)) return { status: "suppressed" };
    return result;
  } catch (error: unknown) {
    if (childSignal.aborted && error === childSignal.reason) return { status: "suppressed" };
    throw error;
  }
}

export async function taskChildUpdaterSkip(context: V2Context, sessionID: string): Promise<string | undefined> {
  const lineage = await classifyV2Session(context, sessionID);
  if (lineage.kind === "task-child") return "task_child_inheritance";
  if (lineage.kind === "metadata-error") return "session_metadata_unavailable";
  return undefined;
}
