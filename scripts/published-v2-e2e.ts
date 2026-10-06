import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { OpenCode } from "../fixtures/v2-generation-probe/node_modules/@opencode/client/dist/promise/index.js";
import { dialogRows, tuiReadiness } from "../fixtures/v2-generation-probe/tui-output/production-acceptance.js";
import { redactDiagnostic, serializeFailure } from "../fixtures/v2-generation-probe/diagnostic-redaction.js";
import { parse } from "jsonc-parser";

// Explicit invocation only; neither the product nor its loader is adapted.
const started = Date.now();
const deadline = started + 320_000;
const parent = "/home/dev/workspace/opencode-work/stm-published-rc-e2e";
const root = await mkdtemp(join(parent, "v2-"));
const runID = randomUUID();
const socket = join("/tmp/opencode", `v2-${runID.slice(0, 8)}.sock`);
const project = join(root, "project");
const host = join(root, "host");
const bun = await realpath(process.execPath);
const fixture = await realpath(join(import.meta.dir, "../fixtures/v2-generation-probe"));
const spec = "@atonev/opencode-short-term-memory@1.4.0-rc.1";
const candidateInput = Bun.argv[2];
let configuredTarget = spec;
let productVersion = "1.4.0-rc.1";
let candidateDirectory = "";
let candidateFiles: { path: string; sha256: string }[] = [];
type Stage = "install" | "load" | "setup" | "run" | "memory";
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
  // This scenario records prompts but does not match any fixture tool-dispatch marker.
  PROBE_SCENARIO: "reset",
  PROBE_TELEMETRY_PATH: join(root, "telemetry.jsonl"),
  PROBE_MEMORY_DIR: join(project, ".opencode", "memory"),
};
const configDir = join(env.XDG_CONFIG_HOME!, "opencode");
const serverConfig = join(configDir, "opencode.json");
const cliConfig = join(configDir, "cli.json");
const serviceFile = join(env.XDG_STATE_HOME!, "opencode", "service.json");
const evidence: Record<string, unknown> = {
  runID,
  root,
  started: new Date(started).toISOString(),
  investigationArtifact: join(parent, "2026-10-06--investigation.html"),
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
try {
  assert.ok(Bun.argv.length <= 3, "Supply at most one absolute candidate tarball path");
  assert.ok(existsSync(evidence.investigationArtifact as string), "Required investigation artifact missing");
  assert.ok(existsSync(dirname(socket)), "Short tmux socket parent missing");
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
    evidence.pluginRegistry = await registry("@atonev/opencode-short-term-memory", "1.4.0-rc.1");
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
  async function nativeCommand(text: string, title: string, lines: string[]) {
    await call(
      "session.command",
      { sessionID: session.id, name: "stm", text },
      (signal) => client.session.command({ sessionID: session.id, name: "stm", text }, { signal }),
      45_000,
    );
    await wait(
      8_000,
      async () => {
        const screen = (await terminal(["capture-pane", "-p", "-t", "published:0.0"])).stdout;
        await save(`${text.replaceAll(" ", "-")}-screen.txt`, screen);
        const rows = screen.split(/\r?\n/);
        const titleMatch = rows.map((row) => new RegExp(`${title}[ \\t]+esc[ \\t]*$`).exec(row)).find(Boolean);
        return !!titleMatch && dialogRows(rows.map((row) => row.slice(titleMatch.index)).join("\n"), title, lines);
      },
      `Actual ${title} dialog missing expected rendered output`,
    );
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
  await nativeCommand("setup", "STM setup", [
    "Refused: setup not run. Use /stm setup confirm true with exact literal confirmation.",
  ]);
  assert.ok(!existsSync(setupPath), "Unconfirmed native setup wrote config");
  await nativeCommand("setup confirm true", "STM setup", [`Created project example config at ${setupPath}.`]);
  assert.ok(existsSync(setupPath), "Confirmed native setup created no config");
  const created = readFileSync(setupPath, "utf8");
  evidence.setupCreatedConfig = { path: setupPath, text: created };
  await save("setup-created-stm.jsonc", created);
  const settings = parse(created);
  Object.assign(settings, {
    enabled: true,
    summarizerMode: "clean",
    memoryDir: env.PROBE_MEMORY_DIR,
    maxDeltaMessages: 200,
    maxUpdateInputLength: 20_000,
  });
  await Bun.write(setupPath, JSON.stringify(settings, null, 2));
  evidence.functionalSettings = settings;
  stages.setup = {
    verdict: "PASS",
    evidence:
      "Native refusal rendered/no write; native confirmed setup rendered and actual config preserved before test settings adjustment",
  };
  current = "run";
  const prompt = `Published V2 conversation ${runID}: retain the cobalt decision and respond normally without tools.`;
  await call("session.prompt", { sessionID: session.id, text: prompt }, (signal) =>
    client.session.prompt({ sessionID: session.id, text: prompt }, { signal }),
  );
  await call(
    "session.wait",
    { sessionID: session.id },
    (signal) => client.session.wait({ sessionID: session.id }, { signal }),
    30_000,
  );
  const history = await call("session.context", { sessionID: session.id }, (signal) =>
    client.session.context({ sessionID: session.id }, { signal }),
  );
  evidence.generatedHistory = history;
  assert.ok(history.some((message) => message.type === "user" && message.text.includes(runID)));
  assert.ok(
    history.some(
      (message) =>
        message.type === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text.includes("STM_PROBE_STREAM_SENTINEL")),
    ),
  );
  stages.run = {
    verdict: "PASS",
    evidence: "Actual native session prompt/wait and durable assistant generated by deterministic fixture",
  };
  current = "memory";
  await nativeCommand("update", "STM update", ["generation: v2", `sessionID: ${session.id}`, "update: committed"]);
  const memoryPath = join(env.PROBE_MEMORY_DIR!, `session_${session.id}.md`);
  const checkpointPath = join(env.PROBE_MEMORY_DIR!, "checkpoints", `${session.id}.last-message-id.txt`);
  const memory = readFileSync(memoryPath, "utf8");
  const checkpoint = readFileSync(checkpointPath, "utf8").trim();
  for (const heading of [
    "## Session Memory",
    "### User Instructions",
    "### Long Horizon Context",
    "### Decisions",
    "### Conclusions",
    "### Active References",
  ])
    assert.ok(memory.includes(heading));
  assert.ok(memory.includes(`STM_PROBE_MEMORY_SENTINEL:${runID}`));
  assert.ok(
    history.some((message) => message.id === checkpoint),
    "Checkpoint is not generated durable history",
  );
  const log = readFileSync(join(env.PROBE_MEMORY_DIR!, "session-memory.log"), "utf8");
  const commits = log
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.event === "v2_memory_update_committed" && row.sessionID === session.id);
  assert.ok(commits.some((row) => row.checkpointID === checkpoint));
  await nativeCommand("show", "STM show", [
    "## Session Memory",
    "### User Instructions",
    `STM_PROBE_MEMORY_SENTINEL:${runID}`,
  ]);
  await nativeCommand("status", "STM status", [
    "generation: v2",
    `sessionID: ${session.id}`,
    `memoryPath: ${memoryPath}`,
    `checkpoint: ${checkpoint}`,
  ]);
  await call(
    "session.prompt",
    { sessionID: session.id, text: "Continue with the retained decision, no tools." },
    (signal) =>
      client.session.prompt(
        { sessionID: session.id, text: "Continue with the retained decision, no tools." },
        { signal },
      ),
  );
  await call(
    "session.wait",
    { sessionID: session.id },
    (signal) => client.session.wait({ sessionID: session.id }, { signal }),
    30_000,
  );
  const telemetry = readFileSync(env.PROBE_TELEMETRY_PATH!, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const injection = telemetry.some(
    (row) =>
      row.event === "model.invocation" &&
      row.requestKind === "doStream" &&
      row.sentinel === "STM_PROBE_STREAM_SENTINEL" &&
      String(row.details?.prompt).includes("[MEMORY_SYSTEM]") &&
      String(row.details?.prompt).includes(`STM_PROBE_MEMORY_SENTINEL:${runID}`),
  );
  evidence.memory = { memoryPath, memory, checkpointPath, checkpoint, commits, followupInjectionObserved: injection };
  assert.ok(injection, "Followup provider telemetry did not witness production memory injection");
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
      "Native update/show/status rendered; production schema/sentinel/checkpoint/commit log; followup provider injection observed",
  };
} catch (error) {
  const failure = serializeFailure(error, secrets);
  stages[current] = { verdict: "FAIL", evidence: failure };
  evidence.error = failure;
  process.exitCode = 1;
} finally {
  if (tuiStarted)
    await terminal(["kill-server"], true, true).catch(
      (error) => (evidence.tmuxCleanupError = serializeFailure(error, secrets)),
    );
  if (tuiStarted && existsSync(socket)) {
    const stopped = await terminal(["list-sessions"], true, true).catch(() => undefined);
    evidence.tmuxStoppedVerification = stopped;
    if (stopped?.status !== 0 && stopped?.stderr.includes("no server running")) await unlink(socket);
  }
  for (const child of children) kill(child, "SIGTERM");
  await Bun.sleep(300);
  for (const child of children) kill(child);
  await stopService(true).catch((error) => (evidence.serviceCleanupError = serializeFailure(error, secrets)));
  await Bun.sleep(100);
  evidence.childCleanup = [...children].map((child) => ({
    pid: child.pid,
    exitCode: child.exitCode,
    signal: child.signalCode,
    exited: child.exitCode !== null || child.signalCode !== null,
  }));
  evidence.tmuxSocketExistsAfterCleanup = existsSync(socket);
  await save("serve.log", serveLog);
  const logs = await files(root).catch(() => []);
  evidence.hostLogPaths = logs.filter((path) => path.endsWith("/opencode.log"));
  for (const [index, path] of (evidence.hostLogPaths as string[]).entries())
    await save(`host-${index}.log`, readFileSync(path, "utf8"));
  evidence.elapsedMs = Date.now() - started;
  evidence.verdict = Object.values(stages).every((stage) => stage.verdict === "PASS") ? "PASS" : "FAIL";
  clearTimeout(watchdog);
  await save("evidence.json", evidence);
  console.log(
    JSON.stringify(
      {
        runID,
        evidence: join(root, "evidence.json"),
        stages,
        elapsedMs: evidence.elapsedMs,
        costConsumed: 0,
        globalBudgetChanged: false,
        remaining:
          evidence.verdict === "PASS"
            ? "Deterministic inference does not establish semantic summarization quality"
            : "Later stages NOTRUN; no product/loader fallback attempted",
      },
      null,
      2,
    ),
  );
}
