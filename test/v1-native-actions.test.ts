import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createV1ActionReceiver,
  newV1Request,
  V1_REQUEST_PREFIX,
  decodeV1Response,
  type V1Action,
} from "../src/v1-native-actions";
import SessionMemoryPlugin from "../src/v1-adapter";
import { DEFAULT_CONFIG, readText, memoryPathFor } from "../src/memory-utils";
import { createFakeClient } from "./test-helpers";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "stm-native-actions-"));
  roots.push(directory);
  const memoryDir = join(directory, ".opencode", "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    join(directory, ".opencode", "stm.json"),
    JSON.stringify({ ...DEFAULT_CONFIG, memoryDir, debug: false }),
  );
  const responses: any[] = [];
  const client = Object.assign(
    createFakeClient({ messagesRows: [{ id: "m1", role: "user", content: "Remember native updates" }] }),
    {
      tui: {
        async publish(input: any) {
          responses.push(decodeV1Response(input.body.properties.command));
          return { data: true };
        },
      },
    },
  );
  client.session.get = async (input: any) => ({ data: { id: input.path.id, directory } });
  const plugin = (await SessionMemoryPlugin({ directory, client: client as any })) as any;
  const action = async (value: V1Action, confirm?: boolean, sessionID: string | undefined = "ses_test") => {
    await plugin.event({
      event: {
        type: "tui.command.execute",
        properties: {
          command: V1_REQUEST_PREFIX + JSON.stringify(newV1Request({ directory, sessionID }, value, confirm)),
        },
      },
    });
    return responses.at(-1)?.message as string;
  };
  return { directory, memoryDir, plugin, client, action, responses };
}

test("native server reads and reset return exact results without any model prompt", async () => {
  const h = await fixture();
  expect(await h.action("show")).toContain("No memory file exists yet");
  expect(await readText(memoryPathFor("ses_test", h.memoryDir), "MISSING")).toBe("MISSING");
  await writeFile(memoryPathFor("ses_test", h.memoryDir), "EXACT_MEMORY");
  expect(await h.action("show")).toBe("EXACT_MEMORY");
  expect(await h.action("status")).toContain("- updateCount: 0");
  expect(await h.action("settings")).toContain(h.memoryDir.replaceAll("\\", "\\\\"));
  expect(await h.action("reset")).toContain("Explicit confirmation");
  expect(await readText(memoryPathFor("ses_test", h.memoryDir), "")).toBe("EXACT_MEMORY");
  expect(await h.action("reset", true)).toContain("Reset memory for session ses_test");
  expect(await readText(memoryPathFor("ses_test", h.memoryDir), "")).toContain("None captured yet");
  expect(h.client.calls.prompt).toHaveLength(0);
});

test("only update invokes the clean memory generator; its result needs no model echo", async () => {
  const h = await fixture();
  expect(await h.action("update")).toContain("updated from prompt");
  expect(h.client.calls.create).toHaveLength(1);
  expect(h.client.calls.prompt).toHaveLength(1);
  expect((h.client.calls.prompt[0] as any).path.id).not.toBe("ses_test");
  expect(h.responses).toHaveLength(1);
});

test("native setup is optional, session-independent, confirmed and preserves existing config", async () => {
  const h = await fixture();
  expect(await h.action("setup", false, undefined)).toContain("Explicit confirmation");
  expect(await h.action("setup", true, undefined)).toContain("stm.json already exists");
  expect(h.client.calls.prompt).toHaveLength(0);
  const hostConfig: any = {};
  await h.plugin.config(hostConfig);
  expect(hostConfig.command?.stm).toBeUndefined();
});

test("native logs return only the file path even for large or missing logs", async () => {
  const h = await fixture();
  await h.action("status"); // Complete initialization before replacing the log.
  await writeFile(
    join(h.memoryDir, "session-memory.log"),
    Array.from({ length: 119 }, () => "x".repeat(400)).join("\n") + "\nNEWEST_ENTRY",
  );
  const logs = await h.action("logs");
  expect(logs).toBe(join(h.memoryDir, "session-memory.log"));
  await rm(logs);
  expect(await h.action("logs")).toBe(logs);
  expect(h.client.calls.prompt).toHaveLength(0);
});

test("native receiver refuses malformed, stale, foreign and internal sessions and deduplicates requests", async () => {
  const directory = process.cwd();
  const executed: any[] = [],
    replies: any[] = [];
  const client: any = {
    session: { get: async (input: any) => ({ data: { id: input.path.id, directory } }) },
    tui: {
      publish: async (input: any) => {
        replies.push(input);
      },
    },
  };
  const receive = createV1ActionReceiver({
    directory,
    client,
    isInternal: (id) => id === "side_internal",
    execute: async (request) => {
      executed.push(request);
      return "RESULT";
    },
  });
  const base = newV1Request({ directory, sessionID: "ses_test" }, "status");
  const send = (overrides = {}) => receive(V1_REQUEST_PREFIX + JSON.stringify({ ...base, ...overrides }));
  await send({ directory: "/foreign" });
  await send({ sessionID: "../../escape" });
  await send({ createdAt: Date.now() - 20_000 });
  await send({ action: "unknown" });
  expect(executed).toHaveLength(0);
  expect(replies).toHaveLength(0);
  await send({ sessionID: "side_internal" });
  expect(executed).toHaveLength(0);
  const fresh = newV1Request({ directory, sessionID: "ses_test" }, "status");
  const command = V1_REQUEST_PREFIX + JSON.stringify(fresh);
  await Promise.all([receive(command), receive(command)]);
  expect(executed).toHaveLength(1);
  expect(await receive("unrelated.command")).toBe(false);
});
