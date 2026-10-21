import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { reloadConfig, type ConfigContext } from "../src/config";
import { DEFAULT_CONFIG, readConfig, type SessionMemoryConfig } from "../src/memory-utils";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUN_PATH = process.execPath;
const CHILD_SCRIPT = `
  const payload = JSON.parse(process.argv.at(-1));
  const { pathToFileURL } = await import("node:url");
  const { readConfig } = await import(pathToFileURL(payload.repoRoot + "/src/memory-utils.ts").href);
  const actualConfig = await readConfig(undefined, payload.launchDirectory);
  process.stdout.write(JSON.stringify({
    actualConfig,
    homedir: (await import("node:os")).homedir(),
  }));
`;

const numericCases = [
  ["sideSessionRetries", 0, 10],
  ["remindEveryN", 1, 1000],
  ["maxMemoryLength", 200, 50000],
  ["maxUpdateInputLength", 500, 200000],
  ["debounceMs", 100, 120000],
  ["logMaxLines", 20, 20000],
  ["maxDeltaMessages", 20, 10000],
] as const satisfies readonly (readonly [keyof SessionMemoryConfig, number, number])[];

const booleanKeys = [
  "enabled",
  "cleanFallbackToActiveSession",
  "includeAgentsMdOnFirstUpdate",
  "injectInSubagents",
  "enableLegacyPeriodicSystemTransform",
  "debug",
  "collapseAssistantBursts",
] as const satisfies readonly (keyof SessionMemoryConfig)[];

describe("RC public settings matrix", () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stm-rc-settings-"));
    process.env.HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    process.env.OPENCODE_CONFIG_DIR = join(root, "env-config");
    await mkdir(join(root, "project"), { recursive: true });
    process.chdir(join(root, "project"));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    await rm(root, { recursive: true, force: true });
  });

  async function configFile(name = "config.json") {
    const path = join(root, name);
    assertOwnedPath(path);
    await writeFile(path, "{}", "utf8");
    return path;
  }

  async function writeJson(path: string, value: unknown) {
    assertOwnedPath(path);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value), "utf8");
  }

  function assertOwnedPath(path: string) {
    const rel = relative(root, path);
    expect(isAbsolute(path)).toBe(true);
    expect(rel.startsWith("..") || isAbsolute(rel)).toBe(false);
  }

  async function readConfigInFreshChild(expectedHome: string) {
    const launchDirectory = join(root, "project");
    const payload = JSON.stringify({ repoRoot: REPO_ROOT, launchDirectory });
    const child = Bun.spawn([BUN_PATH, "-e", CHILD_SCRIPT, "--", payload], {
      cwd: launchDirectory,
      env: {
        ...process.env,
        HOME: expectedHome,
        USERPROFILE: expectedHome,
        XDG_CONFIG_HOME: join(root, "xdg"),
        OPENCODE_CONFIG_DIR: join(root, "env-config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let settled = false;
    try {
      const result = await Promise.race([
        (async () => ({
          exitCode: await child.exited,
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
        }))(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("config observer timed out after 2s")), 2000),
        ),
      ]);
      settled = true;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout, result.stderr).not.toBe("");
      return JSON.parse(result.stdout) as {
        actualConfig: SessionMemoryConfig;
        homedir: string;
      };
    } finally {
      if (!settled) child.kill();
      await child.exited;
    }
  }

  test("normalizes every numeric public key at boundaries and malformed values", async () => {
    for (const [key, min, max] of numericCases) {
      const path = await configFile(`${key}.json`);
      const values: Array<[string, unknown, number]> = [
        ["below-min", min - 1, min],
        ["min", min, min],
        ["max", max, max],
        ["above-max", max + 1, max],
        ["fractional", min + 0.75, min],
        ["numeric-string", ` ${min + 1} `, min + 1],
        ["blank", "", min],
        ["space", "   ", min],
        ["invalid-string", "not-a-number", DEFAULT_CONFIG[key] as number],
        ["positive-infinity", "Infinity", DEFAULT_CONFIG[key] as number],
        ["not-a-number", "NaN", DEFAULT_CONFIG[key] as number],
        ["nonfinite", null, DEFAULT_CONFIG[key] as number],
      ];
      for (const [label, value, expected] of values) {
        await writeJson(path, { [key]: value });
        expect((await readConfig(path))[key], `${key}:${label}`).toBe(expected);
      }
    }
  });

  test("normalizes booleans independently to native values and field defaults", async () => {
    for (const key of booleanKeys) {
      const path = await configFile(`${key}.json`);
      const fallback = DEFAULT_CONFIG[key] as boolean;
      for (const [value, expected] of [
        [true, true],
        [false, false],
        [" TRUE ", true],
        ["false", false],
        ["invalid", fallback],
        [null, fallback],
      ] as const) {
        await writeJson(path, { [key]: value });
        expect((await readConfig(path))[key], `${key}:${String(value)}`).toBe(expected);
      }
    }
  });

  test("normalizes strings and summarizer modes without leaking unknown settings", async () => {
    const path = await configFile("strings.json");
    for (const [key, fallback] of [
      ["memoryModel", DEFAULT_CONFIG.memoryModel],
      ["memoryDir", DEFAULT_CONFIG.memoryDir],
    ] as const) {
      for (const value of [" provider/model ", "", "   ", 42, null]) {
        await writeJson(path, { [key]: value });
        expect((await readConfig(path))[key], `${key}:${String(value)}`).toBe(
          typeof value === "string" && value.trim() ? value.trim() : fallback,
        );
      }
    }
    for (const [value, expected] of [
      ["ACTIVE", "active"],
      [" active ", "clean"],
      ["clean", "clean"],
      ["typo", "clean"],
      [123, "clean"],
    ] as const) {
      await writeJson(path, { summarizerMode: value });
      expect((await readConfig(path)).summarizerMode, String(value)).toBe(expected);
    }
    await writeJson(path, { unknownKey: true });
    expect(Object.keys(await readConfig(path)).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
  });

  test("applies XDG, HOME, environment, and project precedence with file removal", async () => {
    const xdg = join(process.env.XDG_CONFIG_HOME!, "opencode", "stm.jsonc");
    const privateHome = join(root, "home");
    const home = join(privateHome, ".opencode", "stm.json");
    const env = join(process.env.OPENCODE_CONFIG_DIR!, "stm.json");
    const project = join(root, "project", ".opencode", "stm.json");
    for (const path of [xdg, home, env, project]) assertOwnedPath(path);
    await writeJson(xdg, { debug: false, maxMemoryLength: 201 });
    await writeJson(home, { debug: true, maxMemoryLength: 202 });
    await writeJson(env, { maxMemoryLength: 203 });
    await writeJson(project, { maxMemoryLength: 204 });
    expect((await readConfigInFreshChild(privateHome)).homedir).toBe(privateHome);
    expect((await readConfigInFreshChild(privateHome)).actualConfig.maxMemoryLength).toBe(204);
    await rm(project);
    expect((await readConfigInFreshChild(privateHome)).actualConfig.maxMemoryLength).toBe(203);
    await rm(env);
    expect((await readConfigInFreshChild(privateHome)).actualConfig.maxMemoryLength).toBe(202);
    await rm(home);
    expect((await readConfigInFreshChild(privateHome)).actualConfig.maxMemoryLength).toBe(201);
  });

  test("handles JSONC, JSON shadowing, nearest empty project, invalid overrides, and explicit paths", async () => {
    const projectDir = join(root, "project");
    const projectConfig = join(projectDir, ".opencode");
    const ancestorConfig = join(root, ".opencode");
    await writeJson(join(root, "xdg", "opencode", "stm.json"), { debug: true });
    const malformedPath = join(root, "xdg", "opencode", "stm.jsonc");
    const malformedBytes = '{ "debug": false,';
    assertOwnedPath(malformedPath);
    await writeFile(malformedPath, malformedBytes, "utf8");
    expect((await readConfig(undefined, projectDir)).debug).toBe(true);
    expect(await Bun.file(malformedPath).text()).toBe(malformedBytes);
    await mkdir(projectConfig, { recursive: true });
    const validJsoncPath = join(projectConfig, "stm.jsonc");
    assertOwnedPath(validJsoncPath);
    await writeFile(validJsoncPath, '{ // jsonc\n "debug": true,\n}', "utf8");
    expect((await readConfig(undefined, projectDir)).debug).toBe(true);
    await rm(projectConfig, { recursive: true, force: true });
    await rm(join(root, "xdg", "opencode"), { recursive: true, force: true });
    await writeJson(ancestorConfig + "/stm.json", { maxDeltaMessages: 9999 });
    await mkdir(projectConfig, { recursive: true });
    expect((await readConfig(undefined, projectDir)).maxDeltaMessages).toBe(DEFAULT_CONFIG.maxDeltaMessages);
    await rm(projectConfig, { recursive: true, force: true });
    await mkdir(projectConfig, { recursive: true });
    await writeJson(join(projectConfig, "stm.json"), { debug: "invalid" });
    expect((await readConfig(undefined, projectDir)).debug).toBe(DEFAULT_CONFIG.debug);
    const explicit = await configFile("explicit.json");
    await writeJson(explicit, { debug: true });
    expect((await readConfig(explicit, projectDir)).maxMemoryLength).toBe(DEFAULT_CONFIG.maxMemoryLength);
    expect((await readConfig(explicit, projectDir)).debug).toBe(true);
  });

  test("reloadConfig uses the exact 60-second cache boundary and force bypass", async () => {
    const path = join(root, "project", ".opencode", "stm.json");
    await writeJson(path, { debounceMs: 100 });
    const context: ConfigContext = {
      config: DEFAULT_CONFIG,
      cache: null,
      lastWarning: "",
      globalState: { updateCount: 0, injectCount: 0, injectCharCount: 0, compactCount: 0 },
      baseDir: join(root, "project"),
    };
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      expect((await reloadConfig(context)).debounceMs).toBe(100);
      await writeJson(path, { debounceMs: 200 });
      now = 59_999;
      expect((await reloadConfig(context)).debounceMs).toBe(100);
      now = 60_000;
      expect((await reloadConfig(context)).debounceMs).toBe(200);
      await writeJson(path, { debounceMs: 300 });
      expect((await reloadConfig(context, true)).debounceMs).toBe(300);
    } finally {
      Date.now = originalNow;
    }
  });
});
