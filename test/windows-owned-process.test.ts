import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { cleanupOwnedChildren, isOwnedTreeGone } from "../scripts/windows-owned-process.cjs";

const activeChild = (pid = 12001) => ({ pid, exitCode: null, signalCode: null }) as ChildProcess;

test("parent exit and closed ports do not prove the process tree is gone after taskkill fails", async () => {
  const cleanup = await cleanupOwnedChildren([activeChild()], {
    killTree: async () => ({ succeeded: false, error: "operation attempted is not supported" }),
    waitForExit: async () => true,
    portIsClosed: async () => true,
    captureTree: async () => {
      throw new Error("CIM query unsupported");
    },
  });

  expect(cleanup.childrenExited).toBe(true);
  expect(cleanup.portsClosed).toBe(true);
  expect(cleanup.children[0]).toMatchObject({
    killSucceeded: false,
    treeStatus: "unconfirmed",
    error: "operation attempted is not supported",
    treeVerificationError: "Error: CIM query unsupported",
  });
  expect(cleanup.complete).toBe(false);
});

test("a failed taskkill is classified as contained only after captured tree identities disappear", async () => {
  const snapshot = {
    complete: true,
    identities: [
      { pid: 12001, created: "100", commandLine: 'node "owned-host.js"' },
      { pid: 12002, created: "101", commandLine: 'node "owned-child.js"' },
    ],
  };
  const cleanup = await cleanupOwnedChildren([activeChild()], {
    killTree: async () => ({ succeeded: false, error: "process exited before taskkill completed" }),
    waitForExit: async () => true,
    captureTree: async () => snapshot,
    verifyTreeGone: async (captured) => captured === snapshot,
  });

  expect(cleanup.children[0]).toMatchObject({
    killSucceeded: false,
    treeStatus: "verified-gone",
    treeProcessCount: 2,
    error: "process exited before taskkill completed",
    treeVerificationError: null,
  });
  expect(cleanup.complete).toBe(true);
});

test("captured descendants that remain alive keep cleanup failed", async () => {
  const cleanup = await cleanupOwnedChildren([activeChild()], {
    killTree: async () => ({ succeeded: false, error: "unsupported process type" }),
    waitForExit: async () => true,
    captureTree: async () => ({ complete: true, identities: [{ pid: 12001, created: "100", commandLine: "node" }] }),
    verifyTreeGone: async () => false,
  });

  expect(cleanup.children[0]?.treeStatus).toBe("unconfirmed");
  expect(cleanup.complete).toBe(false);
});

test("tree verification catches a late descendant using the production predicate", async () => {
  const snapshot = {
    complete: true,
    rootPids: [12001],
    identities: [{ pid: 12001, created: "100", commandLine: "node host.js" }],
  };
  const current = [
    { pid: 12002, parentPid: 12001, created: "200", commandLine: "node late-child.js" },
    { pid: 12003, parentPid: 12002, created: "201", commandLine: "node late-grandchild.js" },
  ];
  const cleanup = await cleanupOwnedChildren([activeChild()], {
    killTree: async () => ({ succeeded: false, error: "parent exited before taskkill" }),
    waitForExit: async () => true,
    captureTree: async () => snapshot,
    verifyTreeGone: async (captured) => isOwnedTreeGone(captured, current),
  });

  expect(cleanup.children[0]?.treeStatus).toBe("unconfirmed");
  expect(cleanup.complete).toBe(false);
});

test("tree predicate accepts a gone captured tree", () => {
  const snapshot = {
    rootPids: [12001],
    identities: [
      { pid: 12001, created: "100", commandLine: "node host.js" },
      { pid: 12002, created: "101", commandLine: "node child.js" },
    ],
  };

  expect(isOwnedTreeGone(snapshot, [])).toBe(true);
});

test("tree predicate rejects a late child and conservatively rejects root PID reuse", () => {
  const snapshot = {
    rootPids: [12001],
    identities: [{ pid: 12001, created: "100", commandLine: "node host.js" }],
  };

  expect(
    isOwnedTreeGone(snapshot, [{ pid: 12003, parentPid: 12001, created: "200", commandLine: "node late.js" }]),
  ).toBe(false);
  expect(isOwnedTreeGone(snapshot, [{ pid: 12001, parentPid: 44, created: "999", commandLine: "other.exe" }])).toBe(
    false,
  );
});

test("tree predicate rejects captured descendant PID reuse despite creation or command line drift", () => {
  const snapshot = {
    rootPids: [12001],
    identities: [
      { pid: 12001, created: "100", commandLine: "node host.js" },
      { pid: 12002, created: "101", commandLine: "node child.js" },
    ],
  };

  expect(isOwnedTreeGone(snapshot, [{ pid: 12002, parentPid: 88, created: "999", commandLine: "node child.js" }])).toBe(
    false,
  );
  expect(isOwnedTreeGone(snapshot, [{ pid: 12002, parentPid: 88, created: "101", commandLine: "other.exe" }])).toBe(
    false,
  );
});

test("cleanup rechecks liveness after capture and never signals a child that exited during capture", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 12001, exitCode: null as number | null, signalCode: null });
  const signalled: number[] = [];
  const cleanup = await cleanupOwnedChildren([child as unknown as ChildProcess], {
    captureTree: async () => {
      child.exitCode = 0;
      child.emit("exit", 0);
      return {
        complete: true,
        rootPids: [12001],
        identities: [
          { pid: 12001, created: "100", commandLine: "node host.js" },
          { pid: 12002, created: "101", commandLine: "node child.js" },
        ],
      };
    },
    killTree: async (value) => {
      signalled.push(value.pid!);
      return { succeeded: true, error: null };
    },
    verifyTreeGone: async () => false,
  });

  expect(signalled).toEqual([]);
  expect(cleanup.children[0]).toMatchObject({ signalled: false, exited: true, treeStatus: "unconfirmed" });
  expect(cleanup.complete).toBe(false);
});

test("successful taskkill remains explicit tree-operation evidence when identity queries are unavailable", async () => {
  const cleanup = await cleanupOwnedChildren([activeChild()], {
    killTree: async () => ({ succeeded: true, error: null }),
    waitForExit: async () => true,
    captureTree: async () => {
      throw new Error("CIM unavailable");
    },
  });

  expect(cleanup.children[0]?.treeStatus).toBe("taskkill-succeeded");
  expect(cleanup.children[0]?.treeVerificationError).toBe("Error: CIM unavailable");
  expect(cleanup.complete).toBe(true);
});
