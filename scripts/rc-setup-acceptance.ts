import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "../fixtures/v2-generation-probe/node_modules/@opencode/client/dist/promise/index.js";
import type { SessionMemoryConfig } from "../src/memory-utils";
import {
  canSignalOwnedChild,
  cleanupOwnedRoot,
  diskPreflight,
  markOwnedRoot,
  requireDiskBudget,
  signalOwnedChild,
  writeDurableEvidence,
} from "./rc-harness-lifecycle";
import {
  buildConfigScenario,
  CONFIG_SCENARIO_IDS,
  expectedSettingsMetadata,
  type ConfigScenario,
  type ConfigScenarioId,
  type ConfigScenarioPaths,
} from "./rc-config-scenarios";

type V2Client = ReturnType<typeof OpenCode.make>;
type V1ToolPart = {
  type: "tool";
  tool: string;
  callID: string;
  state: { status: string; input?: unknown; output?: string };
};
type V1HistoryRow = { parts?: V1ToolPart[] };
type ProviderMessage = { role?: string; tool_call_id?: string; content?: unknown };
type ProviderBody = {
  stream?: boolean;
  messages?: ProviderMessage[];
  tools?: Array<{ function?: { name?: string }; name?: string }>;
  kind?: "summary" | "settings-initial" | "settings-continuation" | "ordinary";
};

/**
 * Native setup/settings acceptance.  The host and plugin are always loaded by
 * their public native paths; this runner never calls an STM export directly.
 */
const bun = await realpath(process.execPath);
const started = Date.now();
const deadline = started + 1_800_000;
const usage =
  "Usage: bun scripts/rc-setup-acceptance.ts /absolute/candidate.tgz [--v1-host-version 1.19.2] [--v2-host-version 2.0.30] [--case SCENARIO_ID]";
const args = Bun.argv.slice(2);
assert.ok(args.length >= 1 && isAbsolute(args[0]!), usage);
const candidateInput = await realpath(args[0]!);
assert.ok((await stat(candidateInput)).isFile(), "candidate must be a regular file");
let v1Version = "1.19.2";
let v2Version = "2.0.30";
const seenFlags = new Set<string>();
const selectedScenarioIDs: ConfigScenarioId[] = [];
for (let i = 1; i < args.length; i++) {
  const option = args[i];
  assert.ok(option === "--v1-host-version" || option === "--v2-host-version" || option === "--case", usage);
  if (option !== "--case") {
    assert.ok(!seenFlags.has(option), `duplicate flag: ${option}`);
    seenFlags.add(option!);
  }
  const value = args[++i];
  assert.ok(value, usage);
  if (option !== "--case") assert.ok(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value), usage);
  if (option === "--v1-host-version") v1Version = value;
  else if (option === "--v2-host-version") v2Version = value;
  else {
    assert.ok((CONFIG_SCENARIO_IDS as readonly string[]).includes(value), `unknown config scenario: ${value}`);
    assert.ok(!selectedScenarioIDs.includes(value as ConfigScenarioId), `duplicate config scenario: ${value}`);
    selectedScenarioIDs.push(value as ConfigScenarioId);
  }
}
assert.ok(v1Version.startsWith("1."), `V1 host must be generation 1: ${v1Version}`);
assert.ok(v2Version.startsWith("2."), `V2 host must be generation 2: ${v2Version}`);
assert.ok(Date.now() < deadline, "internal deadline exceeded before setup");
const parent = "/home/dev/workspace/opencode-work/stm-readiness-improvements";
const runtimeParent = "/tmp/opencode";
assert.ok(existsSync(parent), `stable evidence parent is missing: ${parent}`);
assert.ok(existsSync(runtimeParent), `runtime case parent is missing: ${runtimeParent}`);
const runID = randomUUID();
const master = await mkdtemp(join(parent, "rc-setup-"));
const hostRoot = join(master, "hosts");
await mkdir(hostRoot, { recursive: true, mode: 0o700 });
await mkdir(join(master, "cases"), { recursive: true, mode: 0o700 });
const stableCandidate = join(master, "candidate.tgz");
await cp(candidateInput, stableCandidate);

type HostGeneration = "v1" | "v2";
type Scope = "global" | "project";
type Origin = "candidate" | "registry" | "source-root" | "source-file" | "bare-tar" | "package-dir";
type Case = {
  id: string;
  host: HostGeneration;
  scope: Scope;
  origin: Origin;
  expected: "positive" | "negative";
  configScenario?: ConfigScenarioId;
};
type CommandRecord = {
  args: string[];
  cwd: string;
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  noChildStarted?: boolean;
};
type CaseEvidence = Record<string, unknown> & { id: string; verdict: string; failures: string[] };

const cases: Case[] = [];
for (const host of ["v1", "v2"] as const)
  for (const origin of ["candidate", "registry"] as const)
    for (const scope of ["global", "project"] as const)
      cases.push({ id: `${host}-${origin}-${scope}`, host, origin, scope, expected: "positive" });
for (const scope of ["global", "project"] as const)
  cases.push({ id: `v1-source-file-${scope}`, host: "v1", origin: "source-file", scope, expected: "positive" });
cases.push({ id: "v2-source-root-project", host: "v2", origin: "source-root", scope: "project", expected: "positive" });
for (const origin of ["source-file", "bare-tar", "package-dir"] as const)
  cases.push({ id: `v2-${origin}-project-negative`, host: "v2", origin, scope: "project", expected: "negative" });
for (const host of ["v1", "v2"] as const)
  for (const scenario of CONFIG_SCENARIO_IDS)
    cases.push({
      id: `config-${host}-${scenario}`,
      host,
      scope: "project",
      origin: "candidate",
      expected: "positive",
      configScenario: scenario,
    });
assert.equal(cases.length, 46);
const availableCases = [...cases];
const selectedCases =
  selectedScenarioIDs.length === 0
    ? cases
    : cases.filter(
        (testCase) => testCase.configScenario !== undefined && selectedScenarioIDs.includes(testCase.configScenario),
      );

const candidateSha = createHash("sha256").update(readFileSync(stableCandidate)).digest("hex");
const children = new Set<ChildProcess>();
const commands: CommandRecord[] = [];
const redaction = (text: string) =>
  text
    .replace(/(server password\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(authorization|api[_-]?key|token|password)([=: \t]+)[^\s,}]+/gi, "$1$2[REDACTED]");

function safeError(error: unknown) {
  if (error instanceof Error) return redaction(error.stack ?? error.message);
  if (typeof error === "string") return redaction(error);
  try {
    return redaction(JSON.stringify(error));
  } catch {
    return "non-serializable failure";
  }
}

function hasExactWarningTarget(line: string, target: string) {
  return line.includes(`target="${target}"`) || line.includes(`target=${target}`);
}

assert.equal(
  hasExactWarningTarget(
    'level=WARN message="configured plugin path must be a directory" target="/tmp/a.tgz" role=server',
    "/tmp/a.tgz",
  ),
  true,
);
assert.equal(
  hasExactWarningTarget(
    'level=WARN message="configured plugin path must be a directory" target="/tmp/a.tgz" role=server',
    "/tmp/a",
  ),
  false,
);

function assertV1ProbeDelta(requests: readonly ProviderBody[], start: number, enabled: boolean) {
  const delta = requests.slice(start);
  assert.equal(delta.filter((request) => request.kind === "settings-initial").length, 1);
  assert.equal(delta.filter((request) => request.kind === "settings-continuation").length, 1);
  assert.equal(
    delta
      .filter((request) => request.kind === "settings-continuation")
      .flatMap((request) => request.messages ?? [])
      .filter((message) => message.role === "tool" && message.tool_call_id === "stm-rc-tool-settings").length,
    1,
  );
  if (!enabled) assert.equal(delta.filter((request) => request.kind === "summary").length, 0);
}

const run = async (
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeout = 60_000,
  allowFailure = false,
) => {
  assert.ok(Date.now() < deadline, "overall deadline exceeded");
  const record: CommandRecord = { args: argv, cwd, status: null, stdout: "", stderr: "", timedOut: false };
  commands.push(record);
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.once("error", (error) => {
    record.spawnError = safeError(error);
    if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 1) record.noChildStarted = true;
  });
  children.add(child);
  child.stdout!.on("data", (chunk) => (record.stdout += redaction(chunk.toString())));
  child.stderr!.on("data", (chunk) => (record.stderr += redaction(chunk.toString())));
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
          if (!canSignalOwnedChild(child) || !signalOwnedChild(child, "SIGKILL", { detached: true, group: true }))
            record.noChildStarted = true;
          reject(new Error(`timed out after ${timeout}ms: ${argv.join(" ")}`));
        }, timeout);
      }),
    ]);
    if (!allowFailure) assert.equal(record.status, 0, `${argv.join(" ")}: ${record.stderr}`);
    return record;
  } finally {
    clearTimeout(timer);
    if (record.timedOut && canSignalOwnedChild(child))
      signalOwnedChild(child, "SIGKILL", { detached: true, group: true });
    children.delete(child);
  }
};

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const within = (root: string, path: string) => {
  const relativePath = relative(root, path);
  return relativePath === "" || (!isAbsolute(relativePath) && !relativePath.startsWith(".."));
};
const normalizedSettings = (memoryDir: string, local: boolean): SessionMemoryConfig => ({
  enabled: false,
  memoryModel: "stm-probe/deterministic",
  summarizerMode: "active",
  cleanFallbackToActiveSession: false,
  includeAgentsMdOnFirstUpdate: true,
  injectInSubagents: false,
  enableLegacyPeriodicSystemTransform: false,
  sideSessionRetries: 2,
  remindEveryN: local ? 7 : 2,
  maxMemoryLength: 2000,
  maxUpdateInputLength: 3000,
  debounceMs: 60000,
  debug: false,
  logMaxLines: 1000,
  maxDeltaMessages: 60,
  collapseAssistantBursts: true,
  memoryDir,
});

async function registryMetadata(name: string, version: string) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `${url}: ${response.status}`);
  const value = (await response.json()) as { name: string; version: string; dist?: unknown };
  assert.equal(value.version, version);
  return { url, ...value };
}

async function installHost(generation: HostGeneration, version: string) {
  const directory = join(hostRoot, generation);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const packageName = generation === "v1" ? "opencode-ai" : "@opencode/cli";
  await Bun.write(join(directory, "package.json"), json({ private: true, dependencies: { [packageName]: version } }));
  const scratch = join(master, "scratch", `host-${generation}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  for (const name of ["xdg-cache", "bun-cache", "npm-cache"])
    await mkdir(join(scratch, name), { recursive: true, mode: 0o700 });
  await markOwnedRoot(scratch, { runID, caseID: `host-${generation}`, kind: "cache" });
  const environment = baseEnvironment(master, `host-${generation}`, scratch);
  await mkdir(environment.HOME, { recursive: true });
  await mkdir(dirname(environment.OPENCODE_DB), { recursive: true });
  await mkdir(dirname(environment.npm_config_userconfig), { recursive: true });
  await mkdir(environment.npm_config_cache, { recursive: true });
  await mkdir(environment.BUN_INSTALL_CACHE_DIR, { recursive: true });
  await Bun.write(environment.npm_config_userconfig, "");
  await run(
    [bun, "install", "--production", "--registry", "https://registry.npmjs.org"],
    directory,
    environment,
    120_000,
  );
  const packageRoot = join(directory, "node_modules", packageName);
  const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as {
    version: string;
    bin?: Record<string, string>;
  };
  assert.equal(manifest.version, version);
  const nativeName = generation === "v1" ? `opencode-linux-${process.arch}` : `@opencode/cli-linux-${process.arch}`;
  const native = join(directory, "node_modules", nativeName, "bin", "opencode");
  assert.ok(existsSync(native), `native launcher missing: ${native}`);
  const launcherHash = hashFile(native);
  const versionOutput = await run([native, "--version"], directory, environment, 20_000);
  assert.match(versionOutput.stdout, new RegExp(version.replaceAll(".", "\\.")));
  return {
    generation,
    version,
    packageName,
    directory,
    native,
    launcherHash,
    versionOutput: versionOutput.stdout.trim(),
    manifest,
  };
}

const hosts = { v1: await installHost("v1", v1Version), v2: await installHost("v2", v2Version) };
const sourceRoot = await realpath(join(import.meta.dir, ".."));
const fixture = await realpath(join(sourceRoot, "fixtures/v2-generation-probe"));
const published = await registryMetadata("@atonev/opencode-short-term-memory", "1.4.0-rc.5");
const candidateManifest = JSON.parse(
  (
    await run(
      ["/usr/bin/tar", "-xOf", stableCandidate, "package/package.json"],
      master,
      baseEnvironment(master, "metadata"),
    )
  ).stdout,
) as { name: string; version: string };
assert.equal(candidateManifest.name, "@atonev/opencode-short-term-memory");

const aggregate: Record<string, unknown> = {
  runID,
  started: new Date(started).toISOString(),
  parent,
  master,
  artifact: {
    source: candidateInput,
    retainedCopy: stableCandidate,
    sha256: candidateSha,
    manifest: candidateManifest,
  },
  publishedReference: { package: published.name, version: published.version, dist: published.dist },
  platform: process.platform,
  arch: process.arch,
  bun: { executable: bun, version: Bun.version },
  hosts,
  availableCases,
  selectedCases,
  completeMatrix: selectedCases.length === availableCases.length,
  commands,
  costConsumed: 0,
  globalBudgetChanged: false,
  verdict: "FAIL",
  results: [],
  limitations: [
    "V2 source-root is server-only; TUI/RPC are deliberately unverified.",
    "No provider inference is external or billable.",
  ],
};
const results = aggregate.results as CaseEvidence[];

function baseEnvironment(root: string, suffix = "case", cacheRoot = join(root, suffix, "cache")) {
  const caseRoot = join(root, suffix);
  const password = randomUUID();
  const env: Record<string, string> = {
    HOME: join(caseRoot, "home"),
    XDG_CONFIG_HOME: join(caseRoot, "config"),
    XDG_DATA_HOME: join(caseRoot, "data"),
    XDG_STATE_HOME: join(caseRoot, "state"),
    XDG_CACHE_HOME: join(cacheRoot, "xdg-cache"),
    XDG_RUNTIME_DIR: join(caseRoot, "runtime"),
    TMPDIR: join(caseRoot, "tmp"),
    TMP: join(caseRoot, "tmp"),
    TEMP: join(caseRoot, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(cacheRoot, "bun-cache"),
    npm_config_cache: join(cacheRoot, "npm-cache"),
    npm_config_userconfig: join(caseRoot, "config", "empty.npmrc"),
    npm_config_registry: "https://registry.npmjs.org",
    OPENCODE_DB: join(caseRoot, "data", "opencode.db"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    PATH: `${dirname(bun)}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    OPENCODE_SERVER_PASSWORD: password,
  };
  return env;
}

async function inventoryV1(base: string, project: string, password: string, record: CaseEvidence) {
  const response = await fetch(`${base}/command?directory=${encodeURIComponent(project)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    signal: AbortSignal.timeout(120_000),
  });
  assert.ok(response.ok);
  const value = await response.json();
  record.commandInventory = value;
  return value as { name?: string }[];
}

function isExactSTMSource(source: unknown) {
  if (!source || typeof source !== "object") return false;
  const candidate = source as { type?: unknown; target?: unknown };
  return (
    candidate.type === "package" &&
    typeof candidate.target === "string" &&
    candidate.target.startsWith("@atonev/opencode-short-term-memory@")
  );
}

assert.equal(isExactSTMSource({ type: "package", target: "dcp" }), false);
assert.equal(isExactSTMSource({ type: "package", target: "@atonev/opencode-short-term-memory@file:/x" }), true);
assert.equal(
  isExactSTMSource({
    type: "path",
    target: "/workspace/opencode-short-term-memory/fixtures/v2-generation-probe/index.ts",
  }),
  false,
);

async function inventoryV2(
  base: string,
  project: string,
  password: string,
  testCase: Case,
  configuredTarget: string,
  record: CaseEvidence,
) {
  const client = OpenCode.make({
    baseUrl: base,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  });
  const info = await client.server.info({ signal: AbortSignal.timeout(20_000) });
  assert.equal(info.version, hosts.v2.version);
  const until = Date.now() + 120_000;
  let plugins = await client.plugin.list(
    { location: { directory: project } },
    { signal: AbortSignal.timeout(120_000) },
  );
  let command = await client.command.list(
    { location: { directory: project } },
    { signal: AbortSignal.timeout(120_000) },
  );
  let ready = false;
  while (Date.now() < until) {
    const product = plugins.data.find(
      (item) =>
        item.id === "opencode-short-term-memory" ||
        (item.id !== "stm-v2-generation-probe" && isExactSTMSource(item.source)),
    );
    const fixturePlugin = plugins.data.find((item) => item.id === "stm-v2-generation-probe");
    const hasSTM = command.data.some((item) => item.name === "stm");
    const productActive = product?.state.status === "active";
    const fixtureActive = fixturePlugin?.state.status === "active";
    if (testCase.expected === "positive" && product?.state.status === "failed")
      throw new Error("STM product plugin failed during V2 activation");
    if (fixturePlugin?.state.status === "failed") throw new Error("V2 fixture plugin failed during V2 activation");
    if (
      testCase.expected === "positive"
        ? productActive && fixtureActive && hasSTM
        : fixtureActive && !hasSTM && product?.state.status !== "active"
    ) {
      ready = true;
      break;
    }
    await Bun.sleep(250);
    plugins = await client.plugin.list({ location: { directory: project } }, { signal: AbortSignal.timeout(120_000) });
    command = await client.command.list({ location: { directory: project } }, { signal: AbortSignal.timeout(120_000) });
  }
  assert.ok(ready, `V2 activation did not reach the expected state for ${testCase.id}`);
  assert.ok(Array.isArray(plugins.data), "V2 plugin inventory is not an array");
  assert.ok(Array.isArray(command.data), "V2 command inventory is not an array");
  if (testCase.expected === "positive") assert.ok(command.data.length > 0, "V2 positive command inventory is empty");
  if (testCase.origin === "package-dir")
    assert.equal(
      plugins.data.find(
        (item) =>
          item.id === "opencode-short-term-memory" ||
          (item.id !== "stm-v2-generation-probe" && isExactSTMSource(item.source)),
      ),
      undefined,
      "package-directory negative unexpectedly selected an STM product",
    );
  const unexpected = plugins.data.filter((item) => {
    if (item.id === "opencode-short-term-memory" || item.id === "stm-v2-generation-probe") return false;
    const source = JSON.stringify(item.source) ?? "";
    const configuredFailure =
      testCase.expected === "negative" &&
      item.state.status === "failed" &&
      (source.includes(configuredTarget) || source.includes("candidate.tgz") || source.includes("index.ts"));
    if (configuredFailure) return false;
    return !source.includes('"type":"builtin"') && !source.includes('"type": "builtin"');
  });
  assert.deepEqual(unexpected, [], "V2 discovered an unexpected external plugin");
  record.loadedSourceOrigins = plugins.data.map((item) => ({ id: item.id, source: item.source, state: item.state }));
  record.rpc = { client: "@opencode/client", serverInfo: info, pluginList: plugins, commandList: command };
  return { client, commands: command.data };
}

const settingsKeys = Object.keys(normalizedSettings("/case/.opencode/memory", false));
function assertSettingsObject(
  value: unknown,
  expected: ReturnType<typeof normalizedSettings>,
  expectedMetadata: ReturnType<typeof expectedSettingsMetadata>,
  generation: HostGeneration,
) {
  assert.ok(value && typeof value === "object");
  const object = value as Record<string, unknown>;
  const config =
    generation === "v2" && object.resolvedConfig && typeof object.resolvedConfig === "object"
      ? (object.resolvedConfig as Record<string, unknown>)
      : object;
  assert.deepEqual(
    Object.keys(config)
      .filter((key) => settingsKeys.includes(key))
      .sort(),
    [...settingsKeys].sort(),
  );
  if (generation === "v1")
    assert.deepEqual(
      Object.keys(object).sort(),
      [...settingsKeys, "effectiveDeliveryMode", "memoryModelSelection"].sort(),
    );
  for (const key of settingsKeys)
    assert.deepEqual(config[key], expected[key as keyof typeof expected], `settings key ${key}`);
  if (generation === "v1") {
    assert.equal(object.memoryModelSelection, expectedMetadata.memoryModelSelection);
    assert.equal(object.effectiveDeliveryMode, expectedMetadata.effectiveDeliveryMode);
  } else {
    assert.equal(object.generation, "v2");
    assert.ok(object.effective && typeof object.effective === "object");
    const effective = object.effective as Record<string, unknown>;
    assert.deepEqual(effective, {
      ...expected,
      memoryModel: expectedMetadata.effectiveMemoryModel,
      memoryModelSelection: expectedMetadata.memoryModelSelection,
      activeWithExplicitMemoryModel: "unsupported",
      updateHook: "context",
      injectionHooks: ["context", "compaction"],
    });
    assert.deepEqual(object.inactiveSettings, []);
  }
  return config;
}

async function probeV2(
  client: V2Client,
  project: string,
  expected: ReturnType<typeof normalizedSettings>,
  expectedMetadata: ReturnType<typeof expectedSettingsMetadata>,
  record: CaseEvidence,
  phase = "initial",
) {
  const probeStarted = new Date().toISOString();
  const session = await client.session.create(
    {
      title: "STM RC settings",
      agent: "build",
      model: { providerID: "stm-probe", id: "deterministic" },
      location: { directory: project },
    },
    { signal: AbortSignal.timeout(30_000) },
  );
  await client.session.prompt(
    { sessionID: session.id, text: "STM_RC_TOOL:settings" },
    { signal: AbortSignal.timeout(30_000) },
  );
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
  const history = await client.session.context({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
  const toolParts = history
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "tool")
    .filter((part) => part.name === "stm_memory_settings");
  assert.equal(toolParts.length, 1, "V2 durable history must contain exactly one settings tool part");
  const toolPart = toolParts[0]!;
  assert.equal(toolPart.id, "stm-rc-tool:settings");
  if (toolPart.state?.status !== "completed") throw new Error("V2 settings tool did not complete");
  assert.deepEqual(toolPart.state.input, {});
  const resultText = toolPart.state.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  assert.ok(resultText, "V2 durable settings tool result missing");
  const parsed = JSON.parse(resultText);
  const resolved = assertSettingsObject(parsed, expected, expectedMetadata, "v2");
  record.settingsTool = {
    invoked: true,
    generation: "v2",
    sessionID: session.id,
    callID: "stm-rc-tool:settings",
    tool: "stm_memory_settings",
    durable: true,
    result: resolved,
  };
  const probes = Array.isArray(record.probes) ? record.probes : [];
  probes.push({
    phase,
    sessionID: session.id,
    actualConfig: resolved,
    metadata: expectedMetadata,
    startedAt: probeStarted,
    finishedAt: new Date().toISOString(),
  });
  record.probes = probes;
}

async function probeV1(
  base: string,
  project: string,
  password: string,
  expected: ReturnType<typeof normalizedSettings>,
  expectedMetadata: ReturnType<typeof expectedSettingsMetadata>,
  record: CaseEvidence,
  phase = "initial",
) {
  const probeStarted = new Date().toISOString();
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return (await response.json()) as { id: string };
  };
  const session = await post("/session", { title: "STM RC settings" });
  await post(`/session/${session.id}/message`, {
    parts: [{ type: "text", text: "STM_RC_TOOL:settings" }],
    model: { providerID: "stm-probe", modelID: "deterministic" },
  });
  const response = await fetch(`${base}/session/${session.id}/message?directory=${encodeURIComponent(project)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok);
  const history = (await response.json()) as V1HistoryRow[];
  const toolParts = history
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.tool === "stm_memory_settings");
  assert.equal(toolParts.length, 1, "V1 durable history must contain exactly one settings tool part");
  const toolPart = toolParts[0]!;
  assert.equal(toolPart.callID, "stm-rc-tool-settings");
  assert.equal(toolPart.state.status, "completed");
  assert.deepEqual(toolPart.state.input, {});
  assert.equal(typeof toolPart.state.output, "string");
  const resolved = assertSettingsObject(JSON.parse(toolPart.state.output!), expected, expectedMetadata, "v1");
  record.settingsTool = {
    invoked: true,
    generation: "v1",
    sessionID: session.id,
    callID: "stm-rc-tool-settings",
    tool: "stm_memory_settings",
    durable: true,
    result: resolved,
  };
  const probes = Array.isArray(record.probes) ? record.probes : [];
  probes.push({
    phase,
    sessionID: session.id,
    actualConfig: resolved,
    metadata: expectedMetadata,
    startedAt: probeStarted,
    finishedAt: new Date().toISOString(),
  });
  record.probes = probes;
}

async function executeCase(testCase: Case) {
  const caseEvidenceDir = join(master, "cases", testCase.id);
  await mkdir(caseEvidenceDir, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(runtimeParent, `stm-rc-setup-case-${runID}-${testCase.id}-`));
  const caseRoot = join(root, "case");
  await mkdir(caseRoot, { recursive: true, mode: 0o700 });
  const project = join(caseRoot, "workspace");
  const cacheRoot = join(master, "scratch", testCase.id);
  await requireDiskBudget(parent, 4n * 1024n * 1024n * 1024n, "stable workspace");
  await requireDiskBudget(runtimeParent, 1n * 1024n * 1024n * 1024n, "runtime parent");
  const preflight = { workspace: await diskPreflight(parent), runtimeParent: await diskPreflight(runtimeParent) };
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  for (const name of ["xdg-cache", "bun-cache", "npm-cache"])
    await mkdir(join(cacheRoot, name), { recursive: true, mode: 0o700 });
  await markOwnedRoot(root, { runID, caseID: testCase.id, kind: "runtime" });
  await markOwnedRoot(cacheRoot, { runID, caseID: testCase.id, kind: "cache" });
  const env = baseEnvironment(caseRoot, "", cacheRoot);
  await mkdir(dirname(env.npm_config_userconfig), { recursive: true, mode: 0o700 });
  await Bun.write(env.npm_config_userconfig, "");
  const record: CaseEvidence = {
    id: testCase.id,
    verdict: "FAIL",
    failures: [],
    root,
    project,
    environment: { ...env, OPENCODE_SERVER_PASSWORD: "[redacted]" },
    expected: testCase.expected,
    host: testCase.host,
    origin: testCase.origin,
    scope: testCase.scope,
    preflight,
    runtimeRoot: root,
    caseRoot,
    cacheRoot,
  };
  let server: ChildProcess | undefined;
  let serverSpawnError: string | undefined;
  let provider: ReturnType<typeof Bun.serve> | undefined;
  let hostLog = "";
  const providerRequests: ProviderBody[] = [];
  let target = "";
  let expectedWarningTarget: string | undefined;
  let childrenExitedProof = true;
  let portsClosedProof = true;
  let livePids: number[] = [];
  try {
    env.PROBE_RUN_ID = `${runID}-${testCase.id}-${randomUUID()}`;
    env.PROBE_MODE = "ordinary";
    for (const path of Object.values(env)) {
      if (path.startsWith(root) && path !== env.OPENCODE_DB && path !== env.npm_config_userconfig)
        await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await mkdir(dirname(env.OPENCODE_DB), { recursive: true, mode: 0o700 });
    await mkdir(project, { recursive: true, mode: 0o700 });
    await run(["/usr/bin/git", "init", "--quiet"], project, env, 10_000);
    const gitBoundary = (
      await run(["/usr/bin/git", "rev-parse", "--show-toplevel"], project, env, 10_000)
    ).stdout.trim();
    assert.equal(await realpath(gitBoundary), await realpath(project), "project Git boundary escaped workspace");
    record.gitBoundary = gitBoundary;
    const memoryDir = join(caseRoot, ".opencode", "memory");
    const globalSettings = normalizedSettings(memoryDir, false);
    const localSettings = normalizedSettings(memoryDir, true);
    const configPaths: ConfigScenarioPaths = {
      globalConfigDirectory: join(env.XDG_CONFIG_HOME, "opencode"),
      legacyGlobalDirectory: join(env.HOME, ".opencode"),
      environmentConfigDirectory: join(caseRoot, "environment-config"),
      projectDirectory: project,
      memoryDirectory: memoryDir,
    };
    const scenario: ConfigScenario | undefined = testCase.configScenario
      ? buildConfigScenario(testCase.configScenario, configPaths, testCase.host)
      : undefined;
    if (scenario) {
      for (const directory of scenario.directoriesToCreate) {
        assert.ok(within(caseRoot, directory), `planned directory escaped case root: ${directory}`);
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      for (const planned of scenario.plannedFiles) {
        assert.ok(within(caseRoot, planned.path), `planned config escaped case root: ${planned.path}`);
        await mkdir(dirname(planned.path), { recursive: true, mode: 0o700 });
        if (planned.content !== null) await Bun.write(planned.path, planned.content);
        else await rm(planned.path, { force: true });
      }
      record.plannedConfigSnapshot = scenario.plannedFiles.map((planned) => ({
        path: planned.path,
        exists: existsSync(planned.path),
        sha256: existsSync(planned.path) ? hashFile(planned.path) : null,
      }));
      if (scenario.environmentConfigDir) env.OPENCODE_CONFIG_DIR = scenario.environmentConfigDir;
    } else {
      await mkdir(configPaths.globalConfigDirectory, { recursive: true });
      await Bun.write(join(configPaths.globalConfigDirectory, "stm.jsonc"), json(globalSettings));
      if (testCase.scope === "project") {
        await mkdir(join(project, ".opencode"), { recursive: true });
        await Bun.write(join(project, ".opencode", "stm.jsonc"), json(localSettings));
      }
    }
    const globalConfigDir = configPaths.globalConfigDirectory;
    const projectSettingsPath = join(project, ".opencode", "stm.jsonc");
    const originalConfigBytes = existsSync(join(globalConfigDir, "stm.jsonc"))
      ? readFileSync(join(globalConfigDir, "stm.jsonc"))
      : null;
    const originalProjectSettingsBytes = existsSync(projectSettingsPath) ? readFileSync(projectSettingsPath) : null;
    let expectedConfig = scenario?.expectedConfig17 ?? (testCase.scope === "project" ? localSettings : globalSettings);
    let expectedMetadata =
      scenario?.expectedSettingsMetadata ?? expectedSettingsMetadata(testCase.host, expectedConfig);
    record.configScenario = scenario?.id ?? null;
    record.expectedConfig17 = expectedConfig;
    record.expectedSettingsMetadata = expectedMetadata;
    record.knownIssues = scenario?.knownIssues ?? [];
    if (scenario?.hotReload) record.hotReloadExpectations = scenario.hotReload;
    target = `@atonev/opencode-short-term-memory@1.4.0-rc.5`;
    if (testCase.origin === "candidate" || testCase.origin === "bare-tar") {
      const copy = join(root, "candidate.tgz");
      await cp(stableCandidate, copy);
      target = testCase.origin === "bare-tar" ? copy : `@atonev/opencode-short-term-memory@file:${copy}`;
    } else if (testCase.origin === "source-root") target = sourceRoot;
    else if (testCase.origin === "source-file") target = `file://${join(sourceRoot, "src/index.ts")}`;
    else if (testCase.origin === "package-dir") {
      const extraction = join(root, "extracted");
      await mkdir(extraction);
      await run(["/usr/bin/tar", "-xzf", stableCandidate, "-C", extraction], root, env);
      target = join(extraction, "package");
      const nativeEntryCandidates = [
        "index.ts",
        "index.tsx",
        "index.js",
        "index.mjs",
        "server.ts",
        "server.tsx",
        "server.js",
        "server.mjs",
      ].map((entry) => join(target, entry));
      const presentNativeEntries = nativeEntryCandidates.filter((entry) => existsSync(entry));
      assert.deepEqual(presentNativeEntries, [], "extracted package unexpectedly contains a native root entry");
      record.packageDirectoryProof = {
        root: target,
        manifest: await Bun.file(join(target, "package.json")).json(),
        candidateTarballSha256: candidateSha,
        checkedNativeEntries: nativeEntryCandidates,
        presentNativeEntries,
      };
    }
    if (testCase.origin === "source-file") expectedWarningTarget = fileURLToPath(target);
    if (testCase.origin === "bare-tar") expectedWarningTarget = target;
    const providerURL = `http://127.0.0.1:${
      (provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          if (!new URL(request.url).pathname.endsWith("/chat/completions"))
            return new Response("Not found", { status: 404 });
          const body = (await request.json()) as ProviderBody;
          const callID = "stm-rc-tool-settings";
          const continuation = (body.messages ?? []).some(
            (message) => message.role === "tool" && message.tool_call_id === callID,
          );
          const summaryRequest = (body.messages ?? []).some((message) => {
            const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
            return text.includes("<conversation_update>") && text.includes("<existing_memory>");
          });
          const kind = summaryRequest
            ? "summary"
            : continuation
              ? "settings-continuation"
              : (body.messages ?? []).some((message) => JSON.stringify(message).includes("STM_RC_TOOL:settings"))
                ? "settings-initial"
                : "ordinary";
          providerRequests.push({ ...body, kind });
          if (summaryRequest) {
            const summary =
              "## Facts\nDeterministic fixture fact.\n\n## Decisions\nDeterministic fixture decision.\n\n## Open Questions\nNone.\n\n## Constraints\nNo external inference.\n\n## Next Steps\nContinue deterministically.";
            const summaryResponse = {
              id: "stm-rc-summary",
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: summary }, finish_reason: "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
            if (!body.stream) return Response.json(summaryResponse);
            const summaryChunks = [
              {
                id: summaryResponse.id,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: summary }, finish_reason: null }],
              },
              {
                id: summaryResponse.id,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            ];
            return new Response(
              summaryChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          const ordinary = {
            id: "stm-rc-probe-final",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "STM_RC_TOOL_COMPLETE:settings" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          if (continuation) {
            if (!body.stream) return Response.json(ordinary);
            const ordinaryChunks = [
              {
                id: ordinary.id,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: ordinary.choices[0]!.message.content },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: ordinary.id,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            ];
            return new Response(
              ordinaryChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          const response = {
            id: "stm-rc-probe",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  tool_calls: [
                    { id: callID, type: "function", function: { name: "stm_memory_settings", arguments: "{}" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          if (!body.stream) return Response.json(response);
          const chunks = [
            {
              id: response.id,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: callID,
                        type: "function",
                        function: { name: "stm_memory_settings", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: response.id,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
          ];
          return new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      })).port
    }/v1`;
    env.PROBE_RC_TOOLS = "1";
    env.PROBE_TASK_CHILD = "0";
    env.PROBE_SCENARIO = "none";
    env.PROBE_MEMORY_DIR = memoryDir;
    env.PROBE_TELEMETRY_PATH = join(root, "telemetry.jsonl");
    const v1ModelConfig = {
      model: "stm-probe/deterministic",
      small_model: "stm-probe/deterministic",
      provider: {
        "stm-probe": {
          npm: "@ai-sdk/openai-compatible",
          name: "STM deterministic",
          options: { baseURL: providerURL, apiKey: "local-only" },
          models: {
            deterministic: {
              name: "deterministic",
              limit: { context: 128000, output: 4096 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
      agent: { build: { model: "stm-probe/deterministic", permission: { "*": "deny", stm_memory_settings: "allow" } } },
    };
    const config =
      testCase.host === "v1"
        ? { ...v1ModelConfig, plugin: [target] }
        : { plugins: [target, fixture], update: "disable" };
    const launchDirectory = scenario?.launchDirectory ?? project;
    assert.ok(within(caseRoot, launchDirectory), `launch directory escaped case root: ${launchDirectory}`);
    record.projectDirectory = project;
    record.launchDirectory = launchDirectory;
    record.environmentAfterConfig = { ...env, OPENCODE_SERVER_PASSWORD: "[redacted]" };
    const configPath = scenario?.environmentConfigDir
      ? join(scenario.environmentConfigDir, "opencode.json")
      : testCase.scope === "global"
        ? join(globalConfigDir, "opencode.json")
        : join(project, "opencode.json");
    record.provenance =
      testCase.origin === "candidate"
        ? { origin: "candidate-tarball", sha256: candidateSha, manifest: candidateManifest }
        : testCase.origin === "registry"
          ? { origin: "registry", package: published.name, version: published.version, dist: published.dist }
          : testCase.origin === "source-root" || testCase.origin === "source-file"
            ? {
                origin: testCase.origin,
                sourceEntry: join(sourceRoot, "src/index.ts"),
                sourceEntrySha256: hashFile(join(sourceRoot, "src/index.ts")),
                qualification: "V2 source-root is server-only; TUI/RPC are not verified",
              }
            : testCase.origin === "package-dir"
              ? {
                  origin: testCase.origin,
                  expectedNativeLoaderFailure: true,
                  expectedReason: "silent no native server/index entry",
                  preparedTarballSha256: candidateSha,
                  preparedManifest: candidateManifest,
                }
              : { origin: testCase.origin, expectedNativeLoaderFailure: true };
    await Bun.write(configPath, json(config));
    record.configuration = {
      target,
      configPath,
      settings: { global: globalSettings, project: testCase.scope === "project" ? localSettings : undefined },
    };
    const host = hosts[testCase.host];
    const args = [host.native, "serve", "--hostname", "127.0.0.1", "--port", "0"];
    server = spawn(args[0]!, args.slice(1), {
      cwd: launchDirectory,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    record.hostPID = server.pid ?? null;
    server.once("error", (error) => {
      serverSpawnError = safeError(error);
    });
    children.add(server);
    server.stdout!.on("data", (chunk) => (hostLog += redaction(chunk.toString())));
    server.stderr!.on("data", (chunk) => (hostLog += redaction(chunk.toString())));
    const until = Date.now() + 60_000;
    let endpoint = "";
    while (Date.now() < until && !endpoint) {
      if (serverSpawnError) throw new Error(`native host spawn failed: ${serverSpawnError}`);
      if (server.exitCode !== null || server.signalCode !== null)
        throw new Error(`native host exited before listening: ${hostLog}`);
      endpoint = hostLog.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
      if (!endpoint) await Bun.sleep(100);
    }
    record.hostLog = hostLog;
    if (!endpoint) throw new Error(`host listener unavailable: ${hostLog}`);
    record.endpoint = endpoint;
    const v2 =
      testCase.host === "v2"
        ? await inventoryV2(endpoint, launchDirectory, env.OPENCODE_SERVER_PASSWORD, testCase, target, record)
        : undefined;
    const inventory =
      testCase.host === "v1"
        ? await inventoryV1(endpoint, launchDirectory, env.OPENCODE_SERVER_PASSWORD, record)
        : v2!.commands;
    const diagnosticPath = join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log");
    if (existsSync(diagnosticPath)) {
      const bytes = readFileSync(diagnosticPath);
      hostLog += `\n--- owned opencode.log ---\n${redaction(bytes.subarray(0, 2_000_000).toString("utf8"))}`;
      record.ownedHostLog = { path: diagnosticPath, bytes: bytes.length, truncated: bytes.length > 2_000_000 };
    }
    const active = inventory.some((entry) => entry.name === "stm");
    const pluginLoadedCountBefore = (hostLog.match(/plugin_loaded/g) ?? []).length;
    record.pluginLoadedCountBefore = pluginLoadedCountBefore;
    record.loader = {
      active,
      expected: testCase.expected === "positive",
      warningOrError: testCase.expected === "negative" ? hostLog : undefined,
    };
    if (testCase.expected === "positive") assert.ok(active, "native stm command is not active");
    else {
      const expectedReason =
        testCase.origin === "source-file"
          ? "source file is not a package"
          : testCase.origin === "bare-tar"
            ? "tarball path is not a package specifier"
            : "silent no native server/index entry";
      record.expectedNegativeReason = expectedReason;
      assert.ok(!active, `unsupported target unexpectedly activated (${expectedReason})`);
    }
    if (testCase.expected === "positive") {
      const initialProviderRequestStart = providerRequests.length;
      if (testCase.host === "v2") await probeV2(v2!.client, launchDirectory, expectedConfig, expectedMetadata, record);
      else
        await probeV1(
          endpoint,
          launchDirectory,
          env.OPENCODE_SERVER_PASSWORD,
          expectedConfig,
          expectedMetadata,
          record,
        );
      assert.equal((record.settingsTool as { invoked: boolean }).invoked, true);
      if (testCase.host === "v1") {
        assertV1ProbeDelta(providerRequests, initialProviderRequestStart, expectedConfig.enabled);
        const primary = providerRequests.find((request) =>
          (request.messages ?? []).some((message) => JSON.stringify(message).includes("STM_RC_TOOL:settings")),
        );
        assert.ok(primary, "V1 primary marker request missing");
        assert.deepEqual(
          (primary.tools ?? [])
            .map((tool) => tool.function?.name ?? tool.name)
            .filter((name) => name === "stm_memory_settings"),
          ["stm_memory_settings"],
        );
        const continuation = providerRequests.find((request) =>
          (request.messages ?? []).some(
            (message) => message.role === "tool" && message.tool_call_id === "stm-rc-tool-settings",
          ),
        );
        assert.ok(continuation, "V1 provider continuation did not match the actual tool_call_id");
        record.providerCorrelation = {
          primaryTool: "stm_memory_settings",
          callID: "stm-rc-tool-settings",
          continuationMatched: true,
          requests: providerRequests.length,
        };
      }
      if (scenario?.hotReload) {
        for (const mutation of scenario.hotReload.mutationFiles) {
          assert.ok(within(caseRoot, mutation.path), `hot-reload mutation escaped case root: ${mutation.path}`);
          await mkdir(dirname(mutation.path), { recursive: true, mode: 0o700 });
          if (mutation.content !== null) await Bun.write(mutation.path, mutation.content);
        }
        const waitMs = scenario.hotReload.waitMsByGeneration[testCase.host];
        const mutationAt = Date.now();
        expectedConfig = scenario.hotReload.immediateByGeneration[testCase.host];
        expectedMetadata = expectedSettingsMetadata(testCase.host, expectedConfig);
        const hotProbeStart = providerRequests.length;
        if (testCase.host === "v2")
          await probeV2(v2!.client, launchDirectory, expectedConfig, expectedMetadata, record, "hot-reload");
        else
          await probeV1(
            endpoint,
            launchDirectory,
            env.OPENCODE_SERVER_PASSWORD,
            expectedConfig,
            expectedMetadata,
            record,
            "hot-reload",
          );
        if (testCase.host === "v1") assertV1ProbeDelta(providerRequests, hotProbeStart, expectedConfig.enabled);
        if (testCase.host === "v1") {
          const remainingWait = Math.max(0, waitMs - (Date.now() - mutationAt));
          if (remainingWait > 0) await Bun.sleep(remainingWait);
          const settledProbeStart = providerRequests.length;
          await probeV1(
            endpoint,
            launchDirectory,
            env.OPENCODE_SERVER_PASSWORD,
            scenario.hotReload.expectedAfterEdit17,
            expectedSettingsMetadata(testCase.host, scenario.hotReload.expectedAfterEdit17),
            record,
            "hot-reload-settled",
          );
          assertV1ProbeDelta(providerRequests, settledProbeStart, scenario.hotReload.expectedAfterEdit17.enabled);
          expectedConfig = scenario.hotReload.expectedAfterEdit17;
          expectedMetadata = expectedSettingsMetadata(testCase.host, expectedConfig);
        }
        record.hotReloadObservation = {
          mutationFiles: scenario.hotReload.mutationFiles.map((mutation) => mutation.path),
          waitMs,
          mutationAt: new Date(mutationAt).toISOString(),
          immediateProbeAt: (record.probes as Array<{ phase: string; finishedAt: string }>).find(
            (probe) => probe.phase === "hot-reload",
          )?.finishedAt,
          generation: testCase.host,
          expectedImmediate: scenario.hotReload.immediateByGeneration[testCase.host],
          expectedSettled: scenario.hotReload.expectedAfterEdit17,
          hostPID: server?.pid ?? null,
          pluginLoadedCountBefore,
          pluginLoadedCountAfter: (hostLog.match(/plugin_loaded/g) ?? []).length,
        };
        assert.equal(server?.pid, record.hostPID, "hot-reload changed the native host PID");
        assert.equal(
          (hostLog.match(/plugin_loaded/g) ?? []).length,
          pluginLoadedCountBefore,
          "hot-reload restarted the plugin host",
        );
      }
      record.expectedNormalizedConfig = expectedConfig;
      record.configBytesUnchangedBeforeProbe =
        (originalConfigBytes === null && !existsSync(join(globalConfigDir, "stm.jsonc"))) ||
        (originalConfigBytes !== null &&
          existsSync(join(globalConfigDir, "stm.jsonc")) &&
          hashFile(join(globalConfigDir, "stm.jsonc")) ===
            createHash("sha256").update(originalConfigBytes).digest("hex"));
      record.configSnapshots = {
        global: {
          before: originalConfigBytes === null ? null : createHash("sha256").update(originalConfigBytes).digest("hex"),
          after: existsSync(join(globalConfigDir, "stm.jsonc")) ? hashFile(join(globalConfigDir, "stm.jsonc")) : null,
        },
        project:
          testCase.scope === "project" || scenario
            ? {
                before:
                  originalProjectSettingsBytes === null
                    ? null
                    : createHash("sha256").update(originalProjectSettingsBytes).digest("hex"),
                after: existsSync(projectSettingsPath) ? hashFile(projectSettingsPath) : null,
              }
            : null,
      };
      const snapshots = record.configSnapshots as {
        global: { before: string | null; after: string | null };
        project: { before: string | null; after: string | null } | null;
      };
      assert.equal(snapshots.global.before, snapshots.global.after);
      if (testCase.scope === "project") assert.equal(snapshots.project?.before, snapshots.project?.after);
      if (scenario && !scenario.hotReload) {
        const snapshot = record.plannedConfigSnapshot as Array<{
          path: string;
          exists: boolean;
          sha256: string | null;
        }>;
        for (const file of snapshot) {
          assert.equal(existsSync(file.path), file.exists, `planned config existence changed: ${file.path}`);
          assert.equal(
            file.exists ? hashFile(file.path) : null,
            file.sha256,
            `planned config bytes changed: ${file.path}`,
          );
        }
      }
    }
    record.cleanup = { serverObserved: true };
    record.verdict = "PASS";
  } catch (error) {
    record.failures.push(safeError(error));
  } finally {
    if (server) {
      const pid = server.pid;
      const ownedChild = Number.isInteger(pid) && (pid ?? 0) > 1;
      if (ownedChild && server.exitCode === null && server.signalCode === null) {
        signalOwnedChild(server, "SIGTERM", { detached: true, group: true });
        await Promise.race([new Promise((resolve) => server!.once("close", resolve)), Bun.sleep(2_000)]);
      }
      if (ownedChild && server.exitCode === null && server.signalCode === null) {
        signalOwnedChild(server, "SIGKILL", { detached: true, group: true });
        await Promise.race([new Promise((resolve) => server!.once("close", resolve)), Bun.sleep(2_000)]);
      }
      let alive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          /* exited */
        }
      }
      const portClosed = record.endpoint
        ? !(await fetch(String(record.endpoint), { signal: AbortSignal.timeout(2_000) })
            .then(() => true)
            .catch(() => false))
        : true;
      record.cleanup = {
        ...((record.cleanup as object) ?? {}),
        pid,
        ownedChild,
        alive,
        portClosed,
        spawnError: serverSpawnError,
      };
      childrenExitedProof = !alive && (!ownedChild || server.exitCode !== null || server.signalCode !== null);
      portsClosedProof = portClosed;
      livePids = alive && Number.isInteger(pid) ? [pid as number] : [];
      if (serverSpawnError) record.failures.push(`native host spawn failed: ${serverSpawnError}`);
      if (alive || !portClosed) record.failures.push("native host cleanup left a live process or listener");
      children.delete(server);
    }
    provider?.stop(true);
    const ownedHostLog = join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log");
    if (existsSync(ownedHostLog)) {
      const bytes = readFileSync(ownedHostLog);
      hostLog += `\n--- owned opencode.log ---\n${redaction(bytes.subarray(0, 2_000_000).toString("utf8"))}`;
      record.ownedHostLog = { path: ownedHostLog, bytes: bytes.length, truncated: bytes.length > 2_000_000 };
    }
    record.hostLog = redaction(hostLog);
    if (testCase.expected === "negative" && testCase.origin !== "package-dir") {
      try {
        assert.ok(expectedWarningTarget, "negative warning target was not prepared");
        const warning = hostLog
          .split(/\r?\n/)
          .map((line, index) => ({ line, index }))
          .find(
            ({ line }) =>
              line.includes("level=WARN") &&
              line.includes('message="configured plugin path must be a directory"') &&
              line.includes("role=server") &&
              hasExactWarningTarget(line, expectedWarningTarget!),
          );
        assert.ok(
          warning,
          `final owned logs did not contain the configured-directory warning for ${expectedWarningTarget}`,
        );
        record.warningObservation = {
          line: warning.index + 1,
          timestamp: warning.line.match(/(?:tsISO|timestamp)="?([^" ]+)/)?.[1] ?? null,
          target: expectedWarningTarget,
          message: "configured plugin path must be a directory",
          level: "WARN",
          role: "server",
        };
      } catch (error) {
        record.failures.push(`negative warning validation failed: ${safeError(error)}`);
        record.verdict = "FAIL";
      }
    }
    await writeDurableEvidence(join(caseEvidenceDir, "evidence.json"), record);
    const cacheBefore = await diskPreflight(cacheRoot);
    const cleanupStarted = Date.now();
    try {
      const runtimeCleanup = await cleanupOwnedRoot({
        root,
        owner: { runID, caseID: testCase.id, kind: "runtime" },
        targets: ["case/tmp", "case/config/opencode/node_modules"],
        childrenExited: childrenExitedProof,
        portsClosed: portsClosedProof,
        livePids,
        timeoutMs: 60_000,
      });
      const cacheCleanup = await cleanupOwnedRoot({
        root: cacheRoot,
        owner: { runID, caseID: testCase.id, kind: "cache" },
        targets: ["xdg-cache", "bun-cache", "npm-cache"],
        childrenExited: childrenExitedProof,
        portsClosed: portsClosedProof,
        livePids,
        timeoutMs: 60_000,
      });
      record.cacheCleanup = {
        runtime: runtimeCleanup,
        cache: cacheCleanup,
        durationMs: Date.now() - cleanupStarted,
        freeBytesBefore: cacheBefore.freeBytes,
        freeBytesAfter: (await diskPreflight(master)).freeBytes,
      };
      if (
        !runtimeCleanup.complete ||
        !cacheCleanup.complete ||
        runtimeCleanup.refused.length > 0 ||
        cacheCleanup.refused.length > 0
      ) {
        record.failures.push("owned cleanup incomplete or refused");
        record.verdict = "FAIL";
      }
    } catch (error) {
      record.failures.push(`owned cleanup failed: ${safeError(error)}`);
      record.verdict = "FAIL";
    }
    if (!existsSync(root)) {
      record.runtimeRootMissing = true;
      record.runtimeRootStatus = "missing; durable evidence retained outside the runtime root";
    } else {
      record.runtimeRootMissing = false;
      record.residue = await readdir(root);
    }
    await writeDurableEvidence(join(caseEvidenceDir, "evidence.json"), record);
  }
  return record;
}

for (const testCase of selectedCases) {
  if (Date.now() >= deadline) {
    results.push({ id: testCase.id, verdict: "FAIL", failures: ["overall deadline exceeded"], skipped: true });
    continue;
  }
  results.push(await executeCase(testCase));
}
aggregate.verdict =
  results.length === selectedCases.length && results.every((row) => row.verdict === "PASS" && row.failures.length === 0)
    ? "PASS"
    : "FAIL";
aggregate.finished = new Date().toISOString();
aggregate.elapsedMs = Date.now() - started;
await writeDurableEvidence(join(master, "evidence.json"), aggregate);
console.log(`VERDICT: ${aggregate.verdict}; retained evidence: ${join(master, "evidence.json")}`);
process.exitCode = aggregate.verdict === "PASS" ? 0 : 1;
