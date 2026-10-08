import { rm } from "node:fs/promises";
import { checkpointPathFor, memoryPathFor, readConfig, resetBoundaryPathFor, safeSessionID } from "./memory-utils";
import { childStatePath } from "./v2-child-memory";
import { deleteV2MemorySession } from "./v2-mutation-coordination";

export async function deleteV2SessionMemory(directory: string, sessionID: string): Promise<void> {
  if (typeof sessionID !== "string" || !sessionID.trim()) {
    throw new Error("delete sessionID must be a nonempty string");
  }
  if (safeSessionID(sessionID) !== sessionID) {
    throw new Error("delete sessionID contains unsafe path characters");
  }
  return deleteV2MemorySession(directory, sessionID, async () => {
    const config = await readConfig(undefined, directory);
    const results = await Promise.allSettled(
      [
        memoryPathFor(sessionID, config.memoryDir),
        checkpointPathFor(sessionID, config.memoryDir),
        resetBoundaryPathFor(sessionID, config.memoryDir),
        childStatePath(sessionID, config.memoryDir),
      ].map((path) => rm(path, { force: true })),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "V2 session memory deletion failed");
  });
}
