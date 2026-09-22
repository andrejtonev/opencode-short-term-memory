import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import RootSessionMemoryPlugin, { SessionMemoryPlugin as RootNamedSessionMemoryPlugin } from "../index";
import SrcSessionMemoryPlugin, { SessionMemoryPlugin as SrcNamedSessionMemoryPlugin } from "../src";
import { createV1Adapter, createV1RuntimeContract } from "../src/v1-adapter";
import { createFakeClient } from "./test-helpers";

const legacyHookKeys = [
  "config",
  "event",
  "tool",
  "command.execute.before",
  "session.created",
  "session.updated",
  "session.deleted",
  "message.updated",
  "chat.message",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
] as const;

describe("production V1 adapter", () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-v1-adapter-test-"));
    process.env.HOME = join(testDir, "home");
    process.env.XDG_CONFIG_HOME = join(testDir, ".xdg");
    process.env.OPENCODE_CONFIG_DIR = join(testDir, ".config-dir");
    delete process.env.LOCALAPPDATA;
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    await rm(testDir, { recursive: true, force: true });
  });

  function createInput(client = createFakeClient()): PluginInput {
    return {
      client,
      directory: testDir,
      worktree: testDir,
      serverUrl: new URL("http://127.0.0.1:4096"),
    } as unknown as PluginInput;
  }

  async function drainBackgroundInitialization(hooks: Record<string, unknown>) {
    const tools = hooks.tool as {
      stm_memory_status: { execute: (args: Record<string, never>, context: object) => Promise<unknown> };
    };
    await tools.stm_memory_status.execute({}, {});
  }

  test("root and src expose one dual default with the named callable as its V1 server", () => {
    expect(RootSessionMemoryPlugin).toBe(SrcSessionMemoryPlugin);
    expect(Object.keys(RootSessionMemoryPlugin)).toEqual(["id", "server", "setup"]);
    expect(RootSessionMemoryPlugin.id).toBe("opencode-short-term-memory");
    expect(typeof RootSessionMemoryPlugin).toBe("object");
    expect(RootSessionMemoryPlugin.server).toBe(RootNamedSessionMemoryPlugin);
    expect(RootNamedSessionMemoryPlugin).toBe(SrcNamedSessionMemoryPlugin);
    expect(typeof RootNamedSessionMemoryPlugin).toBe("function");
  });

  test("constructing the runtime contract does not call the client", () => {
    const client = createFakeClient();

    createV1RuntimeContract(createInput(client));

    expect(Object.values(client.calls).every((calls) => calls.length === 0)).toBe(true);
  });

  test("createV1Adapter preserves runtime identity and the exact legacy hook surface", async () => {
    const client = createFakeClient();
    const adapter = await createV1Adapter(createInput(client));

    await drainBackgroundInitialization(adapter.hooks as Record<string, unknown>);

    expect(adapter.runtime.identity.generation).toBe("v1");
    expect(Object.keys(adapter.hooks)).toEqual(legacyHookKeys);
    expect(client.calls.list).toHaveLength(1);
  });

  test("the default V1 server returns only the exact legacy hook surface", async () => {
    const client = createFakeClient();
    const hooks = await RootSessionMemoryPlugin.server(createInput(client));

    await drainBackgroundInitialization(hooks as Record<string, unknown>);

    expect(Object.keys(hooks)).toEqual(legacyHookKeys);
    expect(hooks).not.toHaveProperty("runtime");
    expect(client.calls.list).toHaveLength(1);
  });
});
