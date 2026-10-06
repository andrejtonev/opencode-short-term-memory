import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Explicit invocation only: bun test/production-host-load-matrix.ts /absolute/path/package.tgz
const RUNTIME = realpathSync(process.execPath);
const CHECKOUT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const MARKERS = ["server.marker", "setup.marker", "cleanup.marker"] as const;
const HOSTS = [
  { generation: "V1", packageName: "opencode-ai", version: "1.14.25" },
  { generation: "V2", packageName: "@opencode/cli", version: "2.0.8" },
  { generation: "V2", packageName: "@opencode/cli", version: "2.0.12" },
] as const;
const started = Date.now();
const deadline = started + 240_000;
const CLEANUP_RESERVE = 20_000;
const parent = process.env.STM_HOST_MATRIX_SANDBOX_PARENT ?? "/tmp/opencode";
if (process.env.STM_HOST_MATRIX_SANDBOX_PARENT !== undefined) {
  assert.ok(isAbsolute(parent), "STM_HOST_MATRIX_SANDBOX_PARENT must be an absolute path");
  assert.ok(statSync(parent).isDirectory(), "STM_HOST_MATRIX_SANDBOX_PARENT must be an existing directory");
} else {
  mkdirSync(parent, { recursive: true });
}
const sandbox = mkdtempSync(join(parent, "stm-production-host-load-"));

type Manifest = {
  name: string;
  version: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
};
type HostEvidence = {
  generation: string;
  packageName: string;
  version: string;
  root: string;
  verdict: "PASS" | "FAIL" | "NOT_RUN";
  commands: object[];
  errors: string[];
  lifecycle: Record<string, string[]>;
  cleanup: { status: string; error?: string };
  environment?: Record<string, string>;
  initialDirectories?: { path: string; entries: string[] }[];
  consumerManifest?: object;
  installed?: object;
  binary?: object;
};
const hosts: HostEvidence[] = HOSTS.map((host) => ({
  ...host,
  root: join(sandbox, `${host.generation.toLowerCase()}-${host.version}`),
  verdict: "NOT_RUN",
  commands: [],
  errors: [],
  lifecycle: {},
  cleanup: { status: "not needed; host not started" },
}));
const failures: string[] = [];
const commands: object[] = [];
const evidence: Record<string, unknown> = {
  runID: sandbox.slice(sandbox.lastIndexOf("/") + 1),
  started: new Date(started).toISOString(),
  sandboxParent: parent,
  sandbox,
  checkout: CHECKOUT,
  runtime: { executable: RUNTIME, version: Bun.version },
  deadlineMs: 240_000,
  cleanupReserveMs: CLEANUP_RESERVE,
  verdict: "FAIL",
  retained: true,
  scope:
    "Config-based host loading through transparent lifecycle wrappers importing the same installed tarball root export. V1 wrapper is callable and forwards server; V2 forwards setup and cleanup. Not plugin-add bootstrap, unwrapped root compatibility, native TUI, inference, or memory hook behavior.",
  processContainment:
    "Commands use bounded spawnSync with SIGKILL and bounded captured output; descendant containment is not guaranteed. V2 service stop is attempted after lifecycle command failures within the overall deadline.",
  outputPolicy:
    "Command output is collected with a 2 MiB limit, but only byte counts and original --version output are retained; other raw host output may contain endpoint authentication. Errors contain harness diagnostics only.",
  limitations:
    "V1 may directly execute the installed native sibling preferred by its declared Node launcher; this bypasses Node and does not prove launcher bootstrap. Installation timeouts remain infrastructure failures, not qualification; no retries or extended limits are used.",
  paidInference: false,
  costConsumed: 0,
  globalBudgetChanged: false,
  budgetChanges: 0,
  hosts,
  commands,
  failures,
};

function inside(root: string, path: string) {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  records: object[],
  cleanup = false,
) {
  const remaining = deadline - Date.now() - (cleanup ? 0 : CLEANUP_RESERVE);
  const record = {
    command,
    args,
    cwd,
    started: new Date().toISOString(),
    timeoutMs: Math.max(0, Math.min(cleanup ? 10_000 : 60_000, remaining)),
    status: null as number | null,
    signal: null as string | null,
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null as string | null,
  };
  records.push(record);
  try {
    assert.ok(remaining > 0, "Overall deadline reached (including cleanup reserve)");
    console.log(`$ ${[command, ...args].map((arg) => JSON.stringify(arg)).join(" ")}`);
    const result = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: record.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
    });
    record.status = result.status;
    record.signal = result.signal;
    record.stdoutBytes = Buffer.byteLength(result.stdout ?? "");
    record.stderrBytes = Buffer.byteLength(result.stderr ?? "");
    assert.ok(
      !result.error,
      `Command failed: ${(result.error as NodeJS.ErrnoException | undefined)?.code ?? "spawn error"}`,
    );
    assert.equal(result.status, 0, `Command exited with status ${result.status}, signal ${result.signal}`);
    assert.ok(Date.now() < deadline, "Overall deadline exceeded");
    return result.stdout;
  } catch (error) {
    record.error = String(error);
    throw error;
  }
}

function isolatedEnvironment(root: string, record?: HostEvidence) {
  const env = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(root, "bun-install-cache"),
    PATH: `${dirname(RUNTIME)}:/usr/bin:/bin`,
    NO_COLOR: "1",
  };
  const initialDirectories = [];
  for (const path of new Set(Object.values(env).filter((value) => inside(root, value)))) {
    mkdirSync(path, { recursive: true });
    const entries = readdirSync(path);
    initialDirectories.push({ path, entries });
    assert.equal(entries.length, 0, `Initial environment directory is not empty: ${path}`);
  }
  if (record) {
    record.environment = env;
    record.initialDirectories = initialDirectories;
  }
  return env;
}

function installHost(record: HostEvidence, tarball: string, artifact: Manifest, env: Record<string, string>) {
  const consumer = join(record.root, "consumer");
  mkdirSync(consumer);
  const consumerManifest = {
    private: true,
    type: "module",
    trustedDependencies: [record.packageName],
    dependencies: { [artifact.name]: `file:${tarball}`, [record.packageName]: record.version },
  };
  record.consumerManifest = consumerManifest;
  writeFileSync(join(consumer, "package.json"), JSON.stringify(consumerManifest, null, 2) + "\n");
  run(RUNTIME, ["install", "--production", "--exact"], consumer, env, record.commands);
  function physical(path: string) {
    const resolved = realpathSync(path);
    assert.ok(inside(consumer, resolved) && !inside(CHECKOUT, resolved), `Installed path escapes consumer: ${path}`);
    return resolved;
  }
  const packageRoot = physical(join(consumer, "node_modules", artifact.name));
  const installed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;
  assert.equal(installed.name, artifact.name);
  assert.equal(installed.version, artifact.version);
  const resolvedEntry = Bun.resolveSync(artifact.name, consumer);
  const entrypoint = physical(resolvedEntry);
  assert.ok(inside(packageRoot, entrypoint), "Exported root entry escapes installed package");
  assert.ok(lstatSync(entrypoint).isFile(), "Exported root entry is not a regular file");
  const dependencies: { name: string; resolved: string; physical: string }[] = [];
  record.installed = {
    name: installed.name,
    version: installed.version,
    packageRoot,
    resolvedEntry,
    entrypoint,
    dependencies,
  };
  for (const name of Object.keys(installed.dependencies ?? {})) {
    if (name.startsWith("@types/")) continue;
    const resolved = Bun.resolveSync(name, packageRoot);
    dependencies.push({ name, resolved, physical: physical(resolved) });
  }
  const hostRoot = physical(join(consumer, "node_modules", record.packageName));
  const hostManifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8")) as Manifest;
  assert.equal(hostManifest.name, record.packageName);
  assert.equal(hostManifest.version, record.version);
  const bin = typeof hostManifest.bin === "string" ? hostManifest.bin : hostManifest.bin?.opencode;
  assert.equal(typeof bin, "string", "Host manifest does not declare an opencode binary");
  const declaredPath = join(hostRoot, bin!);
  const declaredExecutable = physical(declaredPath);
  let binary = declaredExecutable;
  let selection = "manifest-declared executable";
  if (record.generation === "V1") {
    const launcher = readFileSync(declaredExecutable, "utf8");
    const cached = join(dirname(declaredExecutable), ".opencode");
    const cachedPreference = `const scriptPath = fs.realpathSync(__filename)
const scriptDir = path.dirname(scriptPath)

//
const cached = path.join(scriptDir, ".opencode")
if (fs.existsSync(cached)) {
  run(cached)
}`;
    if (launcher.startsWith("#!/usr/bin/env node\n") && launcher.includes(cachedPreference) && existsSync(cached)) {
      binary = physical(cached);
      selection =
        "installed launcher explicitly prefers physical sibling .opencode; bypasses Node launcher, not launcher bootstrap qualification";
    }
  }
  assert.ok(lstatSync(binary).isFile(), "Installed host binary is not a regular file");
  const binaryEvidence = {
    hostRoot,
    name: hostManifest.name,
    version: hostManifest.version,
    binKey: "opencode",
    declaredPath,
    declaredExecutable,
    binary,
    selection,
    originalVersionOutput: "",
    reportedVersion: null as string | null,
  };
  record.binary = binaryEvidence;
  const output = run(binary, ["--version"], consumer, env, record.commands);
  binaryEvidence.originalVersionOutput = output;
  const match = /^(?:opencode v)?(\d+\.\d+\.\d+)$/.exec(output.trim());
  assert.ok(match, "Host binary version output is not bare semver or opencode v<semver>");
  const reportedVersion = match[1]!;
  binaryEvidence.reportedVersion = reportedVersion;
  assert.equal(reportedVersion, record.version, "Host binary reported a different version");
  return { binary, entrypoint };
}

function createWrapper(root: string, markers: string, entrypoint: string, generation: string) {
  const plugin = join(root, "plugin");
  const wrapper = join(plugin, "index.js");
  mkdirSync(plugin);
  writeFileSync(
    join(plugin, "package.json"),
    JSON.stringify({ private: true, type: "module", main: "./index.js" }) + "\n",
  );
  writeFileSync(
    wrapper,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import productionDefault from ${JSON.stringify(pathToFileURL(entrypoint).href)};
const markers = ${JSON.stringify(markers)};
const mark = (name) => writeFileSync(join(markers, name), name + "\\n");
async function server(...args) {
  const result = await productionDefault.server.apply(productionDefault, args);
  mark("server.marker");
  return result;
}
${
  generation === "V1"
    ? "export default server;"
    : `export default {
  id: productionDefault.id,
  server,
  async setup(...args) {
    const cleanup = await productionDefault.setup.apply(productionDefault, args);
    if (typeof cleanup !== "function") throw new TypeError("production setup did not return cleanup");
    mark("setup.marker");
    return async (...cleanupArgs) => {
      await cleanup(...cleanupArgs);
      mark("cleanup.marker");
    };
  },
};`
}
`,
  );
  return { directory: plugin, entrypoint: wrapper };
}

function observed(markers: string) {
  return MARKERS.filter((marker) => existsSync(join(markers, marker)));
}

function assertMarkers(record: HostEvidence, markers: string, expected: readonly string[], phase: string) {
  const actual = observed(markers);
  record.lifecycle[phase] = actual;
  assert.deepEqual(actual, expected, `${record.generation} ${phase} lifecycle markers`);
}

function waitForMarker(markers: string, marker: (typeof MARKERS)[number], cleanup = false) {
  const until = Math.min(Date.now() + 5_000, deadline - (cleanup ? 0 : CLEANUP_RESERVE));
  const delay = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until) {
    if (existsSync(join(markers, marker))) return;
    Atomics.wait(delay, 0, 0, Math.min(100, until - Date.now()));
  }
  throw new Error(`Timed out waiting for ${marker}`);
}

function runHost(record: HostEvidence, tarball: string, artifact: Manifest) {
  record.verdict = "FAIL";
  mkdirSync(record.root);
  const env = isolatedEnvironment(record.root, record);
  const { binary, entrypoint } = installHost(record, tarball, artifact, env);
  const markers = join(record.root, "markers");
  const project = join(record.root, "project");
  mkdirSync(markers);
  mkdirSync(project);
  const plugin = createWrapper(record.root, markers, entrypoint, record.generation);
  const pluginReference = record.generation === "V1" ? pathToFileURL(plugin.entrypoint).href : plugin.directory;
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({ [record.generation === "V1" ? "plugin" : "plugins"]: [pluginReference] }) + "\n",
  );
  try {
    run(binary, ["debug", "config"], project, env, record.commands);
    if (record.generation === "V1") {
      assertMarkers(record, markers, ["server.marker"], "loaded");
    } else {
      run(binary, ["plugin", "list"], project, env, record.commands);
      waitForMarker(markers, "setup.marker");
      assertMarkers(record, markers, ["setup.marker"], "before shutdown");
    }
  } catch (error) {
    record.errors.push(String(error));
  } finally {
    if (record.generation === "V2") {
      record.cleanup.status = "attempted";
      try {
        run(binary, ["service", "stop"], project, env, record.commands, true);
        waitForMarker(markers, "cleanup.marker", true);
        assertMarkers(record, markers, ["setup.marker", "cleanup.marker"], "after shutdown");
        record.cleanup.status = "successful";
      } catch (error) {
        record.cleanup = { status: "failed", error: String(error) };
        record.errors.push(String(error));
      }
    }
    record.lifecycle.final = observed(markers);
  }
  assert.equal(record.errors.length, 0, `${record.generation} ${record.version} lifecycle or cleanup failed`);
  record.verdict = "PASS";
}

try {
  assert.equal(Bun.argv.length, 3, "Supply exactly one absolute .tgz path");
  const input = Bun.argv[2]!;
  assert.ok(isAbsolute(input) && input.endsWith(".tgz"), "Tarball must be an absolute .tgz path");
  assert.ok(lstatSync(input).isFile(), "Tarball must be an existing regular file, not a symlink");
  const source = realpathSync(input);
  const tarball = join(sandbox, "artifact.tgz");
  copyFileSync(source, tarball);
  const bytes = readFileSync(tarball);
  const sourceHash = new Bun.CryptoHasher("sha256").update(readFileSync(source)).digest("hex");
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  evidence.artifact = { input, source, retainedCopy: tarball, sha256, sourceHash, bytes: bytes.length };
  assert.equal(sha256, sourceHash, "Tarball changed while copying");
  const env = isolatedEnvironment(join(sandbox, "metadata"));
  const manifest = JSON.parse(
    run("/usr/bin/tar", ["-xOf", tarball, "package/package.json"], sandbox, env, commands),
  ) as Manifest;
  evidence.tarballManifest = manifest;
  assert.equal(manifest.name, "@atonev/opencode-short-term-memory");
  assert.ok(typeof manifest.version === "string" && manifest.version.length > 0, "Tarball version is missing");
  for (const host of hosts) {
    try {
      runHost(host, tarball, manifest);
    } catch (error) {
      host.errors.push(String(error));
      failures.push(`${host.generation} ${host.version}: ${String(error)}`);
    }
  }
  assert.ok(Date.now() < deadline, "Overall deadline exceeded");
  assert.ok(
    hosts.every((host) => host.verdict === "PASS"),
    "One or more host gates failed",
  );
  evidence.verdict = "PASS";
} catch (error) {
  failures.push(String(error));
} finally {
  evidence.finished = new Date().toISOString();
  evidence.elapsedMs = Date.now() - started;
  writeFileSync(join(sandbox, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`VERDICT: ${evidence.verdict}; retained evidence: ${join(sandbox, "evidence.json")}`);
  process.exitCode = evidence.verdict === "PASS" ? 0 : 1;
}
