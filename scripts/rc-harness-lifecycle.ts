import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type OwnedChild = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

export type SignalCallback = (pid: number, signal: NodeJS.Signals) => void;

const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;

export function canSignalOwnedChild(child: OwnedChild | undefined): boolean {
  return !!child && validPid(child.pid) && child.exitCode === null && child.signalCode === null;
}

export function signalOwnedChild(
  child: OwnedChild | undefined,
  signal: NodeJS.Signals,
  options: { detached: boolean; group?: boolean; send?: SignalCallback } = { detached: false },
): boolean {
  if (options.group === true && options.detached !== true) throw new Error("process groups require detached ownership");
  if (!child || !canSignalOwnedChild(child)) return false;
  const pid = child.pid;
  if (!validPid(pid)) return false;
  const target = options.detached && options.group ? -pid : pid;
  const send = options.send ?? ((value, valueSignal) => process.kill(value, valueSignal));
  try {
    send(target, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export type OwnerKind = "runtime" | "cache";
export type OwnerRecord = { runID: string; caseID: string; kind: OwnerKind };
export const OWNER_MARKER = ".stm-rc-owner.json";

async function verifiedRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error(`owned root must be absolute: ${root}`);
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`owned root is not a real directory: ${root}`);
  return await realpath(root);
}

function exactOwner(value: unknown, expected: OwnerRecord): value is OwnerRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    record.runID === expected.runID &&
    record.caseID === expected.caseID &&
    record.kind === expected.kind
  );
}

export async function markOwnedRoot(root: string, owner: OwnerRecord): Promise<string> {
  if (!owner.runID || !owner.caseID || (owner.kind !== "runtime" && owner.kind !== "cache")) {
    throw new Error("invalid owned root record");
  }
  const verified = await verifiedRoot(root);
  const marker = join(verified, OWNER_MARKER);
  const body = `${JSON.stringify(owner)}\n`;
  try {
    await writeFile(marker, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`owned root marker already exists: ${marker}`);
    throw error;
  }
  return marker;
}

const allowedTargets: Record<OwnerKind, readonly string[]> = {
  cache: ["xdg-cache", "bun-cache", "npm-cache"],
  runtime: ["case/tmp", "case/config/opencode/node_modules"],
};

async function ownedTarget(root: string, target: string, kind: OwnerKind): Promise<string> {
  const verified = await verifiedRoot(root);
  if (!target || isAbsolute(target) || target.split(/[\\/]/u).includes(".."))
    throw new Error(`invalid cleanup target: ${target}`);
  const normalized = target.replaceAll("\\", "/");
  if (!allowedTargets[kind].includes(normalized)) {
    throw new Error(`cleanup target is not allowlisted for ${kind}: ${target}`);
  }
  const destination = resolve(verified, normalized);
  if (relative(verified, destination) === "") throw new Error("cleanup cannot target its root");
  let current = verified;
  for (const part of normalized.split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`cleanup target contains a symlink: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  return destination;
}

export type CleanupResult = {
  root: string;
  deleted: string[];
  missing: string[];
  refused: string[];
  timedOut: boolean;
  operationPending: boolean;
  complete: boolean;
};

type RemoveFunction = (path: string) => Promise<void>;

async function boundedRemove(path: string, timeoutMs: number, remove: RemoveFunction): Promise<"deleted" | "missing"> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      remove(path),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cleanup operation timed out")), timeoutMs);
      }),
    ]);
    return "deleted";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function cleanupOwnedRoot(options: {
  root: string;
  owner: OwnerRecord;
  targets: string[];
  childrenExited: boolean;
  portsClosed: boolean;
  livePids?: readonly number[];
  timeoutMs?: number;
  remove?: RemoveFunction;
}): Promise<CleanupResult> {
  const root = await verifiedRoot(options.root);
  const markerPath = join(root, OWNER_MARKER);
  const markerInfo = await lstat(markerPath);
  if (markerInfo.isSymbolicLink() || !markerInfo.isFile())
    throw new Error(`owned root marker is not a regular file: ${markerPath}`);
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
  if (!exactOwner(marker, options.owner)) throw new Error(`owned root marker mismatch: ${root}`);
  const result: CleanupResult = {
    root,
    deleted: [],
    missing: [],
    refused: [],
    timedOut: false,
    operationPending: false,
    complete: false,
  };
  if (options.childrenExited !== true || options.portsClosed !== true || (options.livePids ?? []).some(validPid)) {
    result.refused.push("shutdown-not-verified");
    return result;
  }
  if (options.targets.length > 5) throw new Error("cleanup target count exceeds safety bound");
  const validated = await Promise.all(options.targets.map((target) => ownedTarget(root, target, options.owner.kind)));
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer");
  const deadline = Date.now() + timeoutMs;
  const remove =
    options.remove ?? ((path: string) => rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }));
  for (let i = 0; i < validated.length; i++) {
    const destination = validated[i]!;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.timedOut = true;
      break;
    }
    try {
      const outcome = await boundedRemove(destination, remaining, remove);
      result[outcome].push(destination);
    } catch (error) {
      if (error instanceof Error && error.message === "cleanup operation timed out") {
        result.timedOut = true;
        result.operationPending = true;
        break;
      } else throw error;
    }
  }
  result.complete = !result.timedOut;
  return result;
}

export type DiskBudget = { freeBytes: bigint; freeInodes: bigint; blockSize: bigint };

export async function diskPreflight(path: string): Promise<DiskBudget> {
  const info = await statfs(path, { bigint: true });
  return { freeBytes: info.bsize * info.bavail, freeInodes: info.ffree, blockSize: info.bsize };
}

export async function requireDiskBudget(
  path: string,
  thresholdBytes: bigint | number,
  label = "disk",
): Promise<DiskBudget> {
  const threshold = typeof thresholdBytes === "number" ? BigInt(thresholdBytes) : thresholdBytes;
  if (threshold < 0n) throw new Error(`${label} threshold must not be negative`);
  const budget = await diskPreflight(path);
  if (budget.freeBytes < threshold) throw new Error(`${label} under budget: ${budget.freeBytes} < ${threshold} bytes`);
  return budget;
}

export async function writeDurableEvidence(path: string, value: unknown): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`evidence path must be absolute: ${path}`);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.stm-evidence-${randomUUID()}.tmp`);
  try {
    const json = JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? `${item}` : item), 2);
    await writeFile(temporary, `${json}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
