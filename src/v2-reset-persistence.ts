import { diagnosticErrorMessage } from "./diagnostics";
import type { SessionMemoryConfig } from "./memory-utils";
import {
  STANDARD_MEMORY_TEMPLATE,
  checkpointPathFor,
  memoryPathFor,
  resetBoundaryPathFor,
  prepareRawFile,
  readConfig,
  readRawFile,
  removeRawFileIfCurrent,
  safeSessionID,
} from "./memory-utils";
import {
  invalidateV2MemoryGeneration,
  invalidateV2MemoryReads,
  withV2MemoryMutation,
} from "./v2-mutation-coordination";

export type V2MemoryResetTestHooks = {
  readonly beforePrepare?: () => void | Promise<void>;
  readonly beforeCommit?: (kind: "memory" | "checkpoint" | "boundary") => void | Promise<void>;
  readonly beforeRollback?: (kind: "memory" | "checkpoint" | "boundary") => void | Promise<void>;
};

type ResetConfig = Pick<SessionMemoryConfig, "memoryDir">;

function causeMessage(error: unknown): string {
  return diagnosticErrorMessage(error ?? "unknown error");
}

// This is process-local operation rollback, not crash- or cross-process ACID. The boundary
// prevents direct replay of pre-reset history; if its anchor is absent, updates pause.
export async function resetV2MemoryPersistence(
  sessionID: string,
  directory: string,
  anchor: string | null | (() => Promise<string | null>),
  config?: ResetConfig,
  hooks: V2MemoryResetTestHooks = {},
  lifetimeSignal?: AbortSignal,
): Promise<string | null> {
  if (typeof sessionID !== "string" || !sessionID.trim()) throw new Error("reset sessionID must be a nonempty string");
  if (safeSessionID(sessionID) !== sessionID) throw new Error("reset sessionID contains unsafe path characters");
  if (anchor !== null && typeof anchor !== "function" && (typeof anchor !== "string" || !anchor.trim())) {
    throw new Error("reset anchor ID must be nonempty");
  }
  const assertCurrent = () => lifetimeSignal?.throwIfAborted();
  assertCurrent();
  invalidateV2MemoryGeneration(directory, sessionID);
  const resetting = withV2MemoryMutation(directory, sessionID, async () => {
    assertCurrent();
    // Readers admitted before this reset must not publish their old snapshot.
    // Refused/failed resets conservatively invalidate pending reads as well.
    invalidateV2MemoryReads(directory, sessionID);
    const anchorID = typeof anchor === "function" ? await anchor() : anchor;
    assertCurrent();
    if (anchorID !== null && (typeof anchorID !== "string" || !anchorID.trim()))
      throw new Error("reset anchor ID must be nonempty");
    const resolvedConfig = config ?? (await readConfig(undefined, directory));
    assertCurrent();
    const memoryPath = memoryPathFor(sessionID, resolvedConfig.memoryDir);
    const checkpointPath = checkpointPathFor(sessionID, resolvedConfig.memoryDir);
    const boundaryPath = resetBoundaryPathFor(sessionID, resolvedConfig.memoryDir);
    const previousMemory = await readRawFile(memoryPath);
    const previousCheckpoint = await readRawFile(checkpointPath);
    const previousBoundary = await readRawFile(boundaryPath);
    await hooks.beforePrepare?.();
    assertCurrent();

    const memoryPrepared = await prepareRawFile(memoryPath, Buffer.from(STANDARD_MEMORY_TEMPLATE, "utf8"));
    let checkpointPrepared: Awaited<ReturnType<typeof prepareRawFile>> | undefined;
    let boundaryPrepared: Awaited<ReturnType<typeof prepareRawFile>> | undefined;
    try {
      assertCurrent();
      checkpointPrepared = await prepareRawFile(checkpointPath, Buffer.alloc(0));
      assertCurrent();
      boundaryPrepared = await prepareRawFile(
        boundaryPath,
        Buffer.from(JSON.stringify({ version: 1, anchorID }) + "\n", "utf8"),
      );
      assertCurrent();
    } catch (originalError) {
      const cleanupErrors: unknown[] = [];
      for (const prepared of [memoryPrepared, checkpointPrepared, boundaryPrepared]) {
        if (!prepared) continue;
        try {
          await prepared.discard();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([originalError, ...cleanupErrors], "V2 reset preparation cleanup failed", {
          cause: originalError,
        });
      }
      throw originalError;
    }

    const operations = [
      { kind: "boundary" as const, prepared: boundaryPrepared!, previous: previousBoundary },
      { kind: "memory" as const, prepared: memoryPrepared, previous: previousMemory },
      { kind: "checkpoint" as const, prepared: checkpointPrepared!, previous: previousCheckpoint },
    ];
    const committed: typeof operations = [];
    try {
      for (const operation of operations) {
        await hooks.beforeCommit?.(operation.kind);
        assertCurrent();
        if (!(await operation.prepared.commit(operation.previous))) {
          throw new Error(`reset forward conflict: ${operation.kind} changed externally`);
        }
        committed.push(operation);
        assertCurrent();
      }
    } catch (originalError) {
      const rollbackErrors: unknown[] = [];
      for (const operation of committed.reverse()) {
        try {
          await hooks.beforeRollback?.(operation.kind);
          let restored: boolean;
          if (operation.previous === null) {
            restored = await removeRawFileIfCurrent(operation.prepared.path, operation.prepared.committed);
          } else {
            const restorePrepared = await prepareRawFile(operation.prepared.path, operation.previous);
            try {
              restored = await restorePrepared.commit(operation.prepared.committed);
            } catch (restoreError) {
              try {
                await restorePrepared.discard();
              } catch (cleanupError) {
                throw new AggregateError([restoreError, cleanupError], "V2 reset restoration cleanup failed", {
                  cause: restoreError,
                });
              }
              throw restoreError;
            }
            await restorePrepared.discard();
          }
          if (!restored) {
            throw new Error(`reset rollback conflict: ${operation.kind} changed externally`);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const operation of operations) {
        await operation.prepared.discard().catch((discardError) => rollbackErrors.push(discardError));
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [originalError, ...rollbackErrors],
          `V2 reset failed: original=${causeMessage(originalError)}; rollback=${rollbackErrors.map(causeMessage).join(" | ")}`,
          { cause: originalError },
        );
      }
      throw originalError;
    }
    for (const operation of operations) await operation.prepared.discard();
    return anchorID;
  });
  // Invalidate reads started while the reset was preparing/committing as well.
  return await resetting.finally(() => invalidateV2MemoryReads(directory, sessionID));
}
