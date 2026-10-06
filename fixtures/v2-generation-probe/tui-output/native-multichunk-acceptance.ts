import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Host } from "@opencode/plugin/host";
import { redactDiagnostic, serializeEvidence, serializeFailure } from "../diagnostic-redaction.js";
import { memoryUpdateResponse, PROBE_MODEL_ID, PROBE_PROVIDER_ID } from "../index.js";
import { parseProbeTelemetryJsonl } from "../evaluator.js";
import {
  dialogRows,
  fileState,
  tuiReadiness,
  verifyImportedPage,
  verifySessionBaseline,
} from "./production-acceptance.js";

const parent = "/home/dev/workspace/opencode-work/opencode-short-term-memory-v2-forced-update";
const fixture = fileURLToPath(new URL("../", import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const inside = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
};

// Explicit invocation only: bun fixtures/v2-generation-probe/tui-output/native-multichunk-acceptance.ts /absolute/package.tgz
export async function runNativeMultichunkAcceptance(tarball: string) {
  const started = Date.now();
  const deadline = started + 110_000;
  assert.ok((await stat(parent)).isDirectory(), "Acceptance sandbox parent must already exist");
  const sandbox = await mkdtemp(join(parent, "native-multichunk-"));
  const project = join(sandbox, "consumer");
  const memoryDir = join(sandbox, "memory");
  const runId = crypto.randomUUID();
  const socket = join("/tmp/opencode", `stm-${runId}.sock`);
  const failures: unknown[] = [];
  const commands: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = {
    runId,
    started: new Date(started).toISOString(),
    sandbox,
    socket,
    commands,
    limits: { internalMs: 110_000, installMs: 60_000, commandMs: 15_000, proposedOuterMs: 125_000 },
    product:
      "Adapter-mediated unmodified production-only tarball consumer; harness-owned directory with default-only re-exports of exact installed role file URLs, not direct package bootstrap; no host npm generation seeding or checkout symlinks",
    provider: "Existing source fixture stm-probe/deterministic; provider is fixture-backed, product is installed",
    trigger: "Exactly one native session.command({sessionID,name:'stm',text:'update'}), real connected tmux TUI",
    automaticContextSuppressed: false,
    paidInference: false,
    globalBudgetChanged: false,
    retained: true,
    verdict: "fail",
  };
  const runtime = await realpath(process.execPath);
  const env: Record<string, string> = {
    PATH: `${dirname(runtime)}:/usr/bin:/bin`,
    HOME: join(sandbox, "home"),
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"),
    XDG_RUNTIME_DIR: join(sandbox, "runtime"),
    TMPDIR: join(sandbox, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(sandbox, "bun-cache"),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_LOG_LEVEL: "DEBUG",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_PASSWORD: crypto.randomUUID(),
    PROBE_RUN_ID: runId,
    PROBE_MODE: "ordinary",
    PROBE_SCENARIO: "ordinary",
    PROBE_MEMORY_DIR: memoryDir,
    PROBE_TELEMETRY_PATH: join(sandbox, "telemetry.jsonl"),
  };
  const secrets = [env.OPENCODE_PASSWORD!, Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString("base64")];
  const save = (name: string, value: unknown) =>
    writeFile(join(sandbox, name), serializeEvidence(value, secrets) + "\n");
  const saveText = (name: string, value: string) => writeFile(join(sandbox, name), redactDiagnostic(value, secrets));
  let phase = "prepare";
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let serverOutput = "",
    serverErrors = "";
  let drain: Promise<unknown> = Promise.resolve();
  let tuiStarted = false;
  let client: OpenCodeClient | undefined;
  let sessionID: string | undefined;
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const watchdog = setTimeout(
    () => {
      failures.push({ phase, error: "110s internal deadline expired" });
      for (const child of children) child.kill("SIGKILL");
      server?.kill("SIGTERM");
    },
    110_000 - (Date.now() - started),
  );
  const signal = (ms = 3_000) => {
    const remaining = deadline - Date.now() - 8_000;
    assert.ok(remaining > 0, "Overall deadline reached (cleanup reserve)");
    return AbortSignal.timeout(Math.min(ms, remaining));
  };
  const command = async (args: string[], ms: number, cleanup = false) => {
    const remaining = deadline - Date.now() - (cleanup ? 0 : 8_000);
    assert.ok(remaining > 0, "Command deadline reached");
    const timeoutMs = Math.min(ms, remaining);
    const record: Record<string, unknown> = { args, phase, started: new Date().toISOString(), timeoutMs };
    commands.push(record);
    const child = Bun.spawn(["/usr/bin/timeout", "--kill-after=1s", `${timeoutMs / 1_000}s`, ...args], {
      cwd: project,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.add(child);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      Object.assign(record, { code, finished: new Date().toISOString(), stdout, stderr });
      assert.equal(code, 0, `${args[0]} exited ${code}: ${redactDiagnostic(stderr, secrets)}`);
      return stdout;
    } catch (error) {
      record.error = serializeFailure(error, secrets);
      throw error;
    } finally {
      children.delete(child);
    }
  };
  const terminal = (args: string[], cleanup = false) =>
    command(["/usr/bin/tmux", "-S", socket, "-f", "/dev/null", ...args], 2_000, cleanup);
  const capture = () => terminal(["capture-pane", "-p", "-t", "update:0.0"]);
  const wait = async (ms: number, check: () => Promise<boolean>, message: string) => {
    const until = Math.min(Date.now() + ms, deadline - 8_000);
    do {
      if (await check()) return;
      await pause(50);
    } while (Date.now() < until);
    throw new Error(message);
  };
  const readOptional = async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  try {
    assert.ok((await stat(dirname(socket))).isDirectory(), "Tmux socket parent must already exist");
    assert.ok(Buffer.byteLength(socket) <= 100, "Tmux socket path must not exceed 100 bytes");
    await mkdir(project);
    const directories = Object.entries(env).filter(
      ([key]) => key === "HOME" || key.startsWith("XDG_") || key === "TMPDIR" || key === "BUN_INSTALL_CACHE_DIR",
    );
    evidence.initialDirectories = [];
    for (const [, path] of directories) {
      await mkdir(path);
      const entries = await readdir(path);
      assert.equal(entries.length, 0, "Isolation directory was not empty");
      (evidence.initialDirectories as unknown[]).push({ path, entries });
    }
    assert.ok(tarball && isAbsolute(tarball), "Supply exactly one absolute tarball path");
    const source = await realpath(tarball);
    assert.ok((await stat(source)).isFile(), "Tarball must be a regular file");
    const artifact = join(sandbox, "product.tgz");
    await cp(source, artifact);
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const sha256 = hash(await readFile(source));
    assert.equal(hash(await readFile(artifact)), sha256, "Retained artifact hash differs");
    evidence.artifact = { source, copy: artifact, sha256 };
    const manifest = JSON.parse(await command(["/usr/bin/tar", "-xOf", artifact, "package/package.json"], 2_000));
    assert.equal(manifest.name, "@atonev/opencode-short-term-memory");
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies: { [manifest.name]: `file:${artifact}` } }),
    );
    phase = "production-install";
    evidence.installPolicy =
      "Production consumer install with normal Bun lifecycle/trust policy; no --ignore-scripts or trustedDependencies override. Scripts run only when permitted by Bun's default trust policy.";
    await command([runtime, "install", "--production"], 60_000);
    phase = "installed-path-proof";
    const physical = async (path: string) => {
      const value = await realpath(path);
      assert.ok(inside(project, value), `Installed path escapes consumer: ${path}`);
      return value;
    };
    const packageDir = await physical(join(project, "node_modules", manifest.name));
    const installed = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    assert.equal(installed.name, manifest.name);
    assert.equal(installed.version, manifest.version);
    // Check every link, including transitive dependencies; normal Bun hardlinks remain consumer paths.
    let checkedLinks = 0;
    const checkLinks = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          await physical(path);
          checkedLinks++;
        } else if (entry.isDirectory()) await checkLinks(path);
      }
    };
    await checkLinks(join(project, "node_modules"));
    const dependencies = [];
    for (const name of Object.keys(installed.dependencies ?? {})) {
      if (name.startsWith("@types/")) {
        dependencies.push({ name, physical: await physical(join(project, "node_modules", name)), runtime: false });
      } else dependencies.push({ name, physical: await physical(Bun.resolveSync(name, packageDir)), runtime: true });
    }
    const entries = Host.resolve({ directory: project, name: manifest.name });
    const rootEntry = await physical(Bun.resolveSync(manifest.name, project));
    assert.ok(inside(packageDir, rootEntry), "Root export escapes installed package");
    for (const role of ["server", "tui", "rpc"] as const) {
      assert.ok(entries[role], `Missing installed ${role} export`);
      assert.ok(inside(packageDir, await physical(fileURLToPath(entries[role]!))), `${role} export escapes package`);
      await Host.load(entries[role]!);
    }
    evidence.installed = { packageDir, version: installed.version, rootEntry, entries, dependencies, checkedLinks };
    const productBefore = await fileState([packageDir]);
    const adapter = join(project, "stm-loader-adapter");
    await mkdir(adapter);
    assert.equal(await realpath(adapter), adapter, "Adapter directory must be physical");
    const adapterManifest = { path: join(adapter, "package.json"), contents: '{"type":"module"}\n' };
    await writeFile(adapterManifest.path, adapterManifest.contents);
    const adapterFiles = {} as Record<
      "server" | "tui" | "rpc",
      { path: string; contents: string; installedURL: string; installedRealpath: string }
    >;
    for (const role of ["server", "tui", "rpc"] as const) {
      const installedURL = entries[role]!;
      const path = join(adapter, `${role}.js`);
      const contents = `export { default } from ${JSON.stringify(installedURL)};\n`;
      await writeFile(path, contents);
      adapterFiles[role] = {
        path,
        contents,
        installedURL,
        installedRealpath: await physical(fileURLToPath(installedURL)),
      };
    }
    const adapterEntries = Host.resolve({ directory: adapter });
    for (const role of ["server", "tui", "rpc"] as const) {
      assert.ok(adapterEntries[role], `Missing adapter ${role} entrypoint`);
      assert.equal(fileURLToPath(adapterEntries[role]!), adapterFiles[role].path);
      assert.equal(await realpath(adapterFiles[role].path), adapterFiles[role].path);
      assert.equal(await readFile(adapterFiles[role].path, "utf8"), adapterFiles[role].contents);
    }
    evidence.loader = {
      sources: [
        "@opencode/plugin/dist/host.js",
        "@opencode/plugin/dist/source.js",
        "@opencode/plugin/dist/source.bun.js",
      ],
      rationale:
        "Pinned host rejects configured file paths and resolves local directory roles via Host.resolve. Both configs reference the same physical harness-owned adapter directory. Each adapter role only re-exports the default from its exact installed role file URL; installed product modules and RPC registration remain unmodified. This is adapter-mediated installed product acceptance, not direct package bootstrap.",
      configuredDirectory: adapter,
      manifest: { ...adapterManifest, realpath: await realpath(adapterManifest.path) },
      files: adapterFiles,
      entries: adapterEntries,
      server: adapterFiles.server.path,
      tui: adapterFiles.tui.path,
      rpc: adapterFiles.rpc.path,
    };
    const config = join(env.XDG_CONFIG_HOME!, "opencode");
    await mkdir(config);
    await writeFile(join(config, "opencode.json"), JSON.stringify({ plugins: [fixture, adapter], update: "disable" }));
    await writeFile(
      join(config, "cli.json"),
      JSON.stringify({
        plugins: [adapter],
        animations: false,
        mouse: false,
        attention: { notifications: false, sound: false },
        tabs: { enabled: false },
      }),
    );
    await writeFile(
      join(config, "stm.jsonc"),
      JSON.stringify({
        enabled: true,
        memoryDir,
        summarizerMode: "clean",
        maxDeltaMessages: 20,
        maxUpdateInputLength: 20_000,
      }),
    );
    const binary = await realpath(join(fixture, "node_modules/@opencode/cli-linux-x64/bin/opencode"));
    phase = "host-version";
    const versionOutput = await command([binary, "--version"], 3_000);
    const version = "2.0.12";
    evidence.host = { binary, version, versionOutput, runtime, bunVersion: Bun.version };
    assert.ok(
      [version, `opencode v${version}`].includes(versionOutput.trim()),
      "Host version output must be 2.0.12 or opencode v2.0.12",
    );
    phase = "server-start";
    server = Bun.spawn(
      ["/usr/bin/timeout", "--kill-after=2s", "100s", binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
      { cwd: project, env, stdout: "pipe", stderr: "pipe" },
    );
    const consume = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
      append(decoder.decode());
    };
    drain = Promise.all([
      consume(server.stdout as ReadableStream<Uint8Array>, (text) => {
        serverOutput += text;
      }),
      consume(server.stderr as ReadableStream<Uint8Array>, (text) => {
        serverErrors += text;
      }),
    ]).catch((error) => failures.push({ phase: "server-drain", error: serializeFailure(error, secrets) }));
    await wait(
      8_000,
      async () => {
        assert.equal(server!.exitCode, null, "Server exited during startup");
        return /server listening on (http:\/\/127\.0\.0\.1:\d+)/.test(serverOutput);
      },
      "Server startup missing within 8s",
    );
    const endpoint = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serverOutput)![1]!;
    evidence.endpoint = endpoint;
    client = OpenCode.make({ baseUrl: endpoint, headers: { Authorization: `Basic ${secrets[1]}` } });
    assert.equal((await client.server.info({ signal: signal() })).version, version);
    phase = "inventory";
    await wait(
      5_000,
      async () => {
        const plugins = await client!.plugin.list({ location: { directory: project } }, { signal: signal() });
        const inventory = await client!.command.list({ location: { directory: project } }, { signal: signal() });
        evidence.inventory = { plugins, commands: inventory };
        const product = plugins.data.find(
          (item) => item.source.type === "local" && item.source.path === adapterFiles.server.path,
        );
        if (product?.state.status === "failed") throw new Error("Installed STM plugin failed");
        return product?.state.status === "active" && inventory.data.some((item) => item.name === "stm");
      },
      "Installed local STM command inventory missing",
    );
    phase = "settled-import";
    const created = await client.session.create(
      { title: "STM transfer schema seed", location: { directory: project } },
      { signal: signal() },
    );
    const baseline = await client.session.export({ sessionID: created.id }, { signal: signal() });
    assert.equal(baseline.messages.length, 0);
    assert.equal(baseline.info.cost, 0);
    const model = { providerID: PROBE_PROVIDER_ID, id: PROBE_MODEL_ID };
    const messages: Array<Parameters<OpenCodeClient["session"]["import"]>[0]["messages"][number]> = [];
    const transfer: Parameters<OpenCodeClient["session"]["import"]>[0] = {
      info: {
        ...baseline.info,
        id: `ses_stm_multichunk_${runId.replaceAll("-", "")}`,
        title: "STM native multi-chunk acceptance",
        agent: "build",
        model,
      },
      location: { directory: project },
      messages,
    };
    for (let index = 0; index < 60; index++) {
      const id = `msg_stm_${runId.replaceAll("-", "")}_${index}`;
      const time = baseline.info.time.created + index * 3;
      messages.push(
        index % 2 === 0
          ? { id, type: "user", time: { created: time }, text: `Settled imported user record ${index / 2 + 1}.` }
          : {
              id,
              type: "assistant",
              agent: "build",
              model,
              time: { created: time, completed: time + 1 },
              finish: "stop",
              content: [
                {
                  type: "text",
                  text: `Settled imported assistant record ${(index + 1) / 2}.${index === 59 ? ` ${transfer.info.title}` : ""}`,
                },
              ],
              cost: 0,
              tokens: baseline.info.tokens,
            },
      );
    }
    await save("import-transfer.json", transfer);
    const imported = await client.session.import(transfer, { signal: signal() });
    sessionID = imported.id;
    assert.equal(sessionID, transfer.info.id);
    const observe = async () => ({
      exported: await client!.session.export({ sessionID: sessionID! }, { signal: signal() }),
      context: await client!.session.context({ sessionID: sessionID! }, { signal: signal() }),
      page: await client!.message.list(
        { sessionID: sessionID!, limit: transfer.messages.length },
        { signal: signal() },
      ),
      session: await client!.session.get({ sessionID: sessionID! }, { signal: signal() }),
    });
    const before = await observe();
    assert.ok(isDeepStrictEqual(before.exported.messages, transfer.messages), "Export differs from transfer");
    assert.ok(isDeepStrictEqual(before.context, transfer.messages), "Durable context differs from transfer");
    const expectedPage = verifyImportedPage(transfer, before.page, before.session);
    await save("before-session.json", before);
    evidence.usageBefore = { cost: before.session.cost, ...before.session.tokens };
    const paths = {
      memory: join(memoryDir, `session_${sessionID}.md`),
      checkpoint: join(memoryDir, "checkpoints", `${sessionID}.last-message-id.txt`),
      log: join(memoryDir, "session-memory.log"),
    };
    evidence.paths = paths;
    const telemetry = async () =>
      parseProbeTelemetryJsonl((await readOptional(env.PROBE_TELEMETRY_PATH!)) ?? "", { runId, mode: "ordinary" });
    const noPrecommit = async () => {
      const state = {
        memory: await readOptional(paths.memory),
        checkpoint: await readOptional(paths.checkpoint),
        telemetry: await telemetry(),
        log: await readOptional(paths.log),
      };
      evidence.precommand = state;
      assert.equal(state.memory, null, "Memory exists before native command");
      assert.equal(state.checkpoint, null, "Checkpoint exists before native command");
      assert.ok(
        !state.telemetry.some((record) => record.event === "model.invocation"),
        "Model invoked before native command",
      );
      assert.ok(!state.log?.includes("v2_memory_update_committed"), "Automatic precommit detected");
    };
    await noPrecommit();
    phase = "tui-start";
    const tuiCommand = [
      "/usr/bin/timeout",
      "--kill-after=1s",
      "40s",
      binary,
      "--server",
      endpoint,
      "--session",
      sessionID,
    ]
      .map(quote)
      .join(" ");
    await terminal(["new-session", "-d", "-s", "update", "-x", "160", "-y", "100", "-c", project, tuiCommand]);
    tuiStarted = true;
    const hostLogPath = join(env.XDG_DATA_HOME!, "opencode/log/opencode.log");
    phase = "tui-readiness";
    await wait(
      8_000,
      async () => {
        const readiness = tuiReadiness((await readOptional(hostLogPath)) ?? "", adapter);
        if (!readiness) return false;
        evidence.tuiReadiness = readiness;
        const screen = await capture();
        if (!screen.includes(transfer.info.title!) && !screen.includes("Ask anything")) return false;
        await saveText("route-screen.txt", screen);
        return true;
      },
      "Installed TUI setup/event connection/session route not witnessed within 8s",
    );
    const precommand = await observe();
    verifySessionBaseline(precommand.page, precommand.session, imported, expectedPage);
    assert.ok(
      isDeepStrictEqual(precommand.exported.messages, transfer.messages),
      "Pre-command exported records changed",
    );
    assert.ok(isDeepStrictEqual(precommand.context, transfer.messages), "Pre-command durable context changed");
    await save("precommand-session.json", precommand);
    await noPrecommit();
    phase = "native-update";
    evidence.commandStarted = new Date().toISOString();
    await client.session.command({ sessionID, name: "stm", text: "update" }, { signal: signal(15_000) });
    evidence.commandFinished = new Date().toISOString();
    const progress = { checkpointedChunks: 3, checkpointedMessages: 60, persistedPartialFragments: 0 };
    const lines = [
      "generation: v2",
      `sessionID: ${sessionID}`,
      "update: committed",
      "reason: delta_exhausted",
      "source: durable-visible-text",
      `progress: cumulative-invocation ${JSON.stringify(progress)}`,
      "rollback: not-applicable",
      "detail: none",
    ];
    phase = "rendered-dialog";
    await wait(
      3_000,
      async () => {
        const screen = await capture();
        await saveText("update-screen.txt", screen);
        const rows = screen.split(/\r?\n/);
        const title = rows.map((row) => /STM update[ \t]+esc[ \t]*$/.exec(row)).find(Boolean);
        if (!title) return false;
        return dialogRows(rows.map((row) => row.slice(title.index)).join("\n"), "STM update", lines);
      },
      "Exact native committed multi-chunk dialog not rendered",
    );
    evidence.rendered = { title: "STM update", lines, progress, screen: "update-screen.txt" };
    phase = "commit-oracles";
    const memory = await readFile(paths.memory, "utf8");
    const checkpoint = await readFile(paths.checkpoint, "utf8");
    const logText = await readFile(paths.log, "utf8");
    evidence.persisted = {
      memoryBytesBase64: Buffer.from(memory).toString("base64"),
      checkpointBytesBase64: Buffer.from(checkpoint).toString("base64"),
      logText,
    };
    await saveText("committed-memory.md", memory);
    await saveText("committed-checkpoint.txt", checkpoint);
    assert.equal(checkpoint, `${transfer.messages.at(-1)!.id}\n`);
    for (const heading of [
      "## Session Memory",
      "### User Instructions",
      "### Long Horizon Context",
      "### Decisions",
      "### Conclusions",
      "### Active References",
    ])
      assert.ok(memory.includes(heading), `Missing ${heading}`);
    assert.ok(memory.includes(`STM_PROBE_MEMORY_SENTINEL:${runId}`));
    assert.ok(!/<\/?(?:existing_memory|conversation_update|agents_md_context)>/i.test(memory));
    const commits = logText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.event === "v2_memory_update_committed" && row.sessionID === sessionID);
    assert.deepEqual(
      commits.map((row) => row.checkpointID),
      [19, 39, 59].map((index) => transfer.messages[index]!.id),
    );
    const records = await telemetry();
    const invocations = records.filter((record) => record.event === "model.invocation");
    assert.equal(invocations.length, 3, "Expected exactly one deterministic memory generation per chunk");
    assert.ok(
      invocations.every(
        (record) =>
          record.provider === PROBE_PROVIDER_ID &&
          record.model === PROBE_MODEL_ID &&
          record.sentinel === memoryUpdateResponse(runId) &&
          Date.parse(record.timestamp) >= Date.parse(evidence.commandStarted as string),
      ),
      "Non-memory or pre-command generation detected",
    );
    evidence.commit = {
      checkpoint,
      memory,
      memoryBytesBase64: Buffer.from(memory).toString("base64"),
      checkpointBytesBase64: Buffer.from(checkpoint).toString("base64"),
      commits,
      logText,
      records,
    };
    phase = "durable-after";
    const after = await observe();
    verifySessionBaseline(after.page, after.session, imported, expectedPage);
    assert.ok(isDeepStrictEqual(after.exported.messages, transfer.messages), "Durable exported records changed");
    assert.ok(isDeepStrictEqual(after.context, transfer.messages), "Durable context changed");
    assert.ok(isDeepStrictEqual(productBefore, await fileState([packageDir])), "Installed product bytes changed");
    await save("after-session.json", after);
    evidence.usageAfter = { cost: after.session.cost, ...after.session.tokens };
    evidence.costConsumed = 0;
    evidence.durableRecordsUnchanged = true;
    await terminal(["send-keys", "-t", "update:0.0", "Escape"]);
    evidence.acceptanceComplete = true;
  } catch (error) {
    failures.push({ phase, error: serializeFailure(error, secrets) });
    if (tuiStarted)
      try {
        await saveText("failure-screen.txt", await capture());
      } catch (error) {
        failures.push({ phase: "failure-screen", error: serializeFailure(error, secrets) });
      }
  } finally {
    phase = "cleanup";
    if (tuiStarted) {
      try {
        await terminal(["send-keys", "-t", "update:0.0", "Escape"], true);
      } catch (error) {
        evidence.escapeCleanupError = serializeFailure(error, secrets);
      }
      try {
        await terminal(["kill-server"], true);
        tuiStarted = false;
      } catch (error) {
        failures.push({ phase: "tui-cleanup", error: serializeFailure(error, secrets) });
      }
    }
    evidence.tuiStopped = !tuiStarted;
    if (server) {
      server.kill("SIGTERM");
      const grace = setTimeout(() => server?.kill("SIGKILL"), 2_000);
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await server.exited;
        evidence.serverExit = server.exitCode;
        await Promise.race([
          drain,
          new Promise<never>((_, reject) => {
            drainTimer = setTimeout(() => reject(new Error("Server output drain exceeded 1s cleanup bound")), 1_000);
          }),
        ]);
      } catch (error) {
        failures.push({ phase: "server-cleanup", error: serializeFailure(error, secrets) });
      } finally {
        clearTimeout(grace);
        clearTimeout(drainTimer);
      }
    }
    try {
      await rm(socket, { force: true });
      evidence.socketRemoved = true;
    } catch (error) {
      failures.push({ phase: "socket-cleanup", error: serializeFailure(error, secrets) });
    }
    for (const [name, path] of [
      ["provider-telemetry.jsonl", env.PROBE_TELEMETRY_PATH!],
      ["host.log", join(env.XDG_DATA_HOME!, "opencode/log/opencode.log")],
    ] as const) {
      try {
        const text = await readOptional(path);
        if (text !== null) await saveText(name, text);
      } catch (error) {
        failures.push({ phase: "cleanup-evidence", error: serializeFailure(error, secrets) });
      }
    }
    clearTimeout(watchdog);
    await saveText("server.stdout.txt", serverOutput);
    await saveText("server.stderr.txt", serverErrors);
    evidence.finished = new Date().toISOString();
    evidence.elapsedMs = Date.now() - started;
    if (Date.now() > deadline) failures.push({ phase: "deadline", error: "Internal deadline exceeded" });
    evidence.failures = failures;
    evidence.verdict = evidence.acceptanceComplete && !failures.length ? "pass" : "fail";
    const path = join(sandbox, "evidence.json");
    await save("evidence.json", evidence);
    console.log(serializeEvidence({ verdict: evidence.verdict, evidence: path, failures }, secrets));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  }
  return evidence;
}

if (import.meta.main) {
  if (Bun.argv.length !== 3 || !isAbsolute(Bun.argv[2]!)) {
    console.error("Usage: bun native-multichunk-acceptance.ts /absolute/path/product.tgz");
    process.exitCode = 1;
  } else await runNativeMultichunkAcceptance(Bun.argv[2]!);
}
