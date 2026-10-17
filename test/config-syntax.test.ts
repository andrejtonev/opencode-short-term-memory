import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, readConfig } from "../src/memory-utils";

const BUN_PATH = "/home/dev/.bun/bin/bun";
const REPO_ROOT = resolve(import.meta.dir, "..");

describe("configuration syntax boundaries", () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stm-config-syntax-"));
    process.env.HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    delete process.env.OPENCODE_CONFIG_DIR;
    await writeFile(join(root, "cwd-marker"), "owned\n");
    process.chdir(root);
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

  async function assertMalformedCustomPath(source: string) {
    const path = join(root, "custom.jsonc");
    await writeFile(path, source, "utf8");
    const before = await readFile(path, "utf8");

    expect(await readConfig(path)).toEqual(DEFAULT_CONFIG);
    expect(await readFile(path, "utf8")).toBe(before);
  }

  for (const [name, source] of [
    ["malformed property", '{ "enabled": true, "broken" }'],
    ["missing closing brace", '{ "enabled": false'],
    ["missing value", '{ "enabled": }'],
    ["doubled comma", '{ "enabled": false,, "debug": true }'],
    ["unterminated string", '{ "memoryModel": "private/model }'],
    ["unterminated comment", '{ "enabled": false /* never closes }'],
    ["trailing garbage", '{ "enabled": false } garbage'],
    ["truncated object", '{ "enabled": false, "memoryModel": "private/model"'],
  ] as const) {
    test(`rejects ${name} without applying partial fields`, async () => {
      await assertMalformedCustomPath(source);
    });
  }

  test("accepts JSONC comments and trailing commas", async () => {
    const path = join(root, "valid.jsonc");
    const source = `{
      // source-contract comments
      "enabled": false,
      /* block comment */
      "memoryModel": "private/model",
      "debug": true,
    }`;
    await writeFile(path, source, "utf8");

    expect(await readConfig(path)).toEqual({
      ...DEFAULT_CONFIG,
      enabled: false,
      memoryModel: "private/model",
      debug: true,
    });
    expect(await readFile(path, "utf8")).toBe(source);
  });

  test("accepts an empty first JSONC object and duplicate keys use the last value", async () => {
    const candidateDirectory = join(root, "candidate-directory");
    await mkdir(candidateDirectory, { recursive: true });
    await writeFile(join(candidateDirectory, "stm.jsonc"), "{}", "utf8");
    await writeFile(join(candidateDirectory, "stm.json"), '{ "enabled": false }', "utf8");
    expect(await readConfig(undefined, candidateDirectory)).toEqual(DEFAULT_CONFIG);

    const duplicate = join(root, "duplicate.jsonc");
    await writeFile(duplicate, '{ "debug": false, "debug": true }', "utf8");
    expect((await readConfig(duplicate)).debug).toBe(true);
  });

  test("malformed project JSONC falls through to valid JSON without recovered fields", async () => {
    const project = join(root, "project");
    const xdgGlobal = join(root, "xdg", "opencode");
    await mkdir(join(project, ".opencode"), { recursive: true });
    await mkdir(xdgGlobal, { recursive: true });
    await writeFile(join(xdgGlobal, "stm.json"), '{ "enabled": false, "remindEveryN": 3, "debug": true }', "utf8");
    await writeFile(join(project, ".opencode", "stm.jsonc"), '{ "enabled": true, "remindEveryN": 9,', "utf8");
    await writeFile(join(project, ".opencode", "stm.json"), '{ "remindEveryN": 8 }', "utf8");

    const childEnv = { ...process.env, HOME: join(root, "private-home"), XDG_CONFIG_HOME: join(root, "xdg") };
    delete childEnv.OPENCODE_CONFIG_DIR;
    const script = `
      const payload = JSON.parse(process.argv.at(-1));
      const { pathToFileURL } = await import("node:url");
      const { readConfig } = await import(pathToFileURL(payload.repoRoot + "/src/memory-utils.ts").href);
      process.stdout.write(JSON.stringify(await readConfig(undefined, payload.project)));
    `;
    const observe = async () => {
      const child = Bun.spawn([BUN_PATH, "-e", script, "--", JSON.stringify({ repoRoot: REPO_ROOT, project })], {
        cwd: project,
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      return JSON.parse(stdout);
    };

    expect(await observe()).toEqual({ ...DEFAULT_CONFIG, enabled: false, remindEveryN: 8, debug: true });
    expect(await readFile(join(project, ".opencode", "stm.jsonc"), "utf8")).toBe(
      '{ "enabled": true, "remindEveryN": 9,',
    );

    await rm(join(project, ".opencode", "stm.json"));
    expect(await observe()).toEqual({ ...DEFAULT_CONFIG, enabled: false, remindEveryN: 3, debug: true });

    await rm(join(xdgGlobal, "stm.json"));
    expect(await observe()).toEqual(DEFAULT_CONFIG);
  });
});
