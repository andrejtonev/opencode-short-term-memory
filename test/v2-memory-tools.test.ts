import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Info as ToolDefinition, ToolContext } from "@opencode/plugin/promise/tool";
import Root from "../src/index";
import {
  DEFAULT_CONFIG,
  checkpointPathFor,
  createProjectExampleConfig,
  logPath,
  memoryPathFor,
  readRawFile,
  resetBoundaryPathFor,
  writeText,
} from "../src/memory-utils";
import type { V2Context } from "../src/v2-adapter";
import { createV2MemoryActions, createV2MemoryToolRegistrations, createV2MemoryTools } from "../src/v2-memory-tools";
import { createV2ContextInjection } from "../src/v2-context-injection";
import { createV2MemoryUpdater } from "../src/v2-memory-update";
import { withV2MemoryMutation } from "../src/v2-mutation-coordination";

type ToolEditor = { readonly add: (definition: unknown) => void };

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalConfig = process.env.OPENCODE_CONFIG_DIR;

function context(directory: string): V2Context {
  return {
    location: { directory, project: { id: "project", directory, canonical: directory } },
    options: {},
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: null }),
      hook: async () => ({ dispose: async () => undefined }),
    },
    tool: { transform: async () => ({ dispose: async () => undefined }) },
    command: { transform: async () => ({ dispose: async () => undefined }) },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          // The root setup scheduler owns the subscription lifetime.
        },
      }),
    },
    rpc: { register: async () => ({ events: { emit: async () => undefined }, dispose: async () => undefined }) },
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
        return { id: sessionID, parentID: null, model: currentModel };
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

  test("defines exactly eight tools and executes the exact transformed definitions", async () => {
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
      "stm_memory_logs",
      "stm_memory_settings",
      "stm_memory_setup",
      "short_term_memory",
    ]);
    expect(editors).toHaveLength(8);
    editors.forEach((editor, index) => expect(editor.added[0]).toBe(definitions[index]));
    expect(definitions.map(({ options }) => options)).toEqual([
      { codemode: false },
      { codemode: false },
      { codemode: false },
      { codemode: false },
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
    for (const index of [0, 1, 3, 4, 5]) expect(definitions[index]!.input).toEqual(expectedInputSchema);
    expect(definitions[2]!.input).toEqual({
      type: "object",
      properties: { confirm: { type: "boolean" } },
      required: ["confirm"],
      additionalProperties: false,
    });
    expect(definitions[6]!.input).toEqual({
      type: "object",
      properties: { confirm: { type: "boolean" } },
      additionalProperties: false,
    });
    expect(definitions[7]!.input).toEqual({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["show", "status", "update", "reset", "logs", "settings", "setup"],
        },
        confirm: { type: "boolean" },
      },
      required: ["action"],
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
            "effectiveMemoryModel: unresolved",
            "memoryModelSelection: inherited-current-session",
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
    expect(resultText(await definitions[4]!.execute({}, toolContext("authoritative")))).toBe("No logs yet.");
    expect(JSON.parse(resultText(await definitions[5]!.execute({}, toolContext("authoritative"))))).toMatchObject({
      generation: "v2",
      resolvedConfig: DEFAULT_CONFIG,
    });
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

  test("all eight real shared actions match their tool outputs", async () => {
    const sessionID = "shared-actions";
    const h = updateHost(testDir, sessionID, [settledAssistant("msg_a")]);
    const actions = createV2MemoryActions(h.pluginContext);
    const [show, status, reset, update, logs, settings, setup, compatibility] = createV2MemoryTools(h.pluginContext);
    await writeText(memoryPathFor(sessionID), "exact persisted memory");
    await writeText(logPath(), "actual shared log\n");
    for (const [tool, action] of [
      [show, actions.show],
      [status, actions.status],
      [logs, actions.logs],
      [settings, actions.settings],
    ] as const) {
      expect(resultText(await tool.execute({}, toolContext(sessionID)))).toBe(await action(sessionID));
    }
    // Run each mutation from the same persisted state so the comparison is causal.
    const paths = [memoryPathFor(sessionID), checkpointPathFor(sessionID), resetBoundaryPathFor(sessionID)];
    const before = await Promise.all(paths.map(readRawFile));
    const restore = async () => {
      for (const [index, path] of paths.entries()) {
        if (before[index] === null) await rm(path, { force: true });
        else await writeFile(path, before[index]!);
      }
    };
    const actionUpdate = await actions.update(sessionID);
    const actionState = await Promise.all(paths.map(readRawFile));
    await restore();
    expect(resultText(await update.execute({}, toolContext(sessionID)))).toBe(actionUpdate);
    expect(await Promise.all(paths.map(readRawFile))).toEqual(actionState);
    const actionReset = await actions.reset(sessionID, { confirm: true, messageID: "message" });
    const resetState = await Promise.all(paths.map(readRawFile));
    await restore();
    expect(resultText(await reset.execute({ confirm: true }, toolContext(sessionID)))).toBe(actionReset);
    expect(await Promise.all(paths.map(readRawFile))).toEqual(resetState);
    const actionSetup = await actions.setup(sessionID, { confirm: true });
    const configPath = join(testDir, ".opencode", "stm.jsonc");
    const configBytes = await readFile(configPath);
    await rm(configPath);
    expect(resultText(await setup.execute({ confirm: true }, toolContext(sessionID)))).toBe(actionSetup);
    expect(await readFile(configPath)).toEqual(configBytes);
    expect(await actions.setup(sessionID, { confirm: true })).toContain("already exists");
    expect(await readFile(configPath)).toEqual(configBytes);
    expect(await actions.reset(sessionID, { confirm: "true" })).toBe(
      resultText(await reset.execute({ confirm: "true" }, toolContext(sessionID))),
    );
    expect(await actions.setup(sessionID, { confirm: false })).toBe(
      resultText(await setup.execute({ confirm: false }, toolContext(sessionID))),
    );
    expect(resultText(await compatibility.execute({ action: "show" }, toolContext(sessionID)))).toBe(
      await actions.show(sessionID),
    );
    expect(resultText(await compatibility.execute({ action: "logs" }, toolContext(sessionID)))).toBe(
      await actions.logs(sessionID),
    );
  });

  test("compatibility reset requires invocation identity and rejects unknown actions without mutation", async () => {
    const sessionID = "compatibility-reset";
    const host = updateHost(testDir, sessionID, [settledAssistant("msg_a")]);
    const compatibility = createV2MemoryTools(host.pluginContext)[7]!;
    await writeText(memoryPathFor(sessionID), "protected memory");
    const before = await readRawFile(memoryPathFor(sessionID));

    expect(resultText(await compatibility.execute({ action: "unknown" }, toolContext(sessionID)))).toContain(
      "unknown action",
    );
    expect(await readRawFile(memoryPathFor(sessionID))).toEqual(before);
    await expect(
      compatibility.execute({ action: "reset", confirm: true }, {
        ...toolContext(sessionID),
        messageID: "",
      } as ToolContext),
    ).rejects.toThrow("reset messageID must be a nonempty string");
    expect(await readRawFile(memoryPathFor(sessionID))).toEqual(before);
    expect(
      resultText(await compatibility.execute({ action: "reset", confirm: true }, toolContext(sessionID))),
    ).toContain("reset: completed");
    expect(await readRawFile(resetBoundaryPathFor(sessionID))).toEqual(
      Buffer.from('{"version":1,"anchorID":"message"}\n'),
    );
    const setup = await compatibility.execute({ action: "setup", confirm: true }, toolContext(sessionID));
    const configPath = join(testDir, ".opencode", "stm.jsonc");
    const configBytes = await readFile(configPath);
    expect(resultText(setup)).toContain(`configPath: ${configPath}`);
    expect(
      resultText(await compatibility.execute({ action: "setup", confirm: true }, toolContext(sessionID))),
    ).toContain("already exists");
    expect(await readFile(configPath)).toEqual(configBytes);
  });

  test("command reset anchors the last excluded durable record in array order", async () => {
    const sessionID = "command-reset-order";
    const h = updateHost(testDir, sessionID, [
      settledAssistant("msg_z"),
      { id: "msg_a", type: "system", text: "excluded context", time: { created: 3 } },
    ]);
    await writeText(memoryPathFor(sessionID), "previous memory");
    await writeText(checkpointPathFor(sessionID), "msg_z\n");
    const actions = createV2MemoryActions(h.pluginContext);
    const text = await actions.reset(sessionID, { confirm: true });
    expect(text).toContain("reset: completed");
    expect(text).toContain("resetBoundaryAnchor: msg_a");
    expect(text).toContain("boundaryScope: through last record of settled durable snapshot; not invocation message");
    expect(await readFile(resetBoundaryPathFor(sessionID), "utf8")).toBe('{"version":1,"anchorID":"msg_a"}\n');
    expect(await readFile(checkpointPathFor(sessionID), "utf8")).toBe("");
    expect(h.generations).toHaveLength(0);
    // The actual updater respects this excluded anchor and does not replay prior text.
    expect(await actions.update(sessionID)).toContain("reason: no_assistant_in_delta");
    expect(h.generations).toHaveLength(0);
  });

  test.each([
    "empty",
    "unfinished",
    "no-model",
    "empty-no-model",
    "malformed",
    "duplicate",
    "empty-id",
    "host-error",
  ] as const)("command reset refuses %s snapshot without changing any persistence bytes", async (mode) => {
    const sessionID = "command-reset-refusal";
    const records =
      mode === "empty" || mode === "empty-no-model"
        ? []
        : mode === "malformed"
          ? [null]
          : mode === "duplicate"
            ? [settledAssistant("msg_a"), settledAssistant("msg_a")]
            : mode === "empty-id"
              ? [settledAssistant("")]
              : [
                  settledAssistant("msg_a"),
                  settledAssistant("msg_pending", "unfinished", mode === "unfinished" ? null : 2),
                ];
    const h = updateHost(testDir, sessionID, records);
    if (mode === "no-model" || mode === "empty-no-model")
      h.pluginContext.session.get = async () => ({ id: sessionID }) as never;
    if (mode === "host-error")
      h.pluginContext.session.context = async () => {
        throw new Error("host unavailable");
      };
    const paths = [memoryPathFor(sessionID), checkpointPathFor(sessionID), resetBoundaryPathFor(sessionID)];
    const bytes = [
      Buffer.from([0, 255, 10]),
      Buffer.from("protected-checkpoint\n"),
      Buffer.from('{"version":1,"anchorID":"old-anchor"}\n'),
    ];
    for (const path of paths) await writeText(path, "prepare directory");
    for (const [index, path] of paths.entries()) await writeFile(path, bytes[index]!);
    const files = (await readdir(join(testDir, ".opencode", "memory"), { recursive: true })).sort();
    const text = await createV2MemoryActions(h.pluginContext).reset(sessionID, { confirm: true });
    expect(text).toStartWith("Refused to reset V2 short-term memory:");
    expect(text).not.toContain("reset: completed");
    if (mode === "no-model" || mode === "empty-no-model") expect(text).toContain("no-model");
    if (mode === "unfinished") expect(text).toContain("stoppedBeforeMessageID");
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(bytes);
    expect((await readdir(join(testDir, ".opencode", "memory"), { recursive: true })).sort()).toEqual(files);
    expect(h.generations).toHaveLength(0);
  });

  test("command reset reads after queued ownership and blocks a real updater throughout history resolution", async () => {
    const sessionID = "command-reset-race";
    const h = updateHost(testDir, sessionID, []);
    const actions = createV2MemoryActions(h.pluginContext);
    let releaseOwner!: () => void;
    const owner = withV2MemoryMutation(
      testDir,
      sessionID,
      () =>
        new Promise<void>((resolve) => {
          releaseOwner = resolve;
        }),
    );
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
    await writeText(memoryPathFor(sessionID), "protected before resolver");
    const reset = actions.reset(sessionID, { confirm: true });
    await Promise.resolve();
    expect(h.reads).toHaveLength(0);
    await writeText(checkpointPathFor(sessionID), "msg_new\n");
    releaseOwner();
    await owner;
    await started;
    try {
      expect(await readFile(memoryPathFor(sessionID), "utf8")).toBe("protected before resolver");
      const competing = await createV2MemoryUpdater(
        h.pluginContext,
        testDir,
      )({
        sessionID,
        model: currentModel as never,
        messages: [{ id: "msg_competing", role: "assistant", content: [{ type: "text", text: "competing" }] }],
      });
      expect(competing.status).toBe("busy");
      expect(h.generations).toHaveLength(0);
      expect(await readFile(checkpointPathFor(sessionID), "utf8")).toBe("msg_new\n");
    } finally {
      releaseRead([settledAssistant("msg_new")]);
    }
    expect(await reset).toContain("resetBoundaryAnchor: msg_new");
    expect(await readFile(resetBoundaryPathFor(sessionID), "utf8")).toBe('{"version":1,"anchorID":"msg_new"}\n');
  });

  test("logs return the actual shared 120-line tail from freshly configured storage without mutations", async () => {
    const projectDir = join(testDir, "project");
    const configPath = join(projectDir, ".opencode", "stm.json");
    const memoryDir = join(testDir, "shared-memory");
    await writeText(configPath, JSON.stringify({ memoryDir, logMaxLines: 20 }));
    await writeText(logPath(), "wrong directory");
    const lines = Array.from({ length: 140 }, (_, index) =>
      JSON.stringify({ event: "update", sessionID: index % 2 ? "other-session" : "actual", index }),
    );
    await writeText(logPath(memoryDir), lines.join("\n") + "\n");
    await writeText(memoryPathFor("actual", memoryDir), "protected memory");
    await writeText(checkpointPathFor("actual", memoryDir), "protected checkpoint\n");
    await writeText(resetBoundaryPathFor("actual", memoryDir), '{"version":1,"anchorID":"protected"}\n');
    const paths = (await readdir(memoryDir, { recursive: true })).sort();
    const snapshot = async () =>
      await Promise.all(
        paths.map(async (path) => {
          const fullPath = join(memoryDir, path);
          const info = await stat(fullPath);
          return { path, mtimeMs: info.mtimeMs, bytes: info.isFile() ? await readFile(fullPath) : null };
        }),
      );
    const before = await snapshot();
    const h = updateHost(projectDir, "actual", []);
    const [, , , , logsTool] = createV2MemoryTools(h.pluginContext);
    expect(logsTool.description).toContain("shared by all sessions");
    expect(logsTool.description).toContain("sensitive");
    const expected = lines.slice(-120).join("\n");
    expect(resultText(await logsTool.execute({}, toolContext("actual")))).toBe(expected);
    expect(resultText(await logsTool.execute({ sessionID: "other-session" }, toolContext("other-session")))).toBe(
      expected,
    );
    expect((await readdir(memoryDir, { recursive: true })).sort()).toEqual(paths);
    expect(await snapshot()).toEqual(before);
    expect(h.reads).toEqual([]);
    expect(h.generations).toEqual([]);

    const nextMemoryDir = join(testDir, "next-memory");
    await writeText(configPath, JSON.stringify({ memoryDir: nextMemoryDir }));
    await writeText(logPath(nextMemoryDir), "fresh config log\n");
    expect(resultText(await logsTool.execute({}, toolContext("actual")))).toBe("fresh config log");
    expect(await snapshot()).toEqual(before);
  });

  test("missing, empty and unreadable logs use the fallback without creating memory files or directories", async () => {
    const memoryDir = join(testDir, "missing-memory");
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    const [, , , , logsTool] = createV2MemoryTools(context(testDir));
    expect(resultText(await logsTool.execute({}, toolContext("actual")))).toBe("No logs yet.");
    await expect(stat(memoryDir)).rejects.toMatchObject({ code: "ENOENT" });
    await writeText(logPath(memoryDir), "");
    expect(resultText(await logsTool.execute({}, toolContext("actual")))).toBe("No logs yet.");
    expect(await readdir(memoryDir)).toEqual(["session-memory.log"]);
    expect(await readFile(logPath(memoryDir), "utf8")).toBe("");
    await rm(logPath(memoryDir));
    await mkdir(logPath(memoryDir));
    expect(resultText(await logsTool.execute({}, toolContext("actual")))).toBe("No logs yet.");
    expect(await readdir(memoryDir)).toEqual(["session-memory.log"]);
    expect(await readdir(logPath(memoryDir))).toEqual([]);
  });

  test("settings freshly merge and normalize project overrides while separating all inactive V2 config keys", async () => {
    const projectDir = join(testDir, "project");
    const globalPath = join(process.env.XDG_CONFIG_HOME!, "opencode", "stm.jsonc");
    const envPath = join(process.env.OPENCODE_CONFIG_DIR!, "stm.json");
    const projectPath = join(projectDir, ".opencode", "stm.jsonc");
    const memoryDir = join(testDir, "uncreated-memory");
    await writeText(globalPath, JSON.stringify({ maxMemoryLength: 700, summarizerMode: "active", debug: true }));
    await writeText(
      envPath,
      JSON.stringify({ maxMemoryLength: 800, maxDeltaMessages: "30.8", memoryModel: "env/model" }),
    );
    const overrides = {
      enabled: "false",
      memoryModel: " configured/model ",
      summarizerMode: "CLEAN",
      maxMemoryLength: "100",
      maxUpdateInputLength: "999999",
      memoryDir: ` ${memoryDir} `,
      cleanFallbackToActiveSession: true,
      includeAgentsMdOnFirstUpdate: true,
      injectInSubagents: false,
      enableLegacyPeriodicSystemTransform: true,
      sideSessionRetries: 9,
      remindEveryN: 42,
      debounceMs: 9999,
      logMaxLines: 22,
      collapseAssistantBursts: true,
    };
    await writeText(projectPath, JSON.stringify(overrides));
    const hostCalls: string[] = [];
    const pluginContext = context(projectDir);
    for (const key of ["session", "generate"] as const) {
      Object.defineProperty(pluginContext, key, {
        get: () => {
          hostCalls.push(key);
          throw new Error("diagnostics must not access host sessions or generation");
        },
      });
    }
    const [, , , , , settingsTool] = createV2MemoryTools(pluginContext);
    const before = await Promise.all([globalPath, envPath, projectPath].map((path) => readFile(path)));
    const resolvedConfig = {
      ...DEFAULT_CONFIG,
      ...overrides,
      enabled: false,
      memoryModel: "configured/model",
      summarizerMode: "clean",
      maxMemoryLength: 200,
      maxUpdateInputLength: 200000,
      maxDeltaMessages: 30,
      memoryDir,
      debug: true,
    };
    const expected = {
      generation: "v2",
      resolvedConfig,
      effective: {
        enabled: false,
        memoryModel: "configured/model",
        memoryModelSelection: "explicit-override",
        summarizerMode: "clean",
        activeWithExplicitMemoryModel: "unsupported",
        maxMemoryLength: 200,
        maxUpdateInputLength: 200000,
        maxDeltaMessages: 30,
        memoryDir,
        cleanFallbackToActiveSession: true,
        includeAgentsMdOnFirstUpdate: true,
        injectInSubagents: false,
        enableLegacyPeriodicSystemTransform: true,
        sideSessionRetries: 9,
        remindEveryN: 42,
        debounceMs: 9999,
        collapseAssistantBursts: true,
        debug: true,
        logMaxLines: 22,
        updateHook: "context",
        injectionHooks: ["context", "compaction"],
      },
      inactiveSettings: [],
    };
    expect(JSON.parse(resultText(await settingsTool.execute({}, toolContext("actual"))))).toEqual(expected);
    expect(await Promise.all([globalPath, envPath, projectPath].map((path) => readFile(path)))).toEqual(before);
    await expect(stat(memoryDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(projectDir, ".opencode"))).toEqual(["stm.jsonc"]);

    await writeText(projectPath, JSON.stringify({ enabled: true, summarizerMode: "ACTIVE", memoryDir }));
    expect(JSON.parse(resultText(await settingsTool.execute({}, toolContext("different"))))).toEqual({
      ...expected,
      resolvedConfig: {
        ...DEFAULT_CONFIG,
        enabled: true,
        summarizerMode: "active",
        memoryModel: "env/model",
        maxMemoryLength: 800,
        maxDeltaMessages: 30,
        memoryDir,
        debug: true,
      },
      effective: {
        ...expected.effective,
        enabled: true,
        memoryModel: null,
        memoryModelSelection: "active-override-unsupported",
        summarizerMode: "active",
        activeWithExplicitMemoryModel: "unsupported",
        maxMemoryLength: 800,
        maxUpdateInputLength: DEFAULT_CONFIG.maxUpdateInputLength,
        cleanFallbackToActiveSession: DEFAULT_CONFIG.cleanFallbackToActiveSession,
        includeAgentsMdOnFirstUpdate: DEFAULT_CONFIG.includeAgentsMdOnFirstUpdate,
        injectInSubagents: DEFAULT_CONFIG.injectInSubagents,
        enableLegacyPeriodicSystemTransform: false,
        sideSessionRetries: DEFAULT_CONFIG.sideSessionRetries,
        remindEveryN: DEFAULT_CONFIG.remindEveryN,
        debounceMs: DEFAULT_CONFIG.debounceMs,
        collapseAssistantBursts: DEFAULT_CONFIG.collapseAssistantBursts,
        debug: true,
        logMaxLines: DEFAULT_CONFIG.logMaxLines,
      },
    });
    expect(hostCalls).toEqual([]);
    await expect(stat(memoryDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("setup confirms literally before creating only the captured project example without host access", async () => {
    const projectDir = join(testDir, "project");
    const ignoredDir = join(testDir, "ignored");
    const pluginContext = context(projectDir);
    const hostCalls: string[] = [];
    for (const key of ["session", "generate"] as const) {
      Object.defineProperty(pluginContext, key, {
        get: () => {
          hostCalls.push(key);
          throw new Error("setup must not access host sessions or generation");
        },
      });
    }
    const [, , , , , , setupTool] = createV2MemoryTools(pluginContext);
    Object.assign(pluginContext.location, { directory: ignoredDir });
    const invocationContext = new Proxy({} as ToolContext, {
      get: () => {
        throw new Error("setup must not access tool session identity");
      },
    });
    for (const input of [{ confirm: false }, {}, { confirm: "true" }, { confirm: null }, null, undefined, "true"]) {
      expect(resultText(await setupTool.execute(input, invocationContext))).toBe(
        "Refused to create a project example config: set confirm to literal true to confirm setup.",
      );
      await expect(stat(join(projectDir, ".opencode"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(testDir, ".opencode"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const configPath = join(projectDir, ".opencode", "stm.jsonc");
    const text = resultText(
      await setupTool.execute({ confirm: true, directory: ignoredDir, path: ignoredDir }, invocationContext),
    );
    expect(text).toBe(
      [
        `Created project example config at ${configPath}.`,
        `configPath: ${configPath}`,
        "Shared example: see stm_memory_settings for effective V2 settings; explicit memoryModel overrides apply to clean mode.",
      ].join("\n"),
    );
    const reference = await createProjectExampleConfig(join(testDir, "reference"));
    expect(await readFile(configPath)).toEqual(await readFile(reference.configPath));
    expect(await readdir(join(projectDir, ".opencode"))).toEqual(["stm.jsonc"]);
    for (const directory of [
      testDir,
      ignoredDir,
      process.env.HOME!,
      process.env.XDG_CONFIG_HOME!,
      process.env.OPENCODE_CONFIG_DIR!,
    ]) {
      await expect(stat(join(directory, ".opencode"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(stat(process.env.OPENCODE_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(process.env.XDG_CONFIG_HOME!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(hostCalls).toEqual([]);
  });

  test.each(["stm.jsonc", "stm.json"])(
    "setup preserves existing %s bytes and creates no other files",
    async (filename) => {
      const projectDir = join(testDir, "project");
      const configDir = join(projectDir, ".opencode");
      const existingPath = join(configDir, filename);
      const bytes = Buffer.from([0, 255, 10, 123, 125]);
      await mkdir(configDir, { recursive: true });
      await writeFile(existingPath, bytes);
      const [, , , , , , setupTool] = createV2MemoryTools(context(projectDir));
      const text = resultText(await setupTool.execute({ confirm: true }, {} as ToolContext));
      expect(text).toContain(`No example config created: ${filename} already exists in ${configDir}.`);
      expect(text).toContain(`configPath: ${join(configDir, "stm.jsonc")}`);
      expect(await readFile(existingPath)).toEqual(bytes);
      expect(await readdir(configDir)).toEqual([filename]);
    },
  );

  test("concurrent setup calls create once without overwriting the shared example", async () => {
    const projectDir = join(testDir, "project");
    const configDir = join(projectDir, ".opencode");
    const tools = [createV2MemoryTools(context(projectDir))[6], createV2MemoryTools(context(projectDir))[6]];
    const texts = await Promise.all(
      tools.map(async (tool) => resultText(await tool.execute({ confirm: true }, {} as ToolContext))),
    );
    expect(texts.filter((text) => text.startsWith("Created project example config"))).toHaveLength(1);
    expect(texts.filter((text) => text.startsWith("No example config created: stm.jsonc already exists"))).toHaveLength(
      1,
    );
    const configPath = join(configDir, "stm.jsonc");
    const before = await readFile(configPath);
    expect(resultText(await tools[0]!.execute({ confirm: true }, {} as ToolContext))).toContain("already exists");
    expect(await readFile(configPath)).toEqual(before);
    expect(await readdir(configDir)).toEqual(["stm.jsonc"]);
  });

  test("setup propagates IO errors rather than reporting creation", async () => {
    const projectDir = join(testDir, "project");
    await writeText(join(projectDir, ".opencode"), "not a directory");
    const [, , , , , , setupTool] = createV2MemoryTools(context(projectDir));
    await expect(setupTool.execute({ confirm: true }, {} as ToolContext)).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await readFile(join(projectDir, ".opencode"), "utf8")).toBe("not a directory");
    expect(await readdir(projectDir)).toEqual([".opencode"]);
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
      { method: "get", input: { sessionID } },
    ]);
    expect(h.reads[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(h.reads[1]!.signal).toBe(h.reads[0]!.signal);
    expect(h.generations).toHaveLength(1);
    expect(h.generations[0]!.model).toEqual({ providerID: "override", id: "model" });
    expect(h.generations[0]!.model).not.toEqual({ providerID: "attacker", id: "attacker" });
    expect(h.generations[0]!.prompt).toContain("fresh user text");
    expect(h.generations[0]!.prompt).toContain("settled answer");
    for (const hidden of ["unfinished text", "future text", "hidden reasoning", "attacker"])
      expect(h.generations[0]!.prompt).not.toContain(hidden);
    expect(await readFile(checkpointPathFor(sessionID), "utf8")).toBe("msg_settled\n");
    expect(await readFile(memoryPathFor(sessionID), "utf8")).toContain("learned");
    expect(await readRawFile(memoryPathFor("attacker"))).toBeNull();

    const retry = await updateText(h.tool, sessionID);
    expect(h.reads).toHaveLength(6);
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
    expect(h.reads).toHaveLength(1);
    expect(reentries[0]).toContain("update: busy\nreason: update_in_flight\nsource: not-read");
    expect(await updateText(h.tool, sessionID)).toContain("update: committed");
    expect(h.reads).toHaveLength(4);
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
        "effectiveMemoryModel: provider/model",
        "memoryModelSelection: explicit-override",
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
    expect(text).toContain("effectiveMemoryModel: unresolved");
    expect(text).toContain("memoryModelSelection: inherited-current-session");
    expect(text).toContain("checkpoint: message-42");
  });

  test.each([
    { mode: "clean", model: "", selection: "inherited-current-session", effective: null },
    { mode: "active", model: "   ", selection: "inherited-current-session", effective: null },
    {
      mode: "clean",
      model: " provider/model/submodel ",
      selection: "explicit-override",
      effective: "provider/model/submodel",
    },
    { mode: "active", model: "provider/model", selection: "active-override-unsupported", effective: null },
    { mode: "clean", model: "malformed", selection: "invalid-override", effective: null },
    { mode: "active", model: "malformed", selection: "invalid-override", effective: null },
    { mode: "clean", model: "/model", selection: "invalid-override", effective: null },
    { mode: "active", model: "provider/", selection: "invalid-override", effective: null },
    { mode: "clean", model: "provider/   ", selection: "invalid-override", effective: null },
    { mode: "active", model: "   /model", selection: "invalid-override", effective: null },
  ])(
    "reports declarative model selection without host lookup: $mode '$model'",
    async ({ mode, model, selection, effective }) => {
      const configPath = join(testDir, ".opencode", "stm.json");
      await writeText(configPath, JSON.stringify({ summarizerMode: mode, memoryModel: model }));
      const before = await readFile(configPath);
      const pluginContext = context(testDir);
      const hostCalls: string[] = [];
      for (const key of ["session", "generate"] as const) {
        Object.defineProperty(pluginContext, key, {
          get: () => {
            hostCalls.push(key);
            throw new Error("model diagnostics must not access the host");
          },
        });
      }
      const [, statusTool, , , , settingsTool] = createV2MemoryTools(pluginContext);
      const status = resultText(await statusTool.execute({}, toolContext("model-selection")));
      const settings = JSON.parse(resultText(await settingsTool.execute({}, toolContext("model-selection"))));
      expect(status).toContain(`configuredMemoryModel: ${model.trim() || "none"}\n`);
      expect(status).toContain(
        `effectiveMemoryModel: ${effective ?? (selection === "inherited-current-session" ? "unresolved" : "unavailable")}\n`,
      );
      expect(status).toContain(`memoryModelSelection: ${selection}\n`);
      expect(settings.effective.memoryModel).toBe(effective);
      expect(settings.effective.memoryModelSelection).toBe(selection);
      expect(hostCalls).toEqual([]);
      expect(await readFile(configPath)).toEqual(before);
      expect(await readdir(join(testDir, ".opencode"))).toEqual(["stm.json"]);
    },
  );

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

  test("uses the configured model for clean V2 generation rather than the current model", async () => {
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
    expect((cleanCalls[0] as { model: unknown }).model).toEqual({ providerID: "provider", id: "configured" });

    const [, statusTool] = createV2MemoryTools(context(testDir));
    const status = await statusTool.execute({}, toolContext(sessionID));
    const text = resultText(status);
    expect(text).toContain("configuredMemoryModel: provider/configured");
    expect(text).toContain("effectiveMemoryModel: provider/configured");
    expect(text).toContain("memoryModelSelection: explicit-override");
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
    const injection = createV2ContextInjection(context(testDir), testDir);
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
    let entered!: () => void;
    const generationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await writeText(join(testDir, ".opencode", "stm.json"), JSON.stringify({ summarizerMode: "clean" }));
    const updater = createV2MemoryUpdater(
      {
        ...context(testDir),
        generate: {
          text: async () => {
            entered();
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
      model: currentModel,
      messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "answer" }] }],
    } as never);
    let updateResult!: Awaited<typeof update>;
    try {
      await generationEntered;
      const [, statusTool] = createV2MemoryTools(context(testDir));
      const status = await statusTool.execute({}, toolContext(sessionID));
      expect(resultText(status)).toContain("updaterBusy: true");
    } finally {
      release();
      updateResult = await update;
    }
    expect(updateResult.status).toBe("committed");
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
        get: async ({ sessionID: requestedSessionID }: { sessionID: string }) => ({
          id: requestedSessionID,
          parentID: null,
          model: currentModel,
        }),
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

    const updateResult = await updater({
      sessionID,
      model: currentModel,
      messages: [{ id: "assistant-1", role: "assistant", content: [{ type: "text", text: "answer" }] }],
    } as never);

    expect(updateResult.status).toBe("committed");
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
      "stm_memory_logs",
      "stm_memory_settings",
      "stm_memory_setup",
      "short_term_memory",
    ]);
    expect(registrations.map(({ definition }) => definition.name)).toEqual(registrations.map(({ name }) => name));
    expect(registrations.map(({ definition }) => definition.options)).toEqual([
      { codemode: false },
      { codemode: false },
      { codemode: false },
      { codemode: false },
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
      "acquire:prompt",
      "acquire:read",
      "acquire:status",
      "dispose:read",
      "dispose:compaction",
      "dispose:context",
      "dispose:prompt",
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
      "acquire:prompt",
      "acquire:read",
      "dispose:compaction",
      "dispose:context",
      "dispose:prompt",
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
          const name = ["read", "status", "reset", "update", "logs", "settings", "setup", "compatibility"][
            toolNumber - 1
          ]!;
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
      "acquire:prompt",
      "acquire:read",
      "acquire:status",
      "acquire:reset",
      "acquire:update",
      "acquire:logs",
      "acquire:settings",
      "acquire:setup",
      "acquire:compatibility",
      "dispose:prompt",
      "dispose:compatibility",
      "dispose:setup",
      "dispose:settings",
      "dispose:logs",
      "dispose:update",
      "dispose:reset",
      "dispose:status",
      "dispose:read",
      "dispose:compaction",
      "dispose:context",
    ]);
  });
});
