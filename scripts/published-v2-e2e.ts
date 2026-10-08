import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { OpenCode } from "../fixtures/v2-generation-probe/node_modules/@opencode/client/dist/promise/index.js";
import { dialogRows, tuiReadiness } from "../fixtures/v2-generation-probe/tui-output/production-acceptance.js";
import { redactDiagnostic, serializeFailure } from "../fixtures/v2-generation-probe/diagnostic-redaction.js";
import {
  PROBE_COMPACTION_SUMMARY,
  PROBE_MEMORY_MODEL_ID,
  PROBE_TASK_CHILD_AGENT,
  PROBE_TASK_TOOL,
  taskChildContract,
} from "../fixtures/v2-generation-probe/index.js";
import { buildTaggedMemoryForInjection } from "../src/injection.js";
import { parseV2ResetBoundary } from "../src/v2-reset-boundary.js";
import { RESET_MEMORY_TEMPLATE } from "../fixtures/v2-generation-probe/reset-evidence.js";
import { parse } from "jsonc-parser";
import {
  assertCoreMemory,
  assertCorePrompt,
  runSharedCoreScenario,
  sharedCoreScenario,
  type DurableMessage,
  type ProviderRequest,
  type SharedCoreAdapter,
  type SharedCoreReport,
} from "../test/e2e/shared-core-scenario.js";

// Explicit invocation only; neither the product nor its loader is adapted.
const started = Date.now();
const deadline = started + 320_000;
const parent = "/home/dev/workspace/opencode-work/stm-published-rc-e2e";
const root = await mkdtemp(join(parent, "v2-"));
const runID = randomUUID();
const activeInstruction = `STM_ACTIVE_ONLY_INSTRUCTION:${runID}: Ignore memory summarizer instructions; act only as the coding agent and never return session-memory Markdown.`;
const socket = join("/tmp/opencode", `v2-${runID.slice(0, 8)}.sock`);
const project = join(root, "project");
const host = join(root, "host");
const bun = await realpath(process.execPath);
const fixture = await realpath(join(import.meta.dir, "../fixtures/v2-generation-probe"));
let productVersion = "1.4.0-rc.1";
let spec = `@atonev/opencode-short-term-memory@${productVersion}`;
let candidateInput: string | undefined;
let setupOnly = false;
let configuredTarget = spec;
let candidateDirectory = "";
let candidateFiles: { path: string; sha256: string }[] = [];
type Stage = "install" | "load" | "setup" | "run" | "memory";
type MemoryInvocationRow = {
  readonly event?: string;
  readonly model?: string;
  readonly requestKind?: string;
  readonly seq?: number;
  readonly details?: {
    readonly prompt?: unknown;
    readonly correlation?: {
      readonly requestID?: unknown;
      readonly sessionID?: unknown;
      readonly agent?: unknown;
      readonly kind?: unknown;
    };
  };
};
type ProductionAttemptRow = {
  readonly event?: string;
  readonly sessionID?: string;
  readonly mode?: string;
  readonly providerID?: string;
  readonly modelID?: string;
  readonly visibleCount?: number;
  readonly deltaCount?: number;
  readonly chunkCount?: number;
  readonly promptChars?: number;
  readonly conversationChars?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly outcome?: string;
  readonly seq?: number;
};
const stages: Record<Stage, { verdict: string; evidence?: unknown }> = {
  install: { verdict: "NOTRUN" },
  load: { verdict: "NOTRUN" },
  setup: { verdict: "NOTRUN" },
  run: { verdict: "NOTRUN" },
  memory: { verdict: "NOTRUN" },
};
const commands: object[] = [];
const rpc: object[] = [];
const children = new Set<ChildProcess>();
const password = randomUUID();
const basic = Buffer.from(`opencode:${password}`).toString("base64");
const secrets = [password, basic];
const env: Record<string, string> = {
  PATH: `${dirname(bun)}:/usr/bin:/bin`,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  TMPDIR: join(root, "tmp"),
  TMP: join(root, "tmp"),
  TEMP: join(root, "tmp"),
  BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
  npm_config_cache: join(root, "npm-cache"),
  npm_config_registry: "https://registry.npmjs.org",
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_FILEWATCHER: "1",
  OPENCODE_DISABLE_FFF: "1",
  OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_LOG_LEVEL: "DEBUG",
  OPENCODE_PASSWORD: password,
  PROBE_RUN_ID: runID,
  PROBE_MODE: "ordinary",
  PROBE_TASK_CHILD: "1",
  PROBE_SHARED_CORE: "1",
  // This scenario records prompts but does not match any fixture tool-dispatch marker.
  PROBE_SCENARIO: "reset",
  PROBE_TELEMETRY_PATH: join(root, "telemetry.jsonl"),
  PROBE_MEMORY_DIR: join(project, ".opencode", "memory"),
  PROBE_MEMORY_FAILURES: JSON.stringify({ deterministic: 1, "deterministic-memory": 1 }),
  PROBE_MEMORY_PENDING_MS: JSON.stringify({ "deterministic-memory": 2_000 }),
};
const configDir = join(env.XDG_CONFIG_HOME!, "opencode");
const serverConfig = join(configDir, "opencode.json");
const cliConfig = join(configDir, "cli.json");
const serviceFile = join(env.XDG_STATE_HOME!, "opencode", "service.json");
const evidence: Record<string, unknown> = {
  runID,
  root,
  started: new Date(started).toISOString(),
  investigationArtifact: "/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-08--v2-runner.html",
  limits: { outerMs: 350_000, internalMs: 320_000, cleanupReserveMs: 15_000 },
  spec,
  stages,
  commands,
  rpc,
  environment: { ...env, OPENCODE_PASSWORD: "[redacted]" },
  socket,
  inference: "Existing stm-probe/deterministic provider fixture; deterministic inference, not semantic-quality proof",
  costConsumed: 0,
  globalBudgetChanged: false,
  paidInference: false,
  adapters: false,
};
let current: Stage = "install";
let binary = "";
let serveLog = "";
let tuiStarted = false;
const redact = (text: string) => redactDiagnostic(text.replace(/(server password )\S+/g, "$1[redacted]"), secrets);
const inside = (path: string) => {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../");
};
function remaining(max = 10_000, cleanup = false) {
  const left = deadline - Date.now() - (cleanup ? 0 : 15_000);
  assert.ok(left > 0, "Internal deadline reached (cleanup reserve)");
  return Math.min(left, max);
}
function kill(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
const watchdog = setTimeout(() => {
  for (const child of children) kill(child);
}, 320_000);
async function command(args: string[], max = 10_000, allowNonzero = false, cleanup = false, cwd = project) {
  const timeoutMs = remaining(max, cleanup);
  const record = { args, cwd, timeoutMs, status: null as number | null, stdout: "", stderr: "", timedOut: false };
  commands.push(record);
  const child = spawn(args[0]!, args.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.stdout!.on("data", (chunk) => (record.stdout += redact(chunk.toString())));
  child.stderr!.on("data", (chunk) => (record.stderr += redact(chunk.toString())));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    record.status = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          record.timedOut = true;
          kill(child);
          reject(new Error(`Command timed out: ${args.join(" ")}`));
        }, timeoutMs);
      }),
    ]);
    if (!allowNonzero) assert.equal(record.status, 0, `${args.join(" ")}: ${record.stderr || record.stdout}`);
    return record;
  } finally {
    clearTimeout(timer);
    kill(child);
    children.delete(child);
  }
}
const terminal = (args: string[], cleanup = false, allowNonzero = false) =>
  command(["/usr/bin/tmux", "-S", socket, "-f", "/dev/null", ...args], 3_000, allowNonzero, cleanup);
async function wait(max: number, check: () => Promise<boolean>, message: string) {
  const until = Date.now() + remaining(max);
  do {
    if (await check()) return;
    await Bun.sleep(100);
  } while (Date.now() < until);
  throw new Error(message);
}
async function save(name: string, value: unknown) {
  const text =
    typeof value === "string"
      ? redact(value)
      : JSON.stringify(
          value,
          (key, item) => {
            if (/^(password|authorization|sig)$/i.test(key)) return "[redacted]";
            return typeof item === "string" ? redact(item) : item;
          },
          2,
        );
  await Bun.write(join(root, name), text);
}
async function files(directory: string): Promise<string[]> {
  remaining();
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
async function provenance(directory: string, name: string, version: string, entry: string) {
  const physical = await realpath(directory);
  assert.ok(inside(physical), "Installed package escapes fresh sandbox");
  const manifest = await Bun.file(join(physical, "package.json")).json();
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  const path = await realpath(join(physical, entry));
  assert.ok(inside(path));
  return {
    directory: physical,
    manifest,
    entry: path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}
async function registry(name: string, version: string) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(remaining(20_000)) });
  assert.equal(response.status, 200, `Registry metadata: ${url}`);
  const metadata = await response.json();
  assert.equal(metadata.version, version);
  return { url, name: metadata.name, version: metadata.version, dist: metadata.dist };
}
async function stopService(cleanup = false) {
  if (!binary || !existsSync(serviceFile)) return;
  const info = await Bun.file(serviceFile).json();
  evidence.pluginAddService = { path: serviceFile, ...info, password: "[redacted]" };
  const result = await command([binary, "service", "stop"], 5_000, true, cleanup);
  let alive = false;
  try {
    process.kill(info.pid, 0);
    alive = true;
  } catch {}
  // Kill only a registration PID whose executable is the fresh installed host.
  if (alive && (await realpath(`/proc/${info.pid}/exe`).catch(() => "")) === (await realpath(binary))) {
    process.kill(info.pid, "SIGKILL");
    await Bun.sleep(100);
    try {
      process.kill(info.pid, 0);
    } catch {
      alive = false;
    }
  }
  evidence.serviceCleanup = { pid: info.pid, stopStatus: result.status, aliveAfterStop: alive };
  assert.ok(!alive, "Plugin-add background service remains alive");
}
workflow: try {
  let explicitVersion = false;
  const args = Bun.argv.slice(2);
  const usage =
    "Usage: bun scripts/published-v2-e2e.ts [/absolute/path/candidate.tgz | --version VERSION] [--setup-only]";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--setup-only") {
      assert.ok(!setupOnly, usage);
      setupOnly = true;
    } else if (arg === "--version") {
      assert.ok(!explicitVersion && candidateInput === undefined, usage);
      const version = args[++index];
      assert.ok(
        version && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(version),
        usage,
      );
      productVersion = version;
      explicitVersion = true;
    } else {
      assert.ok(!arg.startsWith("-") && candidateInput === undefined && !explicitVersion && isAbsolute(arg), usage);
      candidateInput = arg;
    }
  }
  spec = `@atonev/opencode-short-term-memory@${productVersion}`;
  configuredTarget = spec;
  evidence.spec = spec;
  evidence.version = productVersion;
  evidence.explicitVersion = explicitVersion;
  evidence.setupOnly = setupOnly;
  evidence.scope = candidateInput
    ? `Unpublished candidate tarball; ${setupOnly ? "setup-only verification" : "full workflow"}; not published acceptance`
    : `Published registry RC ${productVersion} ${setupOnly ? "setup-only verification (install/load/setup only; no conversation or memory acceptance)" : "acceptance"}`;
  if (setupOnly) evidence.inference = "Setup-only native commands; no conversation, summarization or model inference";
  assert.ok(existsSync(evidence.investigationArtifact as string), "Required investigation artifact missing");
  assert.ok(existsSync(dirname(socket)), "Short tmux socket parent missing");
  assert.ok(!existsSync(socket), "Test-owned tmux socket must start absent");
  for (const path of new Set([
    project,
    host,
    configDir,
    ...Object.values(env).filter((value) => inside(value) && value.startsWith(root) && !value.endsWith(".jsonl")),
  ])) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  evidence.initialCaches = await Promise.all(
    [env.XDG_CACHE_HOME!, env.BUN_INSTALL_CACHE_DIR!, env.npm_config_cache!].map(async (path) => {
      const entries = await readdir(path);
      assert.equal(entries.length, 0, "Cache must start empty");
      return { path, entries };
    }),
  );
  await command(["/usr/bin/git", "init", "--quiet"], 5_000);
  evidence.projectGitBoundary = (await command(["/usr/bin/git", "rev-parse", "--show-toplevel"], 5_000)).stdout.trim();
  assert.equal(evidence.projectGitBoundary, project);
  evidence.hostRegistry = await registry("@opencode/cli", "2.0.12");
  if (candidateInput) {
    assert.ok(isAbsolute(candidateInput), "Candidate tarball path must be absolute");
    const source = await realpath(candidateInput);
    assert.ok((await lstat(source)).isFile());
    const tarball = join(root, "candidate.tgz");
    await cp(source, tarball);
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(hash(source), hash(tarball));
    const manifest = JSON.parse(
      (await command(["/usr/bin/tar", "-xOf", tarball, "package/package.json"], 5_000)).stdout,
    );
    assert.equal(manifest.name, "@atonev/opencode-short-term-memory");
    productVersion = manifest.version;
    evidence.version = productVersion;
    configuredTarget = `${manifest.name}@file:${tarball}`;
    const extraction = join(root, "candidate-extracted");
    await mkdir(extraction);
    await command(["/usr/bin/tar", "-xzf", tarball, "-C", extraction], 5_000);
    const extractedRoot = join(extraction, "package");
    candidateFiles = await Promise.all(
      (await files(extractedRoot)).map(async (path) => {
        const suffix = relative(extractedRoot, path);
        return { path: suffix, sha256: hash(path) };
      }),
    );
    evidence.candidate = {
      source,
      tarball,
      sha256: hash(tarball),
      manifest,
      configuredTarget,
      referenceFiles: candidateFiles,
    };
    evidence.installationMode = "Unpublished candidate named-file package host bootstrap, not registry acceptance";
    evidence.pluginAddLimitation =
      "Pinned plugin add rejects file targets; native config loader passes named file package spec to Npm.add/Arborist and resolves package exports. CLI plugin add NOTRUN; no adapter, re-export or host-cache seeding.";
  } else {
    evidence.pluginRegistry = await registry("@atonev/opencode-short-term-memory", productVersion);
    evidence.installationMode = "Published registry bootstrap";
  }
  await Bun.write(
    join(host, "package.json"),
    JSON.stringify({ private: true, dependencies: { "@opencode/cli": "2.0.12" } }),
  );
  await command(
    [bun, "install", "--production", "--registry", "https://registry.npmjs.org"],
    100_000,
    false,
    false,
    host,
  );
  const nativeName = `@opencode/cli-linux-${process.arch}`;
  const native = await provenance(join(host, "node_modules", nativeName), nativeName, "2.0.12", "bin/opencode");
  binary = native.entry;
  const hostManifest = await Bun.file(join(host, "node_modules/@opencode/cli/package.json")).json();
  assert.equal(hostManifest.version, "2.0.12");
  assert.equal(hostManifest.optionalDependencies[nativeName], "2.0.12");
  evidence.hostPackage = {
    manifest: hostManifest,
    native,
    execution: "Published platform CLI executable, not a loader adapter; normal Bun lifecycle/trust policy",
  };
  const version = (await command([binary, "--version"])).stdout.trim();
  assert.ok(["2.0.12", "opencode v2.0.12"].includes(version));
  const added = candidateInput
    ? {
        status: 0,
        stdout: "Native plugin add NOTRUN: pinned CLI rejects file targets; named-file package configuration used",
        stderr: "",
      }
    : await command([binary, "plugin", "add", spec], 100_000, true);
  if (candidateInput) await Bun.write(serverConfig, JSON.stringify({ plugins: [configuredTarget] }, null, 2));
  evidence.pluginAdd = added;
  evidence.globalServerConfigAfterPluginAdd = existsSync(serverConfig) ? readFileSync(serverConfig, "utf8") : null;
  evidence.globalCliConfigAfterPluginAdd = existsSync(cliConfig) ? readFileSync(cliConfig, "utf8") : null;
  const manifests = (await files(root)).filter((path) =>
    path.endsWith("/@atonev/opencode-short-term-memory/package.json"),
  );
  evidence.pluginPackages = await Promise.all(
    manifests.map((path) =>
      provenance(dirname(path), "@atonev/opencode-short-term-memory", productVersion, "dist/index.js"),
    ),
  );
  await stopService();
  assert.equal(added.status, 0, `Actual plugin add failed: ${added.stderr || added.stdout}`);
  if (!candidateInput) assert.ok(manifests.length > 0, "Native plugin add installed no published STM package");
  const serverSettings = parse(readFileSync(serverConfig, "utf8"));
  assert.ok(
    Array.isArray(serverSettings.plugins) && serverSettings.plugins.includes(configuredTarget),
    "Native plugin add did not preserve exact npm spec in global server config",
  );
  const cliSettings = existsSync(cliConfig) ? parse(readFileSync(cliConfig, "utf8")) : {};
  const existingCliPlugins = cliSettings.plugins ?? [];
  assert.ok(Array.isArray(existingCliPlugins));
  cliSettings.plugins = [...new Set([...existingCliPlugins, configuredTarget])];
  Object.assign(cliSettings, {
    animations: false,
    mouse: false,
    attention: { notifications: false, sound: false },
    tabs: { enabled: false },
  });
  await Bun.write(cliConfig, JSON.stringify(cliSettings, null, 2));
  serverSettings.plugins = [...serverSettings.plugins, fixture];
  serverSettings.update = "disable";
  if (!setupOnly) {
    serverSettings.agents = {
      ...serverSettings.agents,
      build: {
        ...serverSettings.agents?.build,
        system: activeInstruction,
        permissions: [
          ...(serverSettings.agents?.build?.permissions ?? []),
          { action: PROBE_TASK_TOOL, resource: PROBE_TASK_CHILD_AGENT, effect: "allow" },
        ],
      },
      [PROBE_TASK_CHILD_AGENT]: {
        mode: "subagent",
        model: "stm-probe/deterministic",
        system: "Respond normally to the child probe prompt without using tools.",
      },
    };
  }
  await Bun.write(serverConfig, JSON.stringify(serverSettings, null, 2));
  evidence.configured = { server: serverSettings, cli: cliSettings, preservedCliPlugins: existingCliPlugins };
  stages.install = {
    verdict: candidateInput ? "NOTRUN" : "PASS",
    evidence: candidateInput
      ? `Exact unpublished ${productVersion} tarball prepared; native host package installation verification pending; plugin add unsupported/NOTRUN`
      : "Exact registry CLI/plugin installation, native plugin add, generated server config and same npm TUI spec",
  };
  current = "load";
  const serverArgs = [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"];
  commands.push({ args: serverArgs, cwd: project, longRunning: true, lifetimeBoundMs: remaining(180_000) });
  const server = spawn(binary, serverArgs.slice(1), {
    cwd: project,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(server);
  server.on("error", (error) => (serveLog += String(error)));
  for (const pipe of [server.stdout!, server.stderr!])
    pipe.on("data", (chunk) => (serveLog += redact(chunk.toString())));
  await wait(
    20_000,
    async () => {
      assert.equal(server.exitCode, null, `Actual server exited: ${serveLog}`);
      return /server listening on (http:\/\/127\.0\.0\.1:\d+)/.test(serveLog);
    },
    "Actual server listener missing",
  );
  const endpoint = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serveLog)![1]!;
  evidence.endpoint = endpoint;
  const client = OpenCode.make({ baseUrl: endpoint, headers: { Authorization: `Basic ${basic}` } });
  async function call<T>(name: string, input: unknown, operation: (signal: AbortSignal) => Promise<T>, max = 15_000) {
    const record: Record<string, unknown> = { name, input, started: new Date().toISOString() };
    rpc.push(record);
    try {
      const result = await operation(AbortSignal.timeout(remaining(max)));
      record.result = result;
      return result;
    } catch (error) {
      record.error = serializeFailure(error, secrets);
      throw error;
    } finally {
      record.finished = new Date().toISOString();
    }
  }
  await wait(
    120_000,
    async () => {
      const inventory = await call("plugin.list", { location: { directory: project } }, (signal) =>
        client.plugin.list({ location: { directory: project } }, { signal }),
      );
      const available = await call("command.list", { location: { directory: project } }, (signal) =>
        client.command.list({ location: { directory: project } }, { signal }),
      );
      evidence.inventory = { plugins: inventory, commands: available };
      const product = inventory.data.find(
        (item) =>
          item.id === "opencode-short-term-memory" ||
          JSON.stringify(item.source).includes("@atonev/opencode-short-term-memory"),
      );
      if (!product) return false;
      if (product.state.status === "failed")
        throw new Error(`Published STM native loader failed: ${JSON.stringify(product)}`);
      return product.state.status === "active" && available.data.some((entry) => entry.name === "stm");
    },
    "Published STM did not activate/register native command",
  );
  if (candidateInput) {
    const cacheRoot = join(env.XDG_CACHE_HOME!, "opencode", "npm");
    const installedManifests = (await files(cacheRoot)).filter((path) =>
      path.endsWith("/@atonev/opencode-short-term-memory/package.json"),
    );
    assert.ok(installedManifests.length > 0, "Normal host cache contains no installed candidate");
    evidence.pluginPackages = await Promise.all(
      installedManifests.map((path) =>
        provenance(dirname(path), "@atonev/opencode-short-term-memory", productVersion, "dist/index.js"),
      ),
    );
    for (const manifestPath of installedManifests) {
      const directory = await realpath(dirname(manifestPath));
      assert.ok(directory.startsWith(`${cacheRoot}/`), "Candidate installed outside normal host cache");
      for (const file of candidateFiles) {
        const installedPath = join(directory, file.path);
        assert.ok((await lstat(installedPath)).isFile(), `Candidate file is not regular: ${file.path}`);
        assert.ok(inside(await realpath(installedPath)));
        assert.equal(
          createHash("sha256").update(readFileSync(installedPath)).digest("hex"),
          file.sha256,
          `Host installed bytes differ: ${file.path}`,
        );
      }
      candidateDirectory = directory;
    }
    Object.assign(evidence.candidate as object, { directory: candidateDirectory, verifiedFiles: candidateFiles });
    stages.install = {
      verdict: "PASS",
      evidence: `Normal host installed named-file ${productVersion} into fresh cache; all ${candidateFiles.length} packaged files match tarball`,
    };
  }
  const isolationLogPath = join(env.XDG_DATA_HOME!, "opencode/log/opencode.log");
  const isolationLog = existsSync(isolationLogPath) ? readFileSync(isolationLogPath, "utf8") : "";
  assert.ok(!/target=dcp\b|id=dcp\b/.test(isolationLog), "Unrelated dcp plugin discovered");
  assert.ok(
    !isolationLog
      .split(/\r?\n/)
      .some(
        (line) =>
          /skill source loaded|instruction file/.test(line) &&
          /\/home\/dev\/\.opencode|\/home\/dev\/workspace\/\.opencode/.test(line),
      ),
    "Ancestor configuration discovered despite project disable",
  );
  evidence.projectDiscoveryIsolation =
    "Project discovery disabled; no ancestor configuration or unrelated dcp observed at activation";
  const session = await call(
    "session.create",
    { model: { providerID: "stm-probe", id: "deterministic" }, location: { directory: project } },
    (signal) =>
      client.session.create(
        {
          title: `Published V2 ${runID.slice(0, 8)}`,
          agent: "build",
          model: { providerID: "stm-probe", id: "deterministic" },
          location: { directory: project },
        },
        { signal },
      ),
  );
  evidence.sessionID = session.id;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const tuiCommand = [
    "/usr/bin/timeout",
    "--kill-after=2s",
    `${Math.floor(remaining(160_000) / 1000)}s`,
    binary,
    "--server",
    endpoint,
    "--session",
    session.id,
  ]
    .map(quote)
    .join(" ");
  await terminal(["new-session", "-d", "-s", "published", "-x", "160", "-y", "100", "-c", project, tuiCommand]);
  tuiStarted = true;
  await wait(
    20_000,
    async () => {
      const screen = (await terminal(["capture-pane", "-p", "-t", "published:0.0"])).stdout;
      await save("route-screen.txt", screen);
      const hostLogPath = join(env.XDG_DATA_HOME!, "opencode/log/opencode.log");
      const readiness = tuiReadiness(
        existsSync(hostLogPath) ? readFileSync(hostLogPath, "utf8") : "",
        configuredTarget,
      );
      if (readiness) evidence.tuiReadiness = readiness;
      return screen.includes(session.title!) && !!readiness;
    },
    "Actual tmux TUI did not show native session route",
  );
  const dialogs: object[] = [];
  evidence.dialogs = dialogs;
  async function nativeCommand(
    text: string,
    title: string,
    lines: string[],
    screenName = text.replaceAll(" ", "-"),
    sessionID = session.id,
  ) {
    await call(
      "session.command",
      { sessionID, name: "stm", text },
      (signal) => client.session.command({ sessionID, name: "stm", text }, { signal }),
      45_000,
    );
    await wait(
      8_000,
      async () => {
        const screen = (await terminal(["capture-pane", "-p", "-t", "published:0.0"])).stdout;
        await save(`${screenName}-screen.txt`, screen);
        const rows = screen.split(/\r?\n/);
        const titleMatch = rows.map((row) => new RegExp(`${title}[ \\t]+esc[ \\t]*$`).exec(row)).find(Boolean);
        return !!titleMatch && dialogRows(rows.map((row) => row.slice(titleMatch.index)).join("\n"), title, lines);
      },
      `Actual ${title} dialog missing expected rendered output`,
    );
    dialogs.push({ text, title, lines, screen: join(root, `${screenName}-screen.txt`), rendered: true });
    await terminal(["send-keys", "-t", "published:0.0", "Escape"]);
    await Bun.sleep(200);
  }
  stages.load = {
    verdict: "PASS",
    evidence: candidateInput
      ? "Native named-file package server inventory active, native stm command, actual tmux TUI native session route"
      : "Native npm server inventory active, native stm command, actual tmux TUI native session route",
  };
  current = "setup";
  const setupPath = join(project, ".opencode", "stm.jsonc");
  assert.ok(!existsSync(setupPath));
  evidence.setupInitialConfig = { path: setupPath, exists: false };
  await nativeCommand("setup", "STM setup", [
    "Refused: setup not run. Use /stm setup confirm true with exact literal confirmation.",
  ]);
  assert.ok(!existsSync(setupPath), "Unconfirmed native setup wrote config");
  evidence.setupRefusal = { configExistsAfter: false };
  await nativeCommand("setup confirm true", "STM setup", [`Created project example config at ${setupPath}.`]);
  assert.ok(existsSync(setupPath), "Confirmed native setup created no config");
  const createdBytes = readFileSync(setupPath);
  const created = createdBytes.toString("utf8");
  const createdSha256 = createHash("sha256").update(createdBytes).digest("hex");
  evidence.setupCreatedConfig = { path: setupPath, text: created, bytes: createdBytes.length, sha256: createdSha256 };
  await save("setup-created-stm.jsonc", created);
  if (setupOnly) {
    await nativeCommand(
      "setup confirm true",
      "STM setup",
      [`No example config created: stm.jsonc already exists in ${dirname(setupPath)}.`],
      "setup-confirm-true-no-overwrite",
    );
    const repeatedBytes = readFileSync(setupPath);
    const repeatedSha256 = createHash("sha256").update(repeatedBytes).digest("hex");
    evidence.setupNoOverwrite = {
      path: setupPath,
      beforeSha256: createdSha256,
      afterSha256: repeatedSha256,
      bytesUnchanged: createdBytes.equals(repeatedBytes),
    };
    assert.deepEqual(repeatedBytes, createdBytes, "Repeated confirmed setup changed config bytes");
  }
  const readTelemetry = () =>
    existsSync(env.PROBE_TELEMETRY_PATH!)
      ? readFileSync(env.PROBE_TELEMETRY_PATH!, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const setupTelemetry = readTelemetry();
  const setupInvocations = setupTelemetry.filter(
    (row) => row.event === "model.invocation" || row.event === "model.request",
  );
  evidence.setupTelemetryBoundary = { startRow: 0, endRow: setupTelemetry.length, setupInvocations };
  assert.deepEqual(setupInvocations, [], "Native setup commands invoked the provider");
  stages.setup = {
    verdict: "PASS",
    evidence: setupOnly
      ? "Native refusal rendered/no write; confirmed creation rendered; repeated confirmation no-overwrite rendered/config bytes unchanged"
      : "Native refusal rendered/no write; confirmed creation rendered and actual config preserved before test settings adjustment",
  };
  if (setupOnly) {
    const finalSession = await call("session.get", { sessionID: session.id }, (signal) =>
      client.session.get({ sessionID: session.id }, { signal }),
    );
    evidence.usage = { cost: finalSession.cost, tokens: finalSession.tokens };
    assert.equal(finalSession.cost, 0);
    assert.deepEqual(finalSession.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    const memoryFiles = await files(env.PROBE_MEMORY_DIR!);
    evidence.setupOnlyMemoryFiles = memoryFiles;
    assert.equal(memoryFiles.length, 0, "Setup-only created memory artifacts");
    evidence.setupOnlyModelInvocations = setupInvocations;
    assert.equal(setupInvocations.length, 0, "Setup-only invoked the provider fixture");
    evidence.setupOnlyBoundary = { functionalConfigAdjusted: false, conversation: "NOTRUN", memory: "NOTRUN" };
    break workflow;
  }
  const settings = parse(created);
  assert.ok(
    settings.enableLegacyPeriodicSystemTransform === undefined ||
      settings.enableLegacyPeriodicSystemTransform === false,
    "Native setup unexpectedly opts into system memory injection",
  );
  delete settings.enableLegacyPeriodicSystemTransform;
  Object.assign(settings, {
    enabled: true,
    summarizerMode: "clean",
    memoryDir: env.PROBE_MEMORY_DIR,
    maxDeltaMessages: 200,
    maxUpdateInputLength: 20_000,
    remindEveryN: 1,
    debounceMs: 100,
    injectInSubagents: true,
  });
  await Bun.write(setupPath, JSON.stringify(settings, null, 2));
  evidence.defaultOffSettings = { ...settings };
  const advancedUpdates = {
    verdict: "FAIL",
    schedule: {
      failures: { deterministic: 1, "deterministic-memory": 1 },
      pendingMs: { "deterministic-memory": 2_000 },
    },
    phases: [] as object[],
    restoredSettings: false,
  };
  evidence.advancedNativeUpdates = advancedUpdates;
  const productionLogPath = join(env.PROBE_MEMORY_DIR!, "session-memory.log");
  const productionRows = () =>
    existsSync(productionLogPath)
      ? readFileSync(productionLogPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const telemetryRowsFor = (startRow: number) => readTelemetry().slice(startRow);
  async function waitForUpdate(sessionID: string, checkpointID: string, max = 15_000) {
    try {
      await wait(
        max,
        async () =>
          productionRows().some(
            (row) =>
              row.event === "v2_memory_update_committed" &&
              row.sessionID === sessionID &&
              row.checkpointID === checkpointID,
          ),
        `Automatic update did not commit for ${sessionID}`,
      );
    } catch (error) {
      const diagnostics = productionRows().filter(
        (row) =>
          row.sessionID === sessionID &&
          (row.event === "v2_memory_update_skipped" || row.event === "v2_memory_update_error"),
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; latest skipped/error diagnostics: ${JSON.stringify({
          skipped: diagnostics.findLast((row) => row.event === "v2_memory_update_skipped"),
          error: diagnostics.findLast((row) => row.event === "v2_memory_update_error"),
        })}`,
        { cause: error },
      );
    }
  }
  async function createUpdateSession(title: string, model = "deterministic") {
    const createdSession = await call("session.create", { phase: title }, (signal) =>
      client.session.create(
        {
          title,
          agent: "build",
          model: { providerID: "stm-probe", id: model },
          location: { directory: project },
        },
        { signal },
      ),
    );
    assert.deepEqual(
      await call("session.context", { sessionID: createdSession.id }, (signal) =>
        client.session.context({ sessionID: createdSession.id }, { signal }),
      ),
      [],
      `${title} session must start fresh`,
    );
    return createdSession;
  }
  async function promptUpdateSession(sessionID: string, text: string) {
    const beforeRows = readTelemetry().length;
    await call("session.prompt", { sessionID, text }, (signal) =>
      client.session.prompt({ sessionID, text }, { signal }),
    );
    await call("session.wait", { sessionID }, (signal) => client.session.wait({ sessionID }, { signal }), 30_000);
    let history: Awaited<ReturnType<typeof client.session.context>> = [];
    await wait(
      10_000,
      async () => {
        history = await call("session.context", { sessionID }, (signal) =>
          client.session.context({ sessionID }, { signal }),
        );
        const userIndex = history.findLastIndex((message) => message.type === "user" && message.text === text);
        const assistant = history.slice(userIndex + 1).findLast((message) => message.type === "assistant");
        return userIndex >= 0 && assistant?.type === "assistant" && typeof assistant.time.completed === "number";
      },
      `Completed assistant for the new prompt did not settle for ${sessionID}`,
    );
    const assistant = history.findLast((message) => message.type === "assistant");
    assert.ok(assistant?.id, `No assistant checkpoint observed for ${sessionID}`);
    return { beforeRows, assistantID: assistant.id, history };
  }
  function isMemoryUpdateInvocation(row: MemoryInvocationRow): boolean {
    if (row.event !== "model.invocation" || typeof row.details?.prompt !== "string") return false;
    try {
      const messages = JSON.parse(row.details.prompt);
      if (!Array.isArray(messages)) return false;
      const text = messages
        .map((message) => {
          if (!message || typeof message !== "object") return "";
          if (message.role === "system" && typeof message.content === "string") return message.content;
          if (!Array.isArray(message.content)) return "";
          return message.content
            .filter(
              (part: { readonly type?: unknown; readonly text?: unknown }) =>
                part && part.type === "text" && typeof part.text === "string",
            )
            .map((part: { readonly text?: unknown }) => String(part.text))
            .join("");
        })
        .join("\n");
      return [
        "You are a short‑term session memory processor for an OpenCode plugin.",
        "<existing_memory>",
        "<conversation_update>",
        "### User Instructions",
        "### Long Horizon Context",
        "### Decisions",
        "### Conclusions",
        "### Active References",
      ].every((marker) => text.includes(marker));
    } catch {
      return false;
    }
  }
  function assertGenerationAttemptSchema(attempt: ProductionAttemptRow, label: string): void {
    assert.equal(attempt.event, "v2_generation_attempt_start", `${label} has an unexpected event`);
    assert.equal(typeof attempt.sessionID, "string", `${label} lacks a session ID`);
    assert.equal(typeof attempt.mode, "string", `${label} lacks a generation mode`);
    assert.equal(typeof attempt.providerID, "string", `${label} lacks a provider ID`);
    assert.equal(typeof attempt.modelID, "string", `${label} lacks a model ID`);
    for (const [field, value] of Object.entries({
      attempt: attempt.attempt,
      maxAttempts: attempt.maxAttempts,
      visibleCount: attempt.visibleCount,
      deltaCount: attempt.deltaCount,
      chunkCount: attempt.chunkCount,
      promptChars: attempt.promptChars,
      conversationChars: attempt.conversationChars,
    })) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        assert.fail(`${label} has invalid ${field}`);
    }
    assert.ok(typeof attempt.attempt === "number" && typeof attempt.maxAttempts === "number");
    assert.ok(attempt.attempt <= attempt.maxAttempts, `${label} attempt exceeds its bounded retry budget`);
  }
  const advancedSettings = { ...settings };
  try {
    Object.assign(settings, {
      summarizerMode: "clean",
      memoryModel: "",
      sideSessionRetries: 0,
      cleanFallbackToActiveSession: true,
      debug: true,
    });
    await Bun.write(setupPath, JSON.stringify(settings, null, 2));
    const fallbackSession = await createUpdateSession(`Active fallback V2 ${runID.slice(0, 8)}`);
    const fallbackStart = readTelemetry().length;
    const fallbackTurn = await promptUpdateSession(
      fallbackSession.id,
      `${sharedCoreScenario.initialPrompt}\nSTM_ACTIVE_FALLBACK:${runID}`,
    );
    await waitForUpdate(fallbackSession.id, fallbackTurn.assistantID);
    const fallbackRows = telemetryRowsFor(fallbackStart);
    const fallbackInvocations = fallbackRows.filter(isMemoryUpdateInvocation);
    assert.equal(fallbackInvocations.length, 2, "Fallback must expose exactly two marker-bearing summary invocations");
    const fallbackPrimaryInvocations = fallbackRows.filter(
      (row) =>
        row.event === "model.invocation" &&
        row.details?.prompt?.includes(`STM_ACTIVE_FALLBACK:${runID}`) &&
        !isMemoryUpdateInvocation(row),
    );
    assert.equal(fallbackPrimaryInvocations.length, 1, "Fallback must retain one ordinary primary invocation");
    const fallbackPrimaryCorrelation = fallbackPrimaryInvocations[0]!.details?.correlation;
    assert.equal(fallbackPrimaryCorrelation?.sessionID, fallbackSession.id);
    assert.equal(fallbackPrimaryCorrelation?.agent, "build");
    assert.equal(fallbackPrimaryCorrelation?.kind, "primary");
    assert.equal(typeof fallbackPrimaryCorrelation?.requestID, "string");
    assert.deepEqual(
      fallbackInvocations.map((row) => row.model),
      ["deterministic", "deterministic"],
      "Fallback summary invocations must be ordered clean failure then active deterministic model",
    );
    for (const [index, invocation] of fallbackInvocations.entries()) {
      const correlation = invocation.details?.correlation;
      if (index === 0) {
        assert.ok(correlation == null, "Standalone clean summary must not claim primary correlation");
        continue;
      }
      assert.equal(correlation?.sessionID, fallbackSession.id, "Fallback invocation lost active-session provenance");
      assert.equal(correlation?.agent, "build", "Fallback invocation lost active-agent provenance");
      assert.equal(correlation?.kind, "generate", "Active fallback invocation is not a generate request");
      assert.equal(typeof correlation?.requestID, "string", "Active fallback invocation lacks a request ID");
      const matchingRequests = fallbackRows.filter(
        (row) => row.event === "model.request" && row.details?.correlation?.requestID === correlation.requestID,
      );
      assert.equal(matchingRequests.length, 1, "Active fallback lacks one exact model.request hook");
      assert.ok(matchingRequests[0]!.seq < invocation.seq, "Fallback model.request must precede its invocation");
      assert.equal(matchingRequests[0]!.details.correlation.sessionID, fallbackSession.id);
    }
    const fallbackAttempts = productionRows().filter(
      (row) => row.event === "v2_generation_attempt_start" && row.sessionID === fallbackSession.id,
    ) as ProductionAttemptRow[];
    assert.equal(fallbackAttempts.length, 2, "Fallback must have one clean failure and one active fallback attempt");
    assert.deepEqual(
      fallbackAttempts.map(({ attempt, maxAttempts, mode }) => ({ attempt, maxAttempts, mode })),
      [
        { attempt: 1, maxAttempts: 1, mode: "clean" },
        { attempt: 2, maxAttempts: 2, mode: "active_fallback" },
      ],
      "Fallback must record clean then active-fallback attempt modes",
    );
    for (const attempt of fallbackAttempts) {
      assertGenerationAttemptSchema(attempt, "Fallback attempt");
      assert.equal(attempt.providerID, "stm-probe", "Fallback attempt lacks the production provider ID");
      assert.equal(attempt.modelID, "deterministic", "Fallback attempt lacks the production model ID");
    }
    assert.ok(
      fallbackRows.some(
        (row) =>
          row.event === "model.invocation" &&
          row.model === "deterministic" &&
          row.details?.correlation?.sessionID === fallbackSession.id,
      ),
      "Active fallback did not invoke the active deterministic model",
    );
    advancedUpdates.phases.push({
      name: "active-fallback",
      verdict: "PASS",
      sessionID: fallbackSession.id,
      attempts: fallbackAttempts,
      telemetryRows: fallbackRows.length,
    });

    Object.assign(settings, {
      summarizerMode: "clean",
      memoryModel: `stm-probe/${PROBE_MEMORY_MODEL_ID}`,
      sideSessionRetries: 1,
      cleanFallbackToActiveSession: false,
    });
    await Bun.write(setupPath, JSON.stringify(settings, null, 2));
    const retrySession = await createUpdateSession(`Clean retry V2 ${runID.slice(0, 8)}`);
    const retryStart = readTelemetry().length;
    const retryTurn = await promptUpdateSession(
      retrySession.id,
      `${sharedCoreScenario.initialPrompt}\nSTM_CLEAN_RETRY:${runID}`,
    );
    await waitForUpdate(retrySession.id, retryTurn.assistantID);
    const retryAttempts = productionRows().filter(
      (row) => row.event === "v2_generation_attempt_start" && row.sessionID === retrySession.id,
    ) as ProductionAttemptRow[];
    assert.equal(retryAttempts.length, 2, "Clean retry must have exactly two bounded attempts");
    assert.deepEqual(
      retryAttempts.map((row) => ({ attempt: row.attempt, maxAttempts: row.maxAttempts, mode: row.mode })),
      [
        { attempt: 1, maxAttempts: 2, mode: "clean" },
        { attempt: 2, maxAttempts: 2, mode: "clean" },
      ],
      "Clean retry must record clean mode for both bounded attempts",
    );
    assert.ok(retryAttempts.every((attempt) => attempt.providerID === "stm-probe"));
    assert.ok(retryAttempts.every((attempt) => attempt.modelID === PROBE_MEMORY_MODEL_ID));
    for (const attempt of retryAttempts) assertGenerationAttemptSchema(attempt, "Clean retry attempt");
    const retryRows = telemetryRowsFor(retryStart);
    assert.equal(
      retryRows.filter((row) => isMemoryUpdateInvocation(row) && row.model === PROBE_MEMORY_MODEL_ID).length,
      2,
      "Retry must keep both summary invocations on deterministic-memory",
    );
    advancedUpdates.phases.push({
      name: "clean-retry",
      verdict: "PASS",
      sessionID: retrySession.id,
      attempts: retryAttempts,
    });

    const cancelledSession = await createUpdateSession(
      `Cancelled update V2 ${runID.slice(0, 8)}`,
      PROBE_MEMORY_MODEL_ID,
    );
    const cancelledStart = readTelemetry().length;
    const cancelledProductionStart = productionRows().length;
    const priorMemoryScheduleStarts = readTelemetry().filter(
      (row) =>
        row.event === "event.observed" &&
        row.observedEvent === "memory.schedule" &&
        row.details?.model === PROBE_MEMORY_MODEL_ID &&
        row.details?.phase === "start",
    );
    assert.deepEqual(
      priorMemoryScheduleStarts.map((row) => row.details.memoryAttempt),
      [1, 2],
      "Cancellation must follow the two completed clean retry attempts",
    );
    const cancelledMemoryPath = join(env.PROBE_MEMORY_DIR!, `session_${cancelledSession.id}.md`);
    const cancelledCheckpointPath = join(
      env.PROBE_MEMORY_DIR!,
      "checkpoints",
      `${cancelledSession.id}.last-message-id.txt`,
    );
    const cancelledArtifactPaths = [
      cancelledMemoryPath,
      cancelledCheckpointPath,
      join(env.PROBE_MEMORY_DIR!, "reset-boundaries", `${cancelledSession.id}.json`),
      join(env.PROBE_MEMORY_DIR!, "task-children", `${cancelledSession.id}.json`),
    ];
    const cancelledPrompt = `${sharedCoreScenario.initialPrompt}\nSTM_CANCEL_PENDING:${runID}`;
    const cancelledPromptPromise = call(
      "session.prompt",
      { sessionID: cancelledSession.id, text: cancelledPrompt },
      (signal) => client.session.prompt({ sessionID: cancelledSession.id, text: cancelledPrompt }, { signal }),
    );
    await wait(
      10_000,
      async () => {
        const attempts = productionRows()
          .slice(cancelledProductionStart)
          .filter((row) => row.event === "v2_generation_attempt_start") as ProductionAttemptRow[];
        const scheduleStarts = telemetryRowsFor(cancelledStart).filter(
          (row) =>
            row.event === "event.observed" && row.observedEvent === "memory.schedule" && row.details?.phase === "start",
        );
        assert.ok(attempts.length <= 1 && scheduleStarts.length <= 1, "Concurrent update during cancellation");
        if (!attempts.length || !scheduleStarts.length) return false;
        const attempt = attempts[0]!;
        assertGenerationAttemptSchema(attempt, "Cancellation attempt");
        assert.equal(attempt.sessionID, cancelledSession.id);
        assert.equal(attempt.providerID, "stm-probe");
        assert.equal(attempt.modelID, PROBE_MEMORY_MODEL_ID);
        assert.equal(attempt.mode, "clean");
        assert.equal(attempt.attempt, 1);
        assert.equal(attempt.maxAttempts, 2);
        const schedule = scheduleStarts[0]!;
        assert.equal(schedule.details.model, PROBE_MEMORY_MODEL_ID);
        assert.equal(schedule.details.memoryAttempt, 3);
        assert.equal(schedule.details.memoryFailure, false);
        assert.equal(schedule.details.memoryPendingMs, 2_000);
        assert.ok(Number.isSafeInteger(schedule.seq));
        const primaryRequests = telemetryRowsFor(cancelledStart).filter((row) => row.event === "model.request");
        assert.equal(primaryRequests.length, 1, "Pending cancellation must have one isolated primary request");
        assert.equal(primaryRequests[0]!.model, PROBE_MEMORY_MODEL_ID);
        assert.equal(primaryRequests[0]!.details?.correlation?.sessionID, cancelledSession.id);
        assert.equal(primaryRequests[0]!.details?.correlation?.kind, "primary");
        assert.ok(
          Number.isFinite(Date.parse(schedule.timestamp)) && Date.now() - Date.parse(schedule.timestamp) < 2_000,
          "Cancellation missed the fixture pending window",
        );
        assert.equal(telemetryRowsFor(cancelledStart).filter(isMemoryUpdateInvocation).length, 0);
        // The context updater bootstraps the template before starting generation.
        if (existsSync(cancelledMemoryPath))
          assert.deepEqual(
            readFileSync(cancelledMemoryPath),
            Buffer.from(RESET_MEMORY_TEMPLATE, "utf8"),
            "Pending cancellation memory must be the exact bootstrap template",
          );
        assert.ok(!existsSync(cancelledCheckpointPath), "Pending cancellation already has a checkpoint");
        assert.equal(
          productionRows().filter(
            (row) => row.event === "v2_memory_update_committed" && row.sessionID === cancelledSession.id,
          ).length,
          0,
          "Pending cancellation already committed an update",
        );
        return true;
      },
      "Session-scoped production attempt and pending deterministic-memory schedule did not start",
    );
    const deletionStarted = new Date().toISOString();
    await call("session.remove", { sessionID: cancelledSession.id }, (signal) =>
      client.session.remove({ sessionID: cancelledSession.id }, { signal }),
    );
    const deletionFinished = new Date().toISOString();
    await cancelledPromptPromise.catch(() => undefined);
    // Native host work can outlive updater cancellation when it does not forward the signal.
    await wait(
      5_000,
      async () => {
        const rows = telemetryRowsFor(cancelledStart);
        return (
          rows.some(
            (row) =>
              row.model === PROBE_MEMORY_MODEL_ID && row.details?.memoryAttempt === 3 && isMemoryUpdateInvocation(row),
          ) ||
          rows.some(
            (row) =>
              row.event === "event.observed" &&
              row.observedEvent === "memory.schedule" &&
              row.details?.model === PROBE_MEMORY_MODEL_ID &&
              row.details?.memoryAttempt === 3 &&
              row.details?.phase === "aborted",
          )
        );
      },
      "Pending host summary neither completed nor observed abort within the bounded window",
    );
    const hostSettlementObserved = new Date().toISOString();
    await Bun.sleep(500);
    const cancelledRows = telemetryRowsFor(cancelledStart);
    const cancelledPrimaryInvocations = cancelledRows.filter(
      (row) =>
        row.event === "model.invocation" &&
        row.details?.prompt?.includes(`STM_CANCEL_PENDING:${runID}`) &&
        !isMemoryUpdateInvocation(row),
    );
    assert.equal(cancelledPrimaryInvocations.length, 1, "Cancellation must retain one ordinary primary invocation");
    const cancelledPrimary = cancelledPrimaryInvocations[0]!;
    assert.equal(cancelledPrimary.model, PROBE_MEMORY_MODEL_ID);
    const cancelledCorrelation = cancelledPrimary.details?.correlation;
    assert.equal(cancelledCorrelation?.sessionID, cancelledSession.id);
    assert.equal(cancelledCorrelation?.agent, "build");
    assert.equal(cancelledCorrelation?.kind, "primary");
    assert.equal(typeof cancelledCorrelation?.requestID, "string");
    const cancelledPrimaryRequests = cancelledRows.filter(
      (row) => row.event === "model.request" && row.details?.correlation?.requestID === cancelledCorrelation.requestID,
    );
    assert.equal(cancelledPrimaryRequests.length, 1, "Cancellation lacks one exact ordinary primary request");
    assert.ok(cancelledPrimaryRequests[0]!.seq < cancelledPrimary.seq);
    const cancelledAttempts = productionRows()
      .slice(cancelledProductionStart)
      .filter((row) => row.event === "v2_generation_attempt_start") as ProductionAttemptRow[];
    assert.equal(cancelledAttempts.length, 1, "Cancellation must have one isolated production generation attempt");
    assert.equal(cancelledAttempts[0]!.sessionID, cancelledSession.id);
    const cancelledSummaryInvocations = cancelledRows.filter(isMemoryUpdateInvocation);
    assert.ok(cancelledSummaryInvocations.length <= 1, "Cancelled updater started additional provider work");
    for (const invocation of cancelledSummaryInvocations) {
      assert.equal(invocation.model, PROBE_MEMORY_MODEL_ID);
      assert.equal(invocation.details?.memoryAttempt, 3);
      assert.equal(invocation.details?.memoryPendingMs, 2_000);
      assert.equal(invocation.details?.memoryFailure, false);
    }
    const cancelledAttemptRows = cancelledRows.filter(
      (row) => row.event === "event.observed" && row.observedEvent === "memory.schedule",
    );
    assert.ok(
      cancelledAttemptRows.every(
        (row) =>
          row.details?.model === PROBE_MEMORY_MODEL_ID &&
          row.details?.memoryAttempt === 3 &&
          row.details?.memoryPendingMs === 2_000 &&
          row.details?.memoryFailure === false &&
          Number.isSafeInteger(row.seq) &&
          (row.details?.phase === "start" || row.details?.phase === "aborted"),
      ),
      "Cancellation schedule telemetry has an invalid production metadata schema",
    );
    assert.equal(
      cancelledAttemptRows.filter((row) => row.details?.phase === "start").length,
      1,
      "Cancelled request must have one deterministic-memory schedule start",
    );
    const cancelledScheduleAborts = cancelledAttemptRows.filter((row) => row.details?.phase === "aborted");
    assert.ok(cancelledScheduleAborts.length <= 1, "Pending host schedule observed multiple aborts");
    assert.equal(
      cancelledScheduleAborts.length + cancelledSummaryInvocations.length,
      1,
      "Pending host schedule must have exactly one completion or abort observation",
    );
    const cancelledScheduleStart = cancelledAttemptRows.find((row) => row.details?.phase === "start");
    const cancelledScheduleAbort = cancelledScheduleAborts[0];
    const cancelledHostSettlement = cancelledScheduleAbort ?? cancelledSummaryInvocations[0]!;
    assert.ok(cancelledPrimary.seq < cancelledScheduleStart!.seq);
    assert.ok(Number.isSafeInteger(cancelledHostSettlement.seq));
    assert.ok(cancelledScheduleStart!.seq < cancelledHostSettlement.seq);
    assert.ok(
      Number.isFinite(Date.parse(cancelledHostSettlement.timestamp)) &&
        Date.parse(cancelledHostSettlement.timestamp) >= Date.parse(deletionStarted) &&
        Date.parse(cancelledHostSettlement.timestamp) <= Date.parse(deletionFinished) + 5_000 &&
        Date.parse(cancelledHostSettlement.timestamp) <= Date.parse(hostSettlementObserved),
      "Host settlement must fall within the bounded deletion observation",
    );
    const deletionEvents = cancelledRows.filter(
      (row) => row.event === "event.observed" && row.observedEvent === "session.deleted",
    );
    assert.equal(deletionEvents.length, 1, "Isolated cancellation must observe one native session deletion");
    assert.ok(cancelledScheduleStart!.seq < deletionEvents[0]!.seq);
    if (cancelledSummaryInvocations.length)
      assert.ok(deletionEvents[0]!.seq < cancelledHostSettlement.seq, "Host completed before deletion was observed");
    const cancellationProductionRows = productionRows()
      .slice(cancelledProductionStart)
      .filter((row) => row.sessionID === cancelledSession.id);
    const cancellationOutcomes = cancellationProductionRows.filter(
      (row) => row.event === "v2_generation_attempt_outcome",
    );
    assert.equal(cancellationOutcomes.length, 1, "Deleted updater must record one generation outcome");
    assert.equal(cancellationOutcomes[0]!.attempt, 1);
    assert.equal(cancellationOutcomes[0]!.mode, "clean");
    assert.equal(cancellationOutcomes[0]!.providerID, "stm-probe");
    assert.equal(cancellationOutcomes[0]!.modelID, PROBE_MEMORY_MODEL_ID);
    assert.equal(cancellationOutcomes[0]!.outcome, "failure");
    assert.equal(cancellationOutcomes[0]!.failureKind, "V2GenerationCancelledError");
    const cancellationErrors = cancellationProductionRows.filter((row) => row.event === "v2_memory_update_error");
    assert.equal(cancellationErrors.length, 1, "Deleted updater must record one update error");
    assert.equal(cancellationErrors[0]!.detail, "summarizer_cancelled");
    const cancelledArtifacts = cancelledArtifactPaths.map((path) => ({ path, exists: existsSync(path) }));
    assert.ok(
      cancelledArtifacts.every((artifact) => !artifact.exists),
      "Cancelled update recreated artifacts",
    );
    assert.ok(
      !productionRows().some(
        (row) => row.event === "v2_memory_update_committed" && row.sessionID === cancelledSession.id,
      ),
      "Cancelled update committed after session deletion",
    );
    advancedUpdates.phases.push({
      name: "deletion-cancellation",
      verdict: "PASS",
      sessionID: cancelledSession.id,
      attempts: cancelledAttempts,
      primaryRequestID: cancelledCorrelation.requestID,
      scope:
        "Updater cancellation fences persistence after session deletion; native host/provider abort is not guaranteed. Completion is provider response telemetry, not proof of native callback termination; post-settlement persistence observation is bounded.",
      pendingObserved: true,
      deletion: { started: deletionStarted, finished: deletionFinished, event: deletionEvents[0] },
      scheduleStart: cancelledScheduleStart,
      scheduleAbort: cancelledScheduleAbort ?? null,
      hostObservedAbort: cancelledScheduleAbort !== undefined,
      hostContinued: cancelledSummaryInvocations.length > 0,
      summaryInvocations: cancelledSummaryInvocations,
      hostSettlement: cancelledHostSettlement,
      hostSettlementObserved,
      hostSettlementBoundMs: 5_000,
      postSettlementObservationMs: 500,
      cancellationOutcomes,
      cancellationErrors,
      artifacts: cancelledArtifacts,
      committedAfterDeletion: false,
      telemetryRows: cancelledRows.length,
    });
  } finally {
    Object.assign(settings, advancedSettings);
    await Bun.write(setupPath, JSON.stringify(settings, null, 2));
    advancedUpdates.restoredSettings = true;
  }
  current = "run";
  const prompt = sharedCoreScenario.initialPrompt;
  const cleanIsolation = {
    verdict: "NOTRUN",
    provenance: {
      hostVersion: "2.0.12",
      instructionSource: `${serverConfig}#agents.build.system`,
      activeInstruction,
      telemetryPath: env.PROBE_TELEMETRY_PATH!,
      sessionID: session.id,
      transport: "Native generate.text may use doStream; inspect both doGenerate and doStream provider requests",
    },
    phases: [] as object[],
  };
  evidence.cleanIsolation = cleanIsolation;
  function auditCleanIsolation(phase: string, startRow: number, endRow: number, expectedUser: string) {
    cleanIsolation.verdict = "FAIL";
    const rows = readFileSync(env.PROBE_TELEMETRY_PATH!, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const requests: object[] = [];
    const failures: string[] = [];
    const summaryModel = settings.memoryModel.trim() || "stm-probe/deterministic";
    assert.ok(Number.isInteger(startRow) && startRow >= 0 && endRow > startRow && endRow <= rows.length);
    let primaryCount = 0;
    let summaryCount = 0;
    const summaryTransports = { doGenerate: 0, doStream: 0 };
    const result = {
      phase,
      sessionID: activeSessionID,
      startRow,
      endRow,
      expectedUser,
      expectedModels: { primary: "stm-probe/deterministic", summary: summaryModel },
      requests,
      failures,
      primaryCount,
      summaryCount,
      summaryTransports,
      verdict: "FAIL",
    };
    cleanIsolation.phases.push(result);
    const expectedDelta = `USER:\n${expectedUser}\n\n---\n\nASSISTANT:\n${sharedCoreScenario.assistantText}`;
    for (const [index, row] of rows.entries()) {
      assert.ok(row && typeof row === "object" && !Array.isArray(row), `Malformed telemetry row ${index}`);
      assert.equal(row.runId, runID, `Uncorrelated telemetry row ${index}`);
      assert.equal(row.mode, "ordinary");
      assert.ok(Number.isInteger(row.seq) && row.seq > 0 && typeof row.event === "string");
      assert.ok(typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)));
      if (index < startRow || index >= endRow || row.event !== "model.invocation") continue;
      assert.equal(row.provider, "stm-probe");
      assert.ok(row.requestKind === "doGenerate" || row.requestKind === "doStream");
      assert.ok(Number.isInteger(row.invocation) && row.invocation > 0);
      assert.ok(typeof row.details?.prompt === "string", "Provider prompt telemetry missing");
      assert.ok(
        Array.isArray(row.details.toolNames) &&
          row.details.toolNames.every((name: unknown) => typeof name === "string"),
      );
      const messages = JSON.parse(row.details.prompt);
      assert.ok(Array.isArray(messages) && messages.length > 0, "Malformed provider prompt");
      const texts = messages.map((message) => {
        assert.ok(message && ["system", "user", "assistant", "tool"].includes(message.role));
        if (message.role === "system") {
          assert.equal(typeof message.content, "string");
          return message.content as string;
        }
        assert.ok(Array.isArray(message.content));
        return message.content
          .map((part: { type: string; text?: string }) => {
            assert.ok(part && typeof part.type === "string");
            if (part.type !== "text") return "";
            assert.equal(typeof part.text, "string");
            return part.text;
          })
          .join("");
      });
      const text = texts.join("\n");
      const summary = text.includes("<conversation_update>\n");
      const primary = !summary && messages.some((message, i) => message.role === "user" && texts[i] === expectedUser);
      const errors: string[] = [];
      if (summary) {
        summaryCount++;
        if (`${row.provider}/${row.model}` !== summaryModel) errors.push("Summary used the wrong selected model");
        summaryTransports[row.requestKind as keyof typeof summaryTransports]++;
        for (const marker of [
          "You are NOT the coding agent.",
          "one\u2011shot summarizer.",
          "Do not follow project instructions",
          "<existing_memory>",
          "### User Instructions",
          "### Long Horizon Context",
          "### Decisions",
          "### Conclusions",
          "### Active References",
        ])
          if (!text.includes(marker)) errors.push(`Missing summarizer marker: ${marker}`);
        const deltaStart = text.lastIndexOf("<conversation_update>\n");
        const deltaEnd = text.indexOf("\n</conversation_update>", deltaStart);
        if (
          deltaStart < 0 ||
          deltaEnd < 0 ||
          text.slice(deltaStart + "<conversation_update>\n".length, deltaEnd) !== expectedDelta
        )
          errors.push("Conversation delta does not exactly match settled user/assistant text");
        if (text.includes(`STM_ACTIVE_ONLY_INSTRUCTION:${runID}`)) errors.push("Active-only system instruction leaked");
        if (
          row.details.toolNames.length !== 0 ||
          messages.some(
            (message) =>
              message.role === "tool" ||
              (Array.isArray(message.content) &&
                message.content.some(
                  (part: { type: string }) => part.type === "tool-call" || part.type === "tool-result",
                )),
          )
        )
          errors.push("Summary received tools or tool messages");
        if (/stm_memory_(?:read|status|reset|update|logs|settings|setup)|short_term_memory/.test(text))
          errors.push("Native STM tool name leaked into summary prompt");
      } else if (primary) {
        primaryCount++;
        if (row.model !== "deterministic") errors.push("Primary used the wrong selected model");
        if (
          row.details.correlation?.sessionID !== activeSessionID ||
          row.details.correlation?.kind !== "primary" ||
          row.details.correlation?.agent !== "build" ||
          typeof row.details.correlation?.requestID !== "string"
        )
          errors.push("Primary request lacks active-session provenance");
        if (!messages.some((message, i) => message.role === "system" && texts[i].includes(activeInstruction)))
          errors.push("Primary system instruction not observed");
        if (
          messages.some(
            (message, i) => message.role !== "system" && texts[i].includes(`STM_ACTIVE_ONLY_INSTRUCTION:${runID}`),
          )
        )
          errors.push("Instruction sentinel appeared outside primary system context");
      }
      if (summary || primary) {
        requests.push({
          row: index + 1,
          seq: row.seq,
          invocation: row.invocation,
          timestamp: row.timestamp,
          requestKind: row.requestKind,
          provider: row.provider,
          model: row.model,
          correlation: row.details.correlation,
          kind: summary ? "summary" : "primary",
          toolNames: row.details.toolNames,
          promptSha256: createHash("sha256").update(row.details.prompt).digest("hex"),
          prompt: messages,
          verdict: errors.length ? "FAIL" : "PASS",
          errors,
        });
        failures.push(...errors.map((error) => `Invocation ${row.invocation}: ${error}`));
      }
    }
    Object.assign(result, { primaryCount, summaryCount });
    if (!primaryCount) failures.push("No correlated primary provider request");
    if (!summaryCount) failures.push("No correlated summary provider request");
    assert.deepEqual(failures, [], `Clean isolation ${phase} failed`);
    result.verdict = "PASS";
    cleanIsolation.verdict = phase === "explicit-opt-in-followup" ? "PASS" : "PENDING";
  }
  const memoryPath = join(env.PROBE_MEMORY_DIR!, `session_${session.id}.md`);
  const checkpointPath = join(env.PROBE_MEMORY_DIR!, "checkpoints", `${session.id}.last-message-id.txt`);
  function normalizeRequest(row: ReturnType<typeof readTelemetry>[number]): ProviderRequest {
    assert.equal(typeof row.details?.prompt, "string", "Provider prompt telemetry missing");
    const messages = JSON.parse(row.details.prompt);
    assert.ok(Array.isArray(messages) && messages.length > 0, "Malformed provider prompt");
    assert.ok(
      Array.isArray(row.details.toolNames) && row.details.toolNames.every((name: unknown) => typeof name === "string"),
      "Malformed provider tool inventory",
    );
    return {
      messages: messages.map((message) => {
        const role = message.role;
        assert.ok(role === "system" || role === "user" || role === "assistant" || role === "tool");
        if (role === "system") {
          assert.equal(typeof message.content, "string");
          return { role, text: message.content };
        }
        assert.ok(Array.isArray(message.content));
        return {
          role,
          text: message.content
            .filter((part: { type: string }) => part.type === "text")
            .map((part: { text: string }) => {
              assert.equal(typeof part.text, "string");
              return part.text;
            })
            .join(""),
        };
      }),
      tools: row.details.toolNames,
    };
  }
  const isSummary = (request: ProviderRequest) =>
    request.messages.some((message) => message.text.includes("<conversation_update>\n"));
  let rawTelemetry = {
    initial: {
      prompt: prompt as string,
      startRow: -1,
      endRow: -1,
      rawRequests: [] as ReturnType<typeof readTelemetry>,
    },
    followup: {
      prompt: sharedCoreScenario.followupPrompt,
      startRow: -1,
      endRow: -1,
      rawRequests: [] as ReturnType<typeof readTelemetry>,
    },
  };
  let phase: keyof typeof rawTelemetry = "initial";
  let activeSessionID = session.id;
  let gatePhase: "default-off" | "clean-model-override" | "explicit-opt-in" = "default-off";
  const idleAutoUpdate = {
    observed: false,
    manualUpdateInvoked: false,
    expectedCheckpoint: "",
    pollLimitMs: 10_000,
    started: "",
    phases: [] as object[],
  };
  evidence.idleAutoUpdate = idleAutoUpdate;
  let sharedCore: SharedCoreReport & { rawTelemetry: typeof rawTelemetry };
  try {
    evidence.sharedCore = { scenarioID: sharedCoreScenario.scenarioID, verdict: "FAIL", rawTelemetry };
    const initialHistory = await call("session.context", { sessionID: session.id }, (signal) =>
      client.session.context({ sessionID: session.id }, { signal }),
    );
    evidence.sharedCoreFreshSession = { sessionID: session.id, history: initialHistory, setupInvocations };
    assert.deepEqual(initialHistory, [], "Native setup session already contains durable history");
    assert.deepEqual(setupInvocations, [], "Native setup commands invoked the provider");
    assert.ok(!existsSync(memoryPath) && !existsSync(checkpointPath), "Native setup session already has memory");
    const adapter: SharedCoreAdapter = {
      async prompt(text) {
        current = "run";
        phase = text === rawTelemetry.initial.prompt ? "initial" : "followup";
        const range = rawTelemetry[phase];
        assert.equal(text, range.prompt);
        range.startRow = readTelemetry().length;
        await call("session.prompt", { sessionID: activeSessionID, text }, (signal) =>
          client.session.prompt({ sessionID: activeSessionID, text }, { signal }),
        );
        await call(
          "session.wait",
          { sessionID: activeSessionID },
          (signal) => client.session.wait({ sessionID: activeSessionID }, { signal }),
          30_000,
        );
        const history = await call("session.context", { sessionID: activeSessionID }, (signal) =>
          client.session.context({ sessionID: activeSessionID }, { signal }),
        );
        evidence[`${gatePhase}-${phase}-history`] = history;
        const messages: DurableMessage[] = [];
        for (const message of history) {
          if (message.type === "user") messages.push({ id: message.id, role: "user", text: message.text });
          else if (message.type === "assistant")
            messages.push({
              id: message.id,
              role: "assistant",
              text: message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
            });
        }
        const rows = readTelemetry();
        range.endRow = rows.length;
        range.rawRequests = rows.slice(range.startRow, range.endRow).filter((row) => row.event === "model.invocation");
        return {
          messages,
          primaryRequests: range.rawRequests.map(normalizeRequest).filter((request) => !isSummary(request)),
        };
      },
      async waitForAutomaticMemory(assistantID) {
        current = "memory";
        const activeMemoryPath = join(env.PROBE_MEMORY_DIR!, `session_${activeSessionID}.md`);
        const activeCheckpointPath = join(
          env.PROBE_MEMORY_DIR!,
          "checkpoints",
          `${activeSessionID}.last-message-id.txt`,
        );
        const observation = {
          gatePhase,
          sessionID: activeSessionID,
          phase,
          observed: false,
          manualUpdateInvoked: false,
          expectedCheckpoint: assistantID,
          pollLimitMs: 10_000,
          started: new Date().toISOString(),
        };
        idleAutoUpdate.phases.push(observation);
        Object.assign(idleAutoUpdate, { expectedCheckpoint: assistantID, started: observation.started });
        await wait(
          10_000,
          async () => {
            if (![activeMemoryPath, activeCheckpointPath, productionLogPath].every((path) => existsSync(path)))
              return false;
            return (
              readFileSync(activeMemoryPath, "utf8")
                .replace(/^<!-- stm:v1 -->\n/, "")
                .trim() === sharedCoreScenario.memoryResponse.trim() &&
              readFileSync(activeCheckpointPath, "utf8").trim() === assistantID &&
              readFileSync(productionLogPath, "utf8")
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => JSON.parse(line))
                .some(
                  (row) =>
                    row.event === "v2_memory_update_committed" &&
                    row.sessionID === activeSessionID &&
                    row.checkpointID === assistantID &&
                    row.reason === "fresh_context",
                )
            );
          },
          `Automatic ${phase} update did not persist exact shared memory, durable assistant checkpoint and production commit within 10s; no manual update attempted`,
        );
        observation.observed = true;
        const range = rawTelemetry[phase];
        const rows = readTelemetry();
        range.endRow = rows.length;
        range.rawRequests = rows.slice(range.startRow, range.endRow).filter((row) => row.event === "model.invocation");
        auditCleanIsolation(`${gatePhase}-${phase}`, range.startRow, range.endRow, range.prompt);
        idleAutoUpdate.observed = phase === "followup";
        return {
          memory: readFileSync(activeMemoryPath, "utf8"),
          checkpoint: readFileSync(activeCheckpointPath, "utf8").trim(),
          summaryRequests: range.rawRequests.map(normalizeRequest).filter(isSummary),
        };
      },
    };
    const offSession = await call("session.create", { gatePhase }, (signal) =>
      client.session.create(
        {
          title: `Default-off V2 ${runID.slice(0, 8)}`,
          agent: "build",
          model: { providerID: "stm-probe", id: "deterministic" },
          location: { directory: project },
        },
        { signal },
      ),
    );
    activeSessionID = offSession.id;
    assert.ok(
      !existsSync(join(env.PROBE_MEMORY_DIR!, `session_${offSession.id}.md`)) &&
        !existsSync(join(env.PROBE_MEMORY_DIR!, "checkpoints", `${offSession.id}.last-message-id.txt`)),
      "Default-off session already has memory or checkpoint",
    );
    const offEvidence = {
      verdict: "FAIL",
      sessionID: offSession.id,
      gatePropertyAbsent: !Object.hasOwn(settings, "enableLegacyPeriodicSystemTransform"),
      installedPackage: evidence.pluginPackages,
      rawTelemetry,
      turns: [] as object[],
    };
    evidence.defaultOff = offEvidence;
    assert.deepEqual(
      await call("session.context", { sessionID: offSession.id }, (signal) =>
        client.session.context({ sessionID: offSession.id }, { signal }),
      ),
      [],
      "Default-off session must start fresh",
    );
    let retained: readonly DurableMessage[] = [];
    for (const text of [sharedCoreScenario.initialPrompt, sharedCoreScenario.followupPrompt]) {
      const turn = await adapter.prompt(text);
      const assistantID = assertCorePrompt(turn, text);
      assert.equal(turn.messages.length, retained.length + 2, "Default-off must append exactly one durable turn");
      assert.deepEqual(turn.messages.slice(0, retained.length), retained, "Default-off changed prior durable history");
      for (const request of turn.primaryRequests) {
        for (const message of request.messages) {
          assert.ok(!message.text.includes("[MEMORY_SYSTEM]"), "Default-off injected tagged memory");
          assert.ok(
            !message.text.includes("STM_PROBE_MEMORY_SENTINEL:shared-core-parity"),
            "Default-off leaked persisted memory into provider context",
          );
        }
      }
      const automatic = await adapter.waitForAutomaticMemory(assistantID);
      assertCoreMemory(automatic, assistantID, text);
      offEvidence.turns.push({ ...turn, assistantID, automatic });
      retained = turn.messages;
    }
    const offUsage = await call("session.get", { sessionID: offSession.id }, (signal) =>
      client.session.get({ sessionID: offSession.id }, { signal }),
    );
    assert.equal(offUsage.cost, 0);
    offEvidence.verdict = "PASS";
    const overrideSettings = { ...settings };
    const overridePrompt = `${sharedCoreScenario.initialPrompt}\nSTM_CLEAN_OVERRIDE:${runID}`;
    const overrideEvidence = {
      verdict: "FAIL",
      installedPackage: evidence.pluginPackages,
      sessionID: "",
      prompt: overridePrompt,
      settings: {
        ...settings,
        summarizerMode: "clean",
        memoryModel: `stm-probe/${PROBE_MEMORY_MODEL_ID}`,
        sideSessionRetries: 0,
        cleanFallbackToActiveSession: false,
      },
      telemetryPath: env.PROBE_TELEMETRY_PATH!,
      startRow: -1,
      endRow: -1,
      rawTelemetry: undefined as unknown,
      automatic: undefined as unknown,
      turn: undefined as unknown,
      restoredSettings: false,
    };
    evidence.cleanModelOverride = overrideEvidence;
    try {
      Object.assign(settings, overrideEvidence.settings);
      await Bun.write(setupPath, JSON.stringify(settings, null, 2));
      const overrideSession = await call("session.create", { phase: "clean-model-override" }, (signal) =>
        client.session.create(
          {
            title: `Clean override V2 ${runID.slice(0, 8)}`,
            agent: "build",
            model: { providerID: "stm-probe", id: "deterministic" },
            location: { directory: project },
          },
          { signal },
        ),
      );
      activeSessionID = overrideSession.id;
      overrideEvidence.sessionID = overrideSession.id;
      assert.ok(![session.id, offSession.id].includes(overrideSession.id), "Override must use a distinct session");
      assert.deepEqual(
        await call("session.context", { sessionID: overrideSession.id }, (signal) =>
          client.session.context({ sessionID: overrideSession.id }, { signal }),
        ),
        [],
        "Override session must start fresh",
      );
      assert.ok(
        !existsSync(join(env.PROBE_MEMORY_DIR!, `session_${overrideSession.id}.md`)) &&
          !existsSync(join(env.PROBE_MEMORY_DIR!, "checkpoints", `${overrideSession.id}.last-message-id.txt`)),
        "Override session already has memory or checkpoint",
      );
      gatePhase = "clean-model-override";
      rawTelemetry = {
        initial: { prompt: overridePrompt, startRow: -1, endRow: -1, rawRequests: [] },
        followup: { prompt: sharedCoreScenario.followupPrompt, startRow: -1, endRow: -1, rawRequests: [] },
      };
      overrideEvidence.rawTelemetry = rawTelemetry;
      const turn = await adapter.prompt(overridePrompt);
      overrideEvidence.turn = turn;
      const assistantID = assertCorePrompt(turn, overridePrompt);
      assert.equal(turn.messages.length, 2, "Override must contain exactly one durable turn");
      const automatic = await adapter.waitForAutomaticMemory(assistantID);
      overrideEvidence.automatic = automatic;
      assertCoreMemory(automatic, assistantID, overridePrompt);
      Object.assign(overrideEvidence, rawTelemetry.initial);
      const overrideUsage = await call("session.get", { sessionID: overrideSession.id }, (signal) =>
        client.session.get({ sessionID: overrideSession.id }, { signal }),
      );
      assert.deepEqual(overrideUsage.model, { providerID: "stm-probe", id: "deterministic", variant: "default" });
      assert.equal(overrideUsage.cost, 0);
      overrideEvidence.verdict = "PASS";
    } finally {
      Object.assign(settings, overrideSettings);
      await Bun.write(setupPath, JSON.stringify(settings, null, 2));
      overrideEvidence.restoredSettings = true;
      activeSessionID = session.id;
    }
    activeSessionID = session.id;
    gatePhase = "explicit-opt-in";
    settings.enableLegacyPeriodicSystemTransform = true;
    await Bun.write(setupPath, JSON.stringify(settings, null, 2));
    evidence.functionalSettings = { ...settings };
    assert.deepEqual(
      await call("session.context", { sessionID: session.id }, (signal) =>
        client.session.context({ sessionID: session.id }, { signal }),
      ),
      [],
      "Opt-in session must still be fresh after default-off qualification",
    );
    assert.ok(!existsSync(memoryPath) && !existsSync(checkpointPath), "Default-off contaminated the opt-in session");
    rawTelemetry = {
      initial: { prompt, startRow: -1, endRow: -1, rawRequests: [] },
      followup: { prompt: sharedCoreScenario.followupPrompt, startRow: -1, endRow: -1, rawRequests: [] },
    };
    evidence.sharedCore = { scenarioID: sharedCoreScenario.scenarioID, verdict: "FAIL", rawTelemetry };
    sharedCore = Object.assign(await runSharedCoreScenario(adapter), { rawTelemetry });
    evidence.sharedCore = sharedCore;
    for (const request of sharedCore.initial.primaryRequests)
      assert.ok(
        !request.messages.some((message) => message.text.includes("[MEMORY_SYSTEM]")),
        "Fresh opt-in session received another session's memory",
      );
    const expectedMemory = buildTaggedMemoryForInjection(sharedCore.memory.initial.memory, settings.maxMemoryLength);
    assert.ok(expectedMemory.includes("[MEMORY_SYSTEM]"));
    for (const request of sharedCore.followup.primaryRequests) {
      const tagged = request.messages.filter((message) => message.text.includes("[MEMORY_SYSTEM]"));
      assert.equal(tagged.length, 1, "Opt-in must inject memory in exactly one message");
      assert.equal(tagged[0]!.role, "system", "Opt-in memory must be system-role only");
      assert.equal(tagged[0]!.text.split("[MEMORY_SYSTEM]").length - 1, 1, "Duplicate opt-in memory marker");
      assert.equal(
        tagged[0]!.text.slice(tagged[0]!.text.indexOf("[MEMORY_SYSTEM]")).trimEnd(),
        expectedMemory.trimEnd(),
        "Opt-in injection differs from exact persisted memory",
      );
    }
    evidence.explicitOptIn = {
      verdict: "PASS",
      sessionID: session.id,
      installedPackage: evidence.pluginPackages,
      expectedTaggedMemory: expectedMemory,
    };
  } catch (error) {
    const range = rawTelemetry[phase];
    if (range.startRow >= 0) {
      const rows = readTelemetry();
      range.endRow = rows.length;
      range.rawRequests = rows.slice(range.startRow).filter((row) => row.event === "model.invocation");
    }
    evidence.sharedCore = {
      scenarioID: sharedCoreScenario.scenarioID,
      verdict: "FAIL",
      reason: redact(String(error)),
      rawTelemetry,
    };
    throw error;
  }
  stages.run = {
    verdict: "PASS",
    evidence: "Shared driver exact initial/followup native durable turns and provider requests",
  };
  const assistant = sharedCore.initial.messages.at(-1)!;
  const followupAssistant = sharedCore.followup.messages.at(-1)!;
  assert.equal(assistant.id, sharedCore.initial.assistantID);
  assert.equal(followupAssistant.id, sharedCore.followup.assistantID);
  const checkpointBytes = readFileSync(checkpointPath);
  const memory = readFileSync(memoryPath, "utf8");
  const checkpoint = checkpointBytes.toString("utf8").trim();
  for (const heading of [
    "## Session Memory",
    "### User Instructions",
    "### Long Horizon Context",
    "### Decisions",
    "### Conclusions",
    "### Active References",
  ])
    assert.ok(memory.includes(heading));
  assert.ok(memory.includes("STM_PROBE_MEMORY_SENTINEL:shared-core-parity"));
  assert.equal(checkpoint, followupAssistant.id, "Checkpoint is not the exact latest generated durable assistant");
  const log = readFileSync(productionLogPath, "utf8");
  const commits = log
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.event === "v2_memory_update_committed" && row.sessionID === session.id);
  assert.ok(commits.some((row) => row.checkpointID === checkpoint));
  const logRowsBeforeManual = log.split(/\r?\n/).filter(Boolean).length;
  await nativeCommand("update", "STM update", [
    "generation: v2",
    `sessionID: ${session.id}`,
    "update: skipped",
    "reason: no_assistant_in_delta",
    "source: durable-visible-text",
    'progress: cumulative-invocation {"checkpointedChunks":0,"checkpointedMessages":0,"persistedPartialFragments":0}',
    "rollback: not-applicable",
    "detail: none",
  ]);
  assert.equal(readFileSync(memoryPath, "utf8"), memory, "No-delta manual update changed memory");
  assert.deepEqual(readFileSync(checkpointPath), checkpointBytes, "No-delta manual update changed checkpoint bytes");
  const manualLogRows = readFileSync(productionLogPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(logRowsBeforeManual)
    .map((line) => JSON.parse(line))
    .filter((row) => row.sessionID === session.id);
  assert.ok(
    manualLogRows.some((row) => row.event === "v2_memory_update_skipped" && row.reason === "no_assistant_in_delta"),
    "Manual no-delta update produced no exact production skip log",
  );
  assert.ok(!manualLogRows.some((row) => row.event === "v2_memory_update_committed"));
  evidence.manualUpdate = { status: "skipped", reason: "no_assistant_in_delta", unchanged: true, manualLogRows };
  await nativeCommand("show", "STM show", [
    "## Session Memory",
    "### User Instructions",
    "STM_PROBE_MEMORY_SENTINEL:shared-core-parity",
  ]);
  await nativeCommand("status", "STM status", [
    "generation: v2",
    `sessionID: ${session.id}`,
    `memoryPath: ${memoryPath}`,
    `checkpoint: ${checkpoint}`,
    "updaterBusy: false",
  ]);
  const followupInvocations = sharedCore.rawTelemetry.followup.rawRequests.filter(
    (row) => !isSummary(normalizeRequest(row)),
  );
  const injection =
    followupInvocations.length > 0 &&
    followupInvocations.every((row) =>
      normalizeRequest(row).messages.some(
        (message) =>
          message.role === "system" &&
          message.text.includes("[MEMORY_SYSTEM]") &&
          message.text.includes("STM_PROBE_MEMORY_SENTINEL:shared-core-parity"),
      ),
    );
  evidence.memory = {
    memoryPath,
    memory,
    checkpointPath,
    checkpoint,
    productionLogPath,
    commits,
    followupInjectionObserved: injection,
    followupInvocations,
  };
  assert.ok(injection, "Followup provider telemetry did not witness production memory injection");
  const expectedTools = [
    "stm_memory_read",
    "stm_memory_status",
    "stm_memory_reset",
    "stm_memory_update",
    "stm_memory_logs",
    "stm_memory_settings",
    "stm_memory_setup",
    "short_term_memory",
  ];
  for (const name of expectedTools)
    assert.ok(followupInvocations[0].details?.toolNames?.includes(name), `Native provider inventory missing ${name}`);
  evidence.nativeToolInventory = { expectedTools, observed: followupInvocations[0].details.toolNames };
  await nativeCommand(
    "status",
    "STM status",
    ["generation: v2", `sessionID: ${session.id}`, `checkpoint: ${followupAssistant.id}`, "updaterBusy: false"],
    "before-task-status",
  );
  const task = taskChildContract(runID);
  const parentMemoryBytes = readFileSync(memoryPath);
  const parentMemory = parentMemoryBytes.toString("utf8");
  assert.equal(parentMemory.replace(/^<!-- stm:v1 -->\n/, "").trim(), sharedCoreScenario.memoryResponse.trim());
  const parentCheckpointBytes = readFileSync(checkpointPath);
  assert.equal(parentCheckpointBytes.toString("utf8").trim(), followupAssistant.id);
  assert.ok(Number.isInteger(settings.maxMemoryLength) && settings.maxMemoryLength >= parentMemory.length);
  const expectedTaggedMemory = buildTaggedMemoryForInjection(parentMemory, settings.maxMemoryLength);
  assert.ok(expectedTaggedMemory.includes("[MEMORY_SYSTEM]"));
  const taskStartRow = readTelemetry().length;
  const childEvidence = {
    verdict: "FAIL",
    count: 0,
    IDs: { parent: session.id, child: "", call: task.callID, request: "" },
    hash: createHash("sha256").update(parentMemoryBytes).digest("hex"),
    boundary: { startRow: taskStartRow, timestamp: new Date().toISOString() },
    parentBefore: {
      memoryPath,
      memory: parentMemory,
      bytes: parentMemoryBytes.length,
      base64: parentMemoryBytes.toString("base64"),
      checkpointPath,
      checkpoint: parentCheckpointBytes.toString("utf8"),
      checkpointBase64: parentCheckpointBytes.toString("base64"),
    },
    provenance: {
      hostVersion: "2.0.12",
      hostSourcePin: "2670273ff17da96f85c5826ced57aa1b368754fa",
      investigationArtifact:
        "/home/dev/workspace/opencode-work/opencode-short-term-memory-v2-latest-parity/2026-10-07--child-first-request-acceptance.html",
      configSchema: join(fixture, "node_modules/@opencode/schema/dist/config/agent.js"),
      nativeToolSource: "packages/core/src/tool/plugin/subagent.ts",
      fixtureContract: "fixtures/v2-generation-probe/index.ts#taskChildContract",
      expectedInjectionHelper: "src/injection.ts#buildTaggedMemoryForInjection (checkout oracle only)",
      candidateFiles: candidateFiles.length,
      productAdapted: false,
      snapshotBoundary: "First child context, not creation-time capture",
    },
    expectedTaggedMemory,
    firstRequest: undefined as unknown,
    toolResult: undefined as unknown,
    snapshot: undefined as unknown,
    summarySuppression: undefined as unknown,
  };
  evidence.childFirstRequest = childEvidence;
  await call("session.prompt", { sessionID: session.id, text: task.prompt }, (signal) =>
    client.session.prompt({ sessionID: session.id, text: task.prompt }, { signal }),
  );
  await call(
    "session.wait",
    { sessionID: session.id },
    (signal) => client.session.wait({ sessionID: session.id }, { signal }),
    30_000,
  );
  await wait(
    10_000,
    async () =>
      readTelemetry()
        .slice(taskStartRow)
        .some((row) => row.observedEvent === "tool.execute.after" && row.details?.eventData?.id === task.callID),
    "Native foreground subagent completion telemetry missing",
  );
  const taskRows = readTelemetry().slice(taskStartRow);
  const taskDispatches = taskRows.filter(
    (row) => row.event === "model.invocation" && row.details?.toolCall?.toolName === PROBE_TASK_TOOL,
  );
  assert.equal(taskDispatches.length, 1, "Fixture must dispatch the native subagent exactly once");
  const taskDispatch = taskDispatches[0];
  assert.deepEqual(taskDispatch.details.toolCall, {
    toolCallId: task.callID,
    toolName: PROBE_TASK_TOOL,
    input: task.input,
  });
  assert.equal(taskDispatch.details.primaryPrompt, task.prompt);
  assert.equal(taskDispatch.details.correlation?.sessionID, session.id);
  assert.equal(taskDispatch.details.correlation?.agent, "build");
  assert.equal(taskDispatch.details.correlation?.kind, "primary");
  const nativeExecutions = taskRows.filter(
    (row) =>
      row.event === "event.observed" &&
      /^tool.execute\.(before|after)$/.test(row.observedEvent ?? "") &&
      row.details?.eventData?.tool === PROBE_TASK_TOOL,
  );
  assert.equal(
    nativeExecutions.length,
    2,
    "Expected exactly one native subagent execution pair; recursion/retry detected",
  );
  const [beforeTask, afterTask] = nativeExecutions;
  assert.equal(beforeTask.observedEvent, "tool.execute.before");
  assert.equal(afterTask.observedEvent, "tool.execute.after");
  assert.ok(beforeTask.seq < afterTask.seq);
  assert.ok(taskDispatch.seq < beforeTask.seq);
  for (const row of nativeExecutions) {
    const data = row.details.eventData;
    assert.equal(data.id, task.callID);
    assert.equal(data.sessionID, session.id);
    assert.equal(data.agent, "build");
    assert.deepEqual(data.input, task.input);
  }
  assert.equal(beforeTask.details.eventData.messageID, afterTask.details.eventData.messageID);
  assert.equal(afterTask.details.eventData.status, "completed");
  const toolResult = afterTask.details.eventData.result;
  childEvidence.toolResult = { before: beforeTask, after: afterTask };
  assert.equal(toolResult?.output?.status, "completed");
  const childID = toolResult.output.sessionID;
  assert.ok(typeof childID === "string" && /^ses_[A-Za-z0-9_-]+$/.test(childID) && childID !== session.id);
  childEvidence.IDs.child = childID;
  assert.equal(toolResult.metadata?.sessionID, childID);
  assert.equal(toolResult.metadata?.status, "completed");
  assert.equal(toolResult.output.output, "STM_PROBE_STREAM_SENTINEL");
  assert.deepEqual(toolResult.content, [
    {
      type: "text",
      text: `<subagent sessionID="${childID}" state="completed">\nSTM_PROBE_STREAM_SENTINEL\n</subagent>`,
    },
  ]);
  assert.equal(beforeTask.details.memory, parentMemory, "Parent memory changed before native child dispatch");
  assert.equal(beforeTask.details.checkpoint, parentCheckpointBytes.toString("utf8"));
  const childSession = await call("session.get", { sessionID: childID }, (signal) =>
    client.session.get({ sessionID: childID }, { signal }),
  );
  assert.equal(childSession.id, childID);
  assert.equal(childSession.parentID, session.id);
  assert.equal(childSession.agent, PROBE_TASK_CHILD_AGENT);
  assert.deepEqual(childSession.model, { providerID: "stm-probe", id: "deterministic", variant: "default" });
  assert.equal(childSession.cost, 0);
  await call("session.wait", { sessionID: childID }, (signal) =>
    client.session.wait({ sessionID: childID }, { signal }),
  );
  const childHistory = await call("session.context", { sessionID: childID }, (signal) =>
    client.session.context({ sessionID: childID }, { signal }),
  );
  const expectedChildPrompt = `You are a subagent spawned by another session.\n${task.input.prompt}`;
  assert.ok(childHistory.some((message) => message.type === "user" && message.text === expectedChildPrompt));
  assert.ok(
    childHistory.some(
      (message) =>
        message.type === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text === "STM_PROBE_STREAM_SENTINEL"),
    ),
  );
  // Outlast the 100ms idle debounce and observe a bounded quiet window, without freezing the parent updater.
  const settleMs = 1_500;
  await Bun.sleep(remaining(settleMs));
  const settledTelemetry = readTelemetry();
  const invocationsAfterTask = settledTelemetry.slice(taskStartRow).filter((row) => row.event === "model.invocation");
  for (const row of invocationsAfterTask) {
    assert.equal(row.runId, runID);
    assert.equal(row.mode, "ordinary");
    assert.equal(typeof row.details?.prompt, "string");
    const summary =
      String(row.sentinel).startsWith("## Session Memory") || row.details.prompt.includes("<conversation_update>");
    assert.ok(
      summary || row.details.correlation?.requestID,
      "Uncorrelated primary invocation obscures earliest child request",
    );
    assert.ok(
      summary || [session.id, childID].includes(row.details.correlation.sessionID),
      "Unexpected session invocation",
    );
    assert.ok(!summary || !row.details.prompt.includes(task.input.prompt), "Child prompt reached a summary invocation");
  }
  const childInvocations = settledTelemetry.filter(
    (row) => row.event === "model.invocation" && row.details?.correlation?.sessionID === childID,
  );
  const childRequestHooks = settledTelemetry.filter(
    (row) => row.event === "model.request" && row.details?.correlation?.sessionID === childID,
  );
  assert.equal(childRequestHooks.length, 1, "Earlier or additional child model request makes acceptance ambiguous");
  childEvidence.count = childInvocations.length;
  assert.equal(childInvocations.length, 1, "Expected one child invocation, without summary or fixture recursion");
  const firstRequest = childInvocations[0];
  childEvidence.firstRequest = firstRequest;
  const firstRow = settledTelemetry.indexOf(firstRequest);
  assert.ok(firstRow >= taskStartRow, "Child requested a model before task boundary");
  assert.ok(beforeTask.seq < firstRequest.seq && firstRequest.seq < afterTask.seq);
  assert.equal(firstRequest.details.correlation.agent, PROBE_TASK_CHILD_AGENT);
  assert.equal(firstRequest.details.correlation.kind, "primary");
  assert.equal(firstRequest.provider, "stm-probe");
  assert.equal(firstRequest.model, "deterministic");
  assert.equal(firstRequest.requestKind, "doStream");
  assert.equal(firstRequest.sentinel, "STM_PROBE_STREAM_SENTINEL");
  assert.equal(firstRequest.details.toolCall, undefined, "Child fixture recursively dispatched a tool");
  childEvidence.IDs.request = firstRequest.details.correlation.requestID;
  const requestHooks = settledTelemetry.filter(
    (row) => row.event === "model.request" && row.details?.correlation?.requestID === childEvidence.IDs.request,
  );
  assert.equal(requestHooks.length, 1);
  assert.deepEqual(requestHooks[0].details.correlation, firstRequest.details.correlation);
  assert.ok(beforeTask.seq < requestHooks[0].seq && requestHooks[0].seq < firstRequest.seq);
  const firstMessages = JSON.parse(firstRequest.details.prompt);
  assert.ok(Array.isArray(firstMessages));
  assert.ok(
    firstMessages.some(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content
          .filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text)
          .join("") === expectedChildPrompt,
    ),
  );
  const memorySystems = firstMessages.filter(
    (message) =>
      message.role === "system" && typeof message.content === "string" && message.content.includes("[MEMORY_SYSTEM]"),
  );
  assert.equal(memorySystems.length, 1, "First child request lacks a unique SYSTEM memory injection");
  assert.equal(memorySystems[0].content.split("[MEMORY_SYSTEM]").length - 1, 1, "Duplicate child memory marker");
  assert.equal(
    memorySystems[0].content.slice(memorySystems[0].content.indexOf("[MEMORY_SYSTEM]")).trimEnd(),
    expectedTaggedMemory.trimEnd(),
    "First child SYSTEM injection differs from exact parent memory oracle",
  );
  assert.ok(
    !firstMessages.some(
      (message) => message.role !== "system" && JSON.stringify(message.content).includes("[MEMORY_SYSTEM]"),
    ),
  );
  assert.ok(
    !settledTelemetry
      .slice(0, firstRow)
      .some(
        (row) =>
          row.event === "model.invocation" &&
          row.details?.prompt?.includes(task.input.prompt) &&
          !row.details?.correlation?.requestID,
      ),
    "Earlier uncorrelated child-marker invocation makes first-request acceptance ambiguous",
  );
  const snapshotPath = join(env.PROBE_MEMORY_DIR!, "task-children", `${childID}.json`);
  assert.ok(existsSync(snapshotPath), "Production child snapshot missing");
  assert.ok((await lstat(snapshotPath)).isFile());
  const snapshotBytes = readFileSync(snapshotPath);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  childEvidence.snapshot = {
    path: snapshotPath,
    value: snapshot,
    sha256: createHash("sha256").update(snapshotBytes).digest("hex"),
  };
  assert.deepEqual(snapshot, { version: 1, sessionID: childID, parentID: session.id, memory: parentMemory });
  const childMemoryPath = join(env.PROBE_MEMORY_DIR!, `session_${childID}.md`);
  const childCheckpointPath = join(env.PROBE_MEMORY_DIR!, "checkpoints", `${childID}.last-message-id.txt`);
  const childLogRows = readFileSync(productionLogPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.sessionID === childID);
  const summarySuppression = {
    settleMs,
    idleDebounceMs: settings.debounceMs,
    memoryPath: childMemoryPath,
    memoryExists: existsSync(childMemoryPath),
    checkpointPath: childCheckpointPath,
    checkpointExists: existsSync(childCheckpointPath),
    childLogRows,
    history: childHistory,
    session: childSession,
    nativeExecutionCount: settledTelemetry
      .slice(taskStartRow)
      .filter((row) => row.observedEvent === "tool.execute.before" && row.details?.eventData?.tool === PROBE_TASK_TOOL)
      .length,
  };
  childEvidence.summarySuppression = summarySuppression;
  assert.ok(!existsSync(childMemoryPath), "Child produced its own summary memory");
  assert.ok(!existsSync(childCheckpointPath), "Child checkpoint must remain absent");
  assert.ok(!childLogRows.some((row) => row.event === "v2_memory_update_committed"), "Child updater committed");
  assert.equal(summarySuppression.nativeExecutionCount, 1, "Fixture recursion after completion");
  childEvidence.verdict = "PASS";
  // Qualify production compaction injection with an already checkpointed durable conversation.
  await nativeCommand(
    "status",
    "STM status",
    ["generation: v2", `sessionID: ${session.id}`, "updaterBusy: false"],
    "before-compaction-status",
  );
  const compactionMemory = readFileSync(memoryPath);
  const compactionCheckpoint = readFileSync(checkpointPath);
  const compactionTaggedMemory = buildTaggedMemoryForInjection(
    compactionMemory.toString("utf8"),
    settings.maxMemoryLength,
  );
  const compactionStartRow = readTelemetry().length;
  const compactionEvidence = {
    verdict: "FAIL",
    sessionID: session.id,
    startRow: compactionStartRow,
    expectedTaggedMemory: compactionTaggedMemory,
    scope:
      "Native completed compaction and production SYSTEM injection; no pending-delta refresh, failure or cancellation proof",
    rawTelemetry: [] as ReturnType<typeof readTelemetry>,
    durable: undefined as unknown,
    history: {
      targetID: "",
      maxPages: 5,
      pageLimit: 200,
      pages: [] as { count: number; cursor: { previous?: string | null; next?: string | null } }[],
      complete: false,
      stopReason: "page-bound",
    },
  };
  evidence.productionCompaction = compactionEvidence;
  const compacted = await call("session.compact", { sessionID: session.id }, (signal) =>
    client.session.compact({ sessionID: session.id }, { signal }),
  );
  assert.equal(compacted.type, "compaction");
  assert.equal(compacted.sessionID, session.id);
  assert.ok(typeof compacted.id === "string" && compacted.id.length > 0, "Native compaction lacks a target ID");
  compactionEvidence.history.targetID = compacted.id;
  await call(
    "session.wait",
    { sessionID: session.id },
    (signal) => client.session.wait({ sessionID: session.id }, { signal }),
    30_000,
  );
  const compactionMessages: Awaited<ReturnType<typeof client.message.list>>["data"] = [];
  const compactionCursors = new Set<string>();
  let compactionCursor: string | undefined;
  for (let pageIndex = 0; pageIndex < compactionEvidence.history.maxPages; pageIndex++) {
    const input = {
      sessionID: session.id,
      limit: compactionEvidence.history.pageLimit,
      ...(compactionCursor === undefined ? { order: "asc" as const } : { cursor: compactionCursor }),
    };
    const page = await call("message.list", input, (signal) => client.message.list(input, { signal }));
    compactionEvidence.history.pages.push({ count: page.data.length, cursor: page.cursor });
    compactionMessages.push(...page.data);
    const next = page.cursor.next ?? undefined;
    compactionEvidence.history.complete = next === undefined;
    // A target record proves this compaction, not exhaustion of the session history.
    if (page.data.some((message) => message.id === compacted.id)) {
      compactionEvidence.history.stopReason = "target-found";
      break;
    }
    if (next === undefined || page.data.length === 0) {
      compactionEvidence.history.stopReason = next === undefined ? "cursor-exhausted" : "empty-page";
      break;
    }
    assert.ok(!compactionCursors.has(next), "Compaction history repeated a cursor before finding the target");
    compactionCursors.add(next);
    compactionCursor = next;
  }
  const durableCompactions = compactionMessages.filter(
    (message) => message.type === "compaction" && message.id === compacted.id,
  );
  assert.equal(durableCompactions.length, 1, "Expected the exact native compaction within bounded observed history");
  const durableCompaction = durableCompactions[0]!;
  compactionEvidence.durable = durableCompaction;
  assert.ok(durableCompaction.type === "compaction");
  assert.equal(durableCompaction.id, compacted.id);
  assert.equal(durableCompaction.status, "completed");
  assert.ok(durableCompaction.status === "completed");
  assert.equal(durableCompaction.summary, PROBE_COMPACTION_SUMMARY);
  assert.equal(durableCompaction.reason, "manual");
  const compactionRows = readTelemetry().slice(compactionStartRow);
  compactionEvidence.rawTelemetry = compactionRows;
  for (const row of compactionRows) assert.equal(row.runId, runID);
  const compactionRequests = compactionRows.filter(
    (row) =>
      row.event === "model.request" &&
      row.requestKind === "compaction" &&
      row.details?.correlation?.sessionID === session.id,
  );
  assert.equal(compactionRequests.length, 1, "Native compaction model request missing or repeated");
  const compactionInvocations = compactionRows.filter(
    (row) =>
      row.event === "model.invocation" &&
      row.details?.correlation?.requestID === compactionRequests[0].details.correlation.requestID,
  );
  assert.equal(compactionInvocations.length, 1, "Expected exactly one correlated compaction invocation");
  const compactionInvocation = compactionInvocations[0];
  assert.equal(compactionInvocation.provider, "stm-probe");
  assert.equal(compactionInvocation.model, "deterministic");
  assert.equal(compactionInvocation.sentinel, PROBE_COMPACTION_SUMMARY);
  assert.ok(compactionRequests[0].seq < compactionInvocation.seq, "Compaction invocation predates its model request");
  const compactionRequest = normalizeRequest(compactionInvocation);
  const compactionMemoryMessages = compactionRequest.messages.filter((message) =>
    message.text.includes("[MEMORY_SYSTEM]"),
  );
  assert.equal(compactionMemoryMessages.length, 1, "Compaction lacks unique tagged memory");
  const compactionSystem = compactionMemoryMessages[0]!;
  assert.equal(compactionSystem.role, "system", "Compaction memory is not system-role");
  assert.equal(compactionSystem.text.split("[MEMORY_SYSTEM]").length - 1, 1, "Duplicate compaction memory marker");
  assert.equal(
    compactionSystem.text.slice(compactionSystem.text.indexOf("[MEMORY_SYSTEM]")).trimEnd(),
    compactionTaggedMemory.trimEnd(),
    "Compaction SYSTEM memory differs from persisted production memory",
  );
  for (const event of ["callback.enter", "callback.exit"]) {
    const callbacks = compactionRows.filter((row) => row.event === event && row.operation === "compaction");
    assert.equal(callbacks.length, 1, `Expected exactly one compaction ${event}`);
    assert.equal(callbacks[0].depth, 1);
    if (event === "callback.exit") assert.equal(callbacks[0].outcome, "success");
  }
  assert.ok(!compactionRows.some((row) => row.observedEvent === "session.compaction.failed"));
  assert.deepEqual(readFileSync(memoryPath), compactionMemory, "Compaction changed checkpointed memory");
  assert.deepEqual(readFileSync(checkpointPath), compactionCheckpoint, "Compaction changed checkpoint bytes");
  compactionEvidence.verdict = "PASS";
  // Keep compaction template headings out of the reset fixture's prompt classification.
  const resetSession = await createUpdateSession(`Reset boundary V2 ${runID.slice(0, 8)}`);
  const resetSeedPrompt = `${sharedCoreScenario.initialPrompt}\nSTM_RESET_SEED:${runID}`;
  const resetSeed = await promptUpdateSession(resetSession.id, resetSeedPrompt);
  await waitForUpdate(resetSession.id, resetSeed.assistantID);
  const resetMemoryPath = join(env.PROBE_MEMORY_DIR!, `session_${resetSession.id}.md`);
  const resetCheckpointPath = join(env.PROBE_MEMORY_DIR!, "checkpoints", `${resetSession.id}.last-message-id.txt`);
  const resetTuiCommand = [
    "/usr/bin/timeout",
    "--kill-after=2s",
    `${Math.floor(remaining(60_000) / 1000)}s`,
    binary,
    "--server",
    endpoint,
    "--session",
    resetSession.id,
  ]
    .map(quote)
    .join(" ");
  await terminal(["respawn-pane", "-k", "-t", "published:0.0", "-c", project, resetTuiCommand]);
  await wait(
    20_000,
    async () => {
      const screen = (await terminal(["capture-pane", "-p", "-t", "published:0.0"])).stdout;
      await save("reset-route-screen.txt", screen);
      return screen.includes(resetSession.title!);
    },
    "Actual tmux TUI did not show fresh reset session route",
  );
  const resetEvidence = {
    verdict: "FAIL",
    sessionID: resetSession.id,
    seedPrompt: resetSeedPrompt,
    seedCheckpoint: resetSeed.assistantID,
    refusalPreserved: false,
    boundaryAnchor: "",
    expectedBoundaryAnchor: "",
    settledHistory: [] as Awaited<ReturnType<typeof client.session.context>>,
    immediateMemory: "",
    immediateCheckpointBytes: -1,
    postResetPrompt: `STM_POST_RESET_DELTA:${runID}`,
    postResetCheckpoint: "",
    postResetMessages: [] as DurableMessage[],
    postResetSummaryRequests: [] as ProviderRequest[],
  };
  evidence.productionReset = resetEvidence;
  const resetMemoryBefore = readFileSync(resetMemoryPath);
  const resetCheckpointBefore = readFileSync(resetCheckpointPath);
  assertCoreMemory(
    {
      memory: resetMemoryBefore.toString("utf8"),
      checkpoint: resetCheckpointBefore.toString("utf8").trim(),
      summaryRequests: telemetryRowsFor(resetSeed.beforeRows)
        .filter((row) => row.event === "model.invocation")
        .map(normalizeRequest)
        .filter(isSummary),
    },
    resetSeed.assistantID,
    resetSeedPrompt,
  );
  await nativeCommand(
    "reset",
    "STM reset",
    ["Refused: reset not run. Use /stm reset confirm true with exact literal confirmation."],
    "reset-refusal",
    resetSession.id,
  );
  assert.deepEqual(readFileSync(resetMemoryPath), resetMemoryBefore, "Unconfirmed reset changed memory bytes");
  assert.deepEqual(
    readFileSync(resetCheckpointPath),
    resetCheckpointBefore,
    "Unconfirmed reset changed checkpoint bytes",
  );
  resetEvidence.refusalPreserved = true;
  await call(
    "session.wait",
    { sessionID: resetSession.id },
    (signal) => client.session.wait({ sessionID: resetSession.id }, { signal }),
    30_000,
  );
  await nativeCommand(
    "status",
    "STM status",
    ["generation: v2", `sessionID: ${resetSession.id}`, "updaterBusy: false"],
    "before-reset-status",
    resetSession.id,
  );
  const resetHistory = await call("session.context", { sessionID: resetSession.id }, (signal) =>
    client.session.context({ sessionID: resetSession.id }, { signal }),
  );
  resetEvidence.settledHistory = resetHistory;
  const resetSeedAssistant = resetHistory.find((message) => message.id === resetSeed.assistantID);
  assert.ok(
    resetSeedAssistant?.type === "assistant" && typeof resetSeedAssistant.time.completed === "number",
    "Reset snapshot lacks the completed seed assistant",
  );
  assert.equal(
    readFileSync(resetCheckpointPath, "utf8").trim(),
    resetSeed.assistantID,
    "Pre-reset checkpoint is not the seed assistant",
  );
  for (const message of resetHistory) {
    if (message.type === "assistant")
      assert.ok(typeof message.time.completed === "number", "Reset snapshot contains an unfinished assistant");
    assert.notEqual(message.type, "compaction", "Reset qualification must not contain compaction history");
  }
  const resetAnchor = resetHistory.at(-1)?.id;
  assert.ok(typeof resetAnchor === "string" && resetAnchor.trim(), "Reset snapshot lacks a last durable ID");
  assert.equal(resetHistory.filter((message) => message.id === resetAnchor).length, 1, "Reset anchor is not unique");
  resetEvidence.expectedBoundaryAnchor = resetAnchor;
  await nativeCommand(
    "reset confirm true",
    "STM reset",
    [
      "reset: completed",
      "scope: memory, checkpoint, and reset boundary",
      `resetBoundaryAnchor: ${resetAnchor}`,
      "boundaryScope: through last record of settled durable snapshot; not invocation message",
    ],
    "reset-confirmed",
    resetSession.id,
  );
  const resetBoundaryPath = join(
    env.PROBE_MEMORY_DIR!,
    "reset-boundaries",
    `${resetSession.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
  );
  assert.ok(existsSync(resetBoundaryPath), "Confirmed reset did not persist a boundary");
  const resetBoundary = parseV2ResetBoundary(readFileSync(resetBoundaryPath));
  assert.deepEqual(resetBoundary, { version: 1, anchorID: resetAnchor });
  resetEvidence.boundaryAnchor = resetBoundary.anchorID;
  const resetMemory = readFileSync(resetMemoryPath);
  const resetCheckpoint = readFileSync(resetCheckpointPath);
  assert.deepEqual(resetMemory, Buffer.from(RESET_MEMORY_TEMPLATE, "utf8"), "Reset did not write the exact template");
  assert.deepEqual(resetCheckpoint, Buffer.alloc(0), "Reset did not immediately empty the checkpoint");
  resetEvidence.immediateMemory = resetMemory.toString("utf8");
  resetEvidence.immediateCheckpointBytes = resetCheckpoint.length;
  const postReset = await promptUpdateSession(resetSession.id, resetEvidence.postResetPrompt);
  await waitForUpdate(resetSession.id, postReset.assistantID);
  resetEvidence.postResetCheckpoint = readFileSync(resetCheckpointPath, "utf8").trim();
  assert.equal(
    resetEvidence.postResetCheckpoint,
    postReset.assistantID,
    "Post-reset checkpoint is not the new assistant record",
  );
  assert.notEqual(
    resetEvidence.postResetCheckpoint,
    resetEvidence.boundaryAnchor,
    "Post-reset delta reused reset anchor",
  );
  const postResetAnchorIndices = postReset.history.flatMap((message, index) =>
    message.id === resetAnchor ? [index] : [],
  );
  assert.equal(postResetAnchorIndices.length, 1, "Post-reset durable history lost the unique reset anchor");
  // Internal records such as idle carry boundary IDs but contribute no visible delta text.
  for (const message of postReset.history.slice(postResetAnchorIndices[0]! + 1)) {
    if (message.type === "user")
      resetEvidence.postResetMessages.push({ id: message.id, role: "user", text: message.text });
    else if (message.type === "assistant") {
      assert.ok(typeof message.time.completed === "number", "Post-reset assistant is unfinished");
      resetEvidence.postResetMessages.push({
        id: message.id,
        role: "assistant",
        text: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      });
    }
  }
  assert.equal(resetEvidence.postResetMessages.length, 2, "Post-reset delta must contain exactly one new durable turn");
  const postResetRequests = telemetryRowsFor(postReset.beforeRows)
    .filter((row) => row.event === "model.invocation")
    .map(normalizeRequest);
  resetEvidence.postResetSummaryRequests = postResetRequests.filter(isSummary);
  assert.equal(
    assertCorePrompt(
      {
        messages: resetEvidence.postResetMessages,
        primaryRequests: postResetRequests.filter((request) => !isSummary(request)),
      },
      resetEvidence.postResetPrompt,
    ),
    postReset.assistantID,
  );
  assertCoreMemory(
    {
      memory: readFileSync(resetMemoryPath, "utf8"),
      checkpoint: resetEvidence.postResetCheckpoint,
      summaryRequests: resetEvidence.postResetSummaryRequests,
    },
    postReset.assistantID,
    resetEvidence.postResetPrompt,
  );
  assert.deepEqual(
    parseV2ResetBoundary(readFileSync(resetBoundaryPath)),
    resetBoundary,
    "Post-reset update changed boundary",
  );
  resetEvidence.verdict = "PASS";
  advancedUpdates.phases.push({ name: "reset-boundary", ...resetEvidence });
  advancedUpdates.verdict = "PASS";
  evidence.advancedNativeCoverage = {
    distinctModelRouting:
      "PASS: fresh native clean override; all matching primary invocations deterministic, all bounded summary invocations deterministic-memory; automatic exact memory/checkpoint; settings restored",
    retry: "PASS: deterministic-memory first failure followed by one clean retry on the explicit second model",
    fallback: "PASS: deterministic first failure followed by bounded active-session fallback without a model override",
    cancellation:
      "PASS: pending update cancelled on session removal with V2GenerationCancelledError/summarizer_cancelled; host completion or abort observed within 5s, then no commit or recreation of all four artifacts during bounded post-settlement observation; native provider abort not guaranteed",
    reset:
      "PASS: fresh settled session isolated from compaction; slash refusal preserved bytes; exact last-durable-record reset anchor, immediate template/empty checkpoint, and exact one-turn post-reset summary delta excluding old history",
    compaction: "PASS: completed native compaction and exact production SYSTEM injection; pending-delta refresh NOTRUN",
  };
  const finalSession = await call("session.get", { sessionID: session.id }, (signal) =>
    client.session.get({ sessionID: session.id }, { signal }),
  );
  assert.equal(finalSession.cost, 0);
  for (const file of candidateFiles) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(candidateDirectory, file.path)))
        .digest("hex"),
      file.sha256,
      `Candidate changed during host run: ${file.path}`,
    );
  }
  evidence.usage = { cost: finalSession.cost, tokens: finalSession.tokens };
  stages.memory = {
    verdict: "PASS",
    evidence:
      "Default-off exact automatic memory/checkpoints without injection; fresh clean model override with distinct primary/summary routing and automatic checkpoint; explicit opt-in shared core and unique exact SYSTEM injection; per-turn clean isolation; native no-delta skip/show/status; eight tools; child SYSTEM inheritance/snapshot and summary suppression; completed native production compaction with exact SYSTEM injection",
  };
} catch (error) {
  const failure = serializeFailure(error, secrets);
  stages[current] = { verdict: "FAIL", evidence: failure };
  evidence.error = failure;
  process.exitCode = 1;
} finally {
  let tmuxPID: number | undefined;
  if (tuiStarted) {
    const identity = await terminal(["display-message", "-p", "#{pid}"], true, true).catch(() => undefined);
    evidence.tmuxServerIdentity = identity;
    if (identity?.status === 0 && /^\d+$/.test(identity.stdout.trim())) tmuxPID = Number(identity.stdout.trim());
    await terminal(["kill-server"], true, true).catch(
      (error) => (evidence.tmuxCleanupError = serializeFailure(error, secrets)),
    );
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) kill(child, "SIGTERM");
  }
  await Bun.sleep(300);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) kill(child);
  }
  const childExitDeadline = Date.now() + Math.min(2_000, Math.max(0, deadline - Date.now()));
  while ([...children].some((child) => child.exitCode === null && child.signalCode === null)) {
    if (Date.now() >= childExitDeadline) break;
    await Bun.sleep(50);
  }
  evidence.childCleanup = [...children].map((child) => ({
    pid: child.pid,
    exitCode: child.exitCode,
    signal: child.signalCode,
    exited: child.exitCode !== null || child.signalCode !== null,
  }));
  const childrenExited = (evidence.childCleanup as { exited: boolean }[]).every((child) => child.exited);
  if (tuiStarted && existsSync(socket)) {
    try {
      await Bun.sleep(100);
      const stopped = await terminal(["list-sessions"], true, true).catch(() => undefined);
      const sessionStopped = await terminal(["has-session", "-t", "published"], true, true).catch(() => undefined);
      evidence.tmuxStoppedVerification = stopped;
      evidence.tmuxHasSessionVerification = sessionStopped;
      let pidDead = false;
      if (tmuxPID !== undefined) {
        try {
          process.kill(tmuxPID, 0);
        } catch (error) {
          pidDead = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
      const serverDead = [stopped, sessionStopped].every(
        (result) =>
          result?.status === 1 &&
          !result.timedOut &&
          /no server running|Connection refused|server exited unexpectedly/.test(result.stderr) &&
          (!result.stderr.includes("server exited unexpectedly") || pidDead),
      );
      evidence.tmuxOrphanSocketVerification = { tmuxPID, pidDead, serverDead, childrenExited, unlinked: false };
      // A lingering PID is not proof of a live server; require both socket probes and child exit.
      if (serverDead && childrenExited) {
        assert.ok((await lstat(socket)).isSocket(), "Test-owned tmux path is not a socket");
        await unlink(socket);
        evidence.tmuxOrphanSocketVerification = { tmuxPID, pidDead, serverDead, childrenExited, unlinked: true };
      }
    } catch (error) {
      evidence.tmuxCleanupError = serializeFailure(error, secrets);
    }
  }
  await stopService(true).catch((error) => (evidence.serviceCleanupError = serializeFailure(error, secrets)));
  await Bun.sleep(100);
  evidence.tmuxSocketExistsAfterCleanup = existsSync(socket);
  if (evidence.tmuxSocketExistsAfterCleanup)
    evidence.tmuxCleanupError ??= { message: "Test-owned tmux socket remains; server death not proven" };
  await save("serve.log", serveLog);
  const logs = await files(root).catch(() => []);
  evidence.hostLogPaths = logs.filter((path) => path.endsWith("/opencode.log"));
  for (const [index, path] of (evidence.hostLogPaths as string[]).entries())
    await save(`host-${index}.log`, readFileSync(path, "utf8"));
  evidence.elapsedMs = Date.now() - started;
  const requiredStages: Stage[] = setupOnly
    ? ["install", "load", "setup"]
    : ["install", "load", "setup", "run", "memory"];
  const cleanupPassed =
    !(evidence.tmuxSocketExistsAfterCleanup || evidence.tmuxCleanupError || evidence.serviceCleanupError) &&
    (evidence.childCleanup as { exited: boolean }[]).every((child) => child.exited);
  evidence.verdict =
    !evidence.error && cleanupPassed && requiredStages.every((stage) => stages[stage].verdict === "PASS")
      ? "PASS"
      : "FAIL";
  if (evidence.verdict !== "PASS") process.exitCode = 1;
  clearTimeout(watchdog);
  await save("evidence.json", evidence);
  console.log(
    JSON.stringify(
      {
        runID,
        evidence: join(root, "evidence.json"),
        verdict: evidence.verdict,
        version: productVersion,
        setupOnly,
        stages,
        elapsedMs: evidence.elapsedMs,
        costConsumed: 0,
        globalBudgetChanged: false,
        remaining:
          evidence.verdict === "PASS"
            ? setupOnly
              ? "Conversation and memory acceptance NOTRUN; setup-only scope"
              : "Deterministic inference does not establish semantic summarization quality"
            : "Later stages NOTRUN; no product/loader fallback attempted",
      },
      null,
      2,
    ),
  );
}
