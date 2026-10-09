import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupE2EWorkspace,
  isServeRunning,
  setupE2EWorkspace,
  startServe,
  stopServe,
  type E2EWorkspace,
} from "./e2e/harness.js";

const BUN = process.execPath;
const originalEnv = { ...process.env };
const fakeRoot = mkdtempSync(join(tmpdir(), "stm-harness-safety-"));
const fakeBin = join(fakeRoot, "bin");
const fakeOpencode = join(fakeBin, "opencode");
const simulatedHome = join(fakeRoot, "home");
const simulatedConfig = join(simulatedHome, ".config", "opencode", "stm.jsonc");
const spawnStamp = join(fakeRoot, "spawned");
const configBytes = '{\n  "enabled": true,\n  "memoryDir": "/not-real-user-data"\n}\n';

let workspace: E2EWorkspace;
const ownedPorts = new Set<number>();

async function allocatePort(): Promise<{ port: number; server: Server }> {
  const server = createServer((_socket) => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate a loopback port");
  return { port: address.port, server };
}

async function waitForServeState(port: number, expected: boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (isServeRunning(port) === expected) return;
    await Bun.sleep(25);
  }
  throw new Error(`Serve port ${port} did not become ${expected ? "ready" : "stopped"}`);
}

beforeAll(async () => {
  mkdirSync(join(simulatedHome, ".config", "opencode"), { recursive: true });
  await Bun.write(
    fakeOpencode,
    `#!${BUN}\nconst portIndex = process.argv.indexOf("--port");\nconst port = Number(process.argv[portIndex + 1]);\nconst server = Bun.serve({ hostname: "127.0.0.1", port, fetch() { return new Response("ok"); } });\nif (process.env.STM_HARNESS_FAKE_SPAWN_STAMP) Bun.write(process.env.STM_HARNESS_FAKE_SPAWN_STAMP, "spawned");\nif (process.env.STM_HARNESS_FAKE_NO_MARKER !== "1") console.log("opencode server listening on http://127.0.0.1:" + port);\nprocess.on("SIGTERM", () => { server.stop(); process.exit(0); });\n`,
  );
  chmodSync(fakeOpencode, 0o755);
  await Bun.write(simulatedConfig, configBytes);

  process.env.PATH = `${fakeBin}:${originalEnv.PATH ?? ""}`;
  process.env.HOME = simulatedHome;
  process.env.XDG_CONFIG_HOME = join(simulatedHome, ".config");
  process.env.STM_HARNESS_FAKE_SPAWN_STAMP = spawnStamp;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  workspace = setupE2EWorkspace();
});

afterAll(async () => {
  for (const port of ownedPorts) {
    await stopServe(port);
  }
  if (workspace) cleanupE2EWorkspace(workspace);
  rmSync(fakeRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
});

describe("e2e harness safety", () => {
  test("rejects an occupied port before spawning and preserves the unrelated listener", async () => {
    const { port, server } = await allocatePort();
    try {
      await expect(startServe(workspace, port, { serveTimeoutMs: 250 })).rejects.toThrow(
        "refusing to kill or adopt its listener",
      );
      expect(existsSync(spawnStamp)).toBe(false);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("stopServe does not affect an unowned listener", async () => {
    const { port, server } = await allocatePort();
    try {
      await stopServe(port);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("stops and restarts the exact owned fake child", async () => {
    const { port, server } = await allocatePort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startServe(workspace, port, { serveTimeoutMs: 1_500 });
    ownedPorts.add(port);
    await waitForServeState(port, true);
    await stopServe(port);
    expect(isServeRunning(port)).toBe(false);
    await startServe(workspace, port, { serveTimeoutMs: 1_500 });
    ownedPorts.add(port);
    await waitForServeState(port, true);
    await stopServe(port);
    expect(isServeRunning(port)).toBe(false);
  });

  test("rejects a healthy child that never emits the readiness marker and terminates it", async () => {
    const { port, server } = await allocatePort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.STM_HARNESS_FAKE_NO_MARKER = "1";
    try {
      await expect(startServe(workspace, port, { serveTimeoutMs: 150 })).rejects.toThrow("did not start within 0.15s");
      await waitForServeState(port, false);
      expect(readFileSync(simulatedConfig, "utf8")).toBe(configBytes);
    } finally {
      delete process.env.STM_HARNESS_FAKE_NO_MARKER;
    }
  });

  test("preserves simulated real HOME config bytes through setup and cleanup", () => {
    expect(existsSync(join(homedir(), ".config", "opencode", "stm.jsonc"))).toBe(true);
    expect(readFileSync(simulatedConfig, "utf8")).toBe(configBytes);
    cleanupE2EWorkspace(workspace);
    expect(readFileSync(simulatedConfig, "utf8")).toBe(configBytes);
  });
});
