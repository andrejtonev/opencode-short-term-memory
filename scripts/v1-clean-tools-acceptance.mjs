// Explicit native acceptance only: node this-file NATIVE_EXE INSTALLED_PACKAGE_ROOT [--live]
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";

const [nativeArgument, packageArgument, liveArgument] = process.argv.slice(2);
assert.ok(nativeArgument && packageArgument, "Supply native executable and installed STM package directory");
const native = resolve(nativeArgument),
  packageRoot = resolve(packageArgument),
  live = liveArgument === "--live";
const root = await mkdtemp(join(tmpdir(), "stm-clean-tools-native-"));
const project = join(root, "project"),
  config = join(root, "config", "opencode");
const marker = join(project, "TOOL_EXECUTED.txt"),
  canaryMarker = join(project, "PLUGIN_EXECUTED.txt");
const sourceFile = join(project, "PRIVATE_INPUT.txt");
const evidence = { root, native, packageRoot, live, providerRequests: [], verdict: "FAIL", hostExited: false };
let host,
  mock,
  hostLog = "",
  base,
  primaryID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, body, method, timeout = 90000) {
  const response = await fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", "x-opencode-directory": project },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
function send(response, delta, finish) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}
async function missing(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}
try {
  await mkdir(config, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(sourceFile, "PRIVATE_INPUT_SENTINEL");
  let cleanFirst = true,
    controlFirst = true;
  if (!live) {
    mock = http.createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const c of request) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const clean = JSON.stringify(body.messages).includes("You are a clean short-term memory summarizer.");
        const names = (body.tools ?? []).map((tool) => tool.function?.name);
        const toolResults = (body.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content);
        evidence.providerRequests.push({ clean, names, toolResults });
        const canary = names.find((name) => name?.endsWith("guard_canary"));
        if (clean && cleanFirst) {
          cleanFirst = false;
          assert.ok(names.includes("write") && names.includes("read") && names.includes("bash") && canary);
          send(
            response,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "blocked-write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ filePath: marker, content: "tool executed" }),
                  },
                },
                {
                  index: 1,
                  id: "blocked-read",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ filePath: sourceFile }) },
                },
                { index: 2, id: "blocked-plugin", type: "function", function: { name: canary, arguments: "{}" } },
              ],
            },
            "tool_calls",
          );
        } else if (!clean && controlFirst && JSON.stringify(body.messages).includes("PRIMARY_CANARY_CONTROL")) {
          controlFirst = false;
          assert.ok(canary);
          send(
            response,
            {
              role: "assistant",
              tool_calls: [
                { index: 0, id: "control-plugin", type: "function", function: { name: canary, arguments: "{}" } },
              ],
            },
            "tool_calls",
          );
        } else
          send(
            response,
            {
              role: "assistant",
              content: clean
                ? "## Session Memory\n\n### User Instructions\n- Keep project settings in stm.json.\n"
                : "STM action completed.",
            },
            "stop",
          );
      } catch (error) {
        evidence.mockError = String(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
    mock.listen(0, "127.0.0.1");
    await once(mock, "listening");
  }
  const plugins = [pathToFileURL(join(packageRoot, "dist", "index.js")).href];
  if (!live) {
    const canaryFile = join(root, "canary.mjs");
    // Import the installed plugin SDK, never the checkout's dependency tree.
    const sdk = pathToFileURL(join(packageRoot, "..", "..", "@opencode-ai", "plugin", "dist", "index.js")).href;
    await writeFile(
      canaryFile,
      `import {tool} from ${JSON.stringify(sdk)}; import {writeFile} from 'node:fs/promises'; export default async()=>({tool:{guard_canary:tool({description:'Native guard canary',args:{},execute:async()=>{await writeFile(${JSON.stringify(canaryMarker)},'executed');return 'CANARY_EXECUTED';}})}});`,
    );
    plugins.push(pathToFileURL(canaryFile).href);
  }
  const model = live ? "opencode/minimax-m3.1-flash-free" : "fixture/test";
  await writeFile(
    join(config, "opencode.json"),
    JSON.stringify({
      plugin: plugins,
      model,
      ...(live
        ? {}
        : {
            provider: {
              fixture: {
                npm: "@ai-sdk/openai-compatible",
                name: "Offline canary",
                options: { baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: "fixture" },
                models: { test: { name: "Fixture", limit: { context: 100000, output: 1000 } } },
              },
            },
          }),
    }),
  );
  await mkdir(join(project, ".opencode"), { recursive: true });
  await writeFile(
    join(project, ".opencode", "stm.json"),
    JSON.stringify({
      memoryModel: model,
      summarizerMode: "clean",
      sideSessionRetries: 0,
      debounceMs: 60000,
      debug: true,
    }),
  );
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("OPENCODE_") || key === "STM_EXPERIMENTAL_CLEAN_TOOLS") delete env[key];
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    OPENCODE_TEST_HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: live ? (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")) : join(root, "data"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP: "1",
  });
  host = spawn(native, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout.on("data", (c) => {
    hostLog += c;
  });
  host.stderr.on("data", (c) => {
    hostLog += c;
  });
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      if ((await api("/global/health", undefined, undefined, 1000)).healthy) break;
    } catch {}
    assert.ok(Date.now() < deadline && host.exitCode === null, "Host startup deadline");
    await sleep(300);
  }
  primaryID = (await api("/session", { title: "STM native clean guard acceptance" })).id;
  assert.ok(primaryID);
  await api(`/session/${primaryID}/message`, {
    noReply: true,
    model: { providerID: model.split("/")[0], modelID: model.split("/")[1] },
    parts: [
      {
        type: "text",
        text: "Keep project settings in stm.json. Summarize this supplied instruction only; do not use tools.",
      },
    ],
  });
  await api(`/session/${primaryID}/command`, { command: "stm", arguments: "update", model });
  const memoryPath = join(project, ".opencode", "memory", `session_${primaryID}.md`);
  evidence.memory = await readFile(memoryPath, "utf8");
  evidence.memoryPath = memoryPath;
  assert.ok(evidence.memory.includes("stm.json") && evidence.memory.includes("### User Instructions"));
  assert.ok(await missing(marker));
  assert.ok(await missing(canaryMarker));
  assert.equal(await readFile(sourceFile, "utf8"), "PRIVATE_INPUT_SENTINEL");
  if (!live) {
    const results = evidence.providerRequests.filter((r) => r.clean).flatMap((r) => r.toolResults);
    assert.equal(results.filter((s) => String(s).includes("cannot execute tools")).length, 3);
    assert.ok(results.every((s) => !String(s).includes("PRIVATE_INPUT_SENTINEL")));
    evidence.blockedAttempts = 3;
    await api(`/session/${primaryID}/message`, {
      model: { providerID: "fixture", modelID: "test" },
      parts: [{ type: "text", text: "PRIMARY_CANARY_CONTROL: exercise the guard_canary tool once." }],
    });
    assert.equal(await readFile(canaryMarker, "utf8"), "executed");
    evidence.primaryControl = "PASS";
  }
  evidence.sideSessions = (await api("/session")).filter((s) => s.title === "Session Memory Summarizer");
  assert.equal(evidence.sideSessions.length, 0);
  evidence.verdict = "PASS";
} catch (error) {
  evidence.error = String(error);
  process.exitCode = 1;
} finally {
  if (primaryID) await api(`/session/${primaryID}`, undefined, "DELETE", 5000).catch(() => {});
  if (host?.exitCode === null) {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(host.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await once(killer, "exit");
    } else {
      try {
        process.kill(-host.pid, "SIGKILL");
      } catch {}
    }
    if (host.exitCode === null) await Promise.race([once(host, "exit"), sleep(5000)]);
  }
  evidence.hostExited = host?.exitCode !== null;
  if (mock) await new Promise((r) => mock.close(r));
  await writeFile(join(root, "host.log"), hostLog);
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      verdict: evidence.verdict,
      error: evidence.error,
      live,
      root,
      evidence: join(root, "evidence.json"),
      blockedAttempts: evidence.blockedAttempts,
      hostExited: evidence.hostExited,
    }),
  );
}
