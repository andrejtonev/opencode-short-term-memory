import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import SessionMemoryPlugin from "../src/v1-adapter";
import { createV2MemoryActions } from "../src/v2-memory-tools";
import type { V2Context } from "../src/v2-adapter";
import { DEFAULT_CONFIG, STANDARD_MEMORY_TEMPLATE, memoryPathFor, readRawFile } from "../src/memory-utils";
import { createFakeClient } from "./test-helpers";
import { newV1Request, V1_REQUEST_PREFIX, decodeV1Response, type V1Action } from "../src/v1-native-actions";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function implementations() {
  const directory = await mkdtemp(join(tmpdir(), "stm-feature-parity-"));
  roots.push(directory);
  const memoryDir = join(directory, ".opencode", "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(directory, ".opencode", "stm.json"), JSON.stringify({ ...DEFAULT_CONFIG, memoryDir }));
  const client = createFakeClient({ messagesRows: [] });
  let response: string | undefined;
  Object.assign(client, {
    tui: {
      publish: async (input: any) => {
        response = decodeV1Response(input.body.properties.command)?.message;
        return { data: true };
      },
    },
  });
  client.session.get = async (input: any) => ({ data: { id: input.path.id, directory } });
  const v1 = (await SessionMemoryPlugin({ directory, client: client as any })) as any;
  const legacy = (action: string, confirm?: boolean) =>
    v1.tool.short_term_memory.execute({ action, confirm }, { sessionID: "ses_v1" });
  const native = async (action: V1Action, confirm?: boolean) => {
    await v1.event({
      event: {
        type: "tui.command.execute",
        properties: {
          command:
            V1_REQUEST_PREFIX + JSON.stringify(newV1Request({ directory, sessionID: "ses_v1" }, action, confirm)),
        },
      },
    });
    return response;
  };
  let v2Calls = 0;
  const context = {
    location: { directory, project: { id: "project", directory, canonical: directory } },
    session: {
      get: async () => ({ id: "ses_v2" }),
      context: async () => [],
      generate: async () => {
        v2Calls++;
        throw new Error("Unexpected model request");
      },
    },
    generate: {
      text: async () => {
        v2Calls++;
        throw new Error("Unexpected model request");
      },
    },
  } as unknown as V2Context;
  const actions = createV2MemoryActions(context);
  return { memoryDir, client, legacy, native, actions, v2Calls: () => v2Calls };
}

test("V1 and V2 Show preserve missing and exact existing memory without inference", async () => {
  const h = await implementations();
  expect(await h.legacy("show")).toBe("No memory file exists yet.");
  expect(await h.actions.show("ses_v2")).toBe("No memory file exists yet.");
  for (const id of ["ses_v1", "ses_v2"]) {
    expect(await readRawFile(memoryPathFor(id, h.memoryDir))).toBeNull();
    await writeFile(memoryPathFor(id, h.memoryDir), "EXACT MEMORY\n\n");
  }
  expect(await h.legacy("show")).toBe("EXACT MEMORY\n\n");
  expect(await h.actions.show("ses_v2")).toBe("EXACT MEMORY\n\n");
  expect(h.client.calls.prompt).toHaveLength(0);
  expect(h.v2Calls()).toBe(0);
});

test("V1 and V2 Logs return the same absolute path without reading log contents", async () => {
  const h = await implementations();
  const v1 = await h.legacy("logs");
  expect(isAbsolute(v1)).toBe(true);
  expect(await h.actions.logs("ses_v2")).toBe(v1);
  expect(h.client.calls.prompt).toHaveLength(0);
  expect(h.v2Calls()).toBe(0);
});

test("V1 and V2 reset require literal confirmation and support verified empty history without a model", async () => {
  const h = await implementations();
  for (const id of ["ses_v1", "ses_v2"]) await writeFile(memoryPathFor(id, h.memoryDir), "PRESERVE");
  await h.native("reset", false);
  await h.actions.reset("ses_v2", { confirm: false });
  for (const id of ["ses_v1", "ses_v2"])
    expect((await readRawFile(memoryPathFor(id, h.memoryDir)))?.toString()).toBe("PRESERVE");
  await h.native("reset", true);
  await h.actions.reset("ses_v2", { confirm: true });
  for (const id of ["ses_v1", "ses_v2"])
    expect((await readRawFile(memoryPathFor(id, h.memoryDir)))?.toString()).toBe(STANDARD_MEMORY_TEMPLATE);
  expect(h.client.calls.prompt).toHaveLength(0);
  expect(h.v2Calls()).toBe(0);
});
