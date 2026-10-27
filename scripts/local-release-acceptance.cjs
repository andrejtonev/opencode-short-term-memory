// Windows candidate gate: node this-file v1|v2 NATIVE_EXE EXACT_TARBALL [message|system] [global|local]
// Uses the native installer and package exports. No plugin wrappers, repository
// dependency junctions, pre-created STM config, or pre-created memory files.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { terminalScreen } = require("./native-terminal-screen.cjs");
const {
  conversationDelta,
  assertGeneratedMemoryInjection,
  assertOrdinaryConversationDelta,
  assertNativeSummarySystem,
} = require("./acceptance-memory-fixture.cjs");
const { cleanupOwnedChildren, applyCleanupVerdict, closeOwnedServer } = require("./windows-owned-process.cjs");

const [generation, nativeArg, archiveArg, mode = "message", scope = "global"] = process.argv.slice(2);
assert.equal(process.platform, "win32", "This runner uses Windows ConPTY containment");
assert.ok(
  ["v1", "v2"].includes(generation) && nativeArg && archiveArg,
  "Supply generation, native executable and exact archive",
);
assert.ok(["message", "system"].includes(mode) && ["global", "local"].includes(scope));
assert.ok(generation === "v1" || scope === "global", "V2 plugin add installs globally; use the documented global path");
const native = path.resolve(nativeArg),
  archive = path.resolve(archiveArg),
  repo = path.resolve(__dirname, "..");
const bytes = fs.readFileSync(archive);
const manifest = JSON.parse(
  cp.execFileSync("tar.exe", ["-xOf", archive, "package/package.json"], { encoding: "utf8", windowsHide: true }),
);
assert.equal(manifest.name, "@atonev/opencode-short-term-memory");
// Native npm cache generations have deeply nested dependency paths. A short
// private root keeps the native Windows installer below legacy path limits.
const sandboxParent = path.join(path.parse(os.tmpdir()).root, "stm-gates");
fs.mkdirSync(sandboxParent, { recursive: true });
const root = fs.mkdtempSync(path.join(sandboxParent, `${generation}-${mode}-`));
const project = path.join(root, "project"),
  configDir = path.join(root, "config", "opencode");
const evidence = {
  root,
  generation,
  mode,
  scope,
  native,
  archive,
  version: manifest.version,
  archiveSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  hostVersion: cp.execFileSync(native, ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
  qualification:
    "Exact candidate archive installed through native CLI from an isolated loopback npm registry; deterministic provider; not public registry or live-provider acceptance",
  verdict: "FAIL",
  checks: [],
  requests: [],
  registryRequests: [],
  commands: [],
};
const env = {};
for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
  if (process.env[name]) env[name] = process.env[name];
for (const [name, sub] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  APPDATA: "appdata",
  LOCALAPPDATA: "localappdata",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  TEMP: "tmp",
  TMP: "tmp",
  BUN_INSTALL_CACHE_DIR: "bun-cache",
  npm_config_cache: "npm-cache",
})) {
  env[name] = path.join(root, sub);
  fs.mkdirSync(env[name], { recursive: true });
}
Object.assign(env, {
  OPENCODE_TEST_HOME: root,
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DB: path.join(root, "host.db"),
  NO_COLOR: "1",
});
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
if (generation === "v2") env.OPENCODE_CONFIG_DIR = configDir;
const password = crypto.randomUUID();
if (generation === "v2") env.OPENCODE_SERVER_PASSWORD = password;
let host,
  terminal,
  installer,
  fixture,
  base,
  hostLog = "",
  terminalLog = "",
  v2client;
let holdNextSummary = false,
  heldResponse,
  releaseHeld;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screen = () => terminalScreen(terminalLog);
const check = (name) => evidence.checks.push({ name, verdict: "PASS" });
async function wait(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    if (host?.exitCode !== null && host?.exitCode !== undefined) throw Error(`Host exited during ${label}`);
    if (terminal?.exitCode !== null && terminal?.exitCode !== undefined) throw Error(`TUI exited during ${label}`);
    await sleep(100);
  }
  throw Error(`Timeout: ${label}\n${screen()}`);
}
async function run(args, timeout = 240000) {
  const row = { args, output: "", exit: null };
  evidence.commands.push(row);
  installer = cp.spawn(native, args, { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [installer.stdout, installer.stderr])
    stream.on("data", (chunk) => {
      row.output += chunk.toString();
      fs.writeFileSync(path.join(root, "installer.log"), row.output);
    });
  const child = installer;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Native installer exceeded ${timeout}ms; see installer.log`)), timeout);
  });
  try {
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), expired]);
  } finally {
    clearTimeout(timer);
  }
  row.exit = child.exitCode;
  assert.equal(row.exit, 0, `Native installer failed: ${row.output.slice(-3000)}`);
}
function send(text) {
  terminal.stdin.write(JSON.stringify({ write: text }) + "\n");
}
async function type(text) {
  send(`\x1b[200~${text}\x1b[201~`);
  await sleep(300);
}
async function enter() {
  send("\r");
  await sleep(250);
}
async function closeDialog() {
  send("\x1b");
  await sleep(500);
}
async function menu(action) {
  const count = evidence.requests.length;
  for (const character of "/stm") {
    send(character);
    await sleep(200);
  }
  await sleep(500);
  fs.writeFileSync(path.join(root, `slash-${action}-screen.txt`), screen());
  await enter();
  await wait(
    () =>
      screen().includes("STM session memory") &&
      screen().includes("Show log file path") &&
      screen().includes("Create optional example config"),
    "typed /stm opens seven-action menu",
    15000,
  );
  assert.equal(evidence.requests.length, count, "Opening /stm invoked a provider");
  await type(action);
  await enter();
}
async function api(route, method = "GET", body) {
  const response = await fetch(base + route, {
    method,
    headers: { "content-type": "application/json", "x-opencode-directory": project },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Fresh native V1 bootstrap may install its own SDK before serving APIs.
    signal: AbortSignal.timeout(180000),
  });
  assert.ok(response.ok, `${route}: ${response.status} ${response.ok ? "" : await response.text()}`);
  return response.json();
}
async function history(sessionID) {
  if (generation === "v1") return api(`/session/${sessionID}/message`);
  return v2client.session.context({ sessionID }, { signal: AbortSignal.timeout(15000) });
}
async function stopHost() {
  const cleanup = await cleanupOwnedChildren([terminal, host], { endpoints: base ? [base] : [] });
  assert.ok(cleanup.complete, "Restart cleanup incomplete");
  terminal = undefined;
  host = undefined;
  base = undefined;
}
function readMemory(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
async function startHost() {
  hostLog = "";
  terminalLog = "";
  host = cp.spawn(native, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: project,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [host.stdout, host.stderr])
    stream.on("data", (chunk) => {
      hostLog += chunk.toString();
      fs.writeFileSync(path.join(root, "host.log"), hostLog);
    });
  await wait(
    () =>
      Boolean(
        (base = hostLog.match(/(?:server listening on|opencode server listening on) (http:\/\/127\.0\.0\.1:\d+)/)?.[1]),
      ),
    "host startup",
    90000,
  );
  if (generation === "v2") {
    await wait(() => findInstalled().length > 0, "native installed package");
    const pkg = findInstalled()[0];
    // The client exposes its promise entry under an import-only export. This
    // Node harness must resolve the installed dependency rather than CJS require.
    let directory = pkg,
      clientEntry;
    while (directory.startsWith(root)) {
      const modules = path.join(directory, "node_modules");
      const candidates = [
        path.join(modules, "@opencode", "client", "dist", "promise", "index.js"),
        path.join(modules, "@opencode", "plugin", "node_modules", "@opencode", "client", "dist", "promise", "index.js"),
      ];
      clientEntry = candidates.find((candidate) => fs.existsSync(candidate));
      if (clientEntry) break;
      directory = path.dirname(directory);
    }
    assert.ok(clientEntry, "Installed package has no native client dependency");
    const { OpenCode } = await import(pathToFileURL(clientEntry).href);
    v2client = OpenCode.make({
      baseUrl: base,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    });
  } else {
    await api("/config");
  }
}
function findInstalled() {
  const found = [];
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (item.name === "opencode-short-term-memory" && path.basename(path.dirname(file)) === "@atonev")
          found.push(file);
        else scan(file);
      }
    }
  }
  scan(root);
  return found;
}
async function startTerminal(sessionID) {
  terminalLog = "";
  const args =
    generation === "v1"
      ? ["attach", base, "--session", sessionID, "--dir", project]
      : ["--server", base, "--session", sessionID, project];
  terminal = cp.spawn(
    process.execPath,
    [path.join(__dirname, "windows-pty-bridge.cjs"), path.join(repo, "node_modules/node-pty"), native, ...args],
    { cwd: project, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffered = "";
  terminal.stdout.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.data) terminalLog += item.data;
      } catch {
        terminalLog += line;
      }
    }
    fs.writeFileSync(path.join(root, "terminal.ansi"), terminalLog);
  });
  terminal.stderr.on("data", (chunk) => {
    terminalLog += chunk.toString();
  });
  await wait(() => screen().includes("Offline test"), "TUI model and prompt ready", 60000);
  await sleep(1500);
  // A genuinely fresh native profile can open the model chooser on startup.
  // A model name inside that dialog is not proof that the prompt is focused.
  if (screen().includes("Select model")) {
    await type("Offline test");
    await enter();
    await wait(() => !screen().includes("Select model"), "fresh-profile model selection");
    await sleep(500);
  }
  fs.writeFileSync(path.join(root, "ready-screen.txt"), screen());
}
function inventoryInstalled() {
  const packages = findInstalled();
  assert.ok(packages.length, "No native STM installation found");
  const expectedRoot = path.join(root, "reference");
  fs.mkdirSync(expectedRoot);
  cp.execFileSync("tar.exe", ["-xf", archive, "-C", expectedRoot], { windowsHide: true });
  const expected = path.join(expectedRoot, "package");
  function verify(relative, pkg) {
    for (const entry of fs.readdirSync(path.join(expected, relative), { withFileTypes: true })) {
      const suffix = path.join(relative, entry.name);
      if (entry.isDirectory()) verify(suffix, pkg);
      else
        assert.deepEqual(
          fs.readFileSync(path.join(pkg, suffix)),
          fs.readFileSync(path.join(expected, suffix)),
          `Installed archive mismatch: ${suffix}`,
        );
    }
  }
  for (const pkg of packages) {
    const physical = fs.realpathSync(pkg);
    assert.ok(physical.startsWith(root + path.sep), "Installed package escapes isolated root");
    assert.equal(JSON.parse(fs.readFileSync(path.join(pkg, "package.json"))).version, manifest.version);
    verify("", pkg);
  }
  evidence.installedPackages = packages;
  check("native-installed package and every shipped file match the exact archive");
}
async function main() {
  fixture = http.createServer(async (request, response) => {
    try {
      const route = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      if (route.startsWith("/registry/")) {
        const name = route.slice("/registry/".length);
        evidence.registryRequests.push(name);
        if (name === "candidate.tgz") {
          response.writeHead(200, { "content-type": "application/octet-stream" });
          response.end(bytes);
          return;
        }
        if (name === manifest.name || name.startsWith(manifest.name + "/")) {
          const record = {
            ...manifest,
            dist: {
              tarball: `http://127.0.0.1:${fixture.address().port}/registry/candidate.tgz`,
              shasum: crypto.createHash("sha1").update(bytes).digest("hex"),
              integrity: "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64"),
            },
          };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              name === manifest.name
                ? {
                    name: manifest.name,
                    "dist-tags": { latest: manifest.version, rc: manifest.version },
                    versions: { [manifest.version]: record },
                  }
                : record,
            ),
          );
          return;
        }
        const upstream = await fetch("https://registry.npmjs.org/" + request.url.slice("/registry/".length), {
          signal: AbortSignal.timeout(30000),
        });
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json",
        });
        response.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      let input = "";
      for await (const chunk of request) input += chunk;
      const body = JSON.parse(input),
        raw = JSON.stringify(body.messages);
      const summary = raw.includes("<existing_memory>");
      const row = { summary, body };
      evidence.requests.push(row);
      if (summary && holdNextSummary) {
        holdNextSummary = false;
        heldResponse = response;
        await new Promise((resolve) => {
          releaseHeld = resolve;
        });
      }
      const delta = summary ? conversationDelta(body) : "";
      const fact = delta.includes("ACCEPTANCE_FACT_NEW") ? "ACCEPTANCE_FACT_NEW" : "ACCEPTANCE_FACT_OLD";
      const text = summary
        ? `## Session Memory\n\n### User Instructions\n- ${fact}\n${Array.from({ length: 120 }, (_, i) => "ACCEPTANCE_MEMORY_LINE_" + String(i).padStart(3, "0")).join("\n")}\n### Long Horizon Context\n- None captured yet.\n### Decisions\n- None captured yet.\n### Conclusions\n- None captured yet.\n### Active References\n- None captured yet.\n`
        : "Acknowledged the user's instruction.";
      const id = `chatcmpl-${evidence.requests.length}`;
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [
        { delta: { role: "assistant", content: text }, finish_reason: null },
        { delta: {}, finish_reason: "stop" },
      ])
        response.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${fixture.address().port}/registry/`;
  env.npm_config_registry = registry;
  env.NPM_CONFIG_REGISTRY = registry;
  fs.writeFileSync(path.join(env.HOME, ".npmrc"), `registry=${registry}\n`);
  const target = `${manifest.name}@${manifest.version}`;
  const providerURL = `http://127.0.0.1:${fixture.address().port}/v1`;
  const config =
    generation === "v1"
      ? {
          model: "offline/test",
          enabled_providers: ["offline"],
          provider: {
            offline: {
              npm: "@ai-sdk/openai-compatible",
              name: "Offline",
              options: { baseURL: providerURL, apiKey: "fixture" },
              models: { test: { name: "Offline test", limit: { context: 100000, output: 4000 } } },
            },
          },
        }
      : {
          model: "offline/test",
          update: "disable",
          share: "disabled",
          providers: {
            offline: {
              env: [],
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: { baseURL: providerURL, apiKey: "fixture" },
              models: { test: { name: "Offline test" } },
            },
          },
        };
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify(config));
  await run(
    generation === "v1"
      ? ["plugin", target, ...(scope === "global" ? ["--global"] : []), "--force"]
      : ["plugin", "add", target],
  );
  check("native CLI installer succeeded from initially empty cache");
  fs.writeFileSync(
    path.join(configDir, generation === "v1" ? "tui.json" : "cli.json"),
    JSON.stringify(generation === "v1" ? { plugin: [target] } : { plugins: [target], animations: false }),
  );
  const stmPath = path.join(scope === "global" ? configDir : path.join(project, ".opencode"), "stm.json");
  evidence.configPath = stmPath;
  await startHost();
  const session =
    generation === "v1"
      ? await api("/session", "POST", { title: "RC acceptance" })
      : await v2client.session.create(
          {
            title: "RC acceptance",
            agent: "build",
            model: { providerID: "offline", id: "test" },
            location: { directory: project },
          },
          { signal: AbortSignal.timeout(20000) },
        );
  evidence.sessionID = session.id;
  await startTerminal(session.id);
  await wait(() => fs.existsSync(stmPath), "first native activation creates scoped stm.json");
  evidence.initialConfig = JSON.parse(fs.readFileSync(stmPath, "utf8"));
  check("native first activation creates stm.json without setup");
  inventoryInstalled();
  await stopHost();
  fs.writeFileSync(
    stmPath,
    JSON.stringify({
      enabled: true,
      debug: true,
      memoryModel: "offline/test",
      sideSessionRetries: 0,
      debounceMs: 100,
      remindEveryN: 1,
      enableLegacyPeriodicSystemTransform: mode === "system",
    }),
  );
  await startHost();
  await startTerminal(session.id);
  const memoryPath = path.join(project, ".opencode", "memory", `session_${session.id}.md`);
  evidence.memoryPath = memoryPath;
  // V1 initializes an empty template when the native session is created; V2
  // leaves storage absent. Neither is a generated memory or harness seed.
  const initialMemory = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath) : undefined;
  assert.ok(!initialMemory?.includes("ACCEPTANCE_FACT_OLD"), "Test started with generated memory");
  evidence.initialMemory = initialMemory === undefined ? "missing" : "native empty template";
  await menu("show");
  await wait(
    () => screen().includes(initialMemory === undefined ? "No memory file exists" : "None captured yet"),
    "initial Show result through native delivery",
  );
  assert.deepEqual(fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath) : undefined, initialMemory);
  assert.equal((await history(session.id)).length, 0);
  assert.equal(evidence.requests.length, 0);
  check("typed /stm Show reaches native result without changing storage, history or inference");
  await closeDialog();
  await type("Remember ACCEPTANCE_FACT_OLD for this conversation.");
  await enter();
  await wait(() => readMemory(memoryPath).includes("ACCEPTANCE_FACT_OLD"), "automatic idle memory creation", 45000);
  check("ordinary terminal chat automatically creates memory without manual update");
  await type("Continue using the remembered instruction.");
  await enter();
  await wait(() => evidence.requests.filter((row) => !row.summary).length === 2, "second ordinary provider request");
  assertGeneratedMemoryInjection(evidence.requests.filter((row) => !row.summary)[1].body, mode);
  await wait(() => evidence.requests.filter((row) => row.summary).length >= 2, "second automatic summary");
  for (const row of evidence.requests.filter((row) => row.summary))
    assert.ok(!conversationDelta(row.body).includes("[MEMORY_SYSTEM]"), "Injected memory leaked into summarizer delta");
  check("memory reaches next ordinary request in selected mode and is excluded from summary delta");
  await sleep(1000);
  // V1 can checkpoint a user-only delta and then its settled assistant reply.
  // Validate provenance rather than assuming exactly one summary per turn.
  for (const row of evidence.requests.filter((row) => row.summary)) assertOrdinaryConversationDelta(row.body);
  await menu("show");
  await wait(() => screen().includes("ACCEPTANCE_MEMORY_LINE_000"), "generated memory Show");
  send("\x1b[4~");
  await wait(() => screen().includes("ACCEPTANCE_MEMORY_LINE_119"), "reader End reaches final generated line");
  send("\x1b[1~");
  await wait(() => screen().includes("ACCEPTANCE_MEMORY_LINE_000"), "reader Home returns to first line");
  check("generated long memory is readable with native keyboard navigation");
  await closeDialog();
  const readCount = evidence.requests.length,
    readHistory = (await history(session.id)).length;
  await menu("log");
  await wait(() => screen().includes("session-memory.log"), "Logs returns file path");
  assert.ok(!screen().includes("memory_update_committed"), "Logs displayed file contents");
  await closeDialog();
  await menu("settings");
  await wait(
    () =>
      screen().includes("STM settings") &&
      (generation === "v1"
        ? screen().includes("memoryModel") && screen().includes("offline/test")
        : screen().includes("configPaths") && screen().includes("stm.json")),
    "Settings result",
  );
  await closeDialog();
  await menu("status");
  await wait(() => screen().includes("STM status") && screen().includes(session.id), "Status result");
  await closeDialog();
  assert.equal(evidence.requests.length, readCount);
  assert.equal((await history(session.id)).length, readHistory);
  check("Logs, Settings and Status use native delivery without inference or conversation writes");
  holdNextSummary = true;
  await type("Remember ACCEPTANCE_PENDING while the background memory update is held.");
  await enter();
  await wait(() => Boolean(releaseHeld), "held background summary request");
  await menu("reset");
  await wait(() => screen().includes("Reset this session"), "Reset confirmation");
  assert.ok(readMemory(memoryPath).includes("ACCEPTANCE_FACT_OLD"), "Reset ran before confirmation");
  await enter();
  await wait(
    () =>
      !readMemory(memoryPath).includes("ACCEPTANCE_FACT_OLD") && readMemory(memoryPath).includes("None captured yet"),
    "Reset completes while provider is pending",
  );
  await closeDialog();
  releaseHeld();
  releaseHeld = undefined;
  heldResponse = undefined;
  await sleep(2000);
  assert.ok(!readMemory(memoryPath).includes("ACCEPTANCE_FACT_OLD"), "Late summary resurrected pre-reset memory");
  check("confirmed Reset cancels pending generation and fences its late result");
  await type("Remember ACCEPTANCE_FACT_NEW after the reset.");
  await enter();
  await wait(() => readMemory(memoryPath).includes("ACCEPTANCE_FACT_NEW"), "post-reset automatic memory", 45000);
  const last = evidence.requests.filter((row) => row.summary).at(-1),
    delta = conversationDelta(last.body);
  assert.ok(
    delta?.includes("ACCEPTANCE_FACT_NEW") &&
      !delta.includes("ACCEPTANCE_FACT_OLD") &&
      !delta.includes("ACCEPTANCE_PENDING"),
    "Post-reset summary reused pre-reset history",
  );
  check("future automatic generation resumes from reset boundary");
  for (const row of evidence.requests.filter((row) => row.summary)) assertOrdinaryConversationDelta(row.body);
  if (generation === "v2") {
    const ordinary = evidence.requests.find((row) => !row.summary);
    for (const row of evidence.requests.filter((row) => row.summary))
      assertNativeSummarySystem(row.body, ordinary.body);
    check("clean summaries preserve native agent identity without implicit project system instructions");
  }
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), evidence.archiveSha256);
  evidence.verdict = "PASS";
}
(async () => {
  try {
    await main();
  } catch (error) {
    evidence.error = error.stack || String(error);
  } finally {
    releaseHeld?.();
    heldResponse?.destroy();
    const cleanup = await cleanupOwnedChildren([terminal, host, installer], { endpoints: base ? [base] : [] });
    cleanup.fixture = await closeOwnedServer(fixture);
    cleanup.complete &&= cleanup.fixture.closed;
    applyCleanupVerdict(evidence, cleanup);
    evidence.finalScreen = screen();
    fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(
      JSON.stringify(
        {
          root,
          verdict: evidence.verdict,
          checks: evidence.checks,
          error: evidence.error,
          cleanupVerdict: evidence.cleanupVerdict,
        },
        null,
        2,
      ),
    );
    process.exitCode = evidence.verdict === "PASS" ? 0 : 1;
  }
})();
