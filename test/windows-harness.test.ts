import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { cleanupOwnedChildren, applyCleanupVerdict, closeOwnedServer } from "../scripts/windows-owned-process.cjs";
import type { Server } from "node:http";
import { selectConfigSweepCases, configSweepPassed } from "../scripts/config-sweep-selection";

const child = (pid: number, exitCode: number | null = null, signalCode: string | null = null) =>
  ({ pid, exitCode, signalCode }) as ChildProcess;

test("config sweep rejects unknown or duplicate selectors and accounts for every selected case", () => {
  expect(() => selectConfigSweepCases(["v1:not-a-scenario"])).toThrow("Unknown config sweep selector");
  expect(() => selectConfigSweepCases(["v1:defaults", "v1:defaults"])).toThrow("Duplicate");
  expect(selectConfigSweepCases([])).toHaveLength(32);
  const selected = selectConfigSweepCases(["v1:defaults", "v2:defaults"]);
  const one = { generation: "v1", id: "defaults", verdict: "PASS" };
  const two = { generation: "v2", id: "defaults", verdict: "PASS" };
  expect(configSweepPassed(selected, [])).toBe(false);
  expect(configSweepPassed(selected, [one])).toBe(false);
  expect(configSweepPassed(selected, [one, one])).toBe(false);
  expect(configSweepPassed(selected, [one, { ...two, verdict: "FAIL" }])).toBe(false);
  expect(configSweepPassed(selected, [one, two])).toBe(true);
});

test("invalid config selector exits before archive reads or native-host setup", async () => {
  const subprocess = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../scripts/windows-config-sweep.ts"),
      "missing.tgz",
      "missing-hosts",
      "missing-seed",
      "v1:not-a-scenario",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [status, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  expect(status).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("Unknown config sweep selector: v1:not-a-scenario");
});

test("Windows cleanup never signals terminal children or invalid process IDs", async () => {
  const killed: number[] = [];
  const cleanup = await cleanupOwnedChildren([child(12001, 0), child(12002, null, "SIGTERM")], {
    killTree: async (value) => {
      killed.push(value.pid!);
      return { succeeded: true, error: null };
    },
    captureTree: async (value) => ({ complete: true, rootPids: [value.pid!], identities: [] }),
    verifyTreeGone: async () => true,
  });
  expect(killed).toEqual([]);
  expect(cleanup.complete).toBe(false);
  const invalid = await cleanupOwnedChildren([child(0), child(-1), child(Number.NaN)], {
    killTree: async (value) => {
      killed.push(value.pid!);
      return { succeeded: true, error: null };
    },
  });
  expect(killed).toEqual([]);
  expect(invalid.complete).toBe(false);
});

test("cleanup failure and open listeners fail overall verdict while preserving functional success", async () => {
  for (const failure of ["kill", "exit", "port"] as const) {
    const host = child(12001);
    const cleanup = await cleanupOwnedChildren([host], {
      timeoutMs: 30,
      endpoints: ["http://127.0.0.1:1000"],
      killTree: async () => ({ succeeded: failure !== "kill", error: failure === "kill" ? "denied" : null }),
      waitForExit: async () => failure !== "exit",
      portIsClosed: async () => failure !== "port",
    });
    const record = applyCleanupVerdict({ verdict: "PASS" }, cleanup);
    expect(record.functionalVerdict).toBe("PASS");
    expect(record.cleanupVerdict).toBe("FAIL");
    expect(record.verdict).toBe("FAIL");
  }
});

test("owned cleanup observes immediate child exit and bounds an unresponsive child", async () => {
  for (const exits of [true, false]) {
    const events = Object.assign(new EventEmitter(), { pid: 12001, exitCode: null as number | null, signalCode: null });
    const cleanup = await cleanupOwnedChildren([events as unknown as ChildProcess], {
      timeoutMs: 30,
      captureTree: async (value) => ({
        complete: true,
        rootPids: [value.pid!],
        identities: [{ pid: value.pid!, created: "100", commandLine: "node" }],
      }),
      killTree: async () => {
        if (exits) {
          events.exitCode = 0;
          events.emit("exit", 0);
        }
        return { succeeded: true, error: null };
      },
    });
    expect(cleanup.complete).toBe(exits);
    expect(events.listenerCount("exit")).toBe(0);
  }
});

test("owned cleanup waits for listener closure after child exit within its deadline", async () => {
  const server = createServer();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let connections = 0;
  server.once("connection", () => {
    connections++;
    closeTimer = setTimeout(() => {
      server.close();
    }, 20);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const cleanup = await cleanupOwnedChildren([child(12001, 0)], {
      timeoutMs: 1000,
      endpoints: [`http://127.0.0.1:${(server.address() as AddressInfo).port}`],
      captureTree: async (value) => ({ complete: true, rootPids: [value.pid!], identities: [] }),
      verifyTreeGone: async () => true,
    });
    expect(connections).toBe(1);
    expect(cleanup.portsClosed).toBe(true);
    expect(cleanup.complete).toBe(false); // Closed listeners do not prove an untracked tree is gone.
  } finally {
    clearTimeout(closeTimer);
    await closeOwnedServer(server as unknown as Server);
  }
});

test("owned mock closure forces only its server connections and bounds a missing close callback", async () => {
  for (const finishes of [true, false]) {
    let closeCallback!: () => void;
    let forced = 0;
    const mock = {
      close(callback: () => void) {
        closeCallback = callback;
      },
      closeAllConnections() {
        forced++;
        if (finishes) closeCallback();
      },
    } as unknown as Server;
    const result = await closeOwnedServer(mock, 30);
    expect(forced).toBe(1);
    expect(result.closed).toBe(finishes);
    expect(result.error).toBe(finishes ? null : "Owned mock server closure timed out");
  }
});

test("native V2 finalization records cleanup failure and exits nonzero without targeting an exited PID", async () => {
  const source = (await readFile(join(import.meta.dir, "../scripts/v2-native-reader-acceptance.cjs"), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const start = source.lastIndexOf("  } finally {") + "  } finally {".length;
  const end = source.lastIndexOf("\n  }\n})();");
  expect(end).toBeGreaterThan(start);
  const attempted: number[] = [],
    exits: number[] = [],
    saved: any[] = [];
  const context = {
    terminal: child(12001, 0),
    host: child(12002),
    hostURL: "http://127.0.0.1:1000",
    cleanupOwnedChildren: (children: ChildProcess[], options: any) =>
      cleanupOwnedChildren(children, {
        ...options,
        timeoutMs: 30,
        captureTree: async (value) => ({
          complete: true,
          rootPids: [value.pid!],
          identities: [{ pid: value.pid!, created: "100", commandLine: "node" }],
        }),
        killTree: async (value) => {
          attempted.push(value.pid!);
          return { succeeded: false, error: "denied" };
        },
        waitForExit: async () => false,
        portIsClosed: async () => false,
        verifyTreeGone: async () => false,
      }),
    applyCleanupVerdict,
    closeOwnedServer,
    mock: {
      close(callback: () => void) {
        callback();
      },
    },
    fs: {
      writeFileSync(_path: string, text: string) {
        saved.push(JSON.parse(text));
      },
    },
    path: { join: (...parts: string[]) => parts.join("/") },
    root: "isolated-review-fixture",
    evidence: { verdict: "PASS" },
    console: { log() {} },
    process: {
      exit(code: number) {
        exits.push(code);
      },
    },
  };
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, context);
  expect(attempted).toEqual([12002]);
  expect(saved[0].functionalVerdict).toBe("PASS");
  expect(saved[0].cleanupVerdict).toBe("FAIL");
  expect(saved[0].verdict).toBe("FAIL");
  expect(exits).toEqual([1]);
});
