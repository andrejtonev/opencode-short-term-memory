import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClient, createPlugin } from "./test-helpers";

const originalCwd = process.cwd();
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stm-clean-tool-guard-"));
  process.chdir(directory);
  process.env.XDG_CONFIG_HOME = join(directory, "config");
  process.env.OPENCODE_CONFIG_DIR = join(directory, "environment");
});
afterEach(async () => {
  process.chdir(originalCwd);
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
  await rm(directory, { recursive: true, force: true });
});

test("owned clean sessions retain definitions but block every tool before execution, including after cleanup", async () => {
  let plugin: any;
  let sideID = "";
  const client = createFakeClient({
    messagesRows: [{ id: "u1", role: "user", content: "Keep project settings in stm.json." }],
    promptResponder: async (raw) => {
      const request = raw as any;
      sideID = request.path.id;
      expect(request.body).not.toHaveProperty("tools");
      for (const tool of ["read", "bash", "write", "question", "stm_memory_read", "mcp_fixture"]) {
        await expect(plugin["tool.execute.before"]({ sessionID: sideID, tool, callID: "call" })).rejects.toThrow(
          "cannot execute tools",
        );
      }
      const permission = { status: "allow" };
      await plugin["permission.ask"]({ sessionID: sideID }, permission);
      expect(permission.status).toBe("deny");
      return "## Session Memory\n\n### User Instructions\n- Keep project settings in stm.json.\n";
    },
  });
  ({ plugin } = await createPlugin({ summarizerMode: "clean", sideSessionRetries: 0 }, client));
  const result = await plugin.tool.stm_memory_update.execute({}, { sessionID: "main" });
  expect(String(result)).toContain("stm.json");
  expect((client.calls.create[0] as any).body.permission).toEqual([{ permission: "*", pattern: "*", action: "ask" }]);
  expect(client.calls.delete).toHaveLength(1);
  await expect(plugin["tool.execute.before"]({ sessionID: sideID, tool: "read", callID: "late" })).rejects.toThrow(
    "cannot execute tools",
  );
  await plugin["tool.execute.before"]({ sessionID: "main", tool: "bash", callID: "primary" });
  const primaryPermission = { status: "ask" };
  await plugin["permission.ask"]({ sessionID: "main" }, primaryPermission);
  expect(primaryPermission.status).toBe("ask");
});

test("an unregistered title-identified orphan is blocked before its first tool can run", async () => {
  const client = createFakeClient();
  client.session.get = async () => ({ data: { id: "orphan", title: "Session Memory Summarizer" } });
  const { plugin } = await createPlugin({}, client);
  await expect(plugin["tool.execute.before"]({ sessionID: "orphan", tool: "write", callID: "race" })).rejects.toThrow(
    "cannot execute tools",
  );
});
