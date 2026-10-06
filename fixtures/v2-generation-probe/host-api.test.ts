import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { isolatedServiceCommand, PROBE_SERVICE_BINARY } from "./host-api.js";

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
  expect(childEnv.PATH).toBe("/usr/bin:/bin");
  expect(process.env).toEqual(parentBefore);
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
