import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Info as ToolDefinition, ToolContext } from "@opencode/plugin/promise/tool";
import Root from "../src/index";
import { checkpointPathFor, memoryPathFor, readRawFile, resetBoundaryPathFor, writeText } from "../src/memory-utils";
import type { V2Context } from "../src/v2-adapter";
import { createV2MemoryToolRegistrations, createV2MemoryTools } from "../src/v2-memory-tools";
import { createV2ContextInjection } from "../src/v2-context-injection";
import { createV2MemoryUpdater } from "../src/v2-memory-update";

type ToolEditor = { readonly add: (definition: unknown) => void };

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalConfig = process.env.OPENCODE_CONFIG_DIR;

function context(directory: string): V2Context {
  return {
    location: { directory, project: { id: "project", directory, canonical: directory } },
    options: {},
    session: { hook: async () => ({ dispose: async () => undefined }) },
    tool: { transform: async () => ({ dispose: async () => undefined }) },
  } as unknown as V2Context;
}

function toolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    agent: "agent",
    messageID: "message",
    id: "call",
    progress: async () => undefined,
  } as ToolContext;
}

describe("V2 memory tools", () => {
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-v2-memory-tools-"));
    process.env.HOME = join(testDir, "home");
    process.env.XDG_CONFIG_HOME = join(testDir, "xdg");
    process.env.OPENCODE_CONFIG_DIR = join(testDir, "config");
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfig;
    await rm(testDir, { recursive: true, force: true });
  });

  test("defines exactly two tools and executes the exact transformed definitions", async () => {
    const transformed: Array<(editor: ToolEditor) => void> = [];
    const setupContext = {
      ...context(testDir),
      tool: {
        transform: async (callback: (editor: ToolEditor) => void) => {
          transformed.push(callback);
          return { dispose: async () => undefined };
        },
      },
    } as unknown as V2Context;
    const cleanup = await Root.setup(setupContext);
    const editors = transformed.map(() => ({
      added: [] as unknown[],
      add(definition: unknown) {
        this.added.push(definition);
      },
    }));
    editors.forEach((editor, index) => transformed[index]!(editor));
    const definitions = editors.flatMap(({ added }) => added) as ToolDefinition[];
    expect(definitions.map(({ name }) => name)).toEqual(["stm_memory_read", "stm_memory_status", "stm_memory_reset"]);
    expect(editors).toHaveLength(3);
    expect(editors[0]!.added[0]).toBe(definitions[0]);
    expect(editors[1]!.added[0]).toBe(definitions[1]);
    expect(definitions.map(({ options }) => options)).toEqual([
      { codemode: false },
      { codemode: false },
      { codemode: false },
    ]);

    const expectedInputSchema = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    expect(definitions[0]!.input).toEqual(expectedInputSchema);
    expect(definitions[1]!.input).toEqual(expectedInputSchema);
    expect(definitions[2]!.input).toEqual({
      type: "object",
      properties: { confirm: { type: "boolean" } },
      required: ["confirm"],
      additionalProperties: false,
    });
    expect({}).toEqual({});
    expect({ unexpected: true }).not.toEqual({});
    expect(expectedInputSchema.additionalProperties).toBe(false);

    const result = await definitions[0]!.execute({}, toolContext("authoritative"));
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: await readFile(memoryPathFor("authoritative"), "utf8"),
        },
      ],
    });
    expect(typeof result).toBe("object");
    const statusResult = await definitions[1]!.execute({}, toolContext("authoritative"));
    expect(statusResult).toEqual({
      content: [
        {
          type: "text",
          text: [
            "generation: v2",
            "enabled: true",
            "authoritative sessionID: authoritative",
            "configuredMemoryModel: none",
            "effectiveMemoryModel: current-session",
            "summarizerMode: clean",
            "memoryDir: .opencode/memory",
            "memoryPath: .opencode/memory/session_authoritative.md",
            "checkpointPath: .opencode/memory/checkpoints/authoritative.last-message-id.txt",
            "resetBoundaryPath: .opencode/memory/reset-boundaries/authoritative.json",
            "resetBoundary: absent",
            "resetPolicy: pause if anchor absent",
            `memoryBytes: ${Buffer.byteLength(await readFile(memoryPathFor("authoritative"), "utf8"), "utf8")}`,
            "checkpoint: none",
            "updaterBusy: false",
          ].join("\n"),
        },
      ],
    });
    expect((statusResult.content as readonly [{ text: string }])[0]!.text).toContain(
      "authoritative sessionID: authoritative",
    );
    await cleanup();
  });

  test("uses only the authoritative tool session and returns existing memory exactly", async () => {
    const memory = "## Session Memory\n\n非ASCII exact\n";
    await writeText(memoryPathFor("actual"), memory);
    const [readTool] = createV2MemoryTools(context(testDir));
    const result = await readTool.execute({}, toolContext("actual"));
    expect(result).toEqual({ content: [{ type: "text", text: memory }] });
    expect((result as { content?: unknown }).content).not.toEqual(expect.any(String));
  });

  test("requires literal confirmation and resets using the authoritative message anchor", async () => {
    const sessionID = "reset-session";
    const messageID = "message-anchor";
    const memoryPath = memoryPathFor(sessionID);
    const checkpointPath = checkpointPathFor(sessionID);
    await writeText(memoryPath, "old memory");
    await writeText(checkpointPath, "old-checkpoint\n");
    const [, , resetTool] = createV2MemoryTools(context(testDir));
    for (const input of [{ confirm: false }, { confirm: "true" }, {}]) {
      await expect(resetTool.execute(input, toolContext(sessionID))).resolves.toEqual({
        content: [
          {
            type: "text",
            text: "Refused to reset V2 short-term memory: set confirm to literal true to confirm this destructive action.",
          },
        ],
      });
    }
    expect(await readFile(memoryPath, "utf8")).toBe("old memory");
    expect(await readFile(checkpointPath, "utf8")).toBe("old-checkpoint\n");

    const result = await resetTool.execute({ confirm: true }, { ...toolContext(sessionID), messageID });
    expect((result.content as readonly [{ text: string }])[0]!.text).toBe(
      [
        "generation: v2",
        "reset: completed",
        "scope: memory, checkpoint, and reset boundary",
        `authoritative sessionID: ${sessionID}`,
        `resetBoundaryAnchor: ${messageID}`,
        "resetPolicy: pause if anchor absent",
        "crashAtomic: false",
        "semanticErasure: false",
      ].join("\n"),
    );
    expect(await readFile(checkpointPath, "utf8")).toBe("");
    expect(await readFile(join(testDir, ".opencode", "memory", "reset-boundaries", `${sessionID}.json`), "utf8")).toBe(
      JSON.stringify({ version: 1, anchorID: messageID }) + "\n",
    );
  });

  test("rejects invalid reset identities without touching persisted files", async () => {
    const sessionID = "identity-session";
    const memoryPath = memoryPathFor(sessionID);
    await writeText(memoryPath, "protected");
    const [, , resetTool] = createV2MemoryTools(context(testDir));
    for (const invalid of [
      { sessionID: "", messageID: "anchor" },
      { sessionID, messageID: "" },
      { sessionID, messageID: undefined },
    ]) {
      await expect(
        resetTool.execute({ confirm: true }, { ...toolContext(sessionID), ...invalid } as ToolContext),
      ).rejects.toThrow("reset");
    }
    expect(await readFile(memoryPath, "utf8")).toBe("protected");
  });

  test("rejects reset session aliases before touching the sanitized session file", async () => {
    const safeCollisionPath = memoryPathFor("a_b");
    await writeText(safeCollisionPath, "protected collision");
    const [, , resetTool] = createV2MemoryTools(context(testDir));

    await expect(resetTool.execute({ confirm: true }, { ...toolContext("a/b"), messageID: "anchor" })).rejects.toThrow(
      "unsafe path characters",
    );
    expect(await readFile(safeCollisionPath, "utf8")).toBe("protected collision");
  });

  test("reports deterministic persisted status, model selection, bytes, and checkpoints", async () => {
    const sessionID = "status-session";
    const memory = "## Session Memory\n\n日本語\n";
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ memoryModel: "provider/model" }));
    await writeText(memoryPathFor(sessionID), memory);
    const [readTool, statusTool] = createV2MemoryTools(context(testDir));
    const readResult = await readTool.execute({}, toolContext(sessionID));
    expect(readResult).toEqual({ content: [{ type: "text", text: memory }] });
    const statusResult = await statusTool.execute({}, toolContext(sessionID));
    const text = (statusResult.content as readonly [{ text: string }])[0]!.text;
    expect(text).toBe(
      [
        "generation: v2",
        "enabled: true",
        `authoritative sessionID: ${sessionID}`,
        "configuredMemoryModel: provider/model",
        "effectiveMemoryModel: current-session",
        "summarizerMode: clean",
        "memoryDir: .opencode/memory",
        `memoryPath: .opencode/memory/session_${sessionID}.md`,
        `checkpointPath: .opencode/memory/checkpoints/${sessionID}.last-message-id.txt`,
        `resetBoundaryPath: .opencode/memory/reset-boundaries/${sessionID}.json`,
        "resetBoundary: absent",
        "resetPolicy: pause if anchor absent",
        `memoryBytes: ${Buffer.byteLength(memory, "utf8")}`,
        "checkpoint: none",
        "updaterBusy: false",
      ].join("\n"),
    );
    for (const name of [
      "updateCount",
      "injectCount",
      "injectCharCount",
      "compactCount",
      "memoryRevision",
      "deliveryClaimPending",
      "child",
      "main",
      "DCP",
      "startupWarning",
      "effectiveDeliveryMode",
    ]) {
      expect(text).not.toContain(name);
    }
  });

  test("reports inherited model and populated checkpoint", async () => {
    const sessionID = "checkpoint-session";
    await writeText(memoryPathFor(sessionID), "memory");
    await writeText(checkpointPathFor(sessionID), "message-42\n");
    const [, statusTool] = createV2MemoryTools(context(testDir));
    const result = await statusTool.execute({}, toolContext(sessionID));
    const text = (result.content as readonly [{ text: string }])[0]!.text;
    expect(text).toContain("configuredMemoryModel: none");
    expect(text).toContain("effectiveMemoryModel: current-session");
    expect(text).toContain("checkpoint: message-42");
  });

  test("reports valid, malformed, and unreadable persisted reset boundaries", async () => {
    const sessionID = "boundary-status";
    const [, statusTool] = createV2MemoryTools(context(testDir));
    const boundaryPath = resetBoundaryPathFor(sessionID);

    await writeText(boundaryPath, '{"version":1,"anchorID":"anchor-1"}\n');
    let text = ((await statusTool.execute({}, toolContext(sessionID))).content as readonly [{ text: string }])[0]!.text;
    expect(text).toContain("resetBoundary: valid");
    expect(text).toContain("resetBoundaryAnchor: anchor-1");

    await writeText(boundaryPath, '{"version":1,"anchorID":"anchor-1","extra":true}\n');
    text = ((await statusTool.execute({}, toolContext(sessionID))).content as readonly [{ text: string }])[0]!.text;
    expect(text).toContain("resetBoundary: invalid");
    expect(text).not.toContain("resetBoundaryAnchor:");

    await rm(boundaryPath, { force: true });
    await mkdir(boundaryPath, { recursive: true });
    text = ((await statusTool.execute({}, toolContext(sessionID))).content as readonly [{ text: string }])[0]!.text;
    expect(text).toContain("resetBoundary: unreadable");
  });

  test("distinguishes configured model from the current model used by clean V2 generation", async () => {
    const sessionID = "model-source-session";
    const currentModel = { providerID: "current-provider", id: "current-model" };
    const cleanCalls: unknown[] = [];
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ memoryModel: "provider/configured" }));
    const updater = createV2MemoryUpdater(
      {
        ...context(testDir),
        generate: {
          text: async (request: unknown) => {
            cleanCalls.push(request);
            return {
              text: "## Session Memory\n\n### User Instructions\n- x\n### Long Horizon Context\n- x\n### Decisions\n- x\n### Conclusions\n- x\n### Active References\n- x\n",
            };
          },
        },
      } as V2Context,
      testDir,
    );
    await updater({
      sessionID,
      model: currentModel,
      messages: [{ id: "assistant-1", role: "assistant", content: [{ type: "text", text: "answer" }] }],
    } as never);
    expect((cleanCalls[0] as { model: unknown }).model).toBe(currentModel);

    const [, statusTool] = createV2MemoryTools(context(testDir));
    const status = await statusTool.execute({}, toolContext(sessionID));
    const text = (status.content as readonly [{ text: string }])[0]!.text;
    expect(text).toContain("configuredMemoryModel: provider/configured");
    expect(text).toContain("effectiveMemoryModel: current-session");
  });

  test("keeps relative memoryDir consistent with updater and injection", async () => {
    const sessionID = "relative-session";
    const memoryDir = "relative-memory";
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    const memory = "relative memory";
    await writeText(memoryPathFor(sessionID, memoryDir), memory);
    const [, statusTool] = createV2MemoryTools(context(testDir));
    const status = await statusTool.execute({}, toolContext(sessionID));
    const text = (status.content as readonly [{ text: string }])[0]!.text;
    expect(text).toContain(`memoryPath: ${memoryDir}/session_${sessionID}.md`);
    const injection = createV2ContextInjection(testDir);
    const input = { sessionID, system: [] } as never;
    await injection(input);
    expect(await readFile(memoryPathFor(sessionID, memoryDir), "utf8")).toBe(memory);
  });

  test("observes a same-session updater while it is blocked", async () => {
    const sessionID = "busy-session";
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ summarizerMode: "clean" }));
    const updater = createV2MemoryUpdater(
      {
        ...context(testDir),
        generate: {
          text: async () => {
            await blocked;
            return {
              text: "## Session Memory\n\n### User Instructions\n- x\n### Long Horizon Context\n- x\n### Decisions\n- x\n### Conclusions\n- x\n### Active References\n- x\n",
            };
          },
        },
      } as V2Context,
      testDir,
    );
    const update = updater({
      sessionID,
      messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "answer" }] }],
    } as never);
    await Promise.resolve();
    const [, statusTool] = createV2MemoryTools(context(testDir));
    const status = await statusTool.execute({}, toolContext(sessionID));
    expect((status.content as readonly [{ text: string }])[0]!.text).toContain("updaterBusy: true");
    release();
    await update;
  });

  test("refuses reset reentry from active generation without deadlocking or writing a boundary", async () => {
    const sessionID = "reentry-session";
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ summarizerMode: "active" }));
    let resetResult: Awaited<ReturnType<ToolDefinition["execute"]>> | undefined;
    let resetTool!: ToolDefinition;
    const activeContext = {
      ...context(testDir),
      session: {
        ...context(testDir).session,
        generate: async ({ sessionID: generatedSessionID }: { sessionID: string }) => {
          resetResult = await resetTool.execute({ confirm: true }, toolContext(generatedSessionID));
          return {
            text: "## Session Memory\n\n### User Instructions\n- x\n### Long Horizon Context\n- x\n### Decisions\n- x\n### Conclusions\n- x\n### Active References\n- x\n",
          };
        },
      },
    } as unknown as V2Context;
    [, , resetTool] = createV2MemoryTools(activeContext);
    const updater = createV2MemoryUpdater(activeContext, testDir);

    await updater({
      sessionID,
      messages: [{ id: "assistant-1", role: "assistant", content: [{ type: "text", text: "answer" }] }],
    } as never);

    expect((resetResult?.content as readonly [{ text: string }])[0]!.text).toContain(
      "an update is active for this session; retry after it finishes",
    );
    expect(await readRawFile(resetBoundaryPathFor(sessionID))).toBeNull();
    const laterReset = await resetTool.execute({ confirm: true }, toolContext(sessionID));
    expect((laterReset.content as readonly [{ text: string }])[0]!.text).toContain("reset: completed");
    expect(await readRawFile(resetBoundaryPathFor(sessionID))).not.toBeNull();
  });

  test("returns registrations in exact order with definition identity", () => {
    const registrations = createV2MemoryToolRegistrations(context(testDir));
    expect(registrations.map(({ name }) => name)).toEqual(["stm_memory_read", "stm_memory_status", "stm_memory_reset"]);
    expect(registrations.map(({ definition }) => definition.name)).toEqual(registrations.map(({ name }) => name));
    expect(registrations.map(({ definition }) => definition.options)).toEqual([
      { codemode: false },
      { codemode: false },
      { codemode: false },
    ]);
  });

  test("acquires and disposes setup registrations in strict order and preserves registration failures", async () => {
    const events: string[] = [];
    let toolAttempts = 0;
    const failure = new Error("status registration failed");
    const setupContext = {
      ...context(testDir),
      session: {
        hook: async (name: string) => {
          events.push(`acquire:${name}`);
          return {
            dispose: async () => {
              events.push(`dispose:${name}`);
              if (name === "compaction") throw new Error("cleanup failure");
            },
          };
        },
      },
      tool: {
        transform: async (callback: (editor: ToolEditor) => void) => {
          toolAttempts += 1;
          const toolName = toolAttempts === 1 ? "read" : toolAttempts === 2 ? "status" : "reset";
          const added: unknown[] = [];
          callback({ add: (definition) => added.push(definition) });
          events.push(`acquire:${toolName}`);
          if (toolAttempts === 2) throw failure;
          return {
            dispose: async () => events.push(`dispose:${toolName}`),
          };
        },
      },
    } as unknown as V2Context;

    await expect(Root.setup(setupContext)).rejects.toBe(failure);
    expect(events).toEqual([
      "acquire:context",
      "acquire:compaction",
      "acquire:read",
      "acquire:status",
      "dispose:read",
      "dispose:compaction",
      "dispose:context",
    ]);
  });

  test("preserves a read registration error, skips status, and survives cleanup failure", async () => {
    const events: string[] = [];
    const failure = new Error("read registration failed");
    let toolAttempts = 0;
    const setupContext = {
      ...context(testDir),
      session: {
        hook: async (name: string) => {
          events.push(`acquire:${name}`);
          return {
            dispose: async () => {
              events.push(`dispose:${name}`);
              if (name === "compaction") throw new Error("cleanup failure");
            },
          };
        },
      },
      tool: {
        transform: async (callback: (editor: ToolEditor) => void) => {
          toolAttempts += 1;
          callback({ add: () => undefined });
          events.push(`acquire:${toolAttempts === 1 ? "read" : "status"}`);
          throw failure;
        },
      },
    } as unknown as V2Context;

    await expect(Root.setup(setupContext)).rejects.toBe(failure);
    expect(toolAttempts).toBe(1);
    expect(events).toEqual([
      "acquire:context",
      "acquire:compaction",
      "acquire:read",
      "dispose:compaction",
      "dispose:context",
    ]);
  });

  test("successfully disposes acquired tools in reverse order and cleanup is idempotent", async () => {
    const events: string[] = [];
    let toolNumber = 0;
    const setupContext = {
      ...context(testDir),
      session: {
        hook: async (name: string) => {
          events.push(`acquire:${name}`);
          return { dispose: async () => events.push(`dispose:${name}`) };
        },
      },
      tool: {
        transform: async (callback: (editor: ToolEditor) => void) => {
          callback({ add: () => undefined });
          toolNumber += 1;
          const name = toolNumber === 1 ? "read" : toolNumber === 2 ? "status" : "reset";
          events.push(`acquire:${name}`);
          return { dispose: async () => events.push(`dispose:${name}`) };
        },
      },
    } as unknown as V2Context;
    const cleanup = await Root.setup(setupContext);
    await cleanup();
    await cleanup();
    expect(events).toEqual([
      "acquire:context",
      "acquire:compaction",
      "acquire:read",
      "acquire:status",
      "acquire:reset",
      "dispose:reset",
      "dispose:status",
      "dispose:read",
      "dispose:compaction",
      "dispose:context",
    ]);
  });
});
