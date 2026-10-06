import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Host } from "@opencode/plugin/host";
import { Npm } from "@opencode/util/npm";
import { OpenCode, isCommandExecutionError, type OpenCodeClient } from "@opencode/client";
import { validateLogBaseline } from "./contract.js";
import { redactDiagnostic, serializeFailure } from "../diagnostic-redaction.js";

const root = resolve(import.meta.dir, "../../..");
const binary = resolve(import.meta.dir, "../node_modules/@opencode/cli-linux-x64/bin/opencode");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const WORKFLOW_MS = 90_000;
export const HEADLESS_COMMANDS = ["setup confirm true", "reset confirm true", "update", "show"] as const;

export function dialogRows(screen: string, title: string, lines: readonly string[]) {
  const rows = screen.split(/\r?\n/).map((row) => row.trim());
  const index = rows.findIndex(
    (row) => row === title || (row.startsWith(title) && /^[ \t]+esc$/.test(row.slice(title.length))),
  );
  // Paths and JSON wrap in real PTY rows; the production alert uses the pinned large dialog.
  const body = rows
    .slice(index + 1)
    .join("")
    .replace(/\s+/g, "");
  let offset = 0;
  return (
    index >= 0 &&
    lines.every((line) => {
      const found = body.indexOf(line.replace(/\s+/g, ""), offset);
      if (found < 0) return false;
      offset = found + line.replace(/\s+/g, "").length;
      return true;
    })
  );
}

export async function fileState(paths: readonly string[]) {
  const state: Record<string, string> = {};
  const visit = async (path: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    state[`${path}/`] = "directory";
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) state[child] = (await readFile(child)).toString("base64");
      else throw new Error(`Unexpected non-file acceptance state: ${child}`);
    }
  };
  for (const path of paths) await visit(path);
  return state;
}

export function assertOnlyChanged(
  before: Record<string, string>,
  after: Record<string, string>,
  paths: readonly string[],
) {
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[path] === after[path]) continue;
    if (paths.includes(path) || (path.endsWith("/") && paths.some((allowed) => allowed.startsWith(path)))) continue;
    throw new Error(`Unexpected action file change: ${path}`);
  }
}

export function settledTransfer(
  baseline: Awaited<ReturnType<OpenCodeClient["session"]["export"]>>,
  id: string,
): Parameters<OpenCodeClient["session"]["import"]>[0] {
  const model = { providerID: "stm-acceptance-unconfigured", id: "import-only-no-inference" };
  const time = baseline.info.time.created;
  return {
    info: { ...baseline.info, id, title: "STM imported settled history", agent: "build", model },
    location: { directory: baseline.info.location.directory },
    messages: [
      { id: "msg_stm_import_user", type: "user", time: { created: time }, text: "Imported existing user text." },
      {
        id: "msg_stm_import_assistant",
        type: "assistant",
        agent: "build",
        model,
        time: { created: time + 1, completed: time + 2 },
        finish: "stop",
        content: [{ type: "text", text: "Imported existing settled assistant text; no model was called." }],
        cost: 0,
        tokens: baseline.info.tokens,
      },
    ],
  };
}

// Pinned SessionMessagesResponse permits null endpoints; an empty page has no anchors.
const emptyMessagePage: Awaited<ReturnType<OpenCodeClient["message"]["list"]>> = {
  data: [],
  cursor: { previous: null, next: null },
};

export function verifySessionBaseline(
  messages: Awaited<ReturnType<OpenCodeClient["message"]["list"]>>,
  session: Awaited<ReturnType<OpenCodeClient["session"]["get"]>>,
  created: Pick<Awaited<ReturnType<OpenCodeClient["session"]["get"]>>, "model">,
  expectedPage = emptyMessagePage,
) {
  if (
    !isDeepStrictEqual(messages, expectedPage) ||
    !isDeepStrictEqual(session.model, created.model) ||
    session.cost !== 0 ||
    !isDeepStrictEqual(session.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  )
    throw new Error("Session messages/cost/tokens changed from its empty or imported baseline");
}

export function verifyImportedPage(
  transfer: Parameters<OpenCodeClient["session"]["import"]>[0],
  page: Awaited<ReturnType<OpenCodeClient["message"]["list"]>>,
  session: Awaited<ReturnType<OpenCodeClient["session"]["get"]>>,
) {
  // Pinned handlers/message.ts defaults to desc and returns endpoint cursors even
  // for a complete page. Import assigns durable seq in transfer array order.
  const data = [...transfer.messages].reverse();
  const cursor = (id: string, direction: "previous" | "next") =>
    Buffer.from(JSON.stringify({ id, order: "desc", direction })).toString("base64url");
  const expected = {
    data,
    cursor: data.length
      ? {
          previous: cursor(data[0]!.id, "previous"),
          next: cursor(data.at(-1)!.id, "next"),
        }
      : emptyMessagePage.cursor,
  };
  if (!isDeepStrictEqual(page, expected))
    throw new Error("Imported page differs from exact durable transfer projection");
  const model = transfer.info.model;
  if (
    session.id !== transfer.info.id ||
    !model ||
    !isDeepStrictEqual(session.model, { ...model, variant: model.variant ?? "default" }) ||
    session.cost !== 0 ||
    !isDeepStrictEqual(session.tokens, transfer.info.tokens) ||
    session.cost !== transfer.info.cost ||
    Object.values(session.tokens).some((value) =>
      typeof value === "number" ? value !== 0 : Object.values(value).some((n) => n !== 0),
    )
  )
    throw new Error("Imported session identity/model/cost/tokens differ from zero-usage transfer");
  // Only a independently verified complete page becomes the subsequent full-response baseline.
  return structuredClone(page);
}

export async function warmCommandInventory(
  client: Pick<OpenCodeClient, "command" | "plugin">,
  directory: string,
  target: string,
  observation: Record<string, unknown>,
  signal = AbortSignal.timeout(5_000),
) {
  const started = Date.now();
  observation.operation = "plugin.list + command.list (read-only inventory polling)";
  observation.attempts = 0;
  try {
    do {
      signal.throwIfAborted();
      const plugins = await client.plugin.list({ location: { directory } }, { signal });
      const commands = await client.command.list({ location: { directory } }, { signal });
      signal.throwIfAborted();
      observation.attempts = Number(observation.attempts) + 1;
      observation.plugins = plugins;
      observation.commands = commands;
      if (plugins.location.directory !== directory || commands.location.directory !== directory)
        throw new Error("Command warmup inventory returned a different location");
      const stm = plugins.data.find((plugin) => plugin.source.type === "package" && plugin.source.target === target);
      if (stm?.state.status === "failed") throw new Error("Staged STM plugin failed during command warmup");
      if (stm?.state.status === "active" && commands.data.some((command) => command.name === "stm")) {
        observation.ready = true;
        return;
      }
      await pause(50);
    } while (!signal.aborted);
    signal.throwIfAborted();
  } finally {
    observation.elapsedMs = Date.now() - started;
  }
}

export async function stageInstalledPackage(cache: string, name: string, version: string) {
  const target = `${name}@${version}`;
  const generation = join(cache, "npm", await Npm.cacheKey(target), String(Date.now()));
  await mkdir(generation, { recursive: true });
  // Pinned Npm.add uses numeric generations, not the flat Host.resolve lookup root.
  await symlink(join(cache, "node_modules"), join(generation, "node_modules"), "dir");
  return { target, generation };
}

export function tuiReadiness(log: string, target: string) {
  const lines = log.split(/\r?\n/);
  const setup = lines.findIndex(
    (line) =>
      line.includes('message="plugin operation completed"') &&
      line.includes("stage=setup ") &&
      line.includes("component=plugin ") &&
      line.includes("plugin=opencode-short-term-memory ") &&
      line.includes(`target=${target} `) &&
      line.includes("role=cli"),
  );
  if (setup < 0) return undefined;
  const run = /\brun=([^ ]+)/.exec(lines[setup]!)?.[1];
  if (!run) return undefined;
  const connected = lines
    .slice(0, setup)
    .find((line) => line.includes(`run=${run} `) && line.includes('message="event stream connected"'));
  const reconciled = lines
    .slice(setup + 1)
    .find((line) => line.includes(`run=${run} `) && line.includes('message="plugin reconciliation completed"'));
  return connected && reconciled ? { run, connected, setup: lines[setup]!, reconciled } : undefined;
}

export async function observeFailure(
  error: unknown,
  phase: string,
  secrets: readonly string[],
  terminal?: { capture: () => Promise<string>; save: (screen: string) => Promise<void> },
) {
  const observation: Record<string, unknown> = { phase, error: serializeFailure(error, secrets) };
  if (terminal)
    try {
      await terminal.save(redactDiagnostic(await terminal.capture(), secrets));
      observation.failureScreen = "failure-screen.txt";
    } catch (error) {
      observation.failureScreenError = serializeFailure(error, secrets);
    }
  return observation;
}

// One bounded workflow, no source plugin, fixture publisher or inference calls.
// Four 3s headless probes, two <=8s TUI activations and 16 serialized dialogs justify
// the 90s overall bound; individual startup, API, render and tmux limits remain short.
async function main() {
  const sandbox = await mkdtemp("/tmp/opencode/stm-production-commands-");
  const project = join(sandbox, "project");
  const memoryDir = join(sandbox, "memory");
  const projectConfig = join(project, ".opencode", "stm.jsonc");
  const statePaths = [memoryDir, join(project, ".opencode")];
  const coverage: Record<string, unknown>[] = [];
  const socket = join(sandbox, "tmux.sock");
  const failures: string[] = [];
  const evidence: Record<string, unknown> = {
    sandbox,
    version: "2.0.12",
    paidInference: false,
    globalBudgetChanged: false,
    packageProof:
      "Named exact-version target backed by locally staged published files and pinned host-compatible NPM generation; existing dependency symlink, not registry installation/publication or local-path activation.",
    commandAPI:
      "Native session.command({sessionID, name:'stm', text}); never fixture publish, prompt, synthetic or generate.",
    coverage,
    limits: { workflowMs: WORKFLOW_MS, serverSeconds: 85, tuiSeconds: 65, externalSeconds: 100 },
    limitations: [
      "Native committed update not covered; no-model and post-reset skip are model-free. Shared unit tests cover committed update.",
      "Unchanged history does not prove absence of internal history reads; receiver-first unit tests provide that proof.",
    ],
  };
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: join(sandbox, "home"),
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"),
    XDG_RUNTIME_DIR: join(sandbox, "runtime"),
    TMPDIR: join(sandbox, "tmp"),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_LOG_LEVEL: "DEBUG",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_PASSWORD: crypto.randomUUID(),
  };
  const secrets = [env.OPENCODE_PASSWORD!, Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString("base64")];
  const failureText = (error: unknown) => JSON.stringify(serializeFailure(error, secrets));
  let phase = "packaging";
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let output = "",
    errors = "";
  let drained: Promise<unknown> = Promise.resolve();
  let client: OpenCodeClient | undefined;
  let created: Awaited<ReturnType<OpenCodeClient["session"]["create"]>> | undefined;
  let tuiStarted = false;
  const watchdog = setTimeout(() => {
    failures.push("Overall 90s deadline expired");
    server?.kill("SIGTERM");
  }, WORKFLOW_MS);
  const terminal = async (...args: string[]) => {
    const child = Bun.spawn(
      ["/usr/bin/timeout", "--kill-after=1s", "4s", "/usr/bin/tmux", "-S", socket, "-f", "/dev/null", ...args],
      {
        cwd: project,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`tmux ${args[0]} exited ${code}: ${stderr}`);
    return stdout;
  };
  let expectedPage = emptyMessagePage;
  const snapshot = async (label: string) => {
    if (!client || !created) throw new Error("Session witness unavailable");
    const log = [];
    for await (const event of client.session.log(
      { sessionID: created.id, follow: false },
      { signal: AbortSignal.timeout(5_000) },
    ))
      log.push(event);
    const messages = await client.message.list({ sessionID: created.id }, { signal: AbortSignal.timeout(5_000) });
    const session = await client.session.get({ sessionID: created.id }, { signal: AbortSignal.timeout(5_000) });
    const observation = { log, messages, session };
    await writeFile(join(sandbox, `${label}-session.json`), JSON.stringify(observation, null, 2));
    validateLogBaseline(log, created, session, project);
    verifySessionBaseline(messages, session, created, expectedPage);
    return observation;
  };
  const native = (text: string) =>
    client!.session.command({ sessionID: created!.id, name: "stm", text }, { signal: AbortSignal.timeout(5_000) });
  const absent = async (text: string) => {
    const before = await fileState(statePaths);
    const started = Date.now();
    let error: unknown;
    try {
      await native(text);
    } catch (value) {
      error = value;
    }
    const elapsedMs = Date.now() - started;
    const after = await fileState(statePaths);
    coverage.push({
      text,
      state: "no-receiver-refused",
      error: serializeFailure(error, secrets),
      elapsedMs,
      before,
      after,
    });
    if (
      !isCommandExecutionError(error) ||
      !error.message.includes("no connected TUI receiver admitted") ||
      !error.message.includes(`STM ${text.split(" ")[0]}`) ||
      !error.message.includes("No action was run.")
    )
      throw new Error(`${text}: expected receiver-first native CommandExecutionError, got ${failureText(error)}`);
    if (elapsedMs > 4_000) throw new Error(`${text}: no-TUI failure exceeded delivery tolerance`);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${text}: headless file state changed`);
  };
  const capture = () => terminal("capture-pane", "-p", "-t", "status:0.0");
  const waitScreen = async (predicate: (screen: string) => boolean, label: string) => {
    const deadline = Date.now() + 2_000;
    let screen = "";
    do {
      screen = await capture();
      if (predicate(screen)) return screen;
      await pause(50);
    } while (Date.now() < deadline);
    await writeFile(join(sandbox, `${label}-screen.txt`), redactDiagnostic(screen, secrets));
    throw new Error(`${label}: actual PTY readiness/output missing within 2s`);
  };
  const connected = async (text: string, state: string, lines: readonly string[], unchanged = true) => {
    phase = `connected-${state}`;
    const title = `STM ${text.split(" ")[0] || "status"}`;
    const before = await fileState(statePaths);
    await native(text);
    const screen = await waitScreen((screen) => dialogRows(screen, title, lines), state);
    await writeFile(join(sandbox, `${state}-screen.txt`), redactDiagnostic(screen, secrets));
    if (state === "explicit-status") {
      const until = Date.now() + 3_100;
      do {
        if (!dialogRows(await capture(), title, lines)) throw new Error("Status disappeared before explicit dismissal");
        await pause(50);
      } while (Date.now() < until);
      await writeFile(join(sandbox, "past-handshake-screen.txt"), redactDiagnostic(await capture(), secrets));
    }
    const after = await fileState(statePaths);
    coverage.push({
      text,
      state,
      title,
      sessionID: created!.id,
      rendered: true,
      screen: `${state}-screen.txt`,
      lines,
      before,
      after,
    });
    if (unchanged && JSON.stringify(before) !== JSON.stringify(after))
      throw new Error(`${state}: unexpected file change`);
    await terminal("send-keys", "-t", "status:0.0", "Escape");
    await waitScreen(
      (screen) => !/^\s*STM (status|show|settings|logs|setup|update|reset)(?:\s+esc)?\s*$/m.test(screen),
      `${state}-dismissed`,
    );
    return { before, after };
  };
  try {
    await Promise.all(
      [
        project,
        ...Object.entries(env)
          .filter(([key]) => key === "HOME" || key.startsWith("XDG_") || key === "TMPDIR")
          .map(([, value]) => value),
      ].map((path) => mkdir(path, { recursive: true })),
    );
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const config = join(env.XDG_CONFIG_HOME!, "opencode");
    const cache = join(env.XDG_CACHE_HOME!, "opencode");
    const packageDir = join(cache, "node_modules", manifest.name);
    await mkdir(packageDir, { recursive: true });
    await mkdir(config, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest, null, 2));
    for (const file of manifest.files as string[])
      await cp(join(root, file), join(packageDir, file), { recursive: true });
    await symlink(join(root, "node_modules"), join(packageDir, "node_modules"), "dir");
    // Preseed both config and cache lookup roots. No installer/network/dependency changes.
    await symlink(join(cache, "node_modules"), join(config, "node_modules"), "dir");
    await symlink(join(cache, "node_modules"), join(project, "node_modules"), "dir");
    await writeFile(
      join(cache, "package.json"),
      JSON.stringify({ private: true, dependencies: { [manifest.name]: manifest.version } }),
    );
    const entries = Host.resolve({ directory: cache, name: manifest.name });
    const expected = { server: "index.js", tui: "tui.js", rpc: "rpc.js" } as const;
    for (const kind of ["server", "tui", "rpc"] as const) {
      if (!entries[kind] || fileURLToPath(entries[kind]!) !== join(packageDir, "dist", expected[kind]))
        throw new Error(`Published export ${kind} did not resolve to staged dist: ${entries[kind]}`);
      await Host.load(entries[kind]!);
    }
    for (const kind of [".", "./tui", "./rpc"]) await readFile(join(packageDir, manifest.exports[kind].types));
    const uiBundle = await readFile(new URL(entries.tui!), "utf8");
    if (/node:fs|readV2MemoryStatus|createV2MemoryUpdater|memory-utils|fixtures\//.test(uiBundle))
      throw new Error("Server/fixture code leaked into UI bundle");
    evidence.packagedEntries = entries;
    evidence.declarationsPresent = true;
    evidence.uiBundleSeparated = true;
    const installed = await stageInstalledPackage(cache, manifest.name, manifest.version);
    evidence.installedPackage = installed;
    await writeFile(join(config, "opencode.json"), JSON.stringify({ plugins: [installed.target], update: "disable" }));
    await writeFile(join(config, "stm.jsonc"), JSON.stringify({ memoryDir }));
    await writeFile(
      join(config, "cli.json"),
      JSON.stringify({
        plugins: [installed.target],
        animations: false,
        mouse: false,
        attention: { notifications: false, sound: false },
        tabs: { enabled: false },
      }),
    );
    phase = "server-start";
    server = Bun.spawn(
      ["/usr/bin/timeout", "--kill-after=2s", "85s", binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
      { cwd: project, env, stdout: "pipe", stderr: "pipe" },
    );
    const read = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
      for await (const chunk of stream) append(new TextDecoder().decode(chunk));
    };
    drained = Promise.all([
      read(server.stdout as ReadableStream<Uint8Array>, (text) => {
        output += text;
      }),
      read(server.stderr as ReadableStream<Uint8Array>, (text) => {
        errors += text;
      }),
    ]).catch((error) => {
      failures.push(`Server output drain: ${failureText(error)}`);
    });
    const startupDeadline = Date.now() + 10_000;
    while (!/server listening on (http:\/\/127\.0\.0\.1:\d+)/.test(output)) {
      if (Date.now() >= startupDeadline || server.exitCode !== null) throw new Error("Host startup failed within 10s");
      await pause(50);
    }
    const endpoint = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)![1]!;
    evidence.endpoint = endpoint;
    client = OpenCode.make({
      baseUrl: endpoint,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString("base64")}` },
    });
    phase = "session-baseline";
    const info = await client.server.info({ signal: AbortSignal.timeout(5_000) });
    if (info.version !== "2.0.12") throw new Error(`Wrong host version ${info.version}`);
    created = await client.session.create(
      { title: "STM production native commands", location: { directory: project } },
      { signal: AbortSignal.timeout(5_000) },
    );
    evidence.sessionID = created.id;
    phase = "command-warmup";
    const commandWarmup: Record<string, unknown> = {};
    evidence.commandWarmup = commandWarmup;
    await warmCommandInventory(client, project, installed.target, commandWarmup);
    evidence.before = await snapshot("before");
    phase = "no-tui-before";
    for (const text of HEADLESS_COMMANDS) await absent(text);
    evidence.afterHeadless = await snapshot("after-headless");
    const startTui = async () => {
      const tuiCommand = [
        "/usr/bin/timeout",
        "--kill-after=2s",
        "65s",
        binary,
        "--server",
        endpoint,
        "--session",
        created!.id,
      ]
        .map(quote)
        .join(" ");
      phase = "tui-start";
      // Pinned alerts do not scroll. A tall PTY exposes complete settings/logs rows.
      await terminal("new-session", "-d", "-s", "status", "-x", "160", "-y", "240", "-c", project, tuiCommand);
      tuiStarted = true;
      phase = "tui-readiness";
      const readinessDeadline = Date.now() + 8_000;
      const priorRun = (evidence.tuiReadiness as { run?: string } | undefined)?.run;
      let readiness;
      while (!readiness) {
        const log = await readFile(join(env.XDG_DATA_HOME!, "opencode/log/opencode.log"), "utf8");
        // Each restart needs its own setup witness, not the first TUI's old log lines.
        const runs = log
          .split(/\r?\n/)
          .filter((line) => !priorRun || !line.includes(`run=${priorRun} `))
          .join("\n");
        readiness = tuiReadiness(runs, installed.target);
        if (readiness) break;
        if (Date.now() >= readinessDeadline)
          throw new Error("Target-specific TUI setup/connection witness missing within 8s");
        await pause(50);
      }
      evidence.tuiReadiness = readiness;
      ((evidence.tuiSetups ??= []) as unknown[]).push(readiness);
      const routeScreen = await waitScreen(
        (screen) => screen.includes(created!.title!) || screen.includes("Ask anything"),
        "session-route",
      );
      await writeFile(join(sandbox, `route-${created!.id}-screen.txt`), redactDiagnostic(routeScreen, secrets));
    };
    await startTui();
    const pathsFor = (sessionID: string) => ({
      memory: join(memoryDir, `session_${sessionID}.md`),
      checkpoint: join(memoryDir, "checkpoints", `${sessionID}.last-message-id.txt`),
      boundary: join(memoryDir, "reset-boundaries", `${sessionID}.json`),
    });
    const paths = pathsFor(created.id);
    const statusLines = [
      "generation: v2",
      `authoritative sessionID: ${created.id}`,
      "effectiveMemoryModel: current-session",
      `memoryDir: ${memoryDir}`,
      `memoryPath: ${paths.memory}`,
      `checkpointPath: ${paths.checkpoint}`,
      `resetBoundaryPath: ${paths.boundary}`,
      "memoryBytes: 0",
      "checkpoint: none",
      "updaterBusy: false",
    ];
    evidence.statusPaths = paths;
    await connected("", "default-status", statusLines);
    await connected("status", "explicit-status", statusLines);
    await connected("settings", "settings-success", [
      '"generation": "v2"',
      `"memoryDir": "${memoryDir}"`,
      '"effective":',
      '"inactiveSettings":',
      '"collapseAssistantBursts"',
    ]);
    await connected("logs", "logs-empty", ["No logs yet."]);
    const shown = await connected(
      "show",
      "show-created",
      [
        "### User Instructions",
        "### Long Horizon Context",
        "### Decisions",
        "### Conclusions",
        "### Active References",
      ],
      false,
    );
    const template = await readFile(paths.memory);
    assertOnlyChanged(shown.before, shown.after, [paths.memory]);
    if (
      shown.before[paths.memory] !== undefined ||
      shown.after[paths.memory] !== template.toString("base64") ||
      !template.length
    )
      throw new Error("Show did not create the witnessed memory template");
    await connected("show", "show-existing", template.toString("utf8").split("\n").filter(Boolean));
    await connected("setup", "setup-unconfirmed", ["Refused: setup not run.", "exact literal confirmation."]);
    const setup = await connected(
      "setup confirm true",
      "setup-created",
      ["Created project example config at", `configPath: ${projectConfig}`, "Shared example:"],
      false,
    );
    const example = await readFile(projectConfig);
    assertOnlyChanged(setup.before, setup.after, [projectConfig]);
    if (
      setup.before[projectConfig] !== undefined ||
      setup.after[projectConfig] !== example.toString("base64") ||
      !example.length
    )
      throw new Error("Confirmed setup did not create example bytes");
    await connected("setup confirm true", "setup-no-overwrite", [
      "No example config created:",
      "already exists",
      `configPath: ${projectConfig}`,
    ]);
    if (!(await readFile(projectConfig)).equals(example)) throw new Error("Setup overwrote example config");
    // Only this freshly created sandbox config is removed; keep its exact bytes as evidence.
    await writeFile(join(sandbox, "created-example-stm.jsonc"), example);
    await rm(projectConfig);
    await writeFile(projectConfig, JSON.stringify({ memoryDir }));
    evidence.harnessConfigReplacement = {
      path: projectConfig,
      reason: "Absolute memoryDir avoids generated example changing action paths",
      example: "created-example-stm.jsonc",
    };
    await connected("update", "update-no-model", [
      "update: unavailable",
      "reason: no-model",
      "source: unavailable",
      "progress: not-started",
    ]);
    await connected("reset", "reset-unconfirmed", ["Refused: reset not run.", "exact literal confirmation."]);
    await connected("reset confirm true", "reset-empty-refused", [
      "Refused to reset V2 short-term memory:",
      "no-model:",
      "current session model unavailable",
    ]);
    evidence.emptyAfter = await snapshot("empty-after");
    await terminal("kill-server");
    tuiStarted = false;
    phase = "settled-import";
    const transfer = settledTransfer(
      await client.session.export({ sessionID: created.id }, { signal: AbortSignal.timeout(5_000) }),
      `ses_stm_import_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    await writeFile(join(sandbox, "import-transfer.json"), JSON.stringify(transfer, null, 2));
    created = await client.session.import(transfer, { signal: AbortSignal.timeout(5_000) });
    const imported = await client.session.export({ sessionID: created.id }, { signal: AbortSignal.timeout(5_000) });
    if (!isDeepStrictEqual(imported.messages, transfer.messages) || !created.model || created.cost !== 0)
      throw new Error("Host import did not retain exact settled records/model/zero cost");
    const durableContext = await client.session.context(
      { sessionID: created.id },
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!isDeepStrictEqual(durableContext, transfer.messages))
      throw new Error("Imported settled context differs from transfer records");
    const importedPage = await client.message.list({ sessionID: created.id }, { signal: AbortSignal.timeout(5_000) });
    expectedPage = verifyImportedPage(transfer, importedPage, created);
    evidence.importBaseline = await snapshot("import-baseline");
    evidence.importProof = {
      schema: "Pinned SessionTransfer.Data; client import({info, messages, location})",
      semantics: "Host transfer filters settled messages and projects records without runner/model calls",
      recordsAre: "imported existing history, not new command effects",
      model: created.model,
      durableContext,
    };
    const importedPaths = pathsFor(created.id);
    // Persistence seeds are harness-owned files, never database/session writes.
    await mkdir(join(memoryDir, "checkpoints"), { recursive: true });
    await writeFile(importedPaths.memory, "Harness-owned memory before reset\n");
    await writeFile(importedPaths.checkpoint, "msg_stm_import_user\n");
    await startTui();
    const reset = await connected(
      "reset confirm true",
      "reset-settled-accepted",
      [
        "reset: completed",
        `authoritative sessionID: ${created.id}`,
        "resetBoundaryAnchor: msg_stm_import_assistant",
        "boundaryScope: through last record of settled durable snapshot; not invocation message",
        "semanticErasure: false",
      ],
      false,
    );
    assertOnlyChanged(reset.before, reset.after, Object.values(importedPaths));
    if (
      !(await readFile(importedPaths.memory)).equals(template) ||
      (await readFile(importedPaths.checkpoint)).length !== 0 ||
      (await readFile(importedPaths.boundary, "utf8")) !==
        JSON.stringify({ version: 1, anchorID: "msg_stm_import_assistant" }) + "\n"
    )
      throw new Error("Accepted reset file bytes do not match template/empty checkpoint/exact snapshot boundary");
    await connected("status", "status-after-reset", [
      `authoritative sessionID: ${created.id}`,
      `memoryPath: ${importedPaths.memory}`,
      `checkpointPath: ${importedPaths.checkpoint}`,
      `resetBoundaryPath: ${importedPaths.boundary}`,
      "resetBoundary: valid",
      "resetBoundaryAnchor: msg_stm_import_assistant",
      `memoryBytes: ${template.length}`,
      "checkpoint: none",
    ]);
    const skipped = await connected(
      "update",
      "update-post-reset-skipped",
      ["update: skipped", "reason: no_assistant_in_delta", "source: durable-visible-text", '"checkpointedChunks":0'],
      false,
    );
    assertOnlyChanged(skipped.before, skipped.after, [join(memoryDir, "session-memory.log")]);
    if (
      !(await readFile(importedPaths.memory)).equals(template) ||
      (await readFile(importedPaths.checkpoint)).length !== 0
    )
      throw new Error("Post-reset update changed memory/checkpoint despite empty delta");
    const log = await readFile(join(memoryDir, "session-memory.log"), "utf8");
    if (!log.includes("v2_memory_update_skipped") || !log.includes("no_assistant_in_delta"))
      throw new Error("Skip log missing");
    await connected("logs", "logs-persisted", ["v2_memory_update_skipped", "no_assistant_in_delta"]);
    await terminal("kill-server");
    tuiStarted = false;
    evidence.nativeConnectedCount = coverage.filter((row) => row.rendered).length;
    if (evidence.nativeConnectedCount !== 16) throw new Error("Unexpected connected command count");
    phase = "session-after";
    evidence.after = await snapshot("after");
    evidence.costConsumed = 0;
  } catch (error) {
    evidence.failure = await observeFailure(
      error,
      phase,
      secrets,
      tuiStarted
        ? {
            capture: () => terminal("capture-pane", "-p", "-t", "status:0.0"),
            save: (screen) => writeFile(join(sandbox, "failure-screen.txt"), screen),
          }
        : undefined,
    );
    failures.push(`${phase}: ${failureText(error)}`);
    if (client && created)
      try {
        evidence.afterFailure = await snapshot("after-failure");
      } catch (error) {
        evidence.failureSnapshotError = serializeFailure(error, secrets);
        failures.push(`Failure session snapshot: ${failureText(error)}`);
      }
  } finally {
    if (tuiStarted)
      try {
        await terminal("kill-server");
        tuiStarted = false;
      } catch (error) {
        evidence.tuiCleanupError = serializeFailure(error, secrets);
        failures.push(`TUI cleanup unconfirmed: ${failureText(error)}`);
      }
    evidence.tuiStopped = !tuiStarted;
    if (server) {
      server.kill("SIGTERM");
      await server.exited;
      await drained;
      evidence.serverExit = server.exitCode;
    }
    clearTimeout(watchdog);
    await writeFile(join(sandbox, "server.stdout.txt"), redactDiagnostic(output, secrets));
    await writeFile(join(sandbox, "server.stderr.txt"), redactDiagnostic(errors, secrets));
    evidence.verdict = failures.length ? "fail" : "pass";
    evidence.failures = failures;
    evidence.sandboxDisposition = "retained for inspection";
    const path = join(sandbox, "evidence.json");
    await writeFile(path, redactDiagnostic(JSON.stringify(evidence, null, 2), secrets));
    console.log(JSON.stringify({ verdict: evidence.verdict, evidence: path, failures }));
    if (failures.length) process.exitCode = 1;
  }
}

if (import.meta.main) await main();
