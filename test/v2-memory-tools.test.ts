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
  } as unknown as ToolContext;
}

function resultText(result: Awaited<ReturnType<ToolDefinition["execute"]>> | undefined): string {
  if (!result || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text")
    throw new Error("expected one text result");
  return result.content[0].text;
}

const generatedMemory =
  "## Session Memory\n\n### User Instructions\n- learned\n### Long Horizon Context\n- x\n### Decisions\n- x\n### Conclusions\n- x\n### Active References\n- x\n";
const currentModel = { providerID: "host-provider", id: "host-model", variant: "host-variant" };
const settledAssistant = (id: string, text = "settled answer", completed: number | null = 2) => ({
  id,
  type: "assistant",
  agent: "agent",
  model: { providerID: "historical-provider", id: "historical-model" },
  content: [
    { type: "text", text },
    { type: "reasoning", text: "hidden reasoning" },
  ],
  time: { created: 1, ...(completed === null ? {} : { completed }) },
});

function updateHost(directory: string, sessionID: string, records: unknown) {
  const reads: { method: string; input: unknown; signal?: AbortSignal | null }[] = [];
  const generations: { prompt: string; model: unknown }[] = [];
  const pluginContext = {
    ...context(directory),
    session: {
      ...context(directory).session,
      context: async (input: unknown, options?: { signal?: AbortSignal | null }) => {
        reads.push({ method: "context", input, signal: options?.signal });
        return records;
      },
      get: async (input: unknown, options?: { signal?: AbortSignal | null }) => {
        reads.push({ method: "get", input, signal: options?.signal });
        return { id: sessionID, model: currentModel };
      },
    },
    generate: {
      text: async (request: { prompt: string; model: unknown }) => {
        generations.push(request);
        return { text: generatedMemory };
      },
    },
  } as unknown as V2Context;
  const [, , , tool] = createV2MemoryTools(pluginContext);
  return { pluginContext, reads, generations, tool };
}

async function updateText(tool: ToolDefinition, sessionID: string, input: unknown = {}) {
  const result = await tool.execute(input, toolContext(sessionID));
  return resultText(result);
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

  test("defines exactly four tools and executes the exact transformed definitions", async () => {
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
    expect(definitions.map(({ name }) => name)).toEqual([
      "stm_memory_read",
      "stm_memory_status",
      "stm_memory_reset",
      "stm_memory_update",
    ]);
    expect(editors).toHaveLength(4);
    editors.forEach((editor, index) => expect(editor.added[0]).toBe(definitions[index]));
    expect(definitions.map(({ options }) => options)).toEqual([
      { codemode: false },
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
    expect(definitions[3]!.input).toEqual(expectedInputSchema);
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
    expect(resultText(statusResult)).toContain("authoritative sessionID: authoritative");
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

  test("updates the fresh settled prefix with exact host identity and model, ignoring malicious input", async () => {
    const sessionID = "manual-session";
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ memoryModel: "override/model" }));
    const h = updateHost(testDir, sessionID, [
      { id: "msg_user", type: "user", text: "fresh user text", time: { created: 1 } },
      settledAssistant("msg_settled"),
      settledAssistant("msg_pending", "unfinished text", null),
      settledAssistant("msg_future", "future text"),
    ]);
    const result = await h.tool.execute(
      { sessionID: "attacker", model: { id: "attacker", providerID: "attacker" }, force: true },
      { ...toolContext(sessionID), messageID: undefined } as unknown as ToolContext,
    );
    const text = resultText(result);
    expect(text).toBe(
      [
        "generation: v2",
        `sessionID: ${sessionID}`,
        "update: committed",
        "reason: delta_exhausted",
        "source: durable-visible-text",
        "stoppedBeforeMessageID: msg_pending",
        'progress: cumulative-invocation {"checkpointedChunks":1,"checkpointedMessages":2,"persistedPartialFragments":0}',
        "rollback: not-applicable",
        "detail: none",
      ].join("\n"),
    );
    expect(h.reads.map(({ method, input }) => ({ method, input }))).toEqual([
      { method: "context", input: { sessionID } },
      { method: "get", input: { sessionID } },
    ]);
    expect(h.reads[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(h.reads[1]!.signal).toBe(h.reads[0]!.signal);
    expect(h.generations).toHaveLength(1);
    expect(h.generations[0]!.model).toBe(currentModel);
    expect(h.generations[0]!.prompt).toContain("fresh user text");
    expect(h.generations[0]!.prompt).toContain("settled answer");
    for (const hidden of ["unfinished text", "future text", "hidden reasoning", "attacker"])
      expect(h.generations[0]!.prompt).not.toContain(hidden);
    expect(await readFile(checkpointPathFor(sessionID), "utf8")).toBe("msg_settled\n");
    expect(await readFile(memoryPathFor(sessionID), "utf8")).toContain("learned");
    expect(await readRawFile(memoryPathFor("attacker"))).toBeNull();

    const retry = await updateText(h.tool, sessionID);
    expect(h.reads).toHaveLength(4);
    expect(h.generations).toHaveLength(1);
    expect(retry).toContain("update: skipped\nreason: no_assistant_in_delta");
    expect(retry).not.toContain("committed");
  });

  test("rejects invalid update identities before host reads or writes without requiring messageID", async () => {
    const h = updateHost(testDir, "a_b", [settledAssistant("msg_a")]);
    await writeText(memoryPathFor("a_b"), "protected");
    for (const sessionID of ["", "   ", "a/b", undefined, 12]) {
      const result = await h.tool.execute({}, { ...toolContext("a_b"), sessionID } as unknown as ToolContext);
      expect(resultText(result)).toContain("reason: invalid_session_id");
    }
    expect(h.reads).toHaveLength(0);
    expect(h.generations).toHaveLength(0);
    expect(await readFile(memoryPathFor("a_b"), "utf8")).toBe("protected");
    expect(await readRawFile(checkpointPathFor("a_b"))).toBeNull();
  });

  test("unavailable, malformed and throwing host reads never generate or write persistence", async () => {
    const sessionID = "unavailable-session";
    for (const mode of ["no-model", "invalid-history", "context-error", "get-error"] as const) {
      const h = updateHost(testDir, sessionID, mode === "invalid-history" ? [null] : [settledAssistant("msg_a")]);
      if (mode === "no-model") h.pluginContext.session.get = async () => ({ id: sessionID }) as never;
      if (mode === "context-error" || mode === "get-error") {
        h.pluginContext.session[mode === "context-error" ? "context" : "get"] = async () => {
          throw new Error("host unavailable\nupdate: committed");
        };
      }
      const text = await updateText(h.tool, sessionID);
      expect(text).toContain(`update: ${mode.endsWith("error") ? "error" : "unavailable"}`);
      expect(text).toContain(`reason: ${mode.endsWith("error") ? "error" : mode}`);
      expect(text).toContain("progress: not-started");
      expect(text.split("\n")).not.toContain("update: committed");
      expect(h.generations).toHaveLength(0);
      expect(await readRawFile(memoryPathFor(sessionID))).toBeNull();
      expect(await readRawFile(checkpointPathFor(sessionID))).toBeNull();
    }
  });

  test("missing or pending reset anchors and user-only history preserve the assistant gate", async () => {
    const sessionID = "boundary-manual";
    const memoryPath = memoryPathFor(sessionID);
    const checkpointPath = checkpointPathFor(sessionID);
    await writeText(memoryPath, "protected");
    await writeText(checkpointPath, "old-checkpoint\n");
    await writeText(resetBoundaryPathFor(sessionID), '{"version":1,"anchorID":"msg_anchor"}\n');
    for (const records of [
      [settledAssistant("msg_other")],
      [settledAssistant("msg_anchor", "pending anchor", null), settledAssistant("msg_future")],
    ]) {
      const h = updateHost(testDir, sessionID, records);
      const text = await updateText(h.tool, sessionID);
      expect(text).toContain("update: skipped\nreason: reset_boundary_anchor_missing");
      expect(h.generations).toHaveLength(0);
      expect(await readFile(memoryPath, "utf8")).toBe("protected");
      expect(await readFile(checkpointPath, "utf8")).toBe("old-checkpoint\n");
    }
    await rm(resetBoundaryPathFor(sessionID));
    const h = updateHost(testDir, sessionID, [
      { id: "msg_user", type: "user", text: "user only", time: { created: 1 } },
    ]);
    expect(await updateText(h.tool, sessionID)).toContain("update: skipped\nreason: no_assistant_in_delta");
    expect(h.generations).toHaveLength(0);
    expect(await readFile(memoryPath, "utf8")).toBe("protected");
    expect(await readFile(checkpointPath, "utf8")).toBe("old-checkpoint\n");
  });

  test("active updater reentry is busy before host reads and a later retry reads fresh history", async () => {
    const sessionID = "manual-reentry";
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ summarizerMode: "active" }));
    const h = updateHost(testDir, sessionID, [settledAssistant("msg_a")]);
    const reentries: string[] = [];
    h.pluginContext.session.generate = async () => {
      const readsBefore = h.reads.length;
      reentries.push(await updateText(h.tool, sessionID));
      expect(h.reads).toHaveLength(readsBefore);
      return { text: generatedMemory } as never;
    };
    const updater = createV2MemoryUpdater(h.pluginContext, testDir);
    const result = await updater({
      sessionID,
      model: currentModel as never,
      messages: [{ id: "msg_previous", role: "assistant", content: [{ type: "text", text: "previous" }] }],
    });
    expect(result.status).toBe("committed");
    expect(h.reads).toHaveLength(0);
    expect(reentries[0]).toContain("update: busy\nreason: update_in_flight\nsource: not-read");
    expect(await updateText(h.tool, sessionID)).toContain("update: committed");
    expect(h.reads).toHaveLength(2);
    expect(reentries).toHaveLength(2);
    expect(await readFile(checkpointPathFor(sessionID), "utf8")).toBe("msg_a\n");
  });

  test("ownership acquired while fresh history is pending returns busy without generating", async () => {
    const sessionID = "manual-race";
    const h = updateHost(testDir, sessionID, [settledAssistant("msg_manual")]);
    let releaseRead!: (records: unknown) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    h.pluginContext.session.context = async () => {
      readStarted();
      return await new Promise<never>((resolve) => {
        releaseRead = resolve as (records: unknown) => void;
      });
    };
    const manual = updateText(h.tool, sessionID);
    await started;
    let releaseGeneration!: () => void;
    let generationStarted!: () => void;
    let generationCalls = 0;
    const generating = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    h.pluginContext.generate.text = async () => {
      generationCalls += 1;
      generationStarted();
      await new Promise<void>((resolve) => {
        releaseGeneration = resolve;
      });
      return { text: generatedMemory } as never;
    };
    const automatic = createV2MemoryUpdater(
      h.pluginContext,
      testDir,
    )({
      sessionID,
      model: currentModel as never,
      messages: [{ id: "msg_auto", role: "assistant", content: [{ type: "text", text: "automatic" }] }],
    });
    await generating;
    try {
      releaseRead([settledAssistant("msg_manual")]);
      const text = await manual;
      expect(text).toContain("update: busy\nreason: update_in_flight\nsource: durable-visible-text");
      expect(text).toContain('progress: cumulative-invocation {"checkpointedChunks":0');
      expect(h.generations).toHaveLength(0);
      expect(generationCalls).toBe(1);
      expect(await readRawFile(checkpointPathFor(sessionID))).toBeNull();
    } finally {
      releaseGeneration();
      await automatic;
    }
    expect(await readFile(checkpointPathFor(sessionID), "utf8")).toBe("msg_auto\n");
  });

  test("partial generation failure reports cumulative fragment writes without claiming completion", async () => {
    const sessionID = "manual-partial";
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ maxUpdateInputLength: 500 }));
    const h = updateHost(testDir, sessionID, [settledAssistant("msg_large", "x".repeat(1200))]);
    let calls = 0;
    h.pluginContext.generate.text = async () => {
      calls += 1;
      if (calls === 2) throw new Error("second fragment failed");
      return { text: generatedMemory } as never;
    };
    const text = await updateText(h.tool, sessionID);
    expect(text).toContain("update: error\nreason: operational_failure");
    expect(text).toContain(
      'progress: cumulative-invocation {"checkpointedChunks":0,"checkpointedMessages":0,"persistedPartialFragments":1}',
    );
    expect(text).toContain('rollback: none-reported\ndetail: "second fragment failed"');
    expect(text).not.toContain("completed");
    expect(text).not.toContain("unchanged");
    expect(calls).toBe(2);
    expect(await readFile(memoryPathFor(sessionID), "utf8")).toContain("learned");
    expect(await readRawFile(checkpointPathFor(sessionID))).toBeNull();
  });

  test("checkpoint write failure reports rollback without inferring unchanged state from zero counters", async () => {
    const sessionID = "manual-rollback";
    await writeText(memoryPathFor(sessionID), "previous memory");
    await mkdir(checkpointPathFor(sessionID), { recursive: true });
    const h = updateHost(testDir, sessionID, [settledAssistant("msg_a")]);
    const text = await updateText(h.tool, sessionID);
    expect(h.generations).toHaveLength(1);
    expect(text).toContain("update: error\nreason: operational_failure");
    expect(text).toContain(
      'progress: cumulative-invocation {"checkpointedChunks":0,"checkpointedMessages":0,"persistedPartialFragments":0}',
    );
    expect(text).toContain("rollback: restored");
    expect(text).toContain("detail:");
    expect(text).not.toContain("unchanged");
    expect(text).not.toContain("committed");
    expect(await readFile(memoryPathFor(sessionID), "utf8")).toBe("previous memory");
  });

  test("disabled configuration remains a skipped update with no generation or persistence", async () => {
    const sessionID = "manual-disabled";
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ enabled: false }));
    const h = updateHost(testDir, sessionID, [settledAssistant("msg_a")]);
    expect(await updateText(h.tool, sessionID)).toContain("update: skipped\nreason: disabled");
    expect(h.generations).toHaveLength(0);
    expect(await readRawFile(memoryPathFor(sessionID))).toBeNull();
    expect(await readRawFile(checkpointPathFor(sessionID))).toBeNull();
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

    const result = await resetTool.execute(
      { confirm: true },
      { ...toolContext(sessionID), messageID: messageID as ToolContext["messageID"] },
    );
    expect(resultText(result)).toBe(
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

    await expect(
      resetTool.execute({ confirm: true }, { ...toolContext("a/b"), messageID: "anchor" as ToolContext["messageID"] }),
    ).rejects.toThrow("unsafe path characters");
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
    const text = resultText(statusResult);
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
    const text = resultText(result);
    expect(text).toContain("configuredMemoryModel: none");
    expect(text).toContain("effectiveMemoryModel: current-session");
    expect(text).toContain("checkpoint: message-42");
  });

  test("reports valid, malformed, and unreadable persisted reset boundaries", async () => {
    const sessionID = "boundary-status";
    const [, statusTool] = createV2MemoryTools(context(testDir));
    const boundaryPath = resetBoundaryPathFor(sessionID);

    await writeText(boundaryPath, '{"version":1,"anchorID":"anchor-1"}\n');
    let text = resultText(await statusTool.execute({}, toolContext(sessionID)));
    expect(text).toContain("resetBoundary: valid");
    expect(text).toContain("resetBoundaryAnchor: anchor-1");

    await writeText(boundaryPath, '{"version":1,"anchorID":"anchor-1","extra":true}\n');
    text = resultText(await statusTool.execute({}, toolContext(sessionID)));
    expect(text).toContain("resetBoundary: invalid");
    expect(text).not.toContain("resetBoundaryAnchor:");

    await rm(boundaryPath, { force: true });
    await mkdir(boundaryPath, { recursive: true });
    text = resultText(await statusTool.execute({}, toolContext(sessionID)));
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
    const text = resultText(status);
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
    const text = resultText(status);
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
    expect(resultText(status)).toContain("updaterBusy: true");
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

    expect(resultText(resetResult)).toContain("an update is active for this session; retry after it finishes");
    expect(await readRawFile(resetBoundaryPathFor(sessionID))).toBeNull();
    const laterReset = await resetTool.execute({ confirm: true }, toolContext(sessionID));
    expect(resultText(laterReset)).toContain("reset: completed");
    expect(await readRawFile(resetBoundaryPathFor(sessionID))).not.toBeNull();
  });

  test("returns registrations in exact order with definition identity", () => {
    const registrations = createV2MemoryToolRegistrations(context(testDir));
    expect(registrations.map(({ name }) => name)).toEqual([
      "stm_memory_read",
      "stm_memory_status",
      "stm_memory_reset",
      "stm_memory_update",
    ]);
    expect(registrations.map(({ definition }) => definition.name)).toEqual(registrations.map(({ name }) => name));
    expect(registrations.map(({ definition }) => definition.options)).toEqual([
      { codemode: false },
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
          const name = ["read", "status", "reset", "update"][toolNumber - 1]!;
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
      "acquire:update",
      "dispose:update",
      "dispose:reset",
      "dispose:status",
      "dispose:read",
      "dispose:compaction",
      "dispose:context",
    ]);
  });
});
