import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";
import {
  DEFAULT_CONFIG,
  INJECTION_PREFIX,
  MEMORY_HEADER,
  appendText,
  clampText,
  compareAndReplaceTextAtomic,
  createProjectExampleConfig,
  ensureMemoryFile,
  getMessageText,
  getMessageTextFromParts,
  getSessionID,
  isSelfInjection,
  logEvent,
  memoryPathFor,
  parseModel,
  prepareRawFile,
  readConfig,
  readText,
  safeSessionID,
  sanitizeMessage,
  tailLog,
  trimLog,
  writeText,
  writeTextAtomic,
  resolveGlobalOpencodeDir,
} from "../src/memory-utils";

async function runGit(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function temporaryEntries(directory: string) {
  return (await readdir(directory)).filter((entry) => entry !== ".gitignore");
}

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

  test("readConfig preserves empty model inheritance and explicit model overrides", async () => {
    await writeText(join(".opencode", "stm.jsonc"), JSON.stringify({ memoryModel: "   " }));
    expect((await readConfig()).memoryModel).toBe("");

    await writeText(join(".opencode", "stm.jsonc"), JSON.stringify({ memoryModel: "openai/gpt-5.3" }));
    expect((await readConfig()).memoryModel).toBe("openai/gpt-5.3");
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

  test("logEvent serializes concurrent appends and retains newest entries", async () => {
    const config = { ...DEFAULT_CONFIG, logMaxLines: 3 };
    await Promise.all(
      ["one", "two", "three", "four", "five"].map((value) => logEvent(config, "concurrent", { value })),
    );

    const contents = await readText(join(config.memoryDir, "session-memory.log"), "");
    const entries = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { value: string });
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.value))).toEqual(new Set(["three", "four", "five"]));
    expect(await tailLog(3, config.memoryDir)).toBe(contents.trim());
  });

  test("logEvent treats an unusable memory directory as nonfatal", async () => {
    const memoryDir = join(testDir, "not-a-directory");
    await writeFile(memoryDir, "file");

    await expect(logEvent({ ...DEFAULT_CONFIG, memoryDir }, "io_failure")).resolves.toBeUndefined();
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

  test("atomic temporary files cannot enter an exact Git snapshot", async () => {
    expect((await runGit(testDir, ["init", "--quiet"])).exitCode).toBe(0);
    expect((await runGit(testDir, ["config", "core.autocrlf", "false"])).exitCode).toBe(0);
    const memoryDir = join(testDir, ".opencode", "memory");
    const persistedPath = join(memoryDir, "session.md");
    await writeText(persistedPath, "persisted\n");

    const prepared = await prepareRawFile(join(memoryDir, "pending.md"), Buffer.from("pending\n"));
    const temporaryDirectory = join(memoryDir, ".stm-tmp");
    const [temporaryName] = await temporaryEntries(temporaryDirectory);
    const temporaryPath = join(temporaryDirectory, temporaryName);
    const ignored = await runGit(testDir, ["check-ignore", "--no-index", "--", relative(testDir, temporaryPath)]);
    const persisted = await runGit(testDir, ["check-ignore", "--no-index", "--", relative(testDir, persistedPath)]);
    expect(ignored.exitCode).toBe(0);
    expect(persisted.exitCode).not.toBe(0);

    const listed = await runGit(testDir, ["ls-files", "--others", "--exclude-standard", "-z"]);
    expect(listed.exitCode).toBe(0);
    const candidates = listed.stdout.split("\0").filter(Boolean);
    expect(candidates.some((candidate) => candidate.endsWith("session.md"))).toBe(true);
    expect(candidates.some((candidate) => candidate.includes(".stm-tmp") && !candidate.endsWith(".gitignore"))).toBe(
      false,
    );

    await prepared.discard();
    const staged = await runGit(testDir, ["add", "--", ...candidates]);
    expect(staged.exitCode).toBe(0);
    expect(staged.stderr).toBe("");
    expect((await runGit(testDir, ["diff", "--cached", "--name-only"])).stdout).toContain(
      ".opencode/memory/session.md",
    );
  });

  test("successful atomic writes leave no transient files beyond metadata", async () => {
    const target = join(testDir, ".opencode", "memory", "session.md");

    await writeTextAtomic(target, "persisted\n");

    expect(await readFile(target, "utf8")).toBe("persisted\n");
    expect(await temporaryEntries(join(testDir, ".opencode", "memory", ".stm-tmp"))).toEqual([]);
  });

  test("discard removes its prepared file but preserves unrelated ignored files", async () => {
    const target = join(testDir, ".opencode", "memory", "session.md");
    const prepared = await prepareRawFile(target, Buffer.from("pending\n"));
    const temporaryDirectory = join(testDir, ".opencode", "memory", ".stm-tmp");
    const beforeDiscard = await temporaryEntries(temporaryDirectory);
    const sentinel = "unrelated-sentinel.tmp";
    await writeFile(join(temporaryDirectory, sentinel), "preserve me\n");

    await prepared.discard();

    expect(await temporaryEntries(temporaryDirectory)).toEqual([sentinel]);
    expect(await readFile(join(temporaryDirectory, sentinel), "utf8")).toBe("preserve me\n");
    expect(beforeDiscard).toHaveLength(1);
  });

  test("rejects conflicting metadata and symlink temporary directories safely", async () => {
    const memoryDir = join(testDir, ".opencode", "memory");
    const temporaryDirectory = join(memoryDir, ".stm-tmp");
    const ignorePath = join(temporaryDirectory, ".gitignore");
    await writeText(ignorePath, "user-owned rules\n");
    await expect(writeTextAtomic(join(memoryDir, "conflict.md"), "no write\n")).rejects.toThrow(
      "conflicting atomic temporary ignore file",
    );
    expect(await readFile(ignorePath, "utf8")).toBe("user-owned rules\n");

    await rm(temporaryDirectory, { recursive: true, force: true });
    const outsideDirectory = join(testDir, "outside");
    await writeText(join(outsideDirectory, "sentinel.txt"), "outside\n");
    await symlink(outsideDirectory, temporaryDirectory, process.platform === "win32" ? "junction" : "dir");
    await expect(writeTextAtomic(join(memoryDir, "symlink.md"), "no outside write\n")).rejects.toThrow(
      "unsafe atomic temporary directory",
    );
    expect(await readdir(outsideDirectory)).toEqual(["sentinel.txt"]);
  });

  test("compareAndReplaceTextAtomic compares and replaces under one path lock", async () => {
    const target = join(DEFAULT_CONFIG.memoryDir, "compare-replace.md");
    await writeText(target, "before");
    expect(await compareAndReplaceTextAtomic(target, "wrong", "next")).toBe(false);
    expect(await readText(target, "")).toBe("before");
    expect(await compareAndReplaceTextAtomic(target, "before", "next")).toBe(true);
    expect(await readText(target, "")).toBe("next");
  });

  test("createProjectExampleConfig creates only a project-local stm.jsonc example", async () => {
    const projectDir = join(testDir, "new-project");
    const result = await createProjectExampleConfig(projectDir);

    expect(result.created).toBe(true);
    expect(result.configPath).toBe(join(projectDir, ".opencode", "stm.jsonc"));
    expect(result.message).toBe(`Created project example config at ${result.configPath}.`);
    const created = await readText(result.configPath, "");
    expect(created).toContain('"enabled": true');
    expect(created).toContain('"memoryModel": ""');
    expect(created).toContain('"summarizerMode": "clean"');
    expect(created).toContain('"remindEveryN": 4');
  });

  for (const existingName of ["stm.jsonc", "stm.json"] as const) {
    test(`createProjectExampleConfig refuses to overwrite existing ${existingName}`, async () => {
      const projectDir = join(testDir, `existing-${existingName}`);
      const opencodeDir = join(projectDir, ".opencode");
      const existingPath = join(opencodeDir, existingName);
      const existingContent = JSON.stringify({ debug: true }, null, 2);
      await writeText(existingPath, existingContent);

      const result = await createProjectExampleConfig(projectDir);

      expect(result.created).toBe(false);
      expect(result.message).toBe(`No example config created: ${existingName} already exists in ${opencodeDir}.`);
      expect(await readText(existingPath, "")).toBe(existingContent);
      if (existingName === "stm.json") {
        expect(await readText(join(opencodeDir, "stm.jsonc"), "missing")).toBe("missing");
      }
    });
  }

  test("resolveGlobalOpencodeDir returns XDG_CONFIG_HOME/opencode when set", () => {
    const dir = resolveGlobalOpencodeDir();
    expect(dir).toBe(join(xdgConfigHome, "opencode"));
  });

  test("resolveGlobalOpencodeDir falls back to ~/.config/opencode when XDG not set", () => {
    delete process.env.XDG_CONFIG_HOME;
    const dir = resolveGlobalOpencodeDir();
    expect(dir).toBe(join(homedir(), ".config", "opencode"));
  });
});
