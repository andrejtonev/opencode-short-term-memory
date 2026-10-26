import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, readdir, cp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, toNamespacedPath } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { keyboardRequestsByTurn } from "./keyboard-turn-requests";
import { requestJournal } from "./request-evidence";
import { cleanupOwnedChildren, applyCleanupVerdict } from "./windows-owned-process.cjs";
// Native Windows live acceptance. See docs/WINDOWS-AZURE-ACCEPTANCE.md.
const [generation = "v1", model = "gpt-6-luna", candidate, hostsDirectory, v1Executable] = process.argv.slice(2);
assert.equal(process.platform, "win32", "This runner requires Windows ConPTY");
assert.ok(
  candidate && hostsDirectory,
  "Usage: bun scripts/windows-azure-acceptance.ts v1|v2 gpt-6-luna|deepseek-v4-flash CANDIDATE HOSTS_DIRECTORY [V1_EXECUTABLE]",
);
const full = process.env.STM_TEST_FULL === "1";
const faults = process.env.STM_TEST_FAULTS === "1";
const commandsOnly = process.env.STM_TEST_COMMANDS_ONLY === "1";
const actionsOnly = process.env.STM_TEST_ACTIONS_ONLY === "1";
let faultMode = "none";
let faultTargetText = "";
let releaseFault: (() => void) | undefined;
const mode = process.env.STM_TEST_MODE === "active" ? "active" : "clean";
const injection = process.env.STM_TEST_INJECTION !== "off";
const providerID = generation === "v2" ? "azure-isolated" : "azure";
assert.ok(["v1", "v2"].includes(generation));
assert.ok(["gpt-6-luna", "deepseek-v4-flash"].includes(model));
const hostRoot = resolve(hostsDirectory!);
const native =
  generation === "v1"
    ? v1Executable
      ? resolve(v1Executable)
      : join(homedir(), ".bun/install/global/node_modules/opencode-ai/bin/opencode.exe")
    : join(hostRoot, "node_modules/@opencode/cli-windows-x64/bin/opencode.exe");
const { OpenCode } = await import(
  pathToFileURL(join(hostRoot, "node_modules/@opencode/client/dist/promise/index.js")).href
);
const auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8").catch(() => "{}"));
const key = auth.azure?.key || process.env.AZURE_OPENAI_API_KEY;
const resource = process.env.AZURE_RESOURCE_NAME;
assert.ok(key && resource && /^[\w-]+$/.test(resource));
const root = await mkdtemp(join(tmpdir(), `stm-azure-${generation}-${model}-`));
console.log(JSON.stringify({ event: "started", root, generation, model }));
const project = join(root, "project");
const memory = join(project, ".opencode/memory");
await mkdir(memory, { recursive: true });
const token = randomUUID();
const redact = (text: string) => text.replaceAll(key, "[AZURE_KEY]").replaceAll(token, "[PROXY_TOKEN]");
const env: Record<string, string> = {};
for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
  if (process.env[name]) env[name] = process.env[name]!;
for (const name of [
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
  env[name] = join(root, name.toLowerCase());
  await mkdir(env[name], { recursive: true });
}
Object.assign(env, {
  OPENCODE_DB: join(root, "host.db"),
  OPENCODE_SERVER_PASSWORD: token,
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  STM_TEST_PROXY_TOKEN: token,
  TERM: "xterm-256color",
});
env.OPENCODE_PASSWORD = token;
env.OPENCODE_TEST_HOME = env.USERPROFILE;
env.OPENCODE_DISABLE_FILEWATCHER = "1";
env.OPENCODE_DISABLE_FFF = "1";
env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
env.npm_config_maxsockets = "2";
// Do not cap Bun's runtime HTTP pool: the TUI keeps an event stream open,
// and a command plus its receiver RPC must be able to run concurrently.
if (process.env.STM_TEST_NPM_CACHE_SEED) {
  await cp(
    toNamespacedPath(join(process.env.STM_TEST_NPM_CACHE_SEED, "localappdata/npm-cache/_cacache")),
    toNamespacedPath(join(env.LOCALAPPDATA, "npm-cache/_cacache")),
    { recursive: true },
  );
  env.npm_config_prefer_offline = "true";
}
await new Promise<void>((resolveDone, reject) => {
  const p = spawn("git", ["init", "--quiet"], { cwd: project, env, windowsHide: true, stdio: "ignore" });
  p.on("exit", (c) => (c === 0 ? resolveDone() : reject(new Error("git init failed"))));
});
const requests: any[] = [];
const recordRequest = requestJournal(join(root, "requests.jsonl"), redact);
const phases: any[] = [];
let providerQuotaBlocked = false;
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    if (!req.url.endsWith("/chat/completions")) return new Response("Unsupported route", { status: 404 });
    if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
    if (requests.length >= (full ? 96 : 32))
      return Response.json({ error: { message: "Run request limit reached" } }, { status: 400 });
    const body = (await req.json()) as any;
    if (body.model !== model) return new Response("Unapproved model", { status: 400 });
    const record: any = {
      index: requests.length,
      summary: (() => {
        // Active mode retains previous summarizer prompts in the conversation.
        // Classify this request by its latest user message, not historical ones.
        const content =
          JSON.stringify(body.messages.findLast((message: any) => message.role === "user")?.content) ?? "";
        return content.includes("<conversation_update>") && content.includes("<existing_memory>");
      })(),
      model,
      tools: body.tools?.map((x: any) => x.function?.name) ?? [],
      messages: body.messages,
      started: new Date().toISOString(),
    };
    requests.push(record);
    await recordRequest(record);
    if (providerQuotaBlocked) {
      record.status = 400;
      record.suppressedAfterQuota = true;
      record.error = "Run stopped forwarding after Azure quota rejection; retry in a fresh run after quota recovers";
      record.finished = new Date().toISOString();
      await recordRequest(record);
      return Response.json({ error: { message: record.error } }, { status: 400 });
    }
    body.stream = false;
    delete body.stream_options;
    body.max_completion_tokens = 4096;
    delete body.max_tokens;
    if (model === "gpt-6-luna") {
      body.reasoning_effort = "none";
      record.reasoningEffort = "none";
    }
    try {
      let injected: any;
      if (
        record.summary &&
        faultMode !== "none" &&
        faultTargetText &&
        JSON.stringify(body.messages).includes(faultTargetText)
      ) {
        record.injectedFault = faultMode;
        record.faultTargetText = faultTargetText;
        if (faultMode === "503-once") {
          faultMode = "none";
          record.status = 503;
          record.finished = new Date().toISOString();
          return Response.json({ error: { message: "Injected acceptance-test outage" } }, { status: 503 });
        }
        let content = "";
        if (faultMode === "malformed") content = "invalid structured memory";
        if (faultMode === "hold") {
          faultMode = "none";
          await new Promise<void>((done) => {
            releaseFault = done;
          });
          releaseFault = undefined;
          content =
            "## Session Memory\n\n### User Instructions\n- STALE_GENERATION_SENTINEL\n\n### Long Horizon Context\n- None.\n\n### Decisions\n- None.\n\n### Conclusions\n- None.\n\n### Active References\n- None.";
        }
        if (faultMode === "empty-once") faultMode = "none";
        injected = {
          id: randomUUID(),
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        };
      }
      const upstream = injected
        ? Response.json(injected)
        : await fetch(`https://${resource}.openai.azure.com/openai/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "api-key": key },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(90000),
          });
      const json = (await upstream.json()) as any;
      record.status = upstream.status;
      record.usage = json.usage;
      record.finished = new Date().toISOString();
      if (!upstream.ok) {
        record.error = redact(JSON.stringify(json.error));
        if (upstream.status === 429) providerQuotaBlocked = true;
        return Response.json(json, { status: upstream.status });
      }
      const choice = json.choices[0];
      record.response = choice;
      // Convert the actual Azure completion to SSE for either native host.
      const common = { id: json.id, created: json.created, model: json.model, object: "chat.completion.chunk" };
      const delta = { ...choice.message };
      delete delta.refusal;
      if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((x: any, index: number) => ({ index, ...x }));
      const chunks = [
        { ...common, choices: [{ index: 0, delta, finish_reason: null }] },
        { ...common, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: json.usage },
      ];
      return new Response(chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    } catch (error) {
      record.error = redact(String(error));
      record.status = 502;
      record.finished = new Date().toISOString();
      return Response.json({ error: { message: record.error } }, { status: 502 });
    } finally {
      await recordRequest(record);
    }
  },
});
const baseURL = `http://127.0.0.1:${proxy.port}/v1`;
const packed = resolve(candidate!);
const installedSeed = process.env.STM_TEST_INSTALLED_PACKAGE_SEED;
const preparedPackageProof: Record<string, string> = {};
if (installedSeed) {
  for (const relative of ["package.json", "dist/index.js", "dist/tui.js", "dist/rpc.js"]) {
    const archiveBytes = await new Promise<Buffer>((done, reject) => {
      const chunks: Buffer[] = [];
      const p = spawn("tar.exe", ["-xOf", packed, `package/${relative}`], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      p.stdout.on("data", (chunk) => chunks.push(chunk));
      p.on("error", reject);
      p.on("exit", (code) =>
        code === 0 ? done(Buffer.concat(chunks)) : reject(new Error("Candidate verification failed")),
      );
    });
    const installedBytes: Buffer = await readFile(
      join(installedSeed, "node_modules/@atonev/opencode-short-term-memory", relative),
    );
    assert.deepEqual(installedBytes, archiveBytes, `Prepared package differs from candidate: ${relative}`);
    preparedPackageProof[relative] = createHash("sha256").update(installedBytes).digest("hex");
  }
}
// Optional independent copies of package caches only; never copy runtime state.
const cacheSeed = process.env.STM_TEST_PACKAGE_CACHE_SEED;
if (cacheSeed) {
  for (const cache of installedSeed
    ? generation === "v2"
      ? ["xdg_cache_home"]
      : []
    : generation === "v2"
      ? ["bun_install_cache_dir", "xdg_cache_home"]
      : ["bun_install_cache_dir"]) {
    await cp(toNamespacedPath(join(resolve(cacheSeed), cache)), toNamespacedPath(join(root, cache)), {
      recursive: true,
      dereference: true,
    });
  }
}
const spec = `@atonev/opencode-short-term-memory@file:${packed}`;
await writeFile(
  join(root, "package.json"),
  JSON.stringify({ private: true, dependencies: { "@atonev/opencode-short-term-memory": `file:${packed}` } }),
);
if (!installedSeed)
  await new Promise<void>((resolveDone, reject) => {
    let output = "";
    const p = spawn(process.execPath, ["install", "--ignore-scripts"], {
      cwd: root,
      env,
      windowsHide: true,
      timeout: 300000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const s of [p.stdout, p.stderr])
      s.on("data", (x) => {
        output += x.toString();
        void writeFile(join(root, "install.log"), redact(output));
      });
    p.on("error", reject);
    p.on("exit", (code, signal) =>
      code === 0
        ? resolveDone()
        : reject(
            new Error(`Package install failed (exit=${code}, signal=${signal}; timeout=300000ms): ${redact(output)}`),
          ),
    );
  }).catch(async (error) => {
    proxy.stop(true);
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify(
        {
          root,
          generation,
          model: `azure/${model}`,
          verdict: "FAIL",
          hostExited: true,
          phase: "package-install",
          error: redact(String(error)),
          requests: 0,
          candidateSha256: createHash("sha256")
            .update(await readFile(packed))
            .digest("hex"),
          packageCacheSeed: cacheSeed ?? null,
        },
        null,
        2,
      ),
    );
    throw error;
  });
const installedEntry = pathToFileURL(
  join(installedSeed ?? root, "node_modules/@atonev/opencode-short-term-memory/dist/index.js"),
).href;
const hostConfig: any =
  generation === "v1"
    ? {
        plugin: [installedEntry],
        model: `azure/${model}`,
        small_model: `azure/${model}`,
        enabled_providers: ["azure"],
        provider: {
          azure: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL, apiKey: "{env:STM_TEST_PROXY_TOKEN}" },
            models: { [model]: { name: model, limit: { context: 128000, output: 4096 } } },
          },
        },
        permission: { "*": "deny", "stm_*": "allow", short_term_memory: "allow" },
      }
    : {
        plugins: [spec],
        model: `${providerID}/${model}`,
        update: "disable",
        share: "disabled",
        providers: {
          [providerID]: {
            env: [],
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL, apiKey: "{env:STM_TEST_PROXY_TOKEN}" },
            models: { [model]: { name: model } },
          },
        },
      };
await writeFile(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify(hostConfig));
if (generation === "v2") {
  await mkdir(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
  const cliConfig: any = {
    plugins: [{ package: spec }],
    animations: false,
    attention: { notifications: false, sound: false },
  };
  if (process.env.STM_TEST_TUI_PROBE === "1") {
    const probe = join(root, "receiver-probe");
    await mkdir(probe);
    await writeFile(
      join(probe, "tui.js"),
      `export { default } from ${JSON.stringify(pathToFileURL(resolve("scripts/windows-tui-receiver-probe.ts")).href)};`,
    );
    cliConfig.plugins.push({
      package: probe,
      options: { entry: installedEntry.replace(/index\.js$/, "tui.js"), log: join(root, "receiver-probe.jsonl") },
    });
  }
  await writeFile(join(env.XDG_CONFIG_HOME, "opencode/cli.json"), JSON.stringify(cliConfig));
  await writeFile(join(env.OPENCODE_CONFIG_DIR, "cli.json"), JSON.stringify(cliConfig));
}
const stmSettings = {
  enabled: false,
  summarizerMode: mode,
  memoryModel: mode === "active" ? "" : `${providerID}/${model}`,
  memoryDir: memory,
  debug: true,
  debounceMs: 300,
  remindEveryN: 2,
  sideSessionRetries: faults ? 1 : 0,
  enableLegacyPeriodicSystemTransform: injection,
};
await writeFile(join(env.OPENCODE_CONFIG_DIR, "stm.json"), JSON.stringify(stmSettings));
await writeFile(
  join(project, "AGENTS.md"),
  "This is an isolated acceptance test. Follow the user's exact tool instructions; do not use filesystem or shell tools. Summarizers receive all their inputs in their prompt.",
);
let priorHostLog = "",
  hostLog = "",
  terminalLog = "",
  url = "",
  host: any,
  terminal: any,
  client: any,
  sessionID = "";
let result: any = {
  root,
  generation,
  model: `azure/${model}`,
  phases,
  paidInference: !(commandsOnly && generation === "v2"),
  diagnosticReceiver: process.env.STM_TEST_TUI_PROBE === "1",
  faults,
  full,
  mode,
  injection,
  configuredDelivery: injection ? "system" : generation === "v1" ? "promptNoReply" : "none",
  installation: installedSeed
    ? { kind: "verified-prepared-package", seed: installedSeed, files: preparedPackageProof }
    : { kind: "fresh-bun-install" },
  candidateSha256: createHash("sha256")
    .update(await readFile(packed))
    .digest("hex"),
};
async function wait(check: () => any, label: string, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function api(path: string, body?: any) {
  const response = await fetch(url + path, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": project,
      authorization: `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(240000),
  });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data as any;
}
async function history() {
  return generation === "v1"
    ? api(`/session/${sessionID}/message`)
    : client.session.context({ sessionID }, { signal: AbortSignal.timeout(faults ? 90000 : 15000) });
}
async function settled() {
  if (generation === "v2") await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(90000) });
}
async function startHost() {
  priorHostLog += hostLog;
  hostLog = "";
  host = spawn(native, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: project,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [host.stdout, host.stderr])
    stream.on("data", (x: any) => {
      hostLog += redact(x.toString());
      void writeFile(join(root, "host.log"), priorHostLog + hostLog);
    });
  await wait(() => {
    assert.equal(host.exitCode, null, hostLog.slice(-2000));
    url = hostLog.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? "";
    return url;
  }, "host listener");
  if (generation === "v2")
    client = OpenCode.make({
      baseUrl: url,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}` },
    });
}
async function createSession(title: string) {
  const session =
    generation === "v1"
      ? await api("/session", { title })
      : await client.session.create({
          title,
          agent: "build",
          model: { providerID, id: model },
          location: { directory: project },
        });
  sessionID = session.id;
  return session;
}
async function prompt(text: string) {
  if (generation === "v2")
    text =
      "STM tools are available as direct function tools with the exact names in this request. Call them directly; do not route STM calls through execute or invent functions/tools namespaces. " +
      text;
  if (generation === "v1")
    await api(`/session/${sessionID}/message`, {
      model: { providerID: "azure", modelID: model },
      parts: [{ type: "text", text }],
    });
  else {
    await client.session.prompt({ sessionID, text }, { signal: AbortSignal.timeout(90000) });
    await settled();
  }
  return history();
}
function toolNames(rows: any[]): string[] {
  return rows.flatMap((row) =>
    (row.parts ?? row.content ?? []).filter((p: any) => p.type === "tool").map((p: any) => p.tool ?? p.name),
  );
}
async function phase(name: string, action: () => Promise<any>) {
  const start = requests.length;
  try {
    const detail = await action();
    phases.push({ name, verdict: "PASS", requestStart: start, requestEnd: requests.length, detail });
  } catch (error) {
    phases.push({
      name,
      verdict: "FAIL",
      error: redact(String(error)),
      requestStart: start,
      requestEnd: requests.length,
    });
    await writeFile(join(root, "evidence.json"), JSON.stringify(result, null, 2));
    await writeFile(join(root, "terminal.ansi"), redact(terminalLog));
    await writeFile(join(root, "requests.json"), redact(JSON.stringify(requests, null, 2)));
    throw error;
  }
  await writeFile(join(root, "evidence.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ event: "phase", generation, model, ...phases.at(-1) }));
}
async function openTerminal() {
  terminalLog += "\n[NEW TERMINAL]\n";
  const terminalStart = terminalLog.length;
  const args =
    generation === "v1"
      ? ["attach", url, "--session", sessionID, "--dir", project]
      : ["--server", url, "--session", sessionID, ...(commandsOnly ? ["--log-level", "debug"] : [])];
  terminal = spawn(
    "node",
    [resolve("scripts/windows-pty-bridge.cjs"), join(hostRoot, "node_modules/node-pty"), native, ...args],
    { cwd: project, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "";
  terminal.stdout.on("data", (chunk: any) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.data) terminalLog += event.data;
    }
  });
  terminal.stderr.on("data", (x: any) => (terminalLog += x.toString()));
  await wait(
    () => {
      assert.equal(
        terminal.exitCode,
        null,
        `TUI exited during startup: ${stripVTControlCharacters(terminalLog.slice(terminalStart)).slice(-2000)}`,
      );
      return terminalLog.slice(terminalStart).includes("build") || terminalLog.slice(terminalStart).includes("Build");
    },
    "TUI readiness",
    45000,
  );
  await Bun.sleep(1500);
}
async function type(text: string) {
  terminal.stdin.write(JSON.stringify({ write: text }) + "\n");
  await Bun.sleep(400);
  terminal.stdin.write(JSON.stringify({ write: "\r" }) + "\n");
  await wait(async () => JSON.stringify(await history()).includes(text), "typed message persisted");
  await wait(async () => {
    const rows = await history();
    const last = generation === "v1" ? rows.at(-1) : rows.findLast((row: any) => row.type === "assistant");
    return generation === "v1"
      ? last?.info?.role === "assistant" && Boolean(last.info.time?.completed)
      : last?.type === "assistant" && Boolean(last.time?.completed);
  }, "typed assistant completed");
  await settled();
}
async function closeTerminal() {
  if (!terminal) return;
  terminal.stdin.write(JSON.stringify({ kill: true }) + "\n");
  await wait(() => terminal.exitCode !== null, "TUI shutdown", 5000).catch(() => terminal.kill());
  terminal = undefined;
}
async function fullActions() {
  // Freeze automatic updates so read/refusal/reset observations are attributable
  // to the action being tested, with no competing automatic write.
  await closeTerminal();
  host.kill();
  await wait(() => host.exitCode !== null || host.signalCode !== null, "host shutdown", 10000);
  await writeFile(join(project, ".opencode/stm.jsonc"), JSON.stringify({ ...stmSettings, enabled: false }));
  await startHost();
  await createSession("Full isolated manual actions");
  if (generation === "v2")
    await writeFile(
      join(root, "plugin-inventory.json"),
      JSON.stringify(
        await client.plugin.list({ location: { directory: project } }, { signal: AbortSignal.timeout(10000) }),
        null,
        2,
      ),
    );
  const mem = join(memory, `session_${sessionID}.md`);
  const sentinel = "## Session Memory\n\n### User Instructions\n- FULL_SWEEP_SENTINEL\n";
  await writeFile(mem, sentinel);
  const attempt = async (name: string, action: () => Promise<any>) => {
    try {
      await phase(name, action);
    } catch {
      /* Retain failure and exercise independent cases. */
    }
  };
  const outputOf = (part: any) =>
    generation === "v1"
      ? part.state.output
      : part.state.content
          ?.filter((x: any) => x.type === "text")
          .map((x: any) => x.text)
          .join("");
  for (const action of commandsOnly ? [] : ["show", "status", "settings", "logs", "update", "setup", "reset"]) {
    await attempt(`compatibility-action-${action}`, async () => {
      const beforeRows = await history();
      const rows = await prompt(
        `Call short_term_memory exactly once with action=${action} and confirm=false. Do not use any other tools.`,
      );
      const parts = rows
        .slice(beforeRows.length)
        .flatMap((r: any) => r.parts ?? r.content ?? [])
        .filter((p: any) => p.type === "tool" && (p.tool ?? p.name) === "short_term_memory");
      assert.equal(parts.length, 1, "exactly one compatibility invocation");
      assert.equal(parts[0].state.status, "completed");
      const output = outputOf(parts[0]);
      assert.ok(output?.length);
      if (action === "setup" || (action === "reset" && generation === "v2"))
        assert.match(output, /refus|not run|confirm/i);
      if (action === "reset" && generation === "v1") {
        assert.match(output, /Reset memory/);
        assert.equal((await readFile(mem, "utf8")).includes("FULL_SWEEP_SENTINEL"), false);
        await writeFile(mem, sentinel);
      } else assert.equal(await readFile(mem, "utf8"), sentinel, "read/refusal actions preserve memory bytes");
      return { output };
    });
  }
  for (const confirm of commandsOnly ? [] : generation === "v1" ? [true] : [false, true]) {
    await attempt(`reset-tool-${confirm ? "confirmed" : "refused"}`, async () => {
      const beforeRows = await history();
      const rows = await prompt(
        `Call stm_memory_reset exactly once with confirm=${confirm}. Do not use any other tools.`,
      );
      const parts = rows
        .slice(beforeRows.length)
        .flatMap((r: any) => r.parts ?? r.content ?? [])
        .filter((p: any) => p.type === "tool" && (p.tool ?? p.name) === "stm_memory_reset");
      assert.equal(parts.length, 1);
      assert.equal(parts[0].state.status, "completed");
      const output = outputOf(parts[0]);
      if (!confirm) {
        assert.match(output, /refus|confirm/i);
        assert.equal(await readFile(mem, "utf8"), sentinel);
      } else {
        assert.match(output, /reset.*completed|Reset memory/i);
        assert.equal((await readFile(mem, "utf8")).includes("FULL_SWEEP_SENTINEL"), false);
      }
      return { output, memory: await readFile(mem, "utf8") };
    });
  }
  await openTerminal();
  const commands = [
    "status",
    "settings",
    "show",
    "logs",
    "update",
    "setup",
    "setup confirm false",
    "setup confirm true",
    "setup confirm true",
    ...(generation === "v2" ? ["reset", "reset confirm false", "reset confirm true"] : ["reset"]),
    "invalid-action",
  ];
  for (const [index, action] of commands.entries()) {
    await attempt(`literal-command-${index}-${action.replaceAll(" ", "-")}`, async () => {
      const snapshot = () =>
        generation === "v1" ? history() : client.message.list({ sessionID }, { signal: AbortSignal.timeout(10000) });
      const beforeRows = await snapshot();
      const requestStart = requests.length;
      const screenStart = terminalLog.length;
      const configBefore = await readFile(join(project, ".opencode/stm.jsonc"), "utf8");
      const memoryBefore = await readFile(mem, "utf8");
      terminal.stdin.write(JSON.stringify({ write: `/stm ${action}` }) + "\n");
      await Bun.sleep(400);
      terminal.stdin.write(JSON.stringify({ write: "\r" }) + "\n");
      let output = "";
      if (generation === "v1") {
        await wait(async () => {
          const rows = (await history()).slice(beforeRows.length);
          const part = rows
            .flatMap((r: any) => r.parts ?? [])
            .find((p: any) => p.synthetic && p.text?.startsWith("The STM action has already completed."));
          if (part) output = JSON.parse(part.text.slice(part.text.indexOf("\n") + 1));
          return part && rows.some((r: any) => r.info?.role === "assistant" && r.info.time?.completed);
        }, `literal /stm ${action}`);
        assert.ok(output.length);
      } else {
        const title = action === "invalid-action" ? "Unknown action" : `STM ${action.split(" ")[0]}`;
        await wait(
          () => {
            const visible = stripVTControlCharacters(terminalLog.slice(screenStart));
            assert.doesNotMatch(visible, /no connected TUI receiver|No action was run/);
            if (action !== "invalid-action") assert.doesNotMatch(visible, /Failed to run command/);
            // Long settings output can place the title above a short viewport.
            // Require actual settings fields, rather than matching echoed input.
            if (action === "settings")
              return (
                /"memoryModelSelection"\s*:/.test(visible) &&
                /"maxDeltaMessages"\s*:\s*200/.test(visible) &&
                /"updateHook"\s*:\s*"context"/.test(visible)
              );
            return visible.includes(title);
          },
          `visible /stm ${action}`,
          30000,
        );
        output = stripVTControlCharacters(terminalLog.slice(screenStart));
        if (action === "reset" || action === "reset confirm false") {
          assert.match(output, /Refused:/);
          assert.equal(await readFile(mem, "utf8"), memoryBefore);
        }
        if (action === "reset confirm true" && !commandsOnly) {
          assert.match(output, /reset:\s*completed/);
          assert.equal((await readFile(mem, "utf8")).includes("FULL_SWEEP_SENTINEL"), false);
        }
        assert.equal(requests.length, requestStart, "V2 command output is model-free");
        assert.deepEqual(await snapshot(), beforeRows, "V2 slash command does not modify durable conversation");
      }
      assert.equal(
        await readFile(join(project, ".opencode/stm.jsonc"), "utf8"),
        configBefore,
        "setup refuses overwrite",
      );
      await writeFile(
        join(root, `command-${index}-visible.txt`),
        stripVTControlCharacters(terminalLog.slice(screenStart)),
      );
      return { action, output, requestStart, requestEnd: requests.length };
    });
    if (generation === "v2") {
      // A failed visibility assertion may leave its dialog open. Dismiss it
      // before independently testing the next command; preserve the failure.
      terminal.stdin.write(JSON.stringify({ write: "\x1b" }) + "\n");
      await Bun.sleep(500);
    }
  }
  assert.ok(
    phases.every((p) => p.verdict === "PASS"),
    "One or more full-sweep actions failed; see individual records",
  );
}
async function faultActions() {
  const selectedFault = process.env.STM_TEST_FAULT_CASE;
  if (selectedFault)
    assert.ok(
      [
        "native-empty-history",
        "native-summary-empty-once",
        "native-summary-503-once",
        "native-summary-empty",
        "native-summary-malformed",
        "native-reset-during-generation",
        "native-delete-during-generation",
      ].includes(selectedFault),
      "Unknown fault-case selection",
    );
  result.faultCaseSelection = selectedFault ?? "all";
  await writeFile(join(project, ".opencode/stm.json"), JSON.stringify({ ...stmSettings, enabled: true }));
  await startHost();
  result.hostVersion =
    generation === "v1" ? (await api("/global/health")).version : (await client.server.info()).version;
  const checkpoint = () => join(memory, "checkpoints", `${sessionID}.last-message-id.txt`);
  const mem = () => join(memory, `session_${sessionID}.md`);
  const quiet = async () =>
    wait(
      () =>
        requests.every((r) => r.finished) &&
        Date.now() - Math.max(...requests.map((r) => Date.parse(r.finished)), 0) > 2500,
      "fault requests quiet",
    );
  const attempt = async (name: string, action: () => Promise<any>) => {
    if (selectedFault && name !== selectedFault && name !== "native-fault-cleanup") return;
    faultTargetText = `FAULT_CASE_${randomUUID()}`;
    try {
      await phase(name, action);
    } catch {}
    releaseFault?.();
    faultMode = "none";
    await quiet();
    if (generation === "v1")
      await wait(
        async () =>
          JSON.parse(await readFile(join(memory, "side-sessions.json"), "utf8").catch(() => "[]")).length === 0,
        "temporary sessions cleaned up between fault cases",
      );
  };
  await attempt("native-empty-history", async () => {
    await createSession("Empty history");
    await Bun.sleep(2000);
    assert.equal(requests.length, 0);
    assert.equal((await readFile(checkpoint(), "utf8").catch(() => "")).trim(), "");
    return { sessionID };
  });
  for (const fault of ["empty-once", "503-once", "empty", "malformed"]) {
    await attempt(`native-summary-${fault}`, async () => {
      await createSession(`Fault ${fault}`);
      faultMode = fault;
      const start = requests.length;
      await prompt(
        `Remember fault-test fact: the isolated project ${faultTargetText} uses port 7319. Reply briefly without tools.`,
      );
      await wait(() => requests.slice(start).some((r) => r.injectedFault), "injected summary fault");
      if (fault.endsWith("once")) {
        await wait(
          async () =>
            (await readFile(mem(), "utf8").catch(() => "")).includes("7319") &&
            Boolean((await readFile(checkpoint(), "utf8").catch(() => "")).trim()),
          "recovered summary and checkpoint",
        );
        assert.ok((await readFile(checkpoint(), "utf8")).trim());
      } else {
        await wait(
          () => requests.slice(start).filter((r) => r.summary && r.finished).length >= 2,
          "exhausted configured summary attempts",
        );
        await quiet();
        assert.equal(
          (await readFile(checkpoint(), "utf8").catch(() => "")).trim(),
          "",
          "failed summary must not advance checkpoint",
        );
      }
      await quiet();
      return {
        sessionID,
        attempts: requests.slice(start).filter((r) => r.summary).length,
        memory: await readFile(mem(), "utf8").catch(() => ""),
      };
    });
  }
  await attempt("native-reset-during-generation", async () => {
    await createSession("Reset while summary held");
    faultMode = "hold";
    const initialTurn = prompt(
      `Remember: this isolated reset test ${faultTargetText} uses port 7319. Reply without tools.`,
    );
    void initialTurn.catch(() => {});
    await wait(() => releaseFault !== undefined, "held generation");
    const rows = await prompt(
      "Reset this session's memory exactly once with confirm=true, using stm_memory_reset or short_term_memory with action=reset. Do not use other tools.",
    );
    const part = rows
      .flatMap((r: any) => r.parts ?? r.content ?? [])
      .findLast((p: any) => p.type === "tool" && ["stm_memory_reset", "short_term_memory"].includes(p.tool ?? p.name));
    assert.ok(part);
    const output = generation === "v1" ? part.state.output : JSON.stringify(part.state.content);
    if (generation === "v2") assert.match(output, /update is active|reset: completed/);
    else assert.match(output, /Reset memory/);
    releaseFault!();
    await initialTurn;
    await quiet();
    // V2 can cancel the context generation before admitting the reset tool.
    // Both safe busy refusal and completed reset are valid native outcomes.
    if (generation === "v1" || /reset: completed/.test(output))
      assert.equal(
        (await readFile(mem(), "utf8")).includes("STALE_GENERATION_SENTINEL"),
        false,
        "pre-reset generation cannot commit",
      );
    return { sessionID, tool: part.tool ?? part.name, output };
  });
  await attempt("native-delete-during-generation", async () => {
    await createSession("Delete while summary held");
    faultMode = "hold";
    const initialTurn = prompt(
      `Remember: this isolated deletion test ${faultTargetText} uses port 7319. Reply without tools.`,
    );
    void initialTurn.catch(() => {});
    await wait(() => releaseFault !== undefined, "held generation");
    if (generation === "v2") await client.session.remove({ sessionID });
    else {
      const response = await fetch(url + `/session/${sessionID}`, {
        method: "DELETE",
        headers: {
          "x-opencode-directory": project,
          authorization: `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}`,
        },
      });
      assert.ok(response.ok);
    }
    releaseFault!();
    // Deleting a session may cancel the pending context request. Its outcome
    // does not replace the persistence assertions below.
    await initialTurn.catch(() => {});
    await quiet();
    assert.equal(await Bun.file(mem()).exists(), false, "deleted session memory cannot resurrect");
    assert.equal(await Bun.file(checkpoint()).exists(), false, "deleted session checkpoint cannot resurrect");
    return { sessionID };
  });
  await attempt("native-fault-cleanup", async () => {
    await quiet();
    if (generation === "v1")
      await wait(
        async () => JSON.parse(await readFile(join(memory, "side-sessions.json"), "utf8")).length === 0,
        "all temporary sessions cleaned up",
      );
    const rows = (await readFile(join(memory, "session-memory.log"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
    const sideIDs = rows.filter((x) => x.event === "side_session_created").map((x) => x.sessionID);
    for (const id of sideIDs) assert.equal(await Bun.file(join(memory, `session_${id}.md`)).exists(), false);
    for (const r of requests.filter((r) => r.summary)) assert.deepEqual(r.tools, []);
    assert.equal(
      rows.some((x) => x.event === "collect_recent_messages_error" && sideIDs.includes(x.sessionID)),
      false,
    );
    if (generation === "v1")
      assert.deepEqual(JSON.parse(await readFile(join(memory, "side-sessions.json"), "utf8")), []);
    return { sideIDs };
  });
  assert.ok(
    phases.every((p) => p.verdict === "PASS"),
    "Native fault case failed; see retained individual phases",
  );
}
try {
  if (commandsOnly || actionsOnly) {
    await startHost();
    result.hostVersion =
      generation === "v1" ? (await api("/global/health")).version : (await client.server.info()).version;
    await fullActions();
  } else if (faults) await faultActions();
  else {
    await phase("isolated-host-start", async () => {
      await startHost();
      result.hostVersion =
        generation === "v1" ? (await api("/global/health")).version : (await client.server.info()).version;
      if (generation === "v2")
        await writeFile(
          join(root, "plugin-inventory.json"),
          JSON.stringify(await client.plugin.list({ location: { directory: project } }), null, 2),
        );
      await createSession("Azure isolated setup");
      return { hostVersion: result.hostVersion };
    });
    await phase("settings-status-tools", async () => {
      const rows = await prompt(
        "Call stm_memory_settings and stm_memory_status exactly once each, then report the configured memory model and directory. Do not use any other tools.",
      );
      const names = toolNames(rows);
      assert.ok(names.includes("stm_memory_settings"));
      assert.ok(names.includes("stm_memory_status"));
      assert.ok(JSON.stringify(rows).includes(model));
      if (generation === "v2") {
        const inventory = await client.plugin.list(
          { location: { directory: project } },
          { signal: AbortSignal.timeout(15000) },
        );
        await writeFile(join(root, "plugin-inventory.json"), JSON.stringify(inventory, null, 2));
        const entry = hostLog.match(/msg="loading plugin"[^\n]*entrypoint=(file:\/\/\/\S+\/dist\/index\.js)/)?.[1];
        assert.ok(entry, "V2 must report a loaded package entrypoint");
        const loadedBytes = await readFile(toNamespacedPath(fileURLToPath(entry)));
        const expectedBytes = await readFile(
          join(installedSeed ?? root, "node_modules/@atonev/opencode-short-term-memory/dist/index.js"),
        );
        assert.ok(loadedBytes.equals(expectedBytes), "V2 loaded entrypoint must match verified candidate bytes");
        result.loadedEntrypointSha256 = createHash("sha256").update(loadedBytes).digest("hex");
      }
      return { tools: names };
    });
    await phase("setup-refusal-confirmation-no-overwrite", async () => {
      const target = join(project, ".opencode/stm.jsonc");
      await prompt("Call stm_memory_setup with confirm=false. Do not call any other tool.");
      assert.equal(await Bun.file(target).exists(), false);
      await prompt("Call stm_memory_setup with confirm=true. Do not call any other tool.");
      assert.equal(await Bun.file(target).exists(), true);
      const before = await readFile(target, "utf8");
      await prompt("Call stm_memory_setup with confirm=true again. Do not call any other tool.");
      assert.equal(await readFile(target, "utf8"), before);
      return { file: target, preservedOnRepeat: true };
    });
    // A fresh host applies the next settings without depending on generation-specific reload delays.
    host.kill();
    await wait(() => host.exitCode !== null || host.signalCode !== null, "host shutdown", 10000);
    await writeFile(join(project, ".opencode/stm.jsonc"), JSON.stringify({ ...stmSettings, enabled: true }));
    await phase("keyboard-memory-journey", async () => {
      await startHost();
      await createSession("Azure isolated keyboard");
      await openTerminal();
      const typedPrompts = [
        "Remember: project cobalt uses port 7319. Reply briefly without tools.",
        "Keep port 7319. The release color is violet. Reply briefly without tools.",
        "The Unicode label is caf\u00e9 \u6771\u4eac. Keep cobalt, 7319, and violet. Reply briefly without tools.",
      ];
      const typedRequestStart = requests.length;
      await type(typedPrompts[0]!);
      const mem = join(memory, `session_${sessionID}.md`);
      await wait(async () => (await readFile(mem, "utf8").catch(() => "")).includes("7319"), "first automatic memory");
      await type(typedPrompts[1]!);
      await wait(
        async () => (await readFile(mem, "utf8").catch(() => "")).toLowerCase().includes("violet"),
        "second automatic memory",
      );
      if (mode === "clean")
        for (const req of requests.filter((x) => x.summary))
          assert.deepEqual(req.tools, [], "summary tools must be absent");
      if (full) {
        await type(typedPrompts[2]!);
        await wait(
          async () => (await readFile(mem, "utf8").catch(() => "")).includes("\u6771\u4eac"),
          "Unicode automatic memory",
        );
        const perTurn = keyboardRequestsByTurn(requests.slice(typedRequestStart), typedPrompts);
        const ordinary = perTurn.map((group, index) => {
          assert.ok(group.length, `Missing provider request for typed turn ${index + 1}`);
          return group[0]!;
        });
        result.keyboardTurnRequestIndexes = perTurn.map((group) => group.map((request) => request.index));
        const fresh = ordinary
          .slice(-3)
          .map(
            (x) =>
              x.messages.filter(
                (m: any) => m.role === "system" && JSON.stringify(m.content).includes("[MEMORY_SYSTEM]"),
              ).length,
          );
        if (generation === "v2")
          assert.deepEqual(
            fresh,
            injection ? [0, 1, 0] : [0, 0, 0],
            "system injection cadence across three typed turns",
          );
        if (generation === "v1") {
          const delivered = injection
            ? fresh
            : ordinary.slice(-3).map(
                (x) =>
                  x.messages.filter((m: any) => {
                    const text =
                      typeof m.content === "string"
                        ? m.content
                        : (m.content ?? []).map((part: any) => part.text ?? "").join("\n");
                    return m.role === "user" && text.trimStart().startsWith("[MEMORY_SYSTEM]");
                  }).length,
              );
          assert.deepEqual(
            delivered,
            injection ? [0, 1, 0] : [0, 1, 1],
            "V1 injection cadence, including retained NoReply messages",
          );
          result.v1DeliveryCadence = delivered;
        }
        result.keyboardCadence = fresh;
        const deliveryCount = (request: any) =>
          request.messages.filter((message: any) => {
            const text =
              typeof message.content === "string"
                ? message.content
                : (message.content ?? []).map((part: any) => part.text ?? "").join("\n");
            const role = generation === "v1" && !injection ? "user" : "system";
            return (
              message.role === role &&
              (role === "user" ? text.trimStart().startsWith("[MEMORY_SYSTEM]") : text.includes("[MEMORY_SYSTEM]"))
            );
          }).length;
        for (const group of perTurn)
          for (const request of group.slice(1))
            assert.equal(
              deliveryCount(request),
              deliveryCount(group[0]),
              "Tool continuations must preserve the turn's delivery count",
            );
      }
      return { sessionID, summaries: requests.filter((x) => x.summary).length, memory: await readFile(mem, "utf8") };
    });
    await phase("read-logs-compatibility-tools", async () => {
      const rows = await prompt(
        "Call stm_memory_read, stm_memory_logs, and short_term_memory with action=status exactly once each. Do not call any other tools. Reply briefly.",
      );
      const names = toolNames(rows);
      for (const name of ["stm_memory_read", "stm_memory_logs", "short_term_memory"]) assert.ok(names.includes(name));
      return { tools: names };
    });
    await phase("manual-update-tool", async () => {
      const logPath = join(memory, "session-memory.log");
      const startedAt = Date.now();
      const checkpointPath = join(memory, "checkpoints", `${sessionID}.last-message-id.txt`);
      const checkpointBefore = await readFile(checkpointPath, "utf8").catch(() => "");
      const rows = await prompt("Call stm_memory_update exactly once, then reply briefly. Do not use any other tools.");
      assert.ok(toolNames(rows).includes("stm_memory_update"));
      if (generation === "v1" && mode === "active") {
        const updates = rows
          .flatMap((row: any) => row.parts ?? [])
          .filter((part: any) => part.type === "tool" && part.tool === "stm_memory_update");
        assert.ok(
          updates.some((part: any) => String(part.state?.output).includes("deferred until")),
          "busy active update must return an explicit deferred result",
        );
        await wait(async () => {
          // The logger may be appending the final line while this poll reads it.
          const events = (await readFile(logPath, "utf8"))
            .split("\n")
            .slice(0, -1)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((event) => event.sessionID === sessionID && Date.parse(event.ts) >= startedAt);
          const deferred = events.findIndex((event) => event.event === "memory_update_deferred");
          return (
            deferred >= 0 &&
            events.slice(deferred + 1).some((event) => event.event === "memory_update_done") &&
            (await readFile(checkpointPath, "utf8").catch(() => "")) !== checkpointBefore
          );
        }, "deferred manual update commits after idle");
        return { deferred: true, committedAfterIdle: true };
      }
      return {};
    });
    await phase("summary-isolation-and-cleanup", async () => {
      await wait(
        () =>
          requests.every((request) => request.finished) &&
          Date.now() - Math.max(...requests.map((request) => Date.parse(request.finished))) > 3000,
        "all provider requests completed and quiet",
      );
      if (generation === "v1" && mode === "clean")
        await wait(
          async () => JSON.parse(await readFile(join(memory, "side-sessions.json"), "utf8")).length === 0,
          "all temporary sessions deleted",
        );
      const log = await readFile(join(memory, "session-memory.log"), "utf8");
      const rows = log
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x));
      const sideIDs = rows.filter((x) => x.event === "side_session_created").map((x) => x.sessionID);
      assert.ok(
        requests.some((x) => x.summary),
        "Expected actual summary requests",
      );
      for (const request of requests.filter((x) => x.summary)) {
        if (mode === "clean") assert.deepEqual(request.tools, []);
        assert.equal(request.response?.message?.tool_calls?.length ?? 0, 0, "summaries must not request tool calls");
      }
      for (const id of sideIDs) assert.equal(await Bun.file(join(memory, `session_${id}.md`)).exists(), false);
      assert.equal(
        rows.some((x) => x.event === "collect_recent_messages_error"),
        false,
      );
      return { sideIDs, memoryFiles: await readdir(memory) };
    });
    if (full && process.env.STM_TEST_ACTIONS !== "off") await fullActions();
  }
  if (!faults)
    await phase("provider-transport-health", async () => {
      const failed = requests.filter((request) => request.status !== 200);
      assert.deepEqual(
        failed.map((request) => ({ index: request.index, status: request.status, error: request.error })),
        [],
        "Provider transport errors occurred; earlier functional phases may still have passed after host retries",
      );
      return { completedRequests: requests.length };
    });
  result.verdict = "PASS";
} catch (error) {
  result.verdict = "FAIL";
  result.error = redact(String(error));
  process.exitCode = 1;
} finally {
  releaseFault?.();
  await writeFile(
    join(root, "history.json"),
    redact(JSON.stringify(sessionID ? await history().catch(() => []) : [], null, 2)),
  );
  const cleanup = await cleanupOwnedChildren([terminal, host], { endpoints: url ? [url] : [] });
  applyCleanupVerdict(result, cleanup);
  if (result.verdict !== "PASS") process.exitCode = 1;
  proxy.stop(true);
  result.hostExited = cleanup.childrenExited;
  result.requests = requests.length;
  result.providerAlias = providerID;
  result.packageCacheSeed = cacheSeed ?? null;
  result.usage = requests.reduce(
    (sum, r) => ({
      promptTokens: sum.promptTokens + (r.usage?.prompt_tokens ?? 0),
      completionTokens: sum.completionTokens + (r.usage?.completion_tokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0 },
  );
  result.notRun = [
    ...(commandsOnly || actionsOnly ? ["ordinary chat journey: separate profile"] : []),
    "settings matrix is executed separately by windows-config-sweep.ts",
    ...(mode === "active" ? [] : ["active summarization is a separate profile"]),
    ...(full && !faults && process.env.STM_TEST_ACTIONS !== "off" ? [] : ["all keyboard commands"]),
    ...(faults ? [] : ["reset/delete races", "provider fault injection"]),
  ];
  await writeFile(join(root, "host.log"), redact(priorHostLog + hostLog));
  await writeFile(join(root, "terminal.ansi"), redact(terminalLog));
  await writeFile(join(root, "requests.json"), redact(JSON.stringify(requests, null, 2)));
  await writeFile(join(root, "evidence.json"), redact(JSON.stringify(result, null, 2)));
  console.log(JSON.stringify(result));
}
