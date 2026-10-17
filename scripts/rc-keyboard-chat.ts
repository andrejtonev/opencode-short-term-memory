/*
 * Bounded native-TUI companion for the RC keyboard contract.
 *
 * This file deliberately owns orchestration only.  The product, fixtures and
 * native host are not adapted here; ordinary turns are delivered exclusively
 * by rc-keyboard-driver's literal send-keys/Enter path.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, mkdtemp, realpath, stat, writeFile, rm } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFile as nodeExecFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { OpenCode } from "../fixtures/v2-generation-probe/node_modules/@opencode/client/dist/promise/index.js";
import { sharedCoreScenario } from "../test/e2e/shared-core-scenario.js";
import { tuiReadiness } from "../fixtures/v2-generation-probe/tui-output/production-acceptance.js";
import { extractComposer, typeAndSubmitOrdinary } from "./rc-keyboard-driver";
import { classifyV2Diagnostics } from "./v2-diagnostic-policy";
import {
  cleanupOwnedRoot,
  markOwnedRoot,
  requireDiskBudget,
  signalOwnedChild,
  writeDurableEvidence,
  type OwnedChild,
} from "./rc-harness-lifecycle";

const execFile = promisify(nodeExecFile);
const BUN = "/home/dev/.bun/bin/bun";
const PARENT = "/home/dev/workspace/opencode-work/stm-readiness-improvements";
const ARTIFACT = "/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-17--keyboard-chat.html";
const MAX_RUN_MS = 900_000;
const CASE_MS = 210_000;
const MEMORY_PREFIX = "<!-- stm:v1 -->\n";
const SYSTEM_PREFIX =
  "[MEMORY_SYSTEM]\nUse this short-term session memory to preserve current instructions and conclusions. Do not mention it unless asked.\n\n";
const JOURNEYS = [
  "Project cobalt uses port 7319. Reply without tools. KB1:",
  "Which port does project cobalt use? Reply without tools. KB2:",
  "Keep port 7319 for project cobalt. Reply without tools. KB3:",
] as const;
const SCENARIOS = ["v1-clean", "v1-active", "v2-default-off", "v2-opt-in"] as const;
type Scenario = (typeof SCENARIOS)[number];
type Generation = "v1" | "v2";
type Child = ChildProcess & { pid?: number };
type TuiProcessOwnership = {
  panePid: number;
  nativePids: number[];
  executablesVerified: string[];
  processes: { pid: number; executable: string }[];
};

type LedgerRow = {
  method: string;
  started: string;
  finished?: string;
  status?: "ok" | "error";
  result?: unknown;
  resultChanged?: boolean;
  error?: string;
};
type CaseEvidence = {
  caseID: string;
  generation: Generation;
  scenario: Scenario;
  source: string;
  candidateHash?: string;
  started: string;
  finished?: string;
  wallMs: number;
  costConsumed: 0;
  paidInference: false;
  globalBudgetChanged: false;
  apiLedger: LedgerRow[];
  screens: string[];
  history: unknown[];
  logs: string[];
  checkpoints: unknown[];
  providerRequests: unknown[];
  turnEvidence?: unknown[];
  diagnosticClassification?: ReturnType<typeof classifyV2Diagnostics>;
  rawTelemetry?: string;
  telemetryStart?: number;
  installedCandidateDirectories?: string[];
  cleanup?: unknown;
  verdict: "PASS" | "FAIL";
  error?: string;
};
type ObservationContext = {
  generation: Generation;
  scenario: Scenario;
  caseID: string;
  sessionID: string;
  project: string;
  endpoint: string;
  socket: string;
  pane: string;
  env: NodeJS.ProcessEnv;
  stmConfig: Record<string, unknown>;
  memoryPath: string;
  checkpointPath: string;
  logPath: string;
  telemetryPath: string;
  providerLedger: unknown[];
  deadlineAt: number;
  record: CaseEvidence;
  readHistory: () => Promise<unknown>;
};
type DurableRow = {
  id: string;
  role: "user" | "assistant";
  text: string;
  parentID?: string;
  agent?: string;
  model?: unknown;
  parts: unknown[];
  completed?: number;
  finish?: string;
  cost?: number;
};
type PromptHistoryRow = { input?: string; parts?: unknown[]; mode?: string; text?: string; pasted?: unknown[] };
type LogRow = Record<string, unknown>;

function args(argv: string[]) {
  let candidate = "";
  let v1 = "1.19.3";
  let v2 = "2.0.32";
  let selected: Scenario[] = [...SCENARIOS];
  let scenarioSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--candidate") candidate = argv[++i] ?? "";
    else if (arg === "--v1-host-version") v1 = argv[++i] ?? "";
    else if (arg === "--v2-host-version") v2 = argv[++i] ?? "";
    else if (arg === "--scenario") {
      if (!scenarioSeen) {
        selected = [];
        scenarioSeen = true;
      }
      selected.push(argv[++i] as Scenario);
    } else if (!arg.startsWith("-") && !candidate) candidate = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (
    !candidate ||
    !selected.length ||
    !selected.every((item) => SCENARIOS.includes(item)) ||
    !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(v1) ||
    !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(v2)
  )
    throw new Error("candidate and valid scenario are required");
  return { candidate, v1, v2, selected };
}

function safeText(value: string): string {
  return value.replaceAll(/[\u0000-\u001f\u007f]/gu, " ");
}
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function redacted(value: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => (secret ? text.replaceAll(secret, "[REDACTED]") : text), value);
}
async function command(command: string, commandArgs: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  const result = await execFile(command, commandArgs, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}
async function hash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function packageDirectories(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "package.json") result.push(directory);
    }
  }
  await visit(root);
  return result;
}
async function verifyInstalledCandidate(
  cacheRoot: string,
  candidateFiles: readonly { path: string; sha256: string }[],
): Promise<string[]> {
  const matches: string[] = [];
  for (const directory of await packageDirectories(cacheRoot)) {
    let manifest: { name?: string };
    try {
      manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string };
    } catch {
      continue;
    }
    if (manifest.name !== "@atonev/opencode-short-term-memory") continue;
    for (const file of candidateFiles)
      assert.equal(
        await hash(join(directory, file.path)),
        file.sha256,
        `installed candidate hash differs: ${file.path}`,
      );
    matches.push(directory);
  }
  assert.ok(matches.length > 0, "native loader did not place the named candidate in its normal cache");
  return matches;
}
async function waitUntil(deadline: number, test: () => Promise<boolean>, label: string, pause = 100) {
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await test()) return;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(pause);
  }
  throw new Error(`${label}${last instanceof Error ? `: ${last.message}` : ""}`);
}
function owned(child: Child | undefined): OwnedChild | undefined {
  return child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode } : undefined;
}
function processAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function processExecutable(pid: number): Promise<string | undefined> {
  try {
    return await realpath(`/proc/${pid}/exe`);
  } catch {
    return undefined;
  }
}
async function descendants(pid: number): Promise<number[]> {
  const result: number[] = [];
  let children = "";
  try {
    children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
  } catch {
    return result;
  }
  for (const value of children.trim().split(/\s+/u).filter(Boolean)) {
    const child = Number(value);
    if (!Number.isSafeInteger(child) || child <= 1) continue;
    result.push(child, ...(await descendants(child)));
  }
  return result;
}
async function inspectTuiOwnership(panePid: number, native: string): Promise<TuiProcessOwnership> {
  const nativePath = await realpath(native);
  const candidates = [panePid, ...(await descendants(panePid))];
  const verified: string[] = [];
  const nativePids: number[] = [];
  const processes: { pid: number; executable: string }[] = [];
  for (const pid of [...new Set(candidates)]) {
    const executable = await processExecutable(pid);
    if (!executable) continue;
    processes.push({ pid, executable });
    if (executable === nativePath || executable === "/usr/bin/timeout") {
      verified.push(executable);
      if (executable === nativePath) nativePids.push(pid);
    }
  }
  assert.ok(nativePids.length > 0, "tmux pane has no verified installed native descendant");
  return { panePid, nativePids, executablesVerified: verified, processes };
}
function signalOwnedPid(pid: number, executable: string, signal: NodeJS.Signals): boolean {
  if (!processAlive(pid)) return false;
  try {
    if (readlinkSync(`/proc/${pid}/exe`) !== executable) return false;
  } catch {
    return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function waitDead(pid: number | undefined, deadline: number): Promise<void> {
  while (processAlive(pid) && Date.now() < deadline) await Bun.sleep(100);
  if (processAlive(pid)) throw new Error(`owned process remained alive after cleanup deadline: ${pid}`);
}

async function listenerClosed(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1", "shutdown probe must target the owned loopback listener");
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("owned listener closure probe timed out"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(error);
    });
  });
}

async function unpackCandidate(source: string, destination: string, commandEnv: NodeJS.ProcessEnv) {
  const physical = await realpath(source);
  assert.equal((await stat(physical)).isFile(), true, "candidate is not a regular file");
  const bytes = await readFile(physical);
  const candidateHash = createHash("sha256").update(bytes).digest("hex");
  const copy = join(destination, "candidate.tgz");
  await writeFile(copy, bytes, { mode: 0o600 });
  const manifestText = (
    await command("/usr/bin/tar", ["-xOf", copy, "package/package.json"], destination, commandEnv, 10_000)
  ).stdout;
  const manifest = JSON.parse(manifestText) as { name?: string; version?: string; files?: string[] };
  assert.equal(manifest.name, "@atonev/opencode-short-term-memory");
  assert.ok(manifest.version, "candidate manifest has no version");
  const listing = (await command("/usr/bin/tar", ["-tzf", copy], destination, commandEnv, 10_000)).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(listing.includes("package/package.json"), "candidate package manifest missing");
  const extracted = join(destination, "candidate-extracted");
  await mkdir(extracted, { recursive: true, mode: 0o700 });
  await command("/usr/bin/tar", ["-xzf", copy, "-C", extracted], destination, commandEnv, 30_000);
  const files: { path: string; sha256: string }[] = [];
  for (const entry of listing.filter((item) => item.startsWith("package/") && !item.endsWith("/"))) {
    files.push({
      path: entry.slice("package/".length),
      sha256: await hash(join(extracted, entry)),
    });
  }
  assert.equal(files.length, 72, `candidate packaged file count changed: ${files.length}`);
  return { physical, copy, candidateHash, manifest, listing, files };
}

function scenarioConfig(scenario: Scenario, memoryDir: string, telemetry: string): Record<string, unknown> {
  const generation: Generation = scenario.startsWith("v1") ? "v1" : "v2";
  const active = scenario === "v1-active";
  const optIn = scenario === "v2-opt-in";
  return generation === "v1"
    ? {
        enabled: true,
        memoryModel: "",
        summarizerMode: active ? "active" : "clean",
        cleanFallbackToActiveSession: false,
        includeAgentsMdOnFirstUpdate: false,
        injectInSubagents: false,
        enableLegacyPeriodicSystemTransform: false,
        remindEveryN: 2,
        debounceMs: active ? 300 : 1200,
        debug: true,
        logMaxLines: 20_000,
        sideSessionRetries: 0,
        memoryDir,
      }
    : {
        enabled: true,
        memoryModel: "stm-probe/deterministic-memory",
        summarizerMode: "clean",
        cleanFallbackToActiveSession: false,
        includeAgentsMdOnFirstUpdate: false,
        injectInSubagents: false,
        remindEveryN: 2,
        debounceMs: 300,
        debug: true,
        logMaxLines: 20_000,
        sideSessionRetries: 0,
        memoryDir,
        telemetryPath: telemetry,
        ...(optIn ? { enableLegacyPeriodicSystemTransform: true } : {}),
      };
}

async function tmux(socket: string, tmuxArgs: string[], env: NodeJS.ProcessEnv, timeoutMs = 5_000) {
  return command("/usr/bin/tmux", ["-S", socket, "-f", "/dev/null", ...tmuxArgs], PARENT, env, timeoutMs);
}
async function capture(socket: string, pane: string, env: NodeJS.ProcessEnv) {
  return (await tmux(socket, ["capture-pane", "-p", "-t", pane], env)).stdout;
}

async function readOnly<T>(ledger: LedgerRow[], method: string, operation: () => Promise<T>): Promise<T> {
  const row: LedgerRow = { method, started: new Date().toISOString() };
  ledger.push(row);
  try {
    const result = await operation();
    const previous = [...ledger]
      .reverse()
      .find((entry) => entry !== row && entry.method === method && entry.result !== undefined);
    row.status = "ok";
    row.resultChanged = !previous || JSON.stringify(previous.result) !== JSON.stringify(result);
    if (row.resultChanged) row.result = result;
    return result;
  } catch (error) {
    row.status = "error";
    row.error = String(error);
    throw error;
  } finally {
    row.finished = new Date().toISOString();
  }
}

async function runCase(
  config: ReturnType<typeof args>,
  scenario: Scenario,
  runRoot: string,
  source: string,
  candidateHash: string,
  candidateFiles: readonly { path: string; sha256: string }[],
): Promise<CaseEvidence> {
  const started = Date.now();
  const caseID = `${scenario}-${randomUUID().slice(0, 8)}`;
  const generation: Generation = scenario.startsWith("v1") ? "v1" : "v2";
  const evidence: CaseEvidence = {
    caseID,
    generation,
    scenario,
    source,
    candidateHash,
    started: new Date(started).toISOString(),
    wallMs: 0,
    costConsumed: 0,
    paidInference: false,
    globalBudgetChanged: false,
    apiLedger: [],
    screens: [],
    history: [],
    logs: [],
    checkpoints: [],
    providerRequests: [],
    verdict: "FAIL",
  };
  const stableCaseDir = join(runRoot, "cases", caseID);
  await mkdir(join(stableCaseDir, "evidence"), { recursive: true, mode: 0o700 });
  const root = await mkdtemp("/tmp/opencode/rc-keyboard-case-");
  const project = join(root, "project");
  const host = join(stableCaseDir, "host");
  const runtime = join(root, "case");
  const cache = join(stableCaseDir, "cache");
  const memory = join(stableCaseDir, "memory");
  const telemetry = join(stableCaseDir, "telemetry.jsonl");
  const evidencePath = join(stableCaseDir, "evidence", "case.json");
  const socket = `/tmp/opencode/kb-${caseID.slice(-8)}.sock`;
  const password = randomUUID();
  const basic = Buffer.from(`opencode:${password}`).toString("base64");
  const secrets = [password, basic];
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(BUN)}:/usr/bin:/bin`,
    HOME: join(runtime, "home"),
    XDG_CONFIG_HOME: join(runtime, "config"),
    XDG_DATA_HOME: join(runtime, "data"),
    XDG_STATE_HOME: join(runtime, "state"),
    XDG_CACHE_HOME: join(cache, "xdg-cache"),
    XDG_RUNTIME_DIR: join(runtime, "run"),
    OPENCODE_DB: join(runtime, "data", "opencode.db"),
    TMPDIR: join(runtime, "tmp"),
    TMP: join(runtime, "tmp"),
    TEMP: join(runtime, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(cache, "bun-cache"),
    npm_config_cache: join(cache, "npm-cache"),
    npm_config_userconfig: join(runtime, "npmrc"),
    npm_config_registry: "https://registry.npmjs.org",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_LOG_LEVEL: "DEBUG",
    PROBE_RUN_ID: caseID,
    PROBE_MODE: "ordinary",
    PROBE_SHARED_CORE: "1",
    PROBE_TASK_CHILD: "1",
    PROBE_TELEMETRY_PATH: telemetry,
    PROBE_MEMORY_DIR: memory,
  };
  let provider: ReturnType<typeof Bun.serve> | undefined;
  let hostChild: Child | undefined;
  let tuiOwnership: TuiProcessOwnership | undefined;
  let tmuxOwnership: { pid: number; executable: string; dev: number; ino: number } | undefined;
  let tmuxAttempted = false;
  let panePid: number | undefined;
  let endpoint = "";
  let hostOutput = "";
  let turnsCompleted = false;
  const remaining = (limit: number) => {
    const value = Math.min(limit, started + CASE_MS - Date.now());
    if (value <= 0) throw new Error("case bounded deadline reached");
    return value;
  };
  const signal = () => AbortSignal.timeout(remaining(15_000));
  const inspectTmux = async () => {
    const pid = Number((await tmux(socket, ["display-message", "-p", "#{pid}"], env)).stdout.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1, "tmux did not report its server PID");
    const executable = await processExecutable(pid);
    assert.equal(executable, "/usr/bin/tmux", "tmux server executable mismatch");
    const info = lstatSync(socket);
    assert.ok(info.isSocket() && !info.isSymbolicLink(), "tmux socket is not a real owned socket");
    tmuxOwnership = { pid, executable: executable!, dev: info.dev, ino: info.ino };
  };
  try {
    for (const directory of [
      project,
      host,
      runtime,
      cache,
      memory,
      join(cache, "xdg-cache"),
      join(cache, "bun-cache"),
      join(cache, "npm-cache"),
      ...Object.values(env).filter(
        (value): value is string =>
          !!value && value.startsWith(runtime) && value !== env.npm_config_userconfig && value !== env.OPENCODE_DB,
      ),
    ])
      await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(dirname(env.npm_config_userconfig!), { recursive: true, mode: 0o700 });
    await mkdir(dirname(env.OPENCODE_DB!), { recursive: true, mode: 0o700 });
    await markOwnedRoot(root, { runID: runRoot.split("/").at(-1)!, caseID, kind: "runtime" });
    await markOwnedRoot(cache, { runID: runRoot.split("/").at(-1)!, caseID, kind: "cache" });
    const cfgDir = join(env.XDG_CONFIG_HOME!, "opencode");
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });
    await writeFile(env.npm_config_userconfig!, "", { mode: 0o600 });
    const pluginTarget = `@atonev/opencode-short-term-memory@file:${source}`;
    const fixture = await realpath(join(import.meta.dir, "../fixtures/v2-generation-probe"));
    await mkdir(join(project, ".opencode"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(project, ".opencode", "stm.jsonc"),
      `${JSON.stringify(scenarioConfig(scenario, memory, telemetry), null, 2)}\n`,
    );
    const hostConfig =
      generation === "v1"
        ? {
            plugin: [pluginTarget],
            model: "isolated/deterministic",
            small_model: "isolated/deterministic",
            enabled_providers: ["isolated"],
            provider: {},
            agent: { build: { model: "isolated/deterministic", permission: { "*": "deny" } } },
            permission: { "*": "deny" },
          }
        : { plugins: [pluginTarget, fixture], update: "disable" };
    const cliConfig =
      generation === "v2"
        ? {
            plugins: [pluginTarget],
            animations: false,
            mouse: false,
            attention: { notifications: false, sound: false },
            tabs: { enabled: false },
          }
        : {};
    await writeFile(join(project, "opencode.json"), `${JSON.stringify(hostConfig, null, 2)}\n`);
    await writeFile(join(cfgDir, "opencode.json"), `${JSON.stringify(hostConfig, null, 2)}\n`);
    await writeFile(join(cfgDir, "cli.json"), `${JSON.stringify(cliConfig, null, 2)}\n`);
    await writeFile(
      join(host, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: {
          [generation === "v1" ? "opencode-ai" : "@opencode/cli"]: generation === "v1" ? config.v1 : config.v2,
        },
      }),
    );
    await command(
      BUN,
      ["install", "--production", "--registry", "https://registry.npmjs.org"],
      host,
      env,
      remaining(120_000),
    );
    assert.equal(process.arch, "x64", "keyboard RC acceptance requires the packaged linux-x64 native host");
    const nativeName = generation === "v1" ? "opencode-linux-x64" : "@opencode/cli-linux-x64";
    const native = join(host, "node_modules", nativeName, "bin", "opencode");
    const selectedVersion = generation === "v1" ? config.v1 : config.v2;
    const hostPackageName = generation === "v1" ? "opencode-ai" : "@opencode/cli";
    const hostManifest = (await Bun.file(join(host, "node_modules", hostPackageName, "package.json")).json()) as {
      name?: string;
      version?: string;
    };
    const nativeManifest = (await Bun.file(join(host, "node_modules", nativeName, "package.json")).json()) as {
      name?: string;
      version?: string;
    };
    assert.equal(hostManifest.name, hostPackageName);
    assert.equal(hostManifest.version, selectedVersion);
    assert.equal(nativeManifest.version, selectedVersion);
    const versionOutput = (await command(native, ["--version"], project, env, remaining(10_000))).stdout.trim();
    assert.ok(
      versionOutput === selectedVersion || versionOutput === `opencode v${selectedVersion}`,
      `unexpected native version: ${versionOutput}`,
    );
    const providerRequests: unknown[] = [];
    if (generation === "v1")
      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
            return new Response("Not found", { status: 404 });
          const body = (await request.json()) as { model?: string; stream?: boolean; messages?: unknown[] };
          const messages = Array.isArray(body.messages) ? body.messages : [];
          const textOf = (value: unknown): string => {
            if (typeof value === "string") return value;
            if (!value || typeof value !== "object") return "";
            const record = value as Record<string, unknown>;
            if (typeof record.text === "string") return record.text;
            if (typeof record.content === "string") return record.content;
            if (Array.isArray(record.content)) return record.content.map(textOf).join("");
            return "";
          };
          const latestUser = messages
            .filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).role === "user")
            .at(-1);
          const latestUserText = textOf(latestUser);
          const summary =
            latestUserText.startsWith("<conversation_update>\n") && latestUserText.endsWith("\n</conversation_update>");
          const content = summary ? sharedCoreScenario.memoryResponse : sharedCoreScenario.assistantText;
          providerRequests.push({
            receivedAt: new Date().toISOString(),
            model: body.model,
            stream: body.stream === true,
            isSummary: summary,
            latestUserText,
            messages,
          });
          const id = `keyboard-provider-${providerRequests.length}`;
          const common = {
            id,
            object: body.stream ? "chat.completion.chunk" : "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? "unknown",
          };
          if (body.stream !== true)
            return Response.json({
              ...common,
              choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
          const chunks = [
            { ...common, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
            { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ];
          return new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        },
      });
    evidence.providerRequests = providerRequests;
    const providerURL = provider ? `http://127.0.0.1:${provider.port}/v1` : "";
    const providerID = generation === "v1" ? "isolated" : "stm-probe";
    const primaryModel = `${providerID}/deterministic`;
    const summaryModel = `${providerID}/deterministic-memory`;
    const providerConfig = {
      model: primaryModel,
      small_model: summaryModel,
      enabled_providers: [providerID],
      provider: {
        [providerID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Isolated deterministic loopback",
          options: { baseURL: providerURL, apiKey: "local-only" },
          models: {
            deterministic: {
              name: "deterministic",
              limit: { context: 128000, output: 4096 },
              cost: { input: 0, output: 0 },
            },
            "deterministic-memory": {
              name: "deterministic-memory",
              limit: { context: 128000, output: 4096 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
      agent: { build: { model: primaryModel, permission: { "*": "deny" } } },
      permission: { "*": "deny" },
    };
    const actualConfig = generation === "v1" ? { ...providerConfig, plugin: [pluginTarget] } : hostConfig;
    await writeFile(join(project, "opencode.json"), `${JSON.stringify(actualConfig, null, 2)}\n`);
    await writeFile(join(cfgDir, "opencode.json"), `${JSON.stringify(actualConfig, null, 2)}\n`);
    const hostLog = join(env.XDG_DATA_HOME!, "opencode/log/opencode.log");
    const serve = spawn(native, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
      cwd: project,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }) as Child;
    hostChild = serve;
    serve.on("error", (error) => (hostOutput += `\nchild-error:${String(error)}`));
    serve.stdout?.on("data", (chunk) => (hostOutput += chunk.toString()));
    serve.stderr?.on("data", (chunk) => (hostOutput += chunk.toString()));
    await waitUntil(
      Math.min(started + CASE_MS, Date.now() + 120_000),
      async () => {
        const match = hostOutput.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          endpoint = match[0];
          return true;
        }
        return false;
      },
      "native host did not listen",
    );
    const auth = `Basic ${basic}`;
    if (generation === "v2") {
      const client = OpenCode.make({ baseUrl: endpoint, headers: { Authorization: auth } });
      await readOnly(evidence.apiLedger, "server.info", () => client.server.info({ signal: signal() }));
      await readOnly(evidence.apiLedger, "plugin.list", () =>
        client.plugin.list({ location: { directory: project } }, { signal: signal() }),
      );
      await readOnly(evidence.apiLedger, "command.list", () =>
        client.command.list({ location: { directory: project } }, { signal: signal() }),
      );
      await waitUntil(
        Math.min(started + CASE_MS, Date.now() + 120_000),
        async () => {
          const inventory = await readOnly(evidence.apiLedger, "plugin.list", () =>
            client.plugin.list({ location: { directory: project } }, { signal: signal() }),
          );
          return inventory.data.some(
            (item) =>
              (item.id === "opencode-short-term-memory" ||
                JSON.stringify(item.source).includes("@atonev/opencode-short-term-memory")) &&
              item.state.status === "active",
          );
        },
        "V2 candidate plugin did not activate",
        500,
      );
      evidence.installedCandidateDirectories = await verifyInstalledCandidate(env.XDG_CACHE_HOME!, candidateFiles);
      const session = await readOnly(evidence.apiLedger, "session.create", () =>
        client.session.create(
          {
            title: `Keyboard ${caseID}`,
            model: { providerID: "stm-probe", id: "deterministic" },
            agent: "build",
            location: { directory: project },
          },
          { signal: signal() },
        ),
      );
      const readHistory = () =>
        readOnly(evidence.apiLedger, "readHistory", () =>
          client.session.context({ sessionID: session.id }, { signal: signal() }),
        );
      const tuiCommand = [
        "exec",
        "/usr/bin/timeout",
        "--kill-after=2s",
        "160s",
        native,
        "--server",
        endpoint,
        "--session",
        session.id,
      ]
        .map(shQuote)
        .join(" ");
      tmuxAttempted = true;
      await tmux(
        socket,
        ["new-session", "-d", "-s", "keyboard", "-x", "160", "-y", "100", "-c", project, tuiCommand],
        env,
      );
      await inspectTmux();
      panePid = Number(
        (await tmux(socket, ["display-message", "-p", "-t", "keyboard:0.0", "#{pane_pid}"], env)).stdout.trim(),
      );
      assert.ok(Number.isSafeInteger(panePid) && panePid > 1, "tmux did not report an owned pane PID");
      tuiOwnership = await inspectTuiOwnership(panePid, native);
      await waitUntil(
        Math.min(started + CASE_MS, Date.now() + 20_000),
        async () => {
          const screen = await capture(socket, "keyboard:0.0", env);
          evidence.screens.push(screen);
          const ready = tuiReadiness(existsSync(hostLog) ? readFileSync(hostLog, "utf8") : "", pluginTarget);
          return screen.includes(session.title!) && !!ready;
        },
        "V2 TUI did not become ready",
      );
      await turns({
        generation,
        scenario,
        caseID,
        sessionID: session.id,
        project,
        endpoint,
        socket,
        pane: "keyboard:0.0",
        env,
        stmConfig: actualConfig,
        memoryPath: join(memory, `session_${session.id}.md`),
        checkpointPath: join(memory, "checkpoints", `${session.id}.last-message-id.txt`),
        logPath: join(memory, "session-memory.log"),
        telemetryPath: telemetry,
        providerLedger: evidence.providerRequests,
        deadlineAt: started + CASE_MS,
        record: evidence,
        readHistory,
      });
    } else {
      const session = await readOnly(evidence.apiLedger, "session.create", async () =>
        (
          await fetch(`${endpoint}/session?directory=${encodeURIComponent(project)}`, {
            method: "POST",
            signal: signal(),
            headers: { Authorization: auth, "content-type": "application/json" },
            body: JSON.stringify({
              title: `Keyboard ${caseID}`,
              model: { providerID: "stm-probe", modelID: "deterministic" },
              agent: "build",
              location: { directory: project },
            }),
          })
        ).json(),
      );
      const id = String((session as { id?: string }).id);
      assert.ok(id && id !== "undefined");
      const readHistory = () =>
        readOnly(evidence.apiLedger, "readHistory", async () => {
          const response = await fetch(`${endpoint}/session/${id}/message?directory=${encodeURIComponent(project)}`, {
            headers: { Authorization: auth },
            signal: signal(),
          });
          assert.ok(response.ok, `V1 history failed: ${response.status}`);
          return response.json();
        });
      await readOnly(evidence.apiLedger, "command.list", async () => {
        const response = await fetch(`${endpoint}/command?directory=${encodeURIComponent(project)}`, {
          headers: { Authorization: auth },
          signal: signal(),
        });
        assert.ok(response.ok, `V1 command inventory failed: ${response.status}`);
        return response.json();
      });
      evidence.installedCandidateDirectories = await verifyInstalledCandidate(env.XDG_CACHE_HOME!, candidateFiles);
      const attach = [
        "exec",
        "/usr/bin/timeout",
        "--kill-after=2s",
        "160s",
        native,
        "attach",
        endpoint,
        "--session",
        id,
        "--dir",
        project,
      ]
        .map(shQuote)
        .join(" ");
      tmuxAttempted = true;
      await tmux(socket, ["new-session", "-d", "-s", "keyboard", "-x", "160", "-y", "100", "-c", project, attach], env);
      await inspectTmux();
      panePid = Number(
        (await tmux(socket, ["display-message", "-p", "-t", "keyboard:0.0", "#{pane_pid}"], env)).stdout.trim(),
      );
      assert.ok(Number.isSafeInteger(panePid) && panePid > 1, "tmux did not report an owned pane PID");
      tuiOwnership = await inspectTuiOwnership(panePid, native);
      await waitUntil(
        Math.min(started + CASE_MS, Date.now() + 20_000),
        async () => {
          const screen = await capture(socket, "keyboard:0.0", env);
          evidence.screens.push(screen);
          return (
            screen.includes(`Keyboard ${caseID}`) &&
            (() => {
              try {
                return extractComposer(screen).text === "";
              } catch {
                return false;
              }
            })()
          );
        },
        "V1 TUI did not become ready",
      );
      throw new Error(
        "V1 qualification blocked: split summary-delta unions and cumulative NoReply cadence validation are not implemented",
      );
      await turns({
        generation,
        scenario,
        caseID,
        sessionID: id,
        project,
        endpoint,
        socket,
        pane: "keyboard:0.0",
        env,
        stmConfig: actualConfig,
        memoryPath: join(memory, `session_${id}.md`),
        checkpointPath: join(memory, "checkpoints", `${id}.last-message-id.txt`),
        logPath: join(memory, "session-memory.log"),
        telemetryPath: telemetry,
        providerLedger: evidence.providerRequests,
        deadlineAt: started + CASE_MS,
        record: evidence,
        readHistory,
      });
    }
    evidence.logs.push(redacted(existsSync(hostLog) ? await readFile(hostLog, "utf8") : hostOutput, secrets));
    turnsCompleted = true;
    evidence.finished = new Date().toISOString();
  } catch (error) {
    evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    const cleanupStartedAt = Date.now();
    const failure = (error: unknown) => {
      evidence.error = `${evidence.error ?? ""}\n${String(error)}`;
    };
    const proof: {
      processes: { pid: number; executable: string; alive?: boolean }[];
      tmux: typeof tmuxOwnership;
      serverAlive: boolean;
      listenerClosed: boolean;
      socketRemoved: boolean;
      socketIdentityMatched: boolean;
      socketAbsent: boolean;
    } = {
      processes: [],
      tmux: tmuxOwnership,
      serverAlive: tmuxAttempted,
      listenerClosed: !hostChild && !endpoint,
      socketRemoved: false,
      socketIdentityMatched: false,
      socketAbsent: false,
    };
    const refused = (path: string) => ({
      root: path,
      deleted: [],
      missing: [],
      refused: ["shutdown-not-verified"],
      timedOut: false,
      operationPending: false,
      complete: false,
    });
    let runtimeCleanup: Awaited<ReturnType<typeof cleanupOwnedRoot>> = refused(root);
    let cacheCleanup: Awaited<ReturnType<typeof cleanupOwnedRoot>> = refused(cache);
    evidence.rawTelemetry = await readFile(telemetry, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") failure(`telemetry retention failure: ${String(error)}`);
      return "";
    });
    await writeDurableEvidence(evidencePath, evidence).catch(failure);
    try {
      // Snapshot descendants while their parent relationships still exist.
      const snapshots = new Map((tuiOwnership?.processes ?? []).map((row) => [row.pid, row]));
      for (const parent of [panePid, hostChild?.pid, tmuxOwnership?.pid]) {
        if (!parent) continue;
        for (const pid of [...(parent === tmuxOwnership?.pid ? [] : [parent]), ...(await descendants(parent))]) {
          const executable = await processExecutable(pid);
          if (executable) snapshots.set(pid, { pid, executable });
        }
      }
      proof.processes = [...snapshots.values()];
      provider?.stop(true);
      if (tmuxOwnership) await tmux(socket, ["kill-server"], env).catch(failure);
      else if (tmuxAttempted) failure("tmux server ownership was not established; preserving socket and caches");
      signalOwnedChild(owned(hostChild), "SIGTERM");
      for (const row of proof.processes) signalOwnedPid(row.pid, row.executable, "SIGTERM");
      await Bun.sleep(250);
      signalOwnedChild(owned(hostChild), "SIGKILL");
      for (const row of proof.processes) signalOwnedPid(row.pid, row.executable, "SIGKILL");
      const shutdownDeadline = Date.now() + 5_000;
      for (const pid of [...new Set([hostChild?.pid, tmuxOwnership?.pid, ...proof.processes.map((row) => row.pid)])])
        await waitDead(pid, shutdownDeadline).catch(failure);
      proof.processes.forEach((row) => {
        row.alive = processAlive(row.pid);
      });
      proof.serverAlive = tmuxOwnership ? processAlive(tmuxOwnership.pid) : tmuxAttempted;
      if (endpoint) proof.listenerClosed = await listenerClosed(endpoint);
      if (!proof.listenerClosed) failure(`owned HTTP listener closure not verified: ${endpoint}`);
      const info = lstatSync(socket, { throwIfNoEntry: false });
      if (info) {
        proof.socketIdentityMatched =
          !!tmuxOwnership &&
          info.isSocket() &&
          !info.isSymbolicLink() &&
          info.dev === tmuxOwnership.dev &&
          info.ino === tmuxOwnership.ino;
        if (
          !proof.serverAlive &&
          proof.listenerClosed &&
          !processAlive(hostChild?.pid) &&
          proof.processes.every((row) => !processAlive(row.pid)) &&
          proof.socketIdentityMatched
        ) {
          unlinkSync(socket);
          proof.socketRemoved = true;
        } else failure(`owned tmux socket removal refused: ${socket}`);
      }
      proof.socketAbsent = lstatSync(socket, { throwIfNoEntry: false }) === undefined;
      const live = [hostChild?.pid, tmuxOwnership?.pid, ...proof.processes.map((row) => row.pid)].filter(
        (pid): pid is number => processAlive(pid),
      );
      const portsClosed = proof.listenerClosed && !proof.serverAlive;
      evidence.cleanup = { proof, runtime: runtimeCleanup, cache: cacheCleanup };
      await writeDurableEvidence(evidencePath, evidence);
      runtimeCleanup = await cleanupOwnedRoot({
        root,
        owner: { runID: runRoot.split("/").at(-1)!, caseID, kind: "runtime" },
        targets: ["case/tmp", "case/config/opencode/node_modules"],
        childrenExited: live.length === 0,
        portsClosed: portsClosed && proof.socketAbsent,
        livePids: live,
      });
      cacheCleanup = await cleanupOwnedRoot({
        root: cache,
        owner: { runID: runRoot.split("/").at(-1)!, caseID, kind: "cache" },
        targets: ["xdg-cache", "bun-cache", "npm-cache"],
        childrenExited: live.length === 0,
        portsClosed: portsClosed && proof.socketAbsent,
        livePids: live,
      });
    } catch (error) {
      failure(`cleanup failure: ${String(error)}`);
    }
    try {
      await Bun.sleep(100);
      const hostLog = join(env.XDG_DATA_HOME!, "opencode/log/opencode.log");
      const finalHostLog = existsSync(hostLog) ? await readFile(hostLog, "utf8") : "";
      evidence.logs.push(redacted(finalHostLog, secrets), redacted(hostOutput, secrets));
      if (generation === "v2") {
        evidence.rawTelemetry = await readFile(telemetry, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" && !turnsCompleted) return "";
          throw error;
        });
        const stmLog = await readFile(join(memory, "session-memory.log"), "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" && !turnsCompleted) return "";
            throw error;
          },
        );
        evidence.logs.push(stmLog);
        const classification = classifyV2Diagnostics({
          candidateTarget: `@atonev/opencode-short-term-memory@file:${source}`,
          cleanupStartedAt,
          expectedFailures: [],
          stmLog,
          hostLogs: [
            { file: hostLog, lines: redacted(finalHostLog, secrets).split(/\r?\n/u).filter(Boolean) },
            { file: "serve-output", lines: redacted(hostOutput, secrets).split(/\r?\n/u).filter(Boolean) },
          ],
        });
        evidence.diagnosticClassification = classification;
        if (turnsCompleted) {
          assert.notEqual(evidence.telemetryStart, undefined, "turn telemetry baseline missing");
          const finalRows = Buffer.from(evidence.rawTelemetry!)
            .subarray(evidence.telemetryStart)
            .toString("utf8")
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LogRow);
          assert.equal(
            finalRows.filter((row) => row.event === "model.request").length,
            JOURNEYS.length,
            "late/extra primary request in final telemetry",
          );
          assert.equal(
            finalRows.filter((row) => row.event === "model.invocation").length,
            JOURNEYS.length * 2,
            "late/extra provider invocation in final telemetry",
          );
          assert.ok(
            !finalRows.some(
              (row) => row.event === "event.observed" && String(row.observedEvent ?? "").startsWith("tool.execute."),
            ),
            "late tool execution in final telemetry",
          );
          const finalCommits = classification.parsedRows.filter(
            (row) => row.event === "v2_memory_update_committed" || row.event === "memory_update_chunk_done",
          );
          assert.deepEqual(
            finalCommits.map((row) => row.checkpointID),
            evidence.checkpoints.map((row) => (row as { assistantID: string }).assistantID),
            "late/extra production commit",
          );
          for (const event of ["v2_generation_attempt_start", "v2_generation_attempt_outcome"])
            assert.equal(
              classification.parsedRows.filter((row) => row.event === event).length,
              JOURNEYS.length,
              "late/extra production generation",
            );
        }
        if (
          classification.parsedIssues.length ||
          classification.tail ||
          classification.unexpectedStm.length ||
          classification.unexpectedHost.length ||
          classification.missing.length ||
          classification.duplicate.length ||
          (turnsCompleted && (!stmLog || !(finalHostLog || hostOutput) || classification.parsedRows.length >= 20_000))
        )
          failure("V2 final diagnostic coverage/classification failed; see durable diagnosticClassification");
      }
    } catch (error) {
      failure(`final diagnostic failure: ${String(error)}`);
    }
    evidence.cleanup = { proof, runtime: runtimeCleanup, cache: cacheCleanup };
    const allowedApi = new Set(["server.info", "plugin.list", "command.list", "session.create", "readHistory"]);
    if (evidence.apiLedger.some((row) => !allowedApi.has(row.method)))
      evidence.error = `${evidence.error ?? ""}\nAPI ledger contains a non-read-only/non-setup method`;
    if (
      turnsCompleted &&
      !evidence.error &&
      runtimeCleanup.complete &&
      cacheCleanup.complete &&
      !processAlive(hostChild?.pid) &&
      proof.processes.every((row) => !processAlive(row.pid)) &&
      !proof.serverAlive &&
      proof.listenerClosed &&
      proof.socketAbsent
    )
      evidence.verdict = "PASS";
    evidence.wallMs = Date.now() - started;
    evidence.finished = new Date().toISOString();
    await writeDurableEvidence(evidencePath, evidence).catch((error) => {
      failure(`final evidence write failure: ${String(error)}`);
      evidence.verdict = "FAIL";
    });
  }
  return evidence;
}

function partText(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as Record<string, unknown>;
      return typeof value.text === "string" ? value.text : typeof value.content === "string" ? value.content : "";
    })
    .join("");
}
export function durableProjection(raw: unknown, generation: Generation): DurableRow[] {
  if (!Array.isArray(raw)) throw new Error("native history was not an array");
  const rows: DurableRow[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("malformed native history row");
    const value = item as Record<string, unknown>;
    if (generation === "v2") {
      const type = value.type;
      if (typeof type !== "string") throw new Error("V2 context row has no type");
      if (type !== "user" && type !== "assistant") {
        if (!["idle", "step-start", "step-finish", "snapshot"].includes(type))
          throw new Error(`unknown V2 context control type: ${type}`);
        if (typeof value.id === "string" && ids.has(value.id)) throw new Error(`duplicate V2 context ID: ${value.id}`);
        if (typeof value.id === "string") ids.add(value.id);
        continue;
      }
      const id = typeof value.id === "string" && value.id.length > 0 ? value.id : "";
      if (!id || ids.has(id)) throw new Error(`missing or duplicate V2 context message ID: ${id}`);
      ids.add(id);
      if (type === "user") {
        if (typeof value.text !== "string") throw new Error("V2 user context row has no text");
        rows.push({ id, role: "user", text: value.text, parts: [] });
      } else {
        if (value.content !== undefined && !Array.isArray(value.content))
          throw new Error("V2 assistant content is not an array");
        const content: unknown[] = Array.isArray(value.content) ? value.content : [];
        if (value.time !== undefined && (!value.time || typeof value.time !== "object" || Array.isArray(value.time)))
          throw new Error(`V2 assistant time metadata invalid: ${id}`);
        const time = value.time && typeof value.time === "object" ? (value.time as Record<string, unknown>) : {};
        if (
          Object.values(time).some((entry) => typeof entry !== "number" || !Number.isFinite(entry)) ||
          (value.finish !== undefined && value.finish !== "stop") ||
          (value.agent !== undefined && value.agent !== "build")
        )
          throw new Error(`V2 assistant completion metadata invalid: ${id}`);
        const model = value.model && typeof value.model === "object" ? (value.model as Record<string, unknown>) : {};
        if (
          (value.model !== undefined && (model.id !== "deterministic" || model.providerID !== "stm-probe")) ||
          (value.cost !== undefined && value.cost !== 0)
        )
          throw new Error(`V2 assistant model/cost metadata invalid: ${id}`);
        if (
          content.some(
            (part) =>
              !part ||
              typeof part !== "object" ||
              Array.isArray(part) ||
              !["text", "reasoning"].includes(String((part as Record<string, unknown>).type)) ||
              typeof (part as Record<string, unknown>).text !== "string",
          )
        )
          throw new Error(`V2 assistant contains a tool or malformed part: ${id}`);
        rows.push({
          id,
          role: "assistant",
          text: partText(content),
          parts: content,
          completed: typeof time.completed === "number" ? time.completed : undefined,
          finish: typeof value.finish === "string" ? value.finish : undefined,
          cost: typeof value.cost === "number" ? value.cost : undefined,
          agent: typeof value.agent === "string" ? value.agent : undefined,
          model: value.model,
        });
      }
      continue;
    }
    const info = value.info && typeof value.info === "object" ? (value.info as Record<string, unknown>) : value;
    const role = info.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts = Array.isArray(value.parts) ? value.parts : Array.isArray(info.parts) ? info.parts : [];
    if (parts.some((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "tool"))
      throw new Error(`${generation} durable history contains a tool part`);
    const id = typeof info.id === "string" ? info.id : "";
    if (!id) throw new Error(`${generation} durable row has no id`);
    if (ids.has(id)) throw new Error(`duplicate V1 durable message ID: ${id}`);
    ids.add(id);
    rows.push({
      id,
      role,
      text: partText(parts),
      parentID: typeof info.parentID === "string" ? info.parentID : undefined,
      agent: typeof info.agent === "string" ? info.agent : undefined,
      model: info.model,
      parts,
    });
  }
  return rows;
}
async function readPromptHistory(stateRoot: string, literal: string): Promise<PromptHistoryRow[]> {
  const path = join(stateRoot, "opencode", "prompt-history.jsonl");
  if (!existsSync(path)) return [];
  const rows: PromptHistoryRow[] = [];
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean)) {
    const row = JSON.parse(line) as PromptHistoryRow;
    const text = row.input ?? row.text;
    if (text === literal) rows.push(row);
  }
  return rows;
}
async function jsonl(path: string, offset: number): Promise<{ rows: LogRow[]; next: number }> {
  if (!existsSync(path)) return { rows: [], next: offset };
  const bytes = await readFile(path);
  const complete = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
  if (complete.length < offset) throw new Error(`log offset moved backwards: ${path}`);
  const text = complete.subarray(offset).toString("utf8");
  const rows: LogRow[] = [];
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`malformed log row: ${line}`);
    rows.push(parsed as LogRow);
  }
  return { rows, next: complete.length };
}
function memoryExpected(): string {
  return `${MEMORY_PREFIX}${sharedCoreScenario.memoryResponse.trim()}\n`;
}
function injectedExpected(): string {
  const body = sharedCoreScenario.memoryResponse
    .trim()
    .replace(/^## Session Memory\s*/u, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return `${SYSTEM_PREFIX}${body}`;
}
function historyText(row: DurableRow): string {
  return row.text;
}
function latestByRole(rows: DurableRow[], role: DurableRow["role"]): DurableRow | undefined {
  return rows.filter((row) => row.role === role).at(-1);
}
export function validateV2TurnEvidence(input: {
  telemetry: readonly unknown[];
  logs: readonly unknown[];
  scenario: "v2-default-off" | "v2-opt-in";
  caseID: string;
  sessionID: string;
  assistantID: string;
  literal: string;
  turnIndex: number;
  priorMemory: string | null;
}) {
  const record = (value: unknown): LogRow => {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), "evidence must be an object");
    return value as LogRow;
  };
  const prompt = (details: LogRow) => {
    assert.equal(typeof details.prompt, "string", "invocation prompt must be JSON-encoded messages");
    const messages: unknown = JSON.parse(details.prompt as string);
    assert.ok(Array.isArray(messages) && messages.length > 0, "invocation prompt must be nonempty messages");
    return (messages as unknown[]).map((message) => {
      const row = record(message);
      assert.ok(["system", "user", "assistant"].includes(String(row.role)), "unexpected/tool prompt role");
      assert.ok(!("tool_calls" in row) && !("toolCalls" in row) && !("function_call" in row), "prompt tool metadata");
      let text: string;
      if (typeof row.content === "string") text = row.content;
      else {
        assert.ok(Array.isArray(row.content), "prompt content must be string or text parts");
        text = (row.content as unknown[])
          .map((part) => {
            const value = record(part);
            assert.equal(value.type, "text", "unexpected/tool prompt content part");
            assert.equal(typeof value.text, "string", "prompt text part lacks text");
            return value.text as string;
          })
          .join("");
      }
      return { role: row.role, text };
    });
  };
  assert.ok(Number.isInteger(input.turnIndex) && input.turnIndex >= 0 && input.turnIndex < JOURNEYS.length);
  const telemetry = input.telemetry.map(record);
  const logs = input.logs.map(record);
  const requests = telemetry.filter((row) => row.event === "model.request");
  const invocations = telemetry.filter((row) => row.event === "model.invocation");
  assert.equal(requests.length, 1, "expected exactly one primary model request, no retries/extra requests");
  assert.equal(invocations.length, 2, "expected exactly primary and automatic memory invocations");
  const primary = invocations.filter((row) => row.model === "deterministic");
  const memory = invocations.filter((row) => row.model === "deterministic-memory");
  assert.equal(primary.length, 1, "expected exactly one primary invocation");
  assert.equal(memory.length, 1, "expected exactly one memory invocation, including default-off");
  const request = requests[0]!;
  const ordinary = primary[0]!;
  const summary = memory[0]!;
  for (const row of [request, ordinary, summary]) {
    assert.equal(row.provider, "stm-probe", "unexpected model provider");
    assert.equal(row.runId, input.caseID, "model evidence belongs to another run");
    assert.ok(Number.isSafeInteger(row.seq) && Number(row.seq) > 0, "model sequence missing");
  }
  assert.equal(request.model, "deterministic");
  assert.equal(request.requestKind, "primary");
  for (const row of [ordinary, summary]) assert.equal(row.requestKind, "doStream");
  assert.equal(ordinary.sentinel, sharedCoreScenario.assistantText, "primary response mismatch");
  assert.equal(summary.sentinel, sharedCoreScenario.memoryResponse, "memory response mismatch");
  const requestDetails = record(request.details);
  const ordinaryDetails = record(ordinary.details);
  const summaryDetails = record(summary.details);
  const correlation = record(requestDetails.correlation);
  assert.equal(correlation.sessionID, input.sessionID);
  assert.equal(correlation.agent, "build");
  assert.equal(correlation.kind, "primary");
  assert.ok(typeof correlation.requestID === "string" && correlation.requestID.trim().length > 0, "empty request ID");
  assert.deepEqual(ordinaryDetails.correlation, correlation, "full primary correlation mismatch");
  assert.ok(
    Number(request.seq) < Number(ordinary.seq) && Number(ordinary.seq) < Number(summary.seq),
    "model order invalid",
  );
  assert.ok(
    summaryDetails.correlation === null || summaryDetails.correlation === undefined,
    "summary is not standalone",
  );
  assert.deepEqual(summaryDetails.toolNames, [], "clean summary must expose no tools");
  assert.ok(
    Array.isArray(ordinaryDetails.toolNames) && ordinaryDetails.toolNames.every((name) => typeof name === "string"),
    "primary tool catalog malformed",
  );
  const ordinaryPrompt = prompt(ordinaryDetails);
  const users = ordinaryPrompt.filter((row) => row.role === "user");
  assert.equal(users.at(-1)?.text, input.literal, "latest primary user is not the exact typed literal");
  assert.ok(
    users.every(
      (row) =>
        !row.text.includes("[MEMORY_SYSTEM]") &&
        !/<\/?(?:existing_memory|conversation_update|agents_md_context)>/u.test(row.text),
    ),
    "memory leaked into user prompt",
  );
  const tags = ordinaryPrompt.filter((row) => row.role === "system" && row.text.startsWith("[MEMORY_SYSTEM]"));
  const expectedTags = input.scenario === "v2-opt-in" ? [0, 1, 0][input.turnIndex] : 0;
  assert.equal(tags.length, expectedTags, "periodic memory system cadence mismatch");
  for (const tag of tags) assert.equal(tag.text, injectedExpected(), "exact compact memory injection mismatch");
  const summaryPrompt = prompt(summaryDetails);
  assert.equal(summaryPrompt.length, 1, "clean summary prompt must be one standalone user wrapper");
  assert.equal(summaryPrompt[0]!.role, "user");
  const wrapper = summaryPrompt[0]!.text;
  const frame = (name: string) => {
    const opens = [...wrapper.matchAll(new RegExp(`^<${name}>\\n`, "gm"))];
    const closes = [...wrapper.matchAll(new RegExp(`^</${name}>(?=\\n|$)`, "gm"))];
    assert.equal(opens.length, 1, `expected unique ${name} DATA opening`);
    assert.equal(closes.length, 1, `expected unique ${name} DATA closing`);
    const start = opens[0]!.index! + opens[0]![0].length;
    const end = closes[0]!.index!;
    assert.ok(end > start && wrapper[end - 1] === "\n", `invalid ${name} DATA framing`);
    return { text: wrapper.slice(start, end - 1), start: opens[0]!.index!, end: end + closes[0]![0].length };
  };
  const existing = frame("existing_memory");
  const delta = frame("conversation_update");
  assert.ok(existing.end < delta.start, "summary DATA frame order mismatch");
  const initialMemory = `${MEMORY_PREFIX}## Session Memory\n\n${[
    "User Instructions",
    "Long Horizon Context",
    "Decisions",
    "Conclusions",
    "Active References",
  ]
    .map((heading) => `### ${heading}\n- None captured yet.\n`)
    .join("\n")}`;
  assert.equal(
    existing.text,
    input.priorMemory?.trim() ? input.priorMemory : initialMemory,
    "summary retained memory mismatch",
  );
  assert.equal(
    delta.text,
    `USER:\n${input.literal}\n\n---\n\nASSISTANT:\n${sharedCoreScenario.assistantText}`,
    "summary delta is not exactly the fresh typed user/ordinary assistant pair",
  );
  const outsideExisting = wrapper.slice(0, existing.start) + wrapper.slice(existing.end);
  for (const prior of JOURNEYS.slice(0, input.turnIndex))
    assert.ok(
      !outsideExisting.includes(`${prior}${input.caseID.slice(-8)}`),
      "old typed turn repeated outside retained memory",
    );
  assert.ok(
    !telemetry.some(
      (row) => row.event === "event.observed" && String(row.observedEvent ?? "").startsWith("tool.execute."),
    ),
    "tool execution observed",
  );
  const starts = logs.filter((row) => row.event === "v2_generation_attempt_start");
  const outcomes = logs.filter((row) => row.event === "v2_generation_attempt_outcome");
  const commits = logs.filter(
    (row) => row.event === "v2_memory_update_committed" || row.event === "memory_update_chunk_done",
  );
  assert.equal(starts.length, 1, "expected exactly one production generation start");
  assert.equal(outcomes.length, 1, "expected exactly one production generation outcome");
  assert.equal(commits.length, 1, "expected exactly one production commit, not telemetry mirrors");
  for (const row of [starts[0]!, outcomes[0]!]) {
    assert.equal(row.sessionID, input.sessionID);
    assert.equal(row.mode, "clean");
    assert.equal(row.providerID, "stm-probe");
    assert.equal(row.modelID, "deterministic-memory");
    assert.equal(row.attempt, 1);
    assert.equal(row.chunkCount, 2);
    assert.equal(row.deltaCount, 2);
  }
  assert.equal(starts[0]!.maxAttempts, 1);
  assert.equal(outcomes[0]!.outcome, "success");
  assert.equal(commits[0]!.event, "v2_memory_update_committed");
  assert.equal(commits[0]!.sessionID, input.sessionID);
  assert.equal(commits[0]!.checkpointID, input.assistantID);
  assert.ok(
    logs.indexOf(starts[0]!) < logs.indexOf(outcomes[0]!) && logs.indexOf(outcomes[0]!) < logs.indexOf(commits[0]!),
    "production generation/commit order mismatch",
  );
  return { requests, invocations, commits };
}
async function waitTurn(
  context: ObservationContext,
  literal: string,
  turnIndex: number,
  baseline: {
    history: DurableRow[];
    prompt: PromptHistoryRow[];
    provider: number;
    telemetry: number;
    log: number;
    memory: Buffer | null;
    checkpoint: Buffer | null;
  },
) {
  const deadline = Math.min(context.deadlineAt, Date.now() + 120_000);
  const observed: { turnIndex: number; raw?: unknown; telemetry?: LogRow[]; logs?: LogRow[]; checkpoint?: string } = {
    turnIndex,
  };
  (context.record.turnEvidence ??= []).push(observed);
  let accepted: DurableRow[] = [];
  let latestRaw: unknown;
  while (Date.now() < deadline) {
    latestRaw = await context.readHistory();
    observed.raw = latestRaw;
    const projected = durableProjection(latestRaw, context.generation);
    const prefix = baseline.history.map((row) => `${row.id}:${row.role}:${row.text}`).join("\n");
    const currentPrefix = projected
      .slice(0, baseline.history.length)
      .map((row) => `${row.id}:${row.role}:${row.text}`)
      .join("\n");
    if (prefix !== currentPrefix) throw new Error(`durable history prefix changed on turn ${turnIndex + 1}`);
    accepted = projected.slice(baseline.history.length);
    const user = accepted.find((row) => row.role === "user" && historyText(row) === literal);
    const assistant = user
      ? accepted.find(
          (row) => row.role === "assistant" && row.text === sharedCoreScenario.assistantText && row.id !== user.id,
        )
      : undefined;
    if (
      user &&
      assistant &&
      (context.generation === "v1" ||
        (assistant.completed !== undefined &&
          assistant.finish === "stop" &&
          assistant.agent === "build" &&
          assistant.model !== undefined &&
          assistant.cost === 0))
    )
      break;
    await Bun.sleep(100);
  }
  const user = accepted.find((row) => row.role === "user" && row.text === literal);
  const assistant = accepted.find((row) => row.role === "assistant" && row.text === sharedCoreScenario.assistantText);
  if (!user || !assistant) throw new Error(`turn ${turnIndex + 1} did not produce a genuine typed user/assistant pair`);
  if (
    context.generation === "v2" &&
    (accepted.length !== 2 ||
      accepted[0] !== user ||
      accepted[1] !== assistant ||
      assistant.completed === undefined ||
      assistant.finish !== "stop" ||
      assistant.agent !== "build" ||
      assistant.model === undefined ||
      assistant.cost !== 0)
  )
    throw new Error(`V2 visible durable turn was not exactly user plus ordinary assistant on turn ${turnIndex + 1}`);
  if (context.generation === "v1" && assistant.parentID !== user.id) {
    const freshNoReply = accepted.find((row) => row.role === "user" && row.text.startsWith(SYSTEM_PREFIX));
    if (!freshNoReply || assistant.parentID !== freshNoReply.id)
      throw new Error(
        `assistant parent did not identify the typed user or fresh NoReply user on turn ${turnIndex + 1}`,
      );
  }
  const promptRows = await readPromptHistory(context.env.XDG_STATE_HOME!, literal);
  if (promptRows.length <= baseline.prompt.length)
    throw new Error(`native prompt history did not accept turn ${turnIndex + 1}`);
  for (const row of promptRows.slice(baseline.prompt.length)) {
    const shape =
      context.generation === "v1"
        ? row.input === literal && Array.isArray(row.parts) && row.mode === "normal"
        : row.text === literal && Array.isArray(row.pasted);
    if (!shape) throw new Error(`native prompt history shape invalid on turn ${turnIndex + 1}`);
  }
  const memoryPath = context.memoryPath;
  let checkpoint = "";
  let telemetryRows: { rows: LogRow[]; next: number } = { rows: [], next: baseline.telemetry };
  let logRows: { rows: LogRow[]; next: number } = { rows: [], next: baseline.log };
  let committed: LogRow[] = [];
  await waitUntil(
    deadline,
    async () => {
      const memoryMatches =
        existsSync(memoryPath) && Buffer.compare(await readFile(memoryPath), Buffer.from(memoryExpected())) === 0;
      checkpoint = await readFile(context.checkpointPath, "utf8").catch(() => "");
      telemetryRows = await jsonl(context.telemetryPath, baseline.telemetry);
      logRows = await jsonl(context.logPath, baseline.log);
      observed.telemetry = telemetryRows.rows;
      observed.logs = logRows.rows;
      observed.checkpoint = checkpoint;
      committed = logRows.rows.filter(
        (row) =>
          (row.event === "memory_update_chunk_done" || row.event === "v2_memory_update_committed") &&
          row.checkpointID === assistant.id &&
          row.sessionID === context.sessionID,
      );
      return memoryMatches && checkpoint === `${assistant.id}\n` && committed.length > 0;
    },
    `automatic memory/checkpoint/commit settlement did not occur on turn ${turnIndex + 1}`,
  );
  const providerRows = context.providerLedger.slice(baseline.provider);
  (context.record.turnEvidence ??= []).push({
    turnIndex,
    raw: latestRaw,
    accepted,
    telemetry: telemetryRows.rows,
    logs: logRows.rows,
    providerRows,
    checkpoint,
    memory: await readFile(memoryPath, "utf8"),
    priorMemory: baseline.memory?.toString("utf8") ?? null,
  });
  if (context.generation === "v1") {
    if (providerRows.length === 0) throw new Error(`V1 provider request was not observed on turn ${turnIndex + 1}`);
    for (const row of providerRows) {
      if (!row || typeof row !== "object" || typeof (row as Record<string, unknown>).latestUserText !== "string")
        throw new Error(`V1 provider row lacks actual latest user text on turn ${turnIndex + 1}`);
      const actual = row as Record<string, unknown>;
      const latest = String(actual.latestUserText);
      if (actual.isSummary === true) {
        const expectedDelta = `USER:\n${literal}\n\n---\n\nASSISTANT:\n${sharedCoreScenario.assistantText}`;
        if (
          !latest.startsWith("<conversation_update>\n") ||
          !latest.endsWith("\n</conversation_update>") ||
          !latest.includes(expectedDelta)
        )
          throw new Error(`V1 summary framing/delta mismatch on turn ${turnIndex + 1}`);
      } else if (latest !== literal && !latest.startsWith(SYSTEM_PREFIX))
        throw new Error(`V1 ordinary provider latest user mismatch on turn ${turnIndex + 1}`);
      const messages = Array.isArray(actual.messages) ? actual.messages : [];
      for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const item = message as Record<string, unknown>;
        if (item.role === "tool") throw new Error(`V1 provider contained a tool role on turn ${turnIndex + 1}`);
        if (
          "tool_calls" in item ||
          "toolCalls" in item ||
          "function_call" in item ||
          (Array.isArray(item.content) &&
            item.content.some(
              (part) =>
                part &&
                typeof part === "object" &&
                ["tool", "tool-call", "tool-result"].includes(String((part as LogRow).type)),
            ))
        )
          throw new Error(`V1 provider contained tool metadata on turn ${turnIndex + 1}`);
        if (
          item.role === "user" &&
          typeof item.content === "string" &&
          item.content.startsWith(SYSTEM_PREFIX) &&
          item.content !== injectedExpected()
        )
          throw new Error(`V1 memory injection body mismatch on turn ${turnIndex + 1}`);
      }
    }
  } else {
    assert.ok(context.scenario === "v2-default-off" || context.scenario === "v2-opt-in");
    validateV2TurnEvidence({
      telemetry: telemetryRows.rows,
      logs: logRows.rows,
      scenario: context.scenario,
      caseID: context.caseID,
      sessionID: context.sessionID,
      assistantID: assistant.id,
      literal,
      turnIndex,
      priorMemory: baseline.memory?.toString("utf8") ?? null,
    });
  }
  context.record.history.push({ turnIndex, raw: latestRaw, projected: accepted });
  context.record.checkpoints.push({ turnIndex, assistantID: assistant.id, rows: committed });
  context.record.providerRequests.push({
    turnIndex,
    rows:
      context.generation === "v2"
        ? telemetryRows.rows.filter((row) => row.event === "model.request" || row.event === "model.invocation")
        : providerRows,
  });
  return {
    user,
    assistant,
    telemetry: telemetryRows.next,
    log: logRows.next,
    memory: await readFile(memoryPath),
    checkpoint: Buffer.from(checkpoint),
  };
}
async function turns(context: ObservationContext) {
  durableProjection(await context.readHistory(), context.generation);
  let telemetryOffset = existsSync(context.telemetryPath) ? (await readFile(context.telemetryPath)).length : 0;
  context.record.telemetryStart = telemetryOffset;
  let logOffset = existsSync(context.logPath) ? (await readFile(context.logPath)).length : 0;
  for (const [turnIndex, base] of JOURNEYS.entries()) {
    const literal = `${base}${context.caseID.slice(-8)}`;
    if (!/^[\x20-\x7e]{1,100}$/u.test(literal) || literal.trim() !== literal)
      throw new Error("journey literal violates keyboard contract");
    const before = {
      history: durableProjection(await context.readHistory(), context.generation),
      prompt: await readPromptHistory(context.env.XDG_STATE_HOME!, literal),
      provider: context.providerLedger.length,
      telemetry: telemetryOffset,
      log: logOffset,
      memory: existsSync(context.memoryPath) ? await readFile(context.memoryPath) : null,
      checkpoint: existsSync(context.checkpointPath) ? await readFile(context.checkpointPath) : null,
    };
    const keyboard = await typeAndSubmitOrdinary({
      pane: context.pane,
      text: literal,
      tmux: async (items) => tmux(context.socket, items, context.env),
      save: (label, screen) => {
        context.record.screens.push(`${label}\n${screen}`);
      },
      label: `${context.caseID}-turn-${turnIndex + 1}`,
      deadlineAt: Math.min(context.deadlineAt, Date.now() + 15_000),
    });
    context.record.history.push({ turnIndex, keyboard });
    const completed = await waitTurn(context, literal, turnIndex, before);
    const quietProvider = context.providerLedger.length;
    if (Date.now() + 2_000 > context.deadlineAt) throw new Error("case deadline cannot accommodate quiet settlement");
    await Bun.sleep(2_000);
    const lateTelemetry = await jsonl(context.telemetryPath, completed.telemetry);
    const lateLog = await jsonl(context.logPath, completed.log);
    (context.record.turnEvidence ??= []).push({
      turnIndex,
      quiet: true,
      telemetry: lateTelemetry.rows,
      logs: lateLog.rows,
      providerRows: context.providerLedger.slice(quietProvider),
    });
    if (context.providerLedger.length !== quietProvider)
      throw new Error(`late provider request after settled turn ${turnIndex + 1}`);
    if (
      lateTelemetry.rows.some(
        (row) =>
          row.event === "model.request" ||
          row.event === "model.invocation" ||
          row.event === "v2_memory_update_committed" ||
          row.event === "memory_update_chunk_done" ||
          (row.event === "event.observed" && String(row.observedEvent ?? "").startsWith("tool.execute.")),
      )
    )
      throw new Error(`late model/tool/commit activity after settled turn ${turnIndex + 1}`);
    if (
      lateLog.rows.some((row) =>
        [
          "v2_generation_attempt_start",
          "v2_generation_attempt_outcome",
          "v2_memory_update_committed",
          "memory_update_chunk_done",
        ].includes(String(row.event)),
      )
    )
      throw new Error(`late production generation/commit after settled turn ${turnIndex + 1}`);
    assert.deepEqual(
      await readFile(context.memoryPath),
      completed.memory,
      "settled memory changed during quiet period",
    );
    assert.deepEqual(
      await readFile(context.checkpointPath),
      completed.checkpoint,
      "settled checkpoint changed during quiet period",
    );
    telemetryOffset = lateTelemetry.next;
    logOffset = lateLog.next;
  }
}

async function main() {
  const options = args(process.argv.slice(2));
  const started = Date.now();
  const runID = randomUUID();
  await requireDiskBudget(PARENT, 4n * 1024n * 1024n * 1024n, "workspace");
  await requireDiskBudget("/tmp", 1024n * 1024n * 1024n, "tmp");
  const runRoot = await mkdtemp(join(PARENT, "keyboard-chat-"));
  await mkdir(join(runRoot, "evidence"), { recursive: true, mode: 0o700 });
  const bootstrapEnv: NodeJS.ProcessEnv = { PATH: `${dirname(BUN)}:/usr/bin:/bin`, LANG: "C.UTF-8" };
  const candidate = await unpackCandidate(options.candidate, runRoot, bootstrapEnv);
  const source = candidate.copy;
  const output: {
    runID: string;
    investigationArtifact: string;
    started: string;
    wallMs: number;
    costConsumed: 0;
    paidInference: false;
    globalBudgetChanged: false;
    scenarios: CaseEvidence[];
  } = {
    runID,
    investigationArtifact: ARTIFACT,
    started: new Date(started).toISOString(),
    wallMs: 0,
    costConsumed: 0,
    paidInference: false,
    globalBudgetChanged: false,
    scenarios: [],
  };
  for (const scenario of options.selected) {
    if (Date.now() - started > MAX_RUN_MS) throw new Error("outer bounded deadline reached");
    const operation = runCase(options, scenario, runRoot, source, candidate.candidateHash, candidate.files);
    let result: CaseEvidence;
    try {
      result = await Promise.race([
        operation,
        Bun.sleep(CASE_MS).then(() => {
          throw new Error("case bounded deadline reached; awaiting owned cleanup");
        }),
      ]);
    } catch (error) {
      result = await operation;
      result.verdict = "FAIL";
      result.error = `${result.error ?? ""}\n${error instanceof Error ? error.message : String(error)}`;
    }
    output.scenarios.push(result);
    await writeDurableEvidence(join(runRoot, "evidence", `${scenario}.json`), result);
  }
  output.wallMs = Date.now() - started;
  await writeDurableEvidence(join(runRoot, "evidence", "result.json"), output);
  console.log(
    JSON.stringify(
      {
        runID,
        runRoot,
        wallMs: output.wallMs,
        costConsumed: output.costConsumed,
        globalBudgetChanged: output.globalBudgetChanged,
        results: output.scenarios.map(({ caseID, verdict, error }) => ({ caseID, verdict, error })),
      },
      null,
      2,
    ),
  );
  if (output.scenarios.some((result) => result.verdict !== "PASS")) process.exitCode = 1;
}

if (import.meta.main) await main();
