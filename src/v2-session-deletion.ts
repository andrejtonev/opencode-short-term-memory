import { rm } from "node:fs/promises";
import { checkpointPathFor, memoryPathFor, readConfig, resetBoundaryPathFor, safeSessionID } from "./memory-utils";
import { forgetV2ChildSession, removeV2ChildStateFile, v2ChildSessionIDsForParent } from "./v2-child-memory";
import { deleteV2MemorySession } from "./v2-mutation-coordination";

export async function deleteV2SessionMemory(directory: string, sessionID: string): Promise<void> {
  if (typeof sessionID !== "string" || !sessionID.trim()) {
    throw new Error("delete sessionID must be a nonempty string");
  }
  if (safeSessionID(sessionID) !== sessionID) {
    throw new Error("delete sessionID contains unsafe path characters");
  }
  return deleteV2SessionFamily(directory, sessionID, new Set());
}

async function deleteV2SessionFamily(directory: string, sessionID: string, visited: Set<string>): Promise<void> {
  if (visited.has(sessionID)) return;
  visited.add(sessionID);
  return deleteV2MemorySession(directory, sessionID, async () => {
    const config = await readConfig(undefined, directory);
    const children = await v2ChildSessionIDsForParent(directory, sessionID, config.memoryDir);
    const childResults = await Promise.allSettled(
      children.map((childID) => deleteV2SessionFamily(directory, childID, visited)),
    );
    const results = await Promise.allSettled(
      [
        memoryPathFor(sessionID, config.memoryDir),
        checkpointPathFor(sessionID, config.memoryDir),
        resetBoundaryPathFor(sessionID, config.memoryDir),
      ].map((path) => rm(path, { force: true })),
    );
    const childStateResult = await Promise.allSettled([removeV2ChildStateFile(sessionID, config.memoryDir)]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    errors.push(
      ...childStateResult
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason),
    );
    errors.push(
      ...childResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason),
    );
    if (errors.length) throw new AggregateError(errors, "V2 session family memory deletion failed");
    forgetV2ChildSession(directory, sessionID);
  });
}
