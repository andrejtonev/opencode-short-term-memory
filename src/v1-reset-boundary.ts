import { join } from "node:path";
import {
  STANDARD_MEMORY_TEMPLATE,
  checkpointPathFor,
  getMessageTime,
  memoryPathFor,
  prepareRawFile,
  readRawFile,
  removeRawFileIfCurrent,
  safeSessionID,
  type SessionMemoryConfig,
} from "./memory-utils";

// Separate from V2's invocation/snapshot boundary: null records a verified empty
// V1 history, so subsequent messages need no nonexistent anchor to be found.
export type V1ResetBoundary = { readonly version: 1; readonly anchorID: string | null };

export function v1ResetBoundaryPathFor(sessionID: string, memoryDir: string) {
  return join(memoryDir, "v1-reset-boundaries", `${safeSessionID(sessionID)}.json`);
}

function messageIDValue(row: unknown): unknown {
  const r = row as Record<string, unknown>;
  const message = r?.message as Record<string, unknown> | undefined;
  const info = r?.info as Record<string, unknown> | undefined;
  const messageInfo = message?.info as Record<string, unknown> | undefined;
  return r?.id ?? r?.messageID ?? r?.messageId ?? message?.id ?? info?.id ?? messageInfo?.id;
}

export function getV1HistoryMessageID(row: unknown): string {
  return String(messageIDValue(row) || "").trim();
}

export function sortV1History(rows: readonly unknown[]): unknown[] {
  return [...rows].sort((a, b) => {
    const timeA = getMessageTime(a);
    const timeB = getMessageTime(b);
    if (timeA !== undefined && timeB !== undefined) return timeA - timeB;
    const idA = getV1HistoryMessageID(a);
    const idB = getV1HistoryMessageID(b);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}

function validatedHistory(rows: readonly unknown[]): unknown[] {
  if (!Array.isArray(rows)) throw new Error("reset_history_invalid");
  const ids = rows.map(getV1HistoryMessageID);
  if (
    rows.some((row) => typeof messageIDValue(row) !== "string") ||
    ids.some((id) => !id) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("reset_history_ambiguous_ids");
  return sortV1History(rows);
}

export function selectV1ResetBoundary(rows: readonly unknown[]): V1ResetBoundary {
  const sorted = validatedHistory(rows);
  return { version: 1, anchorID: sorted.length ? getV1HistoryMessageID(sorted[sorted.length - 1]) : null };
}

export async function readV1ResetBoundary(sessionID: string, memoryDir: string): Promise<V1ResetBoundary | undefined> {
  const raw = await readRawFile(v1ResetBoundaryPathFor(sessionID, memoryDir));
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("malformed_v1_reset_boundary");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    (value as V1ResetBoundary).version !== 1 ||
    ((value as V1ResetBoundary).anchorID !== null &&
      (typeof (value as V1ResetBoundary).anchorID !== "string" || !(value as V1ResetBoundary).anchorID?.trim()))
  )
    throw new Error("malformed_v1_reset_boundary");
  return value as V1ResetBoundary;
}

export function historyAfterV1Reset(rows: readonly unknown[], boundary: V1ResetBoundary): unknown[] {
  const sorted = validatedHistory(rows);
  if (boundary.anchorID === null) return sorted;
  const index = sorted.findIndex((row) => getV1HistoryMessageID(row) === boundary.anchorID);
  if (index < 0) throw new Error("v1_reset_anchor_absent");
  return sorted.slice(index + 1);
}

// Caller owns the session persistence lock and generation fence. Prepare all
// files before changing any; commit the boundary first so partial failures are
// conservative. Rollback is byte-preserving and refuses external conflicts.
export async function persistV1Reset(
  sessionID: string,
  config: Pick<SessionMemoryConfig, "memoryDir">,
  boundary: V1ResetBoundary,
  hooks: { beforeCommit?: (kind: "boundary" | "memory" | "checkpoint") => void | Promise<void> } = {},
) {
  const specifications = [
    {
      kind: "boundary" as const,
      path: v1ResetBoundaryPathFor(sessionID, config.memoryDir),
      data: Buffer.from(JSON.stringify(boundary) + "\n"),
    },
    {
      kind: "memory" as const,
      path: memoryPathFor(sessionID, config.memoryDir),
      data: Buffer.from(STANDARD_MEMORY_TEMPLATE),
    },
    { kind: "checkpoint" as const, path: checkpointPathFor(sessionID, config.memoryDir), data: Buffer.alloc(0) },
  ];
  const operations: {
    kind: "boundary" | "memory" | "checkpoint";
    previous: Buffer | null;
    prepared: Awaited<ReturnType<typeof prepareRawFile>>;
  }[] = [];
  const committed: typeof operations = [];
  try {
    for (const item of specifications) {
      const previous = await readRawFile(item.path);
      const prepared = await prepareRawFile(item.path, item.data);
      operations.push({ kind: item.kind, previous, prepared });
    }
    try {
      for (const item of operations) {
        await hooks.beforeCommit?.(item.kind);
        if (!(await item.prepared.commit(item.previous))) throw new Error(`V1 reset conflict: ${item.kind}`);
        committed.push(item);
      }
    } catch (originalError) {
      const failures: unknown[] = [];
      for (const item of committed.reverse()) {
        try {
          let restored: boolean;
          if (item.previous === null) {
            restored = await removeRawFileIfCurrent(item.prepared.path, item.prepared.committed);
          } else {
            const restore = await prepareRawFile(item.prepared.path, item.previous);
            try {
              restored = await restore.commit(item.prepared.committed);
            } finally {
              await restore.discard();
            }
          }
          if (!restored) throw new Error(`V1 reset rollback conflict: ${item.kind}`);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          [originalError, ...failures],
          "V1 reset failed; rollback incomplete. Inspect persisted state before retrying.",
        );
      throw originalError;
    }
  } finally {
    for (const item of operations) await item.prepared.discard();
  }
}
