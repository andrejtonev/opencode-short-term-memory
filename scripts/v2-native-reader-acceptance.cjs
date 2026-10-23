// Windows offline acceptance: node this-file HOSTS_DIRECTORY DEVELOPMENT_TGZ
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { stripVTControlCharacters } = require("node:util");
if (process.platform !== "win32") throw new Error("This harness requires Windows ConPTY.");
if (process.argv.length !== 4) throw new Error("Supply host directory and development archive.");
const repo = process.cwd();
const [hostRoot, archive] = process.argv.slice(2).map((value) => path.resolve(value));
const native = path.join(hostRoot, "node_modules/@opencode/cli-windows-x64/bin/opencode.exe");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "stm-v2-reader-"));
const project = path.join(root, "project");
const env = {};
for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
  if (process.env[name]) env[name] = process.env[name];
for (const name of [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG_DIR",
  "TEMP",
  "TMP",
  "BUN_INSTALL_CACHE_DIR",
]) {
  env[name] = path.join(root, name.toLowerCase());
  fs.mkdirSync(env[name], { recursive: true });
}
env.OPENCODE_TEST_HOME = root;
env.OPENCODE_DB = path.join(root, "host.db");
env.OPENCODE_DISABLE_AUTOUPDATE = "1";
env.OPENCODE_DISABLE_MODELS_FETCH = "1";
env.OPENCODE_DISABLE_EXTERNAL_PLUGINS = "false";
const token = crypto.randomUUID();
env.OPENCODE_SERVER_PASSWORD = token;
const evidence = {
  root,
  version: cp.execFileSync(native, ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
  archive,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
  qualification: "Extracted development archive with repository dependency junction; not registry installation",
  checks: [],
  providerRequests: 0,
};
let host,
  terminal,
  mock,
  hostLog = "",
  terminalLog = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(200);
  }
  throw Error("Timeout: " + label);
}
function write(text) {
  terminal.stdin.write(JSON.stringify({ write: text }) + "\n");
}
function visible() {
  return stripVTControlCharacters(terminalLog);
}
async function main() {
  fs.mkdirSync(project);
  const unpack = path.join(root, "unpack");
  fs.mkdirSync(unpack);
  cp.execFileSync("tar.exe", ["-xf", archive, "-C", unpack], { windowsHide: true });
  const pkg = path.join(unpack, "package");
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(pkg, "node_modules"), "junction");
  const wrapper = path.join(root, "plugin");
  fs.mkdirSync(wrapper);
  for (const [name, file] of [
    ["server", "index"],
    ["tui", "tui"],
    ["rpc", "rpc"],
  ])
    fs.writeFileSync(
      path.join(wrapper, name + ".js"),
      `export {default} from ${JSON.stringify(pathToFileURL(path.join(pkg, "dist", file + ".js")).href)};\n`,
    );
  mock = http.createServer((req, res) => {
    evidence.providerRequests++;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Unexpected inference" } }));
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const config = {
    plugins: [wrapper],
    model: "offline/test",
    update: "disable",
    share: "disabled",
    providers: {
      offline: {
        env: [],
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: "not-a-credential" },
        models: { test: { name: "Offline test" } },
      },
    },
  };
  fs.writeFileSync(path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify(config));
  const cli = { plugins: [{ package: wrapper }], animations: false, attention: { notifications: false, sound: false } };
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
  for (const base of [env.OPENCODE_CONFIG_DIR, path.join(env.XDG_CONFIG_HOME, "opencode")])
    fs.writeFileSync(path.join(base, "cli.json"), JSON.stringify(cli));
  const memory = path.join(project, ".opencode", "memory");
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(
    path.join(env.OPENCODE_CONFIG_DIR, "stm.json"),
    JSON.stringify({ enabled: false, memoryDir: memory }),
  );
  host = cp.spawn(native, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: project,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [host.stdout, host.stderr])
    stream.on("data", (x) => {
      hostLog += x;
      fs.writeFileSync(path.join(root, "host.log"), hostLog);
    });
  let url;
  await wait(
    () => {
      url = hostLog.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      return url;
    },
    "host listener",
    45000,
  );
  const { OpenCode } = await import(
    pathToFileURL(path.join(hostRoot, "node_modules/@opencode/client/dist/promise/index.js")).href
  );
  const client = OpenCode.make({
    baseUrl: url,
    headers: { Authorization: "Basic " + Buffer.from("opencode:" + token).toString("base64") },
  });
  const session = await client.session.create(
    {
      title: "STM reader smoke",
      agent: "build",
      model: { providerID: "offline", id: "test" },
      location: { directory: project },
    },
    { signal: AbortSignal.timeout(45000) },
  );
  evidence.sessionID = session.id;
  const memoryPath = path.join(memory, `session_${session.id}.md`);
  fs.writeFileSync(
    memoryPath,
    [
      "FIRST_MEMORY_SENTINEL",
      ...Array.from({ length: 180 }, (_, i) => "MEMORY_LINE_" + i),
      "LAST_MEMORY_SENTINEL",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(memory, "session-memory.log"), "PRIVATE_LOG_SENTINEL");
  terminal = cp.spawn(
    process.execPath,
    [
      path.join(repo, "scripts/windows-pty-bridge.cjs"),
      path.join(repo, "node_modules/node-pty"),
      native,
      "--server",
      url,
      "--session",
      session.id,
      "--log-level",
      "debug",
    ],
    { cwd: project, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "";
  terminal.stdout.on("data", (x) => {
    buffer += x;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (e.data) terminalLog += e.data;
      } catch {
        terminalLog += l;
      }
    }
    fs.writeFileSync(path.join(root, "terminal.ansi"), terminalLog);
  });
  terminal.stderr.on("data", (x) => {
    terminalLog += x;
    fs.writeFileSync(path.join(root, "terminal.ansi"), terminalLog);
  });
  await wait(
    () => {
      if (terminal.exitCode !== null) throw Error(visible());
      return /Offline|Build|build/.test(visible());
    },
    "TUI ready",
    45000,
  );
  await sleep(700);
  async function command(action) {
    write("/stm " + action);
    await sleep(700);
    write("\r");
  }
  await command("show");
  await wait(() => visible().includes("FIRST_MEMORY_SENTINEL"), "memory first page", 15000);
  if (visible().includes("LAST_MEMORY_SENTINEL")) throw Error("Memory was not bounded to a viewport");
  write("\x1b[4~");
  await wait(() => visible().includes("LAST_MEMORY_SENTINEL"), "End reaches last line", 10000);
  evidence.checks.push("bounded memory; End reaches last line");
  write("\x1b[1~");
  await sleep(300);
  write("\x1b[6~");
  await sleep(300);
  write("\x1b[5~");
  await sleep(300);
  write("\x1b");
  await sleep(500);
  await command("settings");
  await wait(() => visible().includes("resolvedConfig"), "settings first page", 15000);
  write("\x1b[4~");
  await wait(() => visible().includes("inactiveSettings"), "settings final page", 10000);
  evidence.checks.push("settings navigable after dismissing memory");
  write("\x1b");
  await sleep(500);
  await command("logs");
  const logPath = path.join(memory, "session-memory.log");
  await wait(
    () => visible().includes(memory + path.sep) && visible().includes("session-memory.log"),
    "log file path",
    15000,
  );
  if (visible().includes("PRIVATE_LOG_SENTINEL")) throw Error("Log contents shown");
  const history = await client.session.context({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) });
  evidence.history = history;
  if (!Array.isArray(history) || history.length !== 0) throw Error("Read commands changed session history");
  if (evidence.providerRequests !== 0) throw Error("Provider invoked");
  evidence.checks.push("path-only Logs; zero provider requests; zero session messages");
  evidence.verdict = "PASS";
}
(async () => {
  try {
    await main();
  } catch (error) {
    evidence.verdict = "FAIL";
    evidence.error = String(error);
  } finally {
    if (terminal) terminal.stdin.write(JSON.stringify({ kill: true }) + "\n");
    for (const child of [terminal, host])
      if (child?.pid) {
        try {
          cp.execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } catch {}
      }
    mock?.close();
    fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
    process.exit(evidence.verdict === "PASS" ? 0 : 1);
  }
})();
