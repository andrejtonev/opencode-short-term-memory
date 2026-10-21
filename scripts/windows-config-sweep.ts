import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { Npm } from "@opencode/util/npm";
import {
  buildConfigScenario,
  CONFIG_SCENARIO_IDS,
  expectedSettingsMetadata,
  KNOWN_DEFAULT_CONFIG17,
  type ConfigGeneration,
} from "./rc-config-scenarios";

const [candidateArg, hostsArg, seedArg, ...selection] = process.argv.slice(2);
assert.ok(
  candidateArg && hostsArg && seedArg,
  "Usage: bun scripts/windows-config-sweep.ts CANDIDATE HOSTS PACKAGE_SEED [v1|v2:SCENARIO ...]",
);
const candidate = resolve(candidateArg);
const hosts = resolve(hostsArg);
const seed = resolve(seedArg);
const installRoute = process.env.STM_TEST_INSTALL_ROUTE;
const installScope = process.env.STM_TEST_INSTALL_SCOPE ?? "global";
const { OpenCode } = await import(
  pathToFileURL(join(hosts, "node_modules/@opencode/client/dist/promise/index.js")).href
);
const root = await mkdtemp(join(tmpdir(), "stm-windows-config-sweep-"));
const results: any[] = [];
const artifact = {
  path: candidate,
  sha256: createHash("sha256")
    .update(await readFile(candidate))
    .digest("hex"),
};
const libraryProof: Record<string, string> = {};
for (const relative of ["package.json", "dist/index.js", "dist/tui.js", "dist/rpc.js"]) {
  const packed = await new Promise<Buffer>((done, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn("tar", ["-xOf", candidate, `package/${relative}`], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? done(Buffer.concat(chunks)) : reject(new Error("Candidate verification failed")),
    );
  });
  const installed = await readFile(join(seed, "node_modules/@atonev/opencode-short-term-memory", relative));
  assert.deepEqual(installed, packed, `Prepared library differs from candidate: ${relative}`);
  libraryProof[relative] = createHash("sha256").update(installed).digest("hex");
}
console.log(JSON.stringify({ root, artifact }));
async function save() {
  await writeFile(join(root, "result.json"), JSON.stringify({ artifact, results, externalInference: false }, null, 2));
}
async function wait(check: () => any, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error("deadline exceeded");
}
async function files(items: readonly { path: string; content: string | null }[]) {
  for (const item of items) {
    await mkdir(dirname(item.path), { recursive: true });
    if (item.content === null) await rm(item.path, { force: true });
    else await writeFile(item.path, item.content);
  }
}

for (const generation of ["v1", "v2"] as const)
  for (const id of CONFIG_SCENARIO_IDS) {
    if (selection.length && !selection.includes(`${generation}:${id}`)) continue;
    const caseRoot = join(root, `${generation}-${id}`);
    await mkdir(caseRoot, { recursive: true });
    const env: Record<string, string> = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
      if (process.env[key]) env[key] = process.env[key]!;
    for (const key of [
      "HOME",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "BUN_INSTALL_CACHE_DIR",
    ]) {
      env[key] = join(caseRoot, key.toLowerCase());
      await mkdir(env[key], { recursive: true });
    }
    env.USERPROFILE = env.HOME;
    // Cache only immutable registry response/package bytes, never user config,
    // credentials, databases or memories. Native V1 uses npm's cache here.
    if (generation === "v1" && process.env.STM_TEST_NPM_CACHE_SEED) {
      await cp(
        toNamespacedPath(join(process.env.STM_TEST_NPM_CACHE_SEED, "localappdata/npm-cache/_cacache")),
        toNamespacedPath(join(env.LOCALAPPDATA, "npm-cache/_cacache")),
        { recursive: true },
      );
      env.npm_config_prefer_offline = "true";
    }
    env.npm_config_maxsockets = "2";
    // Persistent host streams and callback RPCs need independent HTTP slots.
    // Resource limits belong to the case supervisor, not Bun's runtime pool.
    const token = randomUUID();
    Object.assign(env, {
      OPENCODE_TEST_HOME: env.HOME,
      OPENCODE_DB: join(caseRoot, "host.db"),
      OPENCODE_SERVER_PASSWORD: token,
      OPENCODE_PASSWORD: token,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
      OPENCODE_DISABLE_FFF: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    });
    const project = join(caseRoot, "project");
    const scenario = buildConfigScenario(
      id,
      {
        globalConfigDirectory: join(env.XDG_CONFIG_HOME, "opencode"),
        legacyGlobalDirectory: join(env.HOME, ".opencode"),
        environmentConfigDirectory: join(caseRoot, "env-config"),
        projectDirectory: project,
        memoryDirectory: join(caseRoot, "memories"),
      },
      generation,
    );
    for (const path of scenario.directoriesToCreate) await mkdir(path, { recursive: true });
    await files(scenario.plannedFiles);
    if (scenario.environmentConfigDir) env.OPENCODE_CONFIG_DIR = scenario.environmentConfigDir;
    await new Promise<void>((done, reject) => {
      const p = spawn("git", ["init", "--quiet"], { cwd: project, env, windowsHide: true });
      p.once("error", reject);
      p.once("exit", (code) => (code === 0 ? done() : reject(new Error("git init failed"))));
    });
    const requests: any[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (requests.length >= 12)
          return Response.json({ error: { message: "Settings probe request limit reached" } }, { status: 400 });
        const body = (await req.json()) as any;
        const summary = body.messages.some(
          (m: any) => m.role === "user" && JSON.stringify(m.content).includes("<conversation_update>"),
        );
        const lastUser = body.messages.findLastIndex((m: any) => m.role === "user");
        const hasTool = body.messages.slice(lastUser + 1).some((m: any) => m.role === "tool");
        requests.push({ summary, tools: body.tools?.map((t: any) => t.function?.name) ?? [], messages: body.messages });
        const text = summary
          ? "## Session Memory\n\n### User Instructions\n- Preserve the configuration test.\n\n### Long Horizon Context\n- None captured yet.\n\n### Decisions\n- None captured yet.\n\n### Conclusions\n- None captured yet.\n\n### Active References\n- None captured yet."
          : "SETTINGS_DONE";
        const message =
          summary || hasTool
            ? { role: "assistant", content: text }
            : {
                role: "assistant",
                tool_calls: [
                  { id: "call_settings", type: "function", function: { name: "stm_memory_settings", arguments: "{}" } },
                ],
              };
        const finish = "tool_calls" in message ? "tool_calls" : "stop";
        if (!body.stream)
          return Response.json({
            id: randomUUID(),
            object: "chat.completion",
            choices: [{ index: 0, message, finish_reason: finish }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        const delta: any = { ...message };
        if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((t: any, index: number) => ({ index, ...t }));
        return new Response(
          [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
          ]
            .map((x) => `data: ${JSON.stringify({ id: "settings", object: "chat.completion.chunk", ...x })}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const baseURL = `http://127.0.0.1:${provider.port}/v1`;
    const spec = `@atonev/opencode-short-term-memory@file:${candidate}`;
    const entry = pathToFileURL(join(seed, "node_modules/@atonev/opencode-short-term-memory/dist/index.js")).href;
    // Independent copies of package cache bytes only, never settings or runtime data.
    if (generation === "v2") {
      if (process.env.STM_TEST_SHARED_LIBRARIES === "1") {
        // Settings probes use only immutable installed library bytes from the
        // verified seed, just as V1's file entrypoint does. Npm metadata, config,
        // credentials, databases and memories remain local to this case.
        const generationRoot = join(env.XDG_CACHE_HOME, "opencode/npm", await Npm.cacheKey(spec), String(Date.now()));
        await mkdir(generationRoot, { recursive: true });
        await writeFile(
          join(generationRoot, "package.json"),
          JSON.stringify({
            private: true,
            dependencies: { "@atonev/opencode-short-term-memory": `file:${candidate}` },
          }),
        );
        await symlink(join(seed, "node_modules"), join(generationRoot, "node_modules"), "junction");
      } else
        await cp(
          toNamespacedPath(join(seed, "xdg_cache_home/opencode/npm")),
          toNamespacedPath(join(env.XDG_CACHE_HOME, "opencode/npm")),
          {
            recursive: true,
            dereference: true,
          },
        );
    }
    const config: any =
      generation === "v1"
        ? {
            plugin: [entry],
            model: "stm-probe/deterministic",
            small_model: "stm-probe/deterministic",
            provider: {
              "stm-probe": {
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL, apiKey: "local-only" },
                models: { deterministic: { name: "deterministic", limit: { context: 128000, output: 4096 } } },
              },
            },
            permission: { "*": "deny", stm_memory_settings: "allow" },
          }
        : {
            plugins: [spec],
            model: "stm-probe/deterministic",
            update: "disable",
            providers: {
              "stm-probe": {
                env: [],
                package: "aisdk:@ai-sdk/openai-compatible",
                settings: { baseURL, apiKey: "local-only" },
                models: { deterministic: { name: "deterministic" } },
              },
            },
          };
    const hostConfigDir = join(env.XDG_CONFIG_HOME, "opencode");
    await mkdir(hostConfigDir, { recursive: true });
    if (installRoute) {
      const sourceRoot = resolve(import.meta.dir, "..");
      const target =
        installRoute === "candidate"
          ? spec
          : installRoute === "source-root"
            ? sourceRoot
            : installRoute === "source-file"
              ? pathToFileURL(join(sourceRoot, "src/index.ts")).href
              : installRoute === "bare-tar"
                ? candidate
                : installRoute === "package-dir"
                  ? join(seed, "node_modules/@atonev/opencode-short-term-memory")
                  : join(caseRoot, "nonexistent-plugin.ts");
      const key = generation === "v1" ? "plugin" : "plugins";
      config[key] = installScope === "global" ? [target] : [];
      if (installScope === "project")
        await writeFile(join(project, "opencode.json"), JSON.stringify({ [key]: [target] }));
    }
    await writeFile(join(hostConfigDir, "opencode.json"), JSON.stringify(config));
    // V2 uses OPENCODE_CONFIG_DIR as its host config root when supplied. Keep
    // provider/plugin wiring there; STM's separate layer fixtures stay intact.
    if (generation === "v2" && env.OPENCODE_CONFIG_DIR) {
      await writeFile(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify(config));
    }
    const native =
      generation === "v1"
        ? join(homedir(), ".bun/install/global/node_modules/opencode-ai/bin/opencode.exe")
        : join(hosts, "node_modules/@opencode/cli-windows-x64/bin/opencode.exe");
    let log = "",
      url = "",
      host: any,
      client: any;
    const record: any = {
      generation,
      id,
      installRoute,
      installScope,
      caseRoot,
      packageCacheSeed: seed,
      sharedImmutableLibraries: process.env.STM_TEST_SHARED_LIBRARIES === "1",
      libraryProof,
      probes: [],
      verdict: "FAIL",
    };
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": scenario.launchDirectory,
      Authorization: `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}`,
    };
    async function api(path: string, body?: any) {
      const res = await fetch(url + path, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(180000),
      });
      const data = await res.json();
      assert.ok(res.ok, JSON.stringify(data));
      return data as any;
    }
    async function probe(expected: any, phase: string) {
      const session =
        generation === "v1"
          ? await api("/session", { title: `settings ${id}` })
          : await client.session.create(
              {
                title: `settings ${id}`,
                agent: "build",
                model: { providerID: "stm-probe", id: "deterministic" },
                location: { directory: scenario.launchDirectory },
              },
              { signal: AbortSignal.timeout(180000) },
            );
      let rows: any[];
      if (generation === "v1") {
        await api(`/session/${session.id}/message`, {
          model: { providerID: "stm-probe", modelID: "deterministic" },
          parts: [{ type: "text", text: "SWEEP_SETTINGS" }],
        });
        rows = await api(`/session/${session.id}/message`);
      } else {
        await client.session.prompt({ sessionID: session.id, text: "SWEEP_SETTINGS" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(180000) });
        rows = await client.session.context({ sessionID: session.id });
      }
      await writeFile(join(caseRoot, `${phase}-history.json`), JSON.stringify(rows, null, 2));
      const parts = rows
        .flatMap((row: any) => row.parts ?? row.content ?? [])
        .filter((p: any) => p.type === "tool" && (p.tool ?? p.name) === "stm_memory_settings");
      assert.equal(parts.length, 1, "one durable settings invocation");
      assert.equal(parts[0].state.status, "completed");
      const raw =
        generation === "v1"
          ? parts[0].state.output
          : parts[0].state.content
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("");
      const actual = JSON.parse(raw);
      const resolved = generation === "v1" ? actual : actual.resolvedConfig;
      record.probes.push({ phase, actual, expected });
      for (const key of Object.keys(KNOWN_DEFAULT_CONFIG17))
        assert.deepEqual(resolved[key], expected[key], `${generation}/${id}/${phase}/${key}`);
      const metadata = expectedSettingsMetadata(generation, expected);
      assert.equal(
        generation === "v1" ? actual.memoryModelSelection : actual.effective.memoryModelSelection,
        metadata.memoryModelSelection,
      );
    }
    try {
      host = spawn(native, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
        cwd: scenario.launchDirectory,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [host.stdout, host.stderr])
        stream.on("data", (x: any) => {
          log += x.toString();
          void writeFile(join(caseRoot, "host.log"), log);
        });
      await wait(() => {
        assert.equal(host.exitCode, null, log.slice(-1000));
        url = log.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? "";
        return url;
      });
      client = OpenCode.make({ baseUrl: url, headers });
      record.hostVersion =
        generation === "v1" ? (await api("/global/health")).version : (await client.server.info()).version;
      const negative =
        generation === "v2" && ["source-file", "bare-tar", "package-dir", "missing"].includes(installRoute ?? "");
      if (negative) {
        const location = { directory: project };
        const commands = await client.command.list({ location });
        const plugins = await client.plugin.list({ location });
        record.inventory = { commands, plugins };
        assert.equal(
          commands.data.some((c: any) => c.name === "stm"),
          false,
          "invalid installation must not expose STM commands",
        );
        assert.equal(
          plugins.data.some((p: any) => p.id === "opencode-short-term-memory" && p.state.status === "active"),
          false,
        );
        record.expectedRejection = true;
      } else await probe(scenario.expectedConfig17, "initial");
      if (scenario.hotReload) {
        await files(scenario.hotReload.mutationFiles);
        await probe(scenario.hotReload.immediateByGeneration[generation], "immediate");
        const delay = scenario.hotReload.waitMsByGeneration[generation];
        if (delay) {
          console.log(JSON.stringify({ generation, id, event: "waiting-for-config-cache-expiry", ms: delay }));
          await Bun.sleep(delay);
        }
        await probe(scenario.hotReload.expectedAfterEdit17, "after-reload");
      }
      record.verdict = "PASS";
    } catch (error) {
      record.error = String(error);
    } finally {
      if (host) {
        host.kill();
        await wait(() => host.exitCode !== null || host.signalCode !== null, 10000).catch(() => {});
      }
      provider.stop(true);
      record.hostExited = !host || host.exitCode !== null || host.signalCode !== null;
      for (const [relative, expected] of Object.entries(libraryProof)) {
        const bytes = await readFile(join(seed, "node_modules/@atonev/opencode-short-term-memory", relative));
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          expected,
          `Case changed library bytes: ${relative}`,
        );
      }
      await writeFile(join(caseRoot, "requests.json"), JSON.stringify(requests, null, 2));
      await writeFile(join(caseRoot, "evidence.json"), JSON.stringify(record, null, 2));
      results.push(record);
      await save();
      console.log(JSON.stringify({ generation, id, verdict: record.verdict, error: record.error, root: caseRoot }));
    }
  }
if (results.some((r) => r.verdict !== "PASS")) process.exitCode = 1;
