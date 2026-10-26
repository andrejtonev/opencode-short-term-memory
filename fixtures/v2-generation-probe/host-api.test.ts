import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";

import {
  bounded,
  isolatedServiceCommand,
  PROBE_SERVICE_BINARY,
  startIsolatedService,
  stopIsolatedService,
} from "./host-api.js";

test("isolated service command clears inherited secrets without changing the parent environment", () => {
  const parentBefore = { ...process.env };
  const supplied = { PROBE_SENTINEL: "fake sentinel = value; $(not-a-command)", PATH: "/untrusted" };
  const command = isolatedServiceCommand(supplied, [
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify(process.env))",
  ]);
  const child = spawnSync(command[0]!, command.slice(1), {
    env: { ...process.env, PROBE_PARENT_SECRET: "fake-parent-secret", ...supplied },
    encoding: "utf8",
    timeout: 5_000,
  });

  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  const childEnv = JSON.parse(child.stdout);
  expect(childEnv.PROBE_PARENT_SECRET).toBeUndefined();
  expect(childEnv.PROBE_SENTINEL).toBe(supplied.PROBE_SENTINEL);
  expect(childEnv.PATH).toBe(process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin");
  expect(process.env).toEqual(parentBefore);
  if (process.platform !== "win32")
    expect(isolatedServiceCommand({})).toEqual([
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      PROBE_SERVICE_BINARY,
      "serve",
      "--service",
    ]);
});

test("isolated service command rejects unsafe environment variable names", () => {
  for (const name of ["", "-S", "BAD=NAME", "BAD-NAME", "1BAD", "BAD\nNAME"]) {
    expect(() => isolatedServiceCommand({ [name]: "fake-value" })).toThrow("Invalid environment variable name");
  }
});

test("bounded rejects even when an operation ignores its timeout signal", async () => {
  let signal: AbortSignal | undefined;
  await expect(
    bounded((input) => {
      signal = input;
      return new Promise<void>(() => {});
    }, 10),
  ).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true);
});

test("service startup timeout retains ownership of late service completion", async () => {
  let finish!: (value: { url: string }) => void;
  const startup = new Promise<{ url: string }>((resolve) => {
    finish = resolve;
  });
  let stopped!: () => void;
  const cleaned = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const options = { cwd: process.cwd(), serviceFile: "/isolated/service.json", env: {} };
  const originalCwd = process.cwd();
  let stopFile: string | undefined;
  const lifecycle = {
    ensure: async () => startup,
    stop: async (input: { file?: string }) => {
      stopFile = input.file;
      stopped();
    },
  };
  await expect(startIsolatedService(options, 10, lifecycle)).rejects.toThrow("timed out");
  expect(process.cwd()).toBe(originalCwd);
  finish({ url: "http://127.0.0.1:1" });
  await bounded(async () => cleaned, 1000);
  expect(stopFile).toBe(options.serviceFile);
});

test("stalled service shutdown fails within the settling deadline", async () => {
  const lifecycle = {
    ensure: async () => ({ url: "http://127.0.0.1:1" }),
    stop: () => new Promise<void>(() => {}),
  };
  await expect(
    stopIsolatedService(
      { options: { cwd: process.cwd(), serviceFile: "/isolated/service.json", env: {} } },
      10,
      lifecycle,
    ),
  ).rejects.toThrow("timed out");
});

test("bounded preserves operation success and failure without running late cleanup", async () => {
  let late = 0;
  expect(
    await bounded(
      async () => 42,
      1000,
      async () => {
        late++;
      },
    ),
  ).toBe(42);
  await expect(
    bounded(async () => {
      throw new Error("startup failed");
    }, 1000),
  ).rejects.toThrow("startup failed");
  expect(late).toBe(0);
});

test("service wrapper applies child cwd without changing parent cwd", () => {
  const originalCwd = process.cwd();
  const cwd = tmpdir();
  const command = isolatedServiceCommand({}, [process.execPath, "-e", "process.stdout.write(process.cwd())"], cwd);
  const child = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 5000 });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe(cwd);
  expect(process.cwd()).toBe(originalCwd);
});

// Windows force-termination does not dispatch a JavaScript SIGTERM handler.
// Execute the generated wrapper with an owned fake child to verify forwarding on
// both platforms without sending a signal to an unknown process.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`service wrapper forwards ${signal} to its owned child and awaits exit`, () => {
    const command = isolatedServiceCommand({}, ["fake-service"], process.cwd());
    const child = new EventEmitter();
    const killed: string[] = [];
    Object.assign(child, {
      kill: (input: string) => {
        killed.push(input);
        return true;
      },
    });
    const parent = new EventEmitter();
    const exits: number[] = [];
    Object.assign(parent, {
      argv: [command.at(-1)],
      exit: (code: number) => {
        exits.push(code);
        parent.emit("exit");
      },
    });
    runInNewContext(command[2]!, { process: parent, require: () => ({ spawn: () => child }) });
    parent.emit(signal);
    expect(killed).toEqual([signal]);
    expect(exits).toEqual([]);
    child.emit("exit", null);
    expect(exits).toEqual([signal === "SIGINT" ? 130 : 143]);
    expect(killed).toEqual([signal]);
  });
}

test("service wrapper parent exit terminates only its direct owned child", () => {
  const command = isolatedServiceCommand({}, ["fake-service"], process.cwd());
  const child = new EventEmitter();
  const killed: string[] = [];
  Object.assign(child, {
    kill: (signal: string) => {
      killed.push(signal);
      return true;
    },
  });
  const parent = new EventEmitter();
  Object.assign(parent, { argv: [command.at(-1)], exit: () => {} });
  runInNewContext(command[2]!, { process: parent, require: () => ({ spawn: () => child }) });
  parent.emit("exit");
  expect(killed).toEqual(["SIGTERM"]);
});
