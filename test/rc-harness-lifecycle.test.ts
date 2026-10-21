import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNER_MARKER,
  canSignalOwnedChild,
  cleanupOwnedRoot,
  diskPreflight,
  markOwnedRoot,
  requireDiskBudget,
  signalOwnedChild,
  writeDurableEvidence,
  type OwnerRecord,
} from "../scripts/rc-harness-lifecycle";

const owner: OwnerRecord = { runID: "run-rc-1", caseID: "case-lifecycle", kind: "cache" };
const runtimeOwner: OwnerRecord = { ...owner, kind: "runtime" };

describe("RC lifecycle safety harness", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function freshRoot(prefix = "stm-rc-lifecycle-"): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  async function markedRoot(kind: "cache" | "runtime" = "cache"): Promise<{ root: string; expected: OwnerRecord }> {
    const root = await freshRoot();
    const expected = kind === "cache" ? owner : runtimeOwner;
    await markOwnedRoot(root, expected);
    return { root, expected };
  }

  test("rejects every invalid PID and never signals terminal children", () => {
    const invalid = [undefined, 0, 1, -1, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (const pid of invalid) {
      expect(canSignalOwnedChild({ pid, exitCode: null, signalCode: null })).toBe(false);
      expect(signalOwnedChild({ pid, exitCode: null, signalCode: null }, "SIGTERM", { detached: false })).toBe(false);
    }
    for (const terminal of [
      { pid: 42, exitCode: 0, signalCode: null },
      { pid: 43, exitCode: null, signalCode: "SIGTERM" as const },
    ]) {
      expect(canSignalOwnedChild(terminal)).toBe(false);
      expect(signalOwnedChild(terminal, "SIGTERM", { detached: false })).toBe(false);
    }
  });

  test("signals a detached process group with exactly the negative positive PID", () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const sent = signalOwnedChild({ pid: 7123, exitCode: null, signalCode: null }, "SIGTERM", {
      detached: true,
      group: true,
      send: (pid, signal) => calls.push([pid, signal]),
    });
    expect(sent).toBe(true);
    expect(calls).toEqual([[-7123, "SIGTERM"]]);
  });

  test("refuses a process group without detached ownership and propagates non-ESRCH errors", () => {
    expect(() =>
      signalOwnedChild({ pid: 7123, exitCode: null, signalCode: null }, "SIGTERM", { detached: false, group: true }),
    ).toThrow("detached ownership");
    const failure = Object.assign(new Error("permission denied"), { code: "EPERM" });
    expect(() =>
      signalOwnedChild({ pid: 7123, exitCode: null, signalCode: null }, "SIGTERM", {
        detached: false,
        send: () => {
          throw failure;
        },
      }),
    ).toThrow("permission denied");
    expect(
      signalOwnedChild({ pid: 7123, exitCode: null, signalCode: null }, "SIGTERM", {
        detached: false,
        send: () => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
      }),
    ).toBe(false);
  });

  test("missing executable reports one error and closes within one second", async () => {
    const started = Date.now();
    const result = await Promise.race([
      new Promise<{ errors: number; closed: boolean }>((resolve) => {
        const child = spawn(join("/definitely", "missing", "stm-executable"), [], { stdio: "ignore" });
        let errors = 0;
        child.once("error", () => {
          errors += 1;
        });
        child.once("close", () => resolve({ errors, closed: true }));
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("missing executable deadline exceeded")), 900),
      ),
    ]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({ errors: 1, closed: true });
  });

  test("refuses foreign, malformed, and unmarked roots before deleting anything", async () => {
    const cases = [
      { name: "mismatched owner", marker: JSON.stringify({ ...owner, caseID: "foreign" }) },
      { name: "extra owner key", marker: JSON.stringify({ ...owner, extra: true }) },
    ];
    for (const scenario of cases) {
      const root = await freshRoot();
      const sentinel = join(root, "xdg-cache");
      await mkdir(sentinel);
      await writeFile(join(root, OWNER_MARKER), `${scenario.marker}\n`);
      await expect(
        cleanupOwnedRoot({ root, owner, targets: ["xdg-cache"], childrenExited: true, portsClosed: true }),
      ).rejects.toThrow("marker mismatch");
      expect(await stat(sentinel)).toBeTruthy();
    }
    const unmarked = await freshRoot();
    const sentinel = join(unmarked, "xdg-cache");
    await mkdir(sentinel);
    await expect(
      cleanupOwnedRoot({ root: unmarked, owner, targets: ["xdg-cache"], childrenExited: true, portsClosed: true }),
    ).rejects.toThrow();
    expect(await stat(sentinel)).toBeTruthy();
  });

  test("rejects root, marker, and cache-target symlinks while allowing inner symlinks", async () => {
    const outside = await freshRoot("stm-rc-outside-");
    const linkedRoot = await freshRoot();
    await symlink(outside, join(linkedRoot, "root-link"), process.platform === "win32" ? "junction" : "dir");
    await expect(markOwnedRoot(join(linkedRoot, "root-link"), owner)).rejects.toThrow("real directory");

    const { root } = await markedRoot();
    const markerTarget = join(root, "marker-real");
    if (process.platform === "win32") await mkdir(markerTarget);
    else await writeFile(markerTarget, JSON.stringify(owner));
    await rm(join(root, OWNER_MARKER));
    await symlink(markerTarget, join(root, OWNER_MARKER), process.platform === "win32" ? "junction" : "file");
    await expect(
      cleanupOwnedRoot({ root, owner, targets: [], childrenExited: true, portsClosed: true }),
    ).rejects.toThrow("regular file");

    const safe = await markedRoot();
    const cache = join(safe.root, "xdg-cache");
    await mkdir(cache);
    await symlink(outside, join(cache, "external-sentinel"), process.platform === "win32" ? "junction" : "dir");
    await expect(
      cleanupOwnedRoot({
        root: safe.root,
        owner: safe.expected,
        targets: ["xdg-cache"],
        childrenExited: true,
        portsClosed: true,
      }),
    ).resolves.toMatchObject({ complete: true });
    expect(await stat(join(outside, OWNER_MARKER)).catch(() => undefined)).toBeUndefined();
    await expect(stat(outside)).resolves.toBeTruthy();

    const targetLinkRoot = await markedRoot();
    await symlink(outside, join(targetLinkRoot.root, "xdg-cache"), process.platform === "win32" ? "junction" : "dir");
    await expect(
      cleanupOwnedRoot({
        root: targetLinkRoot.root,
        owner,
        targets: ["xdg-cache"],
        childrenExited: true,
        portsClosed: true,
      }),
    ).rejects.toThrow("symlink");
  });

  test("enforces exact allowlists, traversal rejection, and the five-target bound", async () => {
    const { root } = await markedRoot();
    const invalid = ["", "unknown", "../xdg-cache", "/tmp", "case/config", "xdg-cache/child"];
    for (const target of invalid) {
      await expect(
        cleanupOwnedRoot({ root, owner, targets: [target], childrenExited: true, portsClosed: true }),
      ).rejects.toThrow();
    }
    await expect(
      cleanupOwnedRoot({
        root,
        owner,
        targets: ["xdg-cache", "bun-cache", "npm-cache", "xdg-cache", "bun-cache", "npm-cache"],
        childrenExited: true,
        portsClosed: true,
      }),
    ).rejects.toThrow("count exceeds");
    const runtime = await markedRoot("runtime");
    await expect(
      cleanupOwnedRoot({
        root: runtime.root,
        owner: runtime.expected,
        targets: ["xdg-cache"],
        childrenExited: true,
        portsClosed: true,
      }),
    ).rejects.toThrow("allowlisted");
  });

  test("cleans only owned cache targets and reports absolute deleted and missing paths", async () => {
    const { root } = await markedRoot();
    const deleted = ["xdg-cache", "bun-cache", "npm-cache"].map((name) => join(root, name));
    await Promise.all(deleted.slice(0, 2).map((path) => mkdir(path)));
    await writeFile(join(root, "config"), "keep");
    await writeFile(join(root, "evidence"), "keep");
    await writeFile(join(root, "db"), "keep");
    await writeFile(join(root, "archive.tgz"), "keep");
    const result = await cleanupOwnedRoot({
      root,
      owner,
      targets: ["xdg-cache", "bun-cache", "npm-cache"],
      childrenExited: true,
      portsClosed: true,
    });
    expect(result).toMatchObject({
      root,
      complete: true,
      timedOut: false,
      operationPending: false,
      missing: [deleted[2]],
    });
    expect(result.deleted).toEqual(deleted.slice(0, 2));
    for (const path of [
      join(root, OWNER_MARKER),
      join(root, "config"),
      join(root, "evidence"),
      join(root, "db"),
      join(root, "archive.tgz"),
    ]) {
      await expect(stat(path)).resolves.toBeTruthy();
    }
  });

  test("refuses cleanup until shutdown booleans and active PID state are safe", async () => {
    const { root } = await markedRoot();
    const cache = join(root, "xdg-cache");
    await mkdir(cache);
    for (const options of [
      { childrenExited: false, portsClosed: true },
      { childrenExited: true, portsClosed: false },
      { childrenExited: true, portsClosed: true, livePids: [7331] },
    ]) {
      const result = await cleanupOwnedRoot({ root, owner, targets: ["xdg-cache"], ...options });
      expect(result).toMatchObject({ complete: false, refused: ["shutdown-not-verified"] });
      await expect(stat(cache)).resolves.toBeTruthy();
    }
  });

  test("uses one overall deadline and reports a pending slow removal without false deletion", async () => {
    const { root } = await markedRoot();
    const cache = join(root, "xdg-cache");
    await mkdir(cache);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await cleanupOwnedRoot({
      root,
      owner,
      targets: ["xdg-cache"],
      childrenExited: true,
      portsClosed: true,
      timeoutMs: 20,
      remove: async () => pending,
    });
    expect(result).toMatchObject({ complete: false, timedOut: true, operationPending: true, deleted: [] });
    release();
    await pending;
  });

  test("returns actual bigint disk statistics and rejects an over-budget preflight", async () => {
    const root = await freshRoot();
    const budget = await diskPreflight(root);
    expect(typeof budget.freeBytes).toBe("bigint");
    expect(typeof budget.freeInodes).toBe("bigint");
    expect(typeof budget.blockSize).toBe("bigint");
    // Other processes can allocate/free bytes between real statfs calls.
    await expect(requireDiskBudget(root, 2n ** 63n, "rc-test")).rejects.toThrow("under budget");
    const accepted = await requireDiskBudget(root, 1n, "rc-test");
    expect(accepted.freeBytes).toBeGreaterThanOrEqual(1n);
    expect(accepted.blockSize).toBe(budget.blockSize);
  });

  test("writes atomic durable evidence with decimal BigInts, replacement, mode 0600, and temp cleanup on rename failure", async () => {
    const root = await freshRoot();
    const evidence = join(root, "evidence", "run.json");
    await writeDurableEvidence(evidence, { revision: 9n, nested: { bytes: 12n } });
    expect(JSON.parse(await readFile(evidence, "utf8"))).toEqual({ revision: "9", nested: { bytes: "12" } });
    // Windows uses ACLs and does not implement POSIX owner permission bits.
    if (process.platform !== "win32") expect((await stat(evidence)).mode & 0o777).toBe(0o600);
    await writeDurableEvidence(evidence, { revision: 10n });
    expect(JSON.parse(await readFile(evidence, "utf8"))).toEqual({ revision: "10" });

    const targetDirectory = join(root, "existing-directory");
    await mkdir(targetDirectory);
    await expect(writeDurableEvidence(targetDirectory, { failed: true })).rejects.toThrow();
    expect(
      (await readdir(root, { recursive: true })).filter(
        (entry) => entry.includes(".stm-evidence-") && entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });
});
