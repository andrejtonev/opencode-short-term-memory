import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit invocation only: bun scripts/package-acceptance.ts /absolute/path/package.tgz
const started = Date.now();
const deadline = started + 180_000;
const sandbox = await mkdtemp("/tmp/opencode/stm-package-acceptance-");
const failures: string[] = [];
const commands: object[] = [];
const evidence: Record<string, unknown> = {
  scope: "Clean tarball installation, public imports and strict declarations only; no host activation",
  sandbox,
  started: new Date(started).toISOString(),
  verdict: "FAIL",
  failures,
  commands,
  retained: true,
  paidInference: false,
  costConsumed: 0,
  globalBudgetChanged: false,
  processContainment:
    "Direct child is killed and awaited with a bounded grace on failure; descendant containment is not guaranteed.",
};
let active: ReturnType<typeof Bun.spawn> | undefined;
const overall = setTimeout(
  () => {
    failures.push("Overall 180s deadline exceeded");
    active?.kill("SIGKILL");
  },
  Math.max(1, deadline - Date.now()),
);

function inside(root: string, path: string) {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

try {
  const checkout = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  evidence.checkout = checkout;
  const bun = await realpath(process.execPath);
  assert.equal(Bun.argv.length, 3, "Supply exactly one absolute tarball path");
  const input = Bun.argv[2]!;
  assert.ok(isAbsolute(input), "Tarball path must be absolute");
  const source = await realpath(input);
  assert.ok((await lstat(source)).isFile(), "Tarball must be a regular file");
  const bytes = await Bun.file(source).arrayBuffer();
  const tarball = join(sandbox, "artifact.tgz");
  await Bun.write(tarball, bytes);
  evidence.artifact = {
    source,
    retainedCopy: tarball,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  };
  evidence.bun = { executable: bun, version: Bun.version };

  const env: Record<string, string> = {
    HOME: join(sandbox, "home"),
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_STATE_HOME: join(sandbox, "state"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_RUNTIME_DIR: join(sandbox, "run"),
    TMPDIR: join(sandbox, "tmp"),
    TMP: join(sandbox, "tmp"),
    TEMP: join(sandbox, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(sandbox, "runtime-install-cache"),
    PATH: `${dirname(bun)}:/usr/bin:/bin`,
  };
  for (const path of new Set(Object.values(env).filter((value) => inside(sandbox, value)))) {
    await mkdir(path, { recursive: true });
  }
  evidence.environment = env;
  const toolingEnv = { ...env, BUN_INSTALL_CACHE_DIR: join(sandbox, "tooling-install-cache") };
  await mkdir(toolingEnv.BUN_INSTALL_CACHE_DIR);
  const initialCaches = [];
  for (const path of [env.XDG_CACHE_HOME!, env.BUN_INSTALL_CACHE_DIR!, toolingEnv.BUN_INSTALL_CACHE_DIR]) {
    const entries = await readdir(path);
    initialCaches.push({ path, entries });
    assert.equal(entries.length, 0, `Initial cache is not empty: ${path}`);
  }
  evidence.initialCaches = initialCaches;

  async function run(label: string, args: string[], cwd: string, environment = env, allowNonzero = false) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "Overall deadline exceeded");
    const timeoutMs = Math.min(60_000, remaining);
    const record = {
      label,
      args,
      cwd,
      allowNonzero,
      timeoutMs,
      timedOut: false,
      status: null as number | null,
      stdout: "",
      stderr: "",
      error: null as string | null,
      directChildExited: false,
      killError: null as string | null,
    };
    commands.push(record);
    console.log(`$ ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(args, { cwd, env: environment, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (error) {
      record.error = String(error);
      throw error;
    }
    active = child;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race pipe draining too: a lifecycle child may keep inherited pipes open.
      await Promise.race([
        Promise.all([
          child.exited.then((status) => {
            record.status = status;
            record.directChildExited = true;
          }),
          new Response(child.stdout).text().then((stdout) => {
            record.stdout = stdout;
          }),
          new Response(child.stderr).text().then((stderr) => {
            record.stderr = stderr;
          }),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            record.timedOut = true;
            reject(new Error(`${label} timed out`));
          }, timeoutMs);
        }),
      ]);
      if (record.stdout) console.log(record.stdout);
      if (record.stderr) console.error(record.stderr);
      assert.ok(!record.timedOut && Date.now() < deadline, `${label} timed out`);
      if (allowNonzero && record.status !== 0) {
        record.error = `${label} exited with status ${record.status}; diagnostic unavailable. Blocked package identities are not established by this diagnostic; see retained stderr and installation output.`;
      } else {
        assert.equal(record.status, 0, `${label} exited with status ${record.status}`);
      }
      return record.stdout;
    } catch (error) {
      record.error = String(error);
      clearTimeout(timer);
      if (!record.directChildExited) {
        try {
          child.kill("SIGKILL");
        } catch (killError) {
          record.killError = String(killError);
        }
      }
      let grace: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          child.exited.then((status) => {
            record.status = status;
            record.directChildExited = true;
          }),
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, 2_000);
          }),
        ]);
      } finally {
        clearTimeout(grace);
      }
      child.stdout.cancel().catch(() => undefined);
      child.stderr.cancel().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
      active = undefined;
    }
  }

  const manifest = JSON.parse(
    await run("tarball metadata", ["/usr/bin/tar", "-xOf", tarball, "package/package.json"], sandbox),
  ) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(manifest.name, "@atonev/opencode-short-term-memory");
  assert.equal(typeof manifest.version, "string");
  evidence.tarballManifest = manifest;
  const runtime = join(sandbox, "runtime");
  const tooling = join(sandbox, "tooling");
  await mkdir(runtime);
  await mkdir(tooling);
  const consumerManifest = { private: true, type: "module", dependencies: { [manifest.name]: `file:${tarball}` } };
  await Bun.write(join(runtime, "package.json"), JSON.stringify(consumerManifest, null, 2));
  evidence.runtimeConsumerManifest = consumerManifest;
  await run(
    "production dependency installation (normal Bun lifecycle policy)",
    [bun, "install", "--production"],
    runtime,
  );
  evidence.productionUntrusted = await run(
    "blocked production lifecycle scripts (no trust changes)",
    [bun, "pm", "untrusted"],
    runtime,
    env,
    true,
  );

  const packageRoot = await realpath(join(runtime, "node_modules", manifest.name));
  assert.ok(inside(runtime, packageRoot) && !inside(checkout, packageRoot), "Installed package escapes consumer");
  const installed = await Bun.file(join(packageRoot, "package.json")).json();
  evidence.installedPackage = { name: installed.name, version: installed.version, path: packageRoot };
  assert.equal(installed.name, manifest.name);
  assert.equal(installed.version, manifest.version);

  const inventory: { name: string; version: string; path: string }[] = [];
  const physicalPaths: { path: string; realpath: string }[] = [];
  evidence.productionInventory = inventory;
  evidence.physicalPaths = physicalPaths;
  const visited = new Set<string>();
  async function inspect(path: string) {
    assert.ok(Date.now() < deadline, "Physical inspection exceeded deadline");
    const physical = await realpath(path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) physicalPaths.push({ path, realpath: physical });
    assert.ok(
      inside(runtime, physical) && !inside(checkout, physical),
      `Dependency path escapes consumer: ${path} -> ${physical}`,
    );
    if (!(await lstat(physical)).isDirectory() || visited.has(physical)) return;
    visited.add(physical);
    const metadata = Bun.file(join(physical, "package.json"));
    if (await metadata.exists()) {
      const pkg = await metadata.json();
      if (typeof pkg.name === "string" && typeof pkg.version === "string") {
        inventory.push({ name: pkg.name, version: pkg.version, path: physical });
      }
    }
    for (const entry of await readdir(physical, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) await inspect(join(physical, entry.name));
    }
  }
  await inspect(join(runtime, "node_modules"));
  const resolvedDependencies: { name: string; resolved: string; realpath: string; kind?: "type-only" }[] = [];
  evidence.resolvedProductionDependencies = resolvedDependencies;
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith("@types/")) continue;
    const resolved = Bun.resolveSync(name, packageRoot);
    const physical = await realpath(resolved);
    assert.ok(
      inside(runtime, physical) && !inside(checkout, physical),
      `Resolved production dependency escapes consumer: ${name} -> ${physical}`,
    );
    resolvedDependencies.push({ name, resolved, realpath: physical });
  }
  evidence.rootDevOnlyDependencies = Object.keys(manifest.devDependencies ?? {})
    .filter((name) => !(name in (manifest.dependencies ?? {})))
    .map((name) => ({
      name,
      installed: inventory.some((pkg) => pkg.name === name),
      packages: inventory.filter((pkg) => pkg.name === name),
    }));
  evidence.rootDevOnlyNote =
    "Presence is reported, not automatically failed: a production transitive dependency may share a root dev-only name.";

  const specifiers = [manifest.name, `${manifest.name}/server`, `${manifest.name}/tui`, `${manifest.name}/rpc`];
  await Bun.write(
    join(runtime, "imports.ts"),
    `import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, isAbsolute, sep } from "node:path";
import root, { SessionMemoryPlugin } from "${manifest.name}";
import server, { SessionMemoryPlugin as serverPlugin } from "${manifest.name}/server";
import tui, { receiveStatus } from "${manifest.name}/tui";
import rpc, { statusOutputDefinition } from "${manifest.name}/rpc";
const paths = [];
for (const specifier of ${JSON.stringify(specifiers)}) {
  const path = await realpath(fileURLToPath(import.meta.resolve(specifier)));
  const suffix = relative(${JSON.stringify(packageRoot)}, path);
  assert.ok(suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix), specifier + " escapes installed package");
  paths.push({ specifier, path });
}
for (const entry of [root, server]) {
  assert.equal(entry.id, "opencode-short-term-memory");
  assert.equal(typeof entry.server, "function");
  assert.equal(typeof entry.setup, "function");
}
assert.equal(root.server, SessionMemoryPlugin);
assert.equal(server.server, serverPlugin);
assert.equal(tui.id, "opencode-short-term-memory");
assert.equal(typeof tui.setup, "function");
assert.equal(tui.setup, receiveStatus);
assert.equal(rpc, statusOutputDefinition);
assert.equal(rpc.id, "stm.status-output");
assert.deepEqual(Object.keys(rpc.methods).sort(), ["acknowledge", "cancel", "claim"]);
assert.deepEqual(Object.keys(rpc.events).sort(), ["offer", "output", "release"]);
for (const method of Object.values(rpc.methods)) {
  assert.equal(method.input.type, "object");
  assert.deepEqual(method.input.required, ["requestID", "sessionID", "receiverID"]);
  assert.equal(method.output.properties.accepted.type, "boolean");
}
console.log(JSON.stringify({ gate: "public imports only, no hooks called", paths }));
`,
  );
  evidence.runtimeImports = JSON.parse(await run("four public runtime exports", [bun, "run", "imports.ts"], runtime));

  const toolingVersions: Record<string, string> = {};
  const lock = await Bun.file(join(checkout, "bun.lock")).text();
  for (const name of ["typescript", "@types/bun"]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const records = [
      ...lock.matchAll(new RegExp(`^[ \\t]*"${escaped}": \\["${escaped}@(\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?)",`, "gm")),
    ];
    assert.equal(records.length, 1, `Expected exactly one locked package record for ${name}`);
    toolingVersions[name] = records[0]![1]!;
  }
  evidence.tooling = {
    scope: "Separate declaration tooling, NOT the production dependency set",
    pinnedVersions: toolingVersions,
    versionSource: join(checkout, "bun.lock"),
  };
  await Bun.write(
    join(tooling, "package.json"),
    JSON.stringify({ private: true, dependencies: toolingVersions }, null, 2),
  );
  await run("separate pinned declaration tooling installation", [bun, "install", "--production"], tooling, toolingEnv);
  for (const [name, version] of Object.entries(toolingVersions)) {
    const path = await realpath(join(tooling, "node_modules", name));
    assert.ok(inside(tooling, path) && !inside(checkout, path), `Tooling escapes sandbox: ${name}`);
    const pkg = await Bun.file(join(path, "package.json")).json();
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, version);
  }
  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: ["bun"],
      typeRoots: [join(tooling, "node_modules", "@types")],
    },
    files: ["consumer.ts"],
  };
  const ts: typeof import("typescript") = await import(
    join(tooling, "node_modules", "typescript", "lib", "typescript.js")
  );
  const compilerOptions = ts.convertCompilerOptionsFromJson(tsconfig.compilerOptions, runtime);
  assert.equal(compilerOptions.errors.length, 0, "Invalid consumer compiler options");
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!name.startsWith("@types/")) continue;
    const directive = name.slice("@types/".length).replace(/^(.+)__(.+)$/, "@$1/$2");
    const resolution = ts.resolveTypeReferenceDirective(
      directive,
      join(packageRoot, "dist", "index.d.ts"),
      compilerOptions.options,
      ts.sys,
    ).resolvedTypeReferenceDirective;
    assert.ok(resolution?.resolvedFileName, `Production type dependency did not resolve: ${name}`);
    const resolved = resolution.resolvedFileName;
    const physical = await realpath(resolved);
    assert.ok(
      inside(runtime, physical) && !inside(checkout, physical) && !inside(tooling, physical),
      `Resolved production type dependency escapes consumer: ${name} -> ${physical}`,
    );
    resolvedDependencies.push({ name, resolved, realpath: physical, kind: "type-only" });
  }
  await Bun.write(
    join(runtime, "tui-consumer.ts"),
    `import tui, { receiveStatus, type StatusTuiContext } from "${manifest.name}/tui";
const tuiShape: { id: string; setup(context: StatusTuiContext): () => void } = tui;
const receiver: typeof tuiShape.setup = receiveStatus;
const id: string = tui.id;
void [tuiShape, receiver, id];
`,
  );
  const tuiConfig = { ...tsconfig, files: ["tui-consumer.ts"] };
  await Bun.write(join(runtime, "tsconfig.tui.json"), JSON.stringify(tuiConfig, null, 2));
  evidence.tuiDeclarationConfig = tuiConfig;
  await run(
    "strict TUI-only declaration consumer",
    [bun, join(tooling, "node_modules", "typescript", "bin", "tsc"), "-p", join(runtime, "tsconfig.tui.json")],
    runtime,
    toolingEnv,
  );
  evidence.tuiDeclarations = { gate: "strict TUI-only declarations, no host SDK imports", verdict: "PASS" };
  await Bun.write(
    join(runtime, "consumer.ts"),
    `import root, { SessionMemoryPlugin } from "${manifest.name}";
import server from "${manifest.name}/server";
import tui, { receiveStatus, type StatusTuiContext } from "${manifest.name}/tui";
import rpc, { statusOutputDefinition, type StatusReceiver, type StatusOutput } from "${manifest.name}/rpc";
import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode/plugin";
import type { Rpc } from "@opencode/plugin/rpc";
const rootShape: { id: string; server: V1Plugin; setup(context: Plugin.Context): Promise<() => Promise<void>> } = root;
const serverShape: typeof rootShape = server;
const legacy: V1Plugin = SessionMemoryPlugin;
const tuiShape: { id: string; setup(context: StatusTuiContext): () => void } = tui;
const receiver: typeof tuiShape.setup = receiveStatus;
const definition: Rpc.PortableDefinition = rpc;
const sameDefinition: typeof rpc = statusOutputDefinition;
const id: "stm.status-output" = rpc.id;
const required: readonly ["requestID", "sessionID", "receiverID"] = rpc.methods.claim.input.required;
const accepted: "boolean" = rpc.methods.acknowledge.output.properties.accepted.type;
const cancel: false = rpc.methods.cancel.input.additionalProperties;
const offer: "number" = rpc.events.offer.schema.properties.expiresAt.type;
const outputLimit: 16384 = rpc.events.output.schema.properties.message.maxLength;
const release: "string" = rpc.events.release.schema.properties.receiverID.type;
const statusReceiver: StatusReceiver = { requestID: "r", sessionID: "s", receiverID: "t" };
const statusOutput: StatusOutput = { ...statusReceiver, expiresAt: 1, message: "m", title: "t" };
void [rootShape, serverShape, legacy, tuiShape, receiver, definition, sameDefinition, id, required, accepted, cancel, offer, outputLimit, release, statusOutput];
`,
  );
  await Bun.write(join(runtime, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  evidence.declarationConfig = tsconfig;
  await run(
    "strict public declaration consumer",
    [bun, join(tooling, "node_modules", "typescript", "bin", "tsc"), "-p", join(runtime, "tsconfig.json")],
    runtime,
    toolingEnv,
  );
  assert.ok(Date.now() < deadline && failures.length === 0, "Overall deadline exceeded");
  evidence.verdict = "PASS";
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  clearTimeout(overall);
  evidence.finished = new Date().toISOString();
  evidence.elapsedMs = Date.now() - started;
  await Bun.write(join(sandbox, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`VERDICT: ${evidence.verdict}; retained evidence: ${join(sandbox, "evidence.json")}`);
  process.exitCode = evidence.verdict === "PASS" ? 0 : 1;
  if (Date.now() >= deadline || commands.some((command) => "timedOut" in command && command.timedOut)) {
    process.exit(1);
  }
}
