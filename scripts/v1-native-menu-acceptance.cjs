// Windows native terminal acceptance: node scripts/v1-native-menu-acceptance.cjs NATIVE_EXE DEVELOPMENT_TGZ
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { stripVTControlCharacters } = require("node:util");
if (process.platform !== "win32") throw new Error("This harness uses Windows process containment and PTY support.");
const repo = process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "stm-native-tui-"));
const project = path.join(root, "project");
if (process.argv.length !== 4) throw new Error("Supply native executable and development archive");
const archive = path.resolve(process.argv[3]);
const native = path.resolve(process.argv[2]);
const evidence = {
  root,
  version: cp.execFileSync(native, ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
  archive,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
  qualification: "Extracted development archive with repository dependency junction; not clean package installation",
  providerRequests: [],
  checks: [],
};
let allowModel = false;
let host,
  terminal,
  mock,
  terminalLog = "",
  hostLog = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(predicate, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (host && host.exitCode !== null) throw new Error("Host exited: " + hostLog.slice(-3000));
    await sleep(100);
  }
  throw new Error("Timeout: " + label);
}
function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  cp.spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}
async function main() {
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(root, "unpacked"));
  cp.execFileSync(process.platform === "win32" ? "tar.exe" : "tar", [
    "-xf",
    archive,
    "-C",
    path.join(root, "unpacked"),
  ]);
  const packageRoot = path.join(root, "unpacked/package");
  fs.symlinkSync(
    path.join(repo, "node_modules"),
    path.join(packageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  evidence.packageRoot = packageRoot;
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/API_KEY|AUTH_TOKEN|NPM_TOKEN|AZURE|OPENCODE|OPENAI|ANTHROPIC|DEEPSEEK/i.test(key)) delete env[key];
  for (const [name, sub] of Object.entries({
    USERPROFILE: "profile",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache",
    XDG_STATE_HOME: "state",
    BUN_INSTALL_CACHE_DIR: "bun-cache",
  })) {
    env[name] = path.join(root, sub);
    fs.mkdirSync(env[name], { recursive: true });
  }
  env.HOME = path.join(root, "profile");
  env.OPENCODE_TEST_HOME = root;
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  env.OPENCODE_DISABLE_MODELS_FETCH = "true";
  env.NO_COLOR = "1";
  mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const clean = JSON.stringify(body.messages).includes("You are a clean short-term memory summarizer.");
    const inputText = JSON.stringify(body.messages);
    const newAfterReset = inputText.includes("NEW_AFTER_RESET_SENTINEL");
    evidence.providerRequests.push({
      method: req.method,
      url: req.url,
      clean,
      oldHistoryPresent: inputText.includes("NATIVE_MENU_UPDATE_SENTINEL"),
      newHistoryPresent: newAfterReset,
    });
    if (!allowModel) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unexpected model request during native reads" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const summary = `## Session Memory\n\n### User Instructions\n- ${newAfterReset ? "NEW_AFTER_RESET_SENTINEL" : "NATIVE_MENU_UPDATE_SENTINEL"}\n`;
    for (const choice of [
      { delta: { role: "assistant", content: summary }, finish_reason: null },
      { delta: {}, finish_reason: "stop" },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "native-menu", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const configDir = path.join(env.XDG_CONFIG_HOME, "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  const config = {
    plugin: [pathToFileURL(path.join(packageRoot, "dist/index.js")).href],
    model: "offline/test",
    enabled_providers: ["offline"],
    provider: {
      offline: {
        npm: "@ai-sdk/openai-compatible",
        name: "Offline",
        options: { baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: "not-a-credential" },
        models: { test: { name: "Offline test", limit: { context: 100000, output: 1000 } } },
      },
    },
  };
  const sdkSeed = process.env.STM_NATIVE_SDK_SEED;
  if (sdkSeed) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(sdkSeed, "node_modules/@opencode-ai/plugin/package.json"), "utf8"),
    );
    if (manifest.version !== evidence.version) throw new Error("Host SDK seed version mismatch");
    for (const item of ["package.json", "package-lock.json", "node_modules"]) {
      if (fs.existsSync(path.join(sdkSeed, item)))
        fs.cpSync(path.join(sdkSeed, item), path.join(configDir, item), { recursive: true, dereference: true });
    }
    evidence.hostSdkSeed = sdkSeed;
  }
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify(config));
  const keysFile = path.join(root, "keys.jsonl");
  const observer = path.join(root, "keys.mjs");
  fs.writeFileSync(
    observer,
    `import fs from 'node:fs'; export default {id:'stm-native-key-observer', tui:async(api)=>{const cb=(key)=>fs.appendFileSync(${JSON.stringify(keysFile)},JSON.stringify({name:key.name,sequence:key.sequence,ctrl:key.ctrl})+'\\n'); api.renderer.keyInput.on('keypress',cb); api.lifecycle.onDispose(()=>api.renderer.keyInput.off('keypress',cb));}};`,
  );
  fs.writeFileSync(
    path.join(configDir, "tui.json"),
    JSON.stringify({
      plugin: [pathToFileURL(observer).href, pathToFileURL(path.join(packageRoot, "dist/tui.js")).href],
    }),
  );
  fs.mkdirSync(path.join(project, ".opencode/memory"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".opencode/stm.json"),
    JSON.stringify({
      enabled: true,
      memoryModel: "offline/test",
      sideSessionRetries: 0,
      debounceMs: 60000,
      memoryDir: path.join(project, ".opencode/memory"),
    }),
  );
  const sentinel = "STM_NATIVE_FIRST_LINE_7392";
  const last = "STM_NATIVE_LAST_LINE_7392";
  fs.writeFileSync(
    path.join(project, ".opencode/memory/session-memory.log"),
    [sentinel, ...Array.from({ length: 100 }, (_, i) => "LOG_LINE_" + i), last].join("\n"),
  );
  const portProbe = http.createServer();
  await new Promise((r) => portProbe.listen(0, "127.0.0.1", r));
  const port = portProbe.address().port;
  await new Promise((r) => portProbe.close(r));
  const url = `http://127.0.0.1:${port}`;
  host = cp.spawn(
    native,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "DEBUG"],
    { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const s of [host.stdout, host.stderr])
    s.on("data", (x) => {
      hostLog += x.toString();
    });
  async function api(route, method = "GET", body, timeout = 90000) {
    const r = await fetch(url + route, {
      method,
      headers: { "content-type": "application/json", "x-opencode-directory": project },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) throw new Error(route + " " + r.status + " " + (await r.text()));
    return r.json();
  }
  await wait(
    async () => {
      try {
        return (await api("/global/health", "GET", undefined, 1000)).healthy;
      } catch (error) {
        evidence.healthError = String(error);
        return false;
      }
    },
    "server ready",
    45000,
  );
  const session = await api("/session", "POST", { title: "Native read smoke" });
  evidence.sessionID = session.id;
  terminal = cp.spawn(
    process.execPath,
    [
      path.join(repo, "scripts/windows-pty-bridge.cjs"),
      path.join(repo, "node_modules/node-pty"),
      native,
      "attach",
      url,
      "--session",
      session.id,
      "--dir",
      project,
      "--log-level",
      "DEBUG",
    ],
    { cwd: project, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "";
  terminal.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.data) terminalLog += item.data;
        if (item.exit) evidence.tuiExit = item.exit;
      } catch {
        terminalLog += line;
      }
    }
  });
  terminal.stderr.on("data", (x) => (terminalLog += x));
  const write = (text) => terminal.stdin.write(JSON.stringify({ write: text }) + "\n");
  await wait(
    () =>
      stripVTControlCharacters(terminalLog).includes("Offline") ||
      stripVTControlCharacters(terminalLog).includes("Build"),
    "TUI ready",
    45000,
  );
  await sleep(1500);
  async function select(action) {
    write("/stm");
    await sleep(600);
    write("\r");
    await sleep(400);
    write(action);
    await sleep(350);
    write("\r");
  }
  const expectedLogPath = path.join(project, ".opencode/memory/session-memory.log");
  await select("log");
  await wait(
    () => stripVTControlCharacters(terminalLog).replace(/\s+/g, "").includes(expectedLogPath.replace(/\s+/g, "")),
    "native log path dialog",
    15000,
  );
  const logScreen = stripVTControlCharacters(terminalLog);
  if (logScreen.includes(sentinel) || logScreen.includes(last)) throw new Error("Log contents were displayed");
  evidence.checks.push({
    name: "native log path without log contents",
    verdict: "PASS",
    path: path.join(project, ".opencode/memory/session-memory.log"),
  });
  write("\x1b");
  await sleep(350);
  await select("status");
  await wait(() => stripVTControlCharacters(terminalLog).includes("enabled: true"), "status reader", 10000);
  write("\x1b[4~");
  await wait(() => stripVTControlCharacters(terminalLog).includes("updateCount: 0"), "authoritative status", 10000);
  evidence.checks.push({ name: "native live status", verdict: "PASS" });
  write("\x1b");
  await sleep(350);
  const memoryPath = path.join(project, ".opencode/memory", `session_${session.id}.md`);
  fs.writeFileSync(memoryPath, "PRESERVE_UNTIL_CONFIRMED");
  await select("reset");
  await wait(() => stripVTControlCharacters(terminalLog).includes("Reset this session"), "reset confirmation", 10000);
  if (fs.readFileSync(memoryPath, "utf8") !== "PRESERVE_UNTIL_CONFIRMED")
    throw new Error("Reset ran before confirmation");
  write("\r");
  await wait(() => fs.readFileSync(memoryPath, "utf8").includes("None captured yet"), "confirmed reset", 10000);
  await wait(() => stripVTControlCharacters(terminalLog).includes("Reset memory for session"), "reset result", 10000);
  evidence.checks.push({ name: "native confirmed reset", verdict: "PASS" });
  write("\x1b");
  await sleep(350);
  await select("example");
  await wait(
    () => stripVTControlCharacters(terminalLog).includes("Create an optional project-local"),
    "setup confirmation",
    10000,
  );
  write("\r");
  await wait(
    () => stripVTControlCharacters(terminalLog).includes("No example config created"),
    "confirmed setup result",
    10000,
  );
  evidence.checks.push({ name: "native optional setup preserves config", verdict: "PASS" });
  const history = await api(`/session/${session.id}/message`);
  evidence.history = history;
  evidence.checks.push({
    name: "zero session messages",
    verdict: history.length === 0 ? "PASS" : "FAIL",
    count: history.length,
  });
  evidence.checks.push({
    name: "zero model requests",
    verdict: evidence.providerRequests.length === 0 ? "PASS" : "FAIL",
    count: evidence.providerRequests.length,
  });
  if (history.length || evidence.providerRequests.length)
    throw new Error("Native read caused conversation or inference");
  write("\x1b");
  await sleep(150);
  write("\x1b");
  await sleep(250);
  await api(`/session/${session.id}/message`, "POST", {
    noReply: true,
    model: { providerID: "offline", modelID: "test" },
    parts: [{ type: "text", text: "Remember NATIVE_MENU_UPDATE_SENTINEL." }],
  });
  allowModel = true;
  const updateStart = terminalLog.length;
  await select("update");
  await wait(
    () =>
      fs.readFileSync(memoryPath, "utf8").includes("NATIVE_MENU_UPDATE_SENTINEL") &&
      stripVTControlCharacters(terminalLog.slice(updateStart)).includes("## Session Memory"),
    "native update result",
    20000,
  );
  const updatedHistory = await api(`/session/${session.id}/message`);
  if (evidence.providerRequests.length !== 1 || !evidence.providerRequests[0].clean || updatedHistory.length !== 1)
    throw new Error("Native Update must invoke only the clean memory model without a main-model echo");
  evidence.checks.push({
    name: "native Update uses only memory model",
    verdict: "PASS",
    providerRequests: 1,
    primaryMessages: updatedHistory.length,
  });
  // Reset an existing conversation, then prove its old messages cannot rebuild memory.
  write("\x1b");
  await sleep(350);
  const resetStart = terminalLog.length;
  await select("reset");
  await wait(
    () => stripVTControlCharacters(terminalLog.slice(resetStart)).includes("Reset this session"),
    "populated reset confirmation",
    10000,
  );
  write("\r");
  await wait(() => fs.readFileSync(memoryPath, "utf8").includes("None captured yet"), "populated reset", 10000);
  await wait(
    () => stripVTControlCharacters(terminalLog.slice(resetStart)).includes("saved reset boundary"),
    "populated reset result",
    10000,
  );
  const boundary = JSON.parse(
    fs.readFileSync(path.join(project, ".opencode/memory/v1-reset-boundaries", `${session.id}.json`), "utf8"),
  );
  if (!boundary.anchorID) throw new Error("Populated reset did not persist an anchor");
  write("\x1b");
  await sleep(350);
  const unchangedStart = terminalLog.length;
  await select("update");
  await wait(
    () => stripVTControlCharacters(terminalLog.slice(unchangedStart)).includes("Memory update skipped"),
    "unchanged post-reset update",
    10000,
  );
  if (evidence.providerRequests.length !== 1 || !fs.readFileSync(memoryPath, "utf8").includes("None captured yet"))
    throw new Error("Unchanged pre-reset history was summarized again");
  write("\x1b");
  await sleep(350);
  await api(`/session/${session.id}/message`, "POST", {
    noReply: true,
    model: { providerID: "offline", modelID: "test" },
    parts: [{ type: "text", text: "Remember NEW_AFTER_RESET_SENTINEL." }],
  });
  const newUpdateStart = terminalLog.length;
  await select("update");
  await wait(
    () =>
      fs.readFileSync(memoryPath, "utf8").includes("NEW_AFTER_RESET_SENTINEL") &&
      stripVTControlCharacters(terminalLog.slice(newUpdateStart)).includes("## Session Memory"),
    "new-only post-reset update",
    20000,
  );
  const finalRequest = evidence.providerRequests.at(-1);
  const finalHistory = await api(`/session/${session.id}/message`);
  if (
    evidence.providerRequests.length !== 2 ||
    !finalRequest.clean ||
    !finalRequest.newHistoryPresent ||
    finalRequest.oldHistoryPresent ||
    finalHistory.length !== 2
  )
    throw new Error("Post-reset generation must contain only new conversation with no main-model echo");
  evidence.checks.push({
    name: "native populated reset excludes old conversation",
    verdict: "PASS",
    boundary,
    providerRequests: 2,
    primaryMessages: finalHistory.length,
  });
  evidence.verdict = "PASS";
}
main()
  .catch((error) => {
    evidence.verdict = "FAIL";
    evidence.error = String(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    killTree(terminal);
    killTree(host);
    if (mock) await new Promise((r) => mock.close(r));
    evidence.keys = fs.existsSync(path.join(root, "keys.jsonl"))
      ? fs.readFileSync(path.join(root, "keys.jsonl"), "utf8")
      : "";
    fs.writeFileSync(path.join(root, "terminal.ansi"), terminalLog);
    fs.writeFileSync(path.join(root, "host.log"), hostLog);
    fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));

    console.log(JSON.stringify({ verdict: evidence.verdict, error: evidence.error, root, checks: evidence.checks }));
  });
