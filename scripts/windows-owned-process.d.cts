import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";
export type CleanupResult = {
  children: {
    pid: number | null;
    signalled: boolean;
    killSucceeded: boolean | null;
    error: string | null;
    exited: boolean;
    treeStatus: string;
    treeProcessCount: number;
    treeVerificationError: string | null;
  }[];
  ports: { endpoint: string; closed: boolean }[];
  childrenExited: boolean;
  portsClosed: boolean;
  complete: boolean;
};
export function canSignalOwnedChild(child: ChildProcess | undefined): boolean;
export function trackOwnedChild(
  child: ChildProcess,
  options?: {
    timeoutMs?: number;
    captureTree?: (
      child: ChildProcess,
      timeoutMs: number,
    ) => Promise<{
      complete: boolean;
      rootPids?: number[];
      identities: { pid: number; created: string; commandLine: string }[];
    }>;
  },
): Promise<unknown> | undefined;
export function isOwnedTreeGone(
  snapshot: { rootPids?: number[]; identities: { pid: number; created: string; commandLine: string }[] },
  rows: { pid: number; parentPid: number; created: string; commandLine: string }[],
): boolean;
export function cleanupOwnedChildren(
  children: (ChildProcess | undefined)[],
  options?: {
    timeoutMs?: number;
    endpoints?: string[];
    killTree?: (child: ChildProcess, timeoutMs: number) => Promise<{ succeeded: boolean; error: string | null }>;
    waitForExit?: (child: ChildProcess, timeoutMs: number) => Promise<boolean>;
    portIsClosed?: (endpoint: string, timeoutMs: number) => Promise<boolean>;
    captureTree?: (
      child: ChildProcess,
      timeoutMs: number,
    ) => Promise<{
      complete: boolean;
      rootPids?: number[];
      identities: { pid: number; created: string; commandLine: string }[];
    }>;
    verifyTreeGone?: (
      snapshot: { rootPids?: number[]; identities: { pid: number; created: string; commandLine: string }[] },
      timeoutMs: number,
    ) => Promise<boolean>;
  },
): Promise<CleanupResult>;
export function applyCleanupVerdict<T extends { verdict?: string; functionalVerdict?: string }>(
  record: T,
  cleanup: CleanupResult,
): T & {
  functionalVerdict: string;
  cleanup: CleanupResult;
  cleanupVerdict: string;
  verdict: string;
};
export function closeOwnedServer(
  server: Server | undefined,
  timeoutMs?: number,
): Promise<{ closed: boolean; error: string | null }>;
