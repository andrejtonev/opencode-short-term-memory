import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  INJECTION_PREFIX,
  MEMORY_HEADER,
  appendText,
  clampText,
  ensureMemoryFile,
  ensureDefaultConfigFile,
  getMessageText,
  getMessageTextFromParts,
  getSessionID,
  isSelfInjection,
  memoryPathFor,
  parseModel,
  readConfig,
  readText,
  safeSessionID,
  sanitizeMessage,
  tailLog,
  trimLog,
  writeText,
  writeTextAtomic,
} from "../src/memory-utils";

describe("memory-utils general behavior", () => {
  const originalCwd = process.cwd();
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  let testDir = "";
  let xdgConfigHome = "";
  let opencodeConfigDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-memory-utils-test-"));
    xdgConfigHome = join(testDir, ".xdg");
    opencodeConfigDir = join(testDir, ".config-dir");
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir;
    delete process.env.LOCALAPPDATA;
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test("safeSessionID and memoryPathFor sanitize file names", () => {
    expect(safeSessionID("a/b:c*?id")).toBe("a_b_c__id");
    expect(memoryPathFor("a/b:c*?id", DEFAULT_CONFIG.memoryDir)).toBe(
      join(DEFAULT_CONFIG.memoryDir, "session_a_b_c__id.md"),
    );
  });

  test("getSessionID resolves common shapes with ctx precedence", () => {
    expect(getSessionID({ event: { properties: { sessionId: "evt-id" } } })).toBe("evt-id");
    expect(getSessionID({ sessionID: "input-id" }, { sessionID: "ctx-id" })).toBe("ctx-id");
    expect(getSessionID({})).toBeUndefined();
  });

  test("getMessageTextFromParts filters think/tool/synthetic parts", () => {
    const parts = [
      { type: "thinking", text: "hidden" },
      { kind: "tool_result", text: "also hidden" },
      { type: "text", text: "kept one" },
      { type: "TEXT", content: "kept two" },
      { type: "text", text: "hidden synthetic", synthetic: true },
    ];

    expect(getMessageTextFromParts(parts)).toBe("kept one\nkept two");
  });

  test("sanitizeMessage and getMessageText remove thought content", () => {
    const raw = "before<think>private reasoning</think>after\n```thinking\nsecret\n```";
    expect(sanitizeMessage(raw)).toBe("beforeafter");

    const extracted = getMessageText({
      message: {
        parts: [
          { type: "text", text: "visible" },
          { type: "thinking", text: "hidden" },
        ],
      },
    });
    expect(extracted).toBe("visible");
  });

  test("clampText keeps full text below limit and tail above limit", () => {
    expect(clampText("abcdef", 10)).toBe("abcdef");
    expect(clampText("abcdef", 3)).toBe("def");
  });

  test("parseModel parses provider/model format", () => {
    expect(parseModel("openai/gpt-5.3")).toEqual({ providerID: "openai", modelID: "gpt-5.3" });
    expect(parseModel("invalid")).toBeUndefined();
    expect(parseModel("")).toBeUndefined();
  });

  test("ensureMemoryFile writes template once and preserves existing memory", async () => {
    const memoryPath = await ensureMemoryFile("session-1", DEFAULT_CONFIG);
    const created = await readText(memoryPath, "");
    expect(created).toContain(MEMORY_HEADER);
    expect(created).toContain("### User Instructions");

    await writeText(memoryPath, "custom memory\n");
    await ensureMemoryFile("session-1", DEFAULT_CONFIG);
    const preserved = await readText(memoryPath, "");
    expect(preserved).toBe("custom memory\n");
  });

  test("readConfig merges defaults and tolerates malformed JSON", async () => {
    await writeText(join(".opencode", "stm.json"), JSON.stringify({ debug: false, memoryModel: "x/y" }));
    const merged = await readConfig();
    expect(merged.debug).toBe(false);
    expect(merged.memoryModel).toBe("x/y");
    expect(merged.summarizerMode).toBe(DEFAULT_CONFIG.summarizerMode);

    await writeText(join(".opencode", "bad-config.json"), "{ bad");
    const fallback = await readConfig(join(".opencode", "bad-config.json"));
    expect(fallback).toEqual(DEFAULT_CONFIG);
  });

  test("readConfig normalizes string booleans and numeric fields", async () => {
    await writeText(
      join(".opencode", "stm.json"),
      JSON.stringify(
        {
          enabled: "false",
          debug: "true",
          debounceMs: "2500",
          maxMemoryLength: "3500",
          sideSessionRetries: "3",
          remindEveryN: "4",
          includeAgentsMdOnFirstUpdate: "true",
          summarizerMode: "ACTIVE",
          maxDeltaMessages: "500",
          memoryDir: "custom/mem",
        },
        null,
        2,
      ),
    );

    const config = await readConfig();
    expect(config.enabled).toBe(false);
    expect(config.debug).toBe(true);
    expect(config.debounceMs).toBe(2500);
    expect(config.maxMemoryLength).toBe(3500);
    expect(config.sideSessionRetries).toBe(3);
    expect(config.remindEveryN).toBe(4);
    expect(config.includeAgentsMdOnFirstUpdate).toBe(true);
    expect(config.summarizerMode).toBe("active");
    expect(config.maxDeltaMessages).toBe(500);
    expect(config.memoryDir).toBe("custom/mem");
  });

  test("readConfig parses jsonc comments and trailing commas", async () => {
    await writeText(
      join(".opencode", "stm.jsonc"),
      `{
        // comment line
        "debug": false,
        "summarizerMode": "active",
      }`,
    );

    const config = await readConfig();
    expect(config.debug).toBe(false);
    expect(config.summarizerMode).toBe("active");
  });

  test("readConfig merges global -> env -> project with project precedence", async () => {
    await writeText(
      join(xdgConfigHome, "opencode", "stm.jsonc"),
      `{
        // global layer
        "debug": false,
        "summarizerMode": "clean"
      }`,
    );
    await writeText(join(opencodeConfigDir, "stm.json"), JSON.stringify({ maxMemoryLength: 1400 }, null, 2));
    await writeText(join(".opencode", "stm.json"), JSON.stringify({ summarizerMode: "active" }, null, 2));

    const merged = await readConfig();
    expect(merged.debug).toBe(false);
    expect(merged.maxMemoryLength).toBe(1400);
    expect(merged.summarizerMode).toBe("active");
  });

  test("isSelfInjection detects memory-system content", () => {
    expect(isSelfInjection("prefix " + INJECTION_PREFIX)).toBe(true);
    expect(isSelfInjection("contains " + MEMORY_HEADER)).toBe(true);
    expect(isSelfInjection("Session Memory plugin says hi")).toBe(true);
    expect(isSelfInjection("normal user message")).toBe(false);
  });

  test("tailLog and trimLog keep only configured number of lines", async () => {
    const config = { ...DEFAULT_CONFIG, logMaxLines: 3 };
    await appendText(join(config.memoryDir, "session-memory.log"), "1\n2\n3\n4\n5\n");

    expect(await tailLog(2, config.memoryDir)).toBe("4\n5");
    await trimLog(config);
    const trimmed = await readText(join(config.memoryDir, "session-memory.log"), "");
    expect(trimmed).toBe("3\n4\n5\n");
  });

  test("writeTextAtomic avoids torn writes under concurrent updates", async () => {
    const target = join(DEFAULT_CONFIG.memoryDir, "race-test.md");
    const chunks = ["A".repeat(8000), "B".repeat(8000), "C".repeat(8000), "D".repeat(8000), "E".repeat(8000)];

    await Promise.all(chunks.map((text) => writeTextAtomic(target, text)));
    await Promise.all(chunks.map((text) => writeTextAtomic(target, `${text}\n`)));

    const final = await readText(target, "");
    const acceptable = new Set(chunks.map((text) => text).concat(chunks.map((text) => `${text}\n`)));
    expect(acceptable.has(final)).toBe(true);
  });

  test("ensureDefaultConfigFile creates stm.jsonc when no config exists", async () => {
    const opencodeDir = join(testDir, "new-project", ".opencode");
    await ensureDefaultConfigFile(opencodeDir);

    const created = await readText(join(opencodeDir, "stm.jsonc"), "");
    expect(created).toContain('"enabled": true');
    expect(created).toContain('"memoryModel":');
    expect(created).toContain('"summarizerMode": "clean"');
    expect(created).toContain('"remindEveryN": 4');
  });

  test("ensureDefaultConfigFile does nothing when config already exists", async () => {
    const opencodeDir = join(testDir, "existing-project", ".opencode");
    await writeText(join(opencodeDir, "stm.json"), JSON.stringify({ debug: true }, null, 2));

    await ensureDefaultConfigFile(opencodeDir);

    const existing = await readText(join(opencodeDir, "stm.json"), "");
    expect(JSON.parse(existing).debug).toBe(true);

    const jsonc = await readText(join(opencodeDir, "stm.jsonc"), "");
    expect(jsonc).toBe("");
  });
});
