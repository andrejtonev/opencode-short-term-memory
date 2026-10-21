import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

assert.equal(process.platform, "win32");
assert.ok(process.argv[2], "Usage: bun scripts/windows-plugin-cli-probe.ts HOST_ROOT");
const native = join(resolve(process.argv[2]), "node_modules/@opencode/cli-windows-x64/bin/opencode.exe");
const root = await mkdtemp(join(tmpdir(), "stm-windows-plugin-cli-"));
const source = resolve(import.meta.dir, "..");
const results: any[] = [];
console.log(JSON.stringify({ root }));
for (const [id, args, expectedSuccess, expectedError] of [
  ["source-directory", ["plugin", "add", source], false, /must be an npm registry package or Git package specifier/],
  [
    "source-file",
    ["plugin", "add", join(source, "src/index.ts")],
    false,
    /must be an npm registry package or Git package specifier/,
  ],
  ["legacy-global-flag", ["plugin", "add", "--global", source], false, /Unrecognized flag: --global/],
] as const) {
  const caseRoot = join(root, id);
  const project = join(caseRoot, "project");
  await mkdir(project, { recursive: true });
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[key]) env[key] = process.env[key]!;
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "OPENCODE_CONFIG_DIR",
    "TEMP",
    "TMP",
    "BUN_INSTALL_CACHE_DIR",
  ]) {
    env[key] = join(caseRoot, key.toLowerCase());
    await mkdir(env[key], { recursive: true });
  }
  Object.assign(env, {
    OPENCODE_TEST_HOME: env.USERPROFILE,
    OPENCODE_DB: join(caseRoot, "host.db"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  });
  const record: any = { id, args, caseRoot, expectedSuccess, verdict: "FAIL" };
  let stdout = "",
    stderr = "",
    timedOut = false;
  const child = spawn(native, [...args], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 45000);
  try {
    record.exitCode = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    assert.equal(timedOut, false, "CLI deadline");
    assert.equal(record.exitCode === 0, expectedSuccess, "CLI exit status");
    assert.match(stderr, expectedError, "Rejection must identify the unsupported route");
    const configPaths = [
      join(env.OPENCODE_CONFIG_DIR, "opencode.json"),
      join(env.OPENCODE_CONFIG_DIR, "cli.json"),
      join(env.XDG_CONFIG_HOME, "opencode/opencode.json"),
      join(env.XDG_CONFIG_HOME, "opencode/cli.json"),
      join(project, "opencode.json"),
    ];
    record.configs = [];
    for (const path of configPaths) {
      const contents = await readFile(path, "utf8").catch(() => undefined);
      if (contents !== undefined) record.configs.push({ path, contents });
    }
    if (expectedSuccess)
      assert.ok(
        record.configs.some(
          (config: any) =>
            config.contents.includes(source.replaceAll("\\", "\\\\")) ||
            config.contents.includes(source.replaceAll("\\", "/")),
        ),
        "CLI persists configured directory",
      );
    else assert.equal(record.configs.length, 0, "Rejected CLI route must not write configuration");
    record.verdict = "PASS";
  } catch (error) {
    record.error = String(error);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    record.hostExited = child.exitCode !== null || child.signalCode !== null;
    record.timedOut = timedOut;
    await writeFile(join(caseRoot, "stdout.log"), stdout);
    await writeFile(join(caseRoot, "stderr.log"), stderr);
    results.push(record);
    await writeFile(join(root, "result.json"), JSON.stringify({ root, paidInference: false, results }, null, 2));
    console.log(JSON.stringify(record));
  }
}
if (results.some((row) => row.verdict !== "PASS")) process.exitCode = 1;
