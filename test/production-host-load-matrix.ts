import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME = process.execPath;
const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const MARKERS = ["server.marker", "setup.marker", "cleanup.marker"] as const;
const HOSTS = [
  {
    generation: "V1",
    packageName: "opencode-ai",
    version: "1.14.25",
    binary: ["bin", ".opencode"],
  },
  {
    generation: "V2",
    packageName: "@opencode/cli",
    version: "2.0.8",
    binary: ["bin", "opencode.exe"],
  },
] as const;

function run(command: string, args: string[], cwd: string, env: Record<string, string>) {
  const rendered = `${command} ${args.join(" ")}`;
  console.log(`$ ${rendered}`);
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.log(result.stderr.trim());
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${rendered} exited with status ${String(result.status)}`);
}

function isolatedEnvironment(root: string, markers: string) {
  const env = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    PATH: [dirname(RUNTIME), process.env.PATH].filter(Boolean).join(delimiter),
    NO_COLOR: "1",
  };
  for (const directory of Object.values(env).filter((value) => value.startsWith(root))) {
    mkdirSync(directory, { recursive: true });
  }
  return env;
}

function installHost(root: string, host: (typeof HOSTS)[number], env: Record<string, string>) {
  const install = join(root, "install");
  mkdirSync(install, { recursive: true });
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify({ private: true, trustedDependencies: [host.packageName], dependencies: { [host.packageName]: host.version } })}\n`,
  );
  run(RUNTIME, ["install", "--exact"], install, env);
  const packageRoot = join(install, "node_modules", ...host.packageName.split("/"));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
  if (manifest.version !== host.version) throw new Error(`installed ${manifest.version}, expected ${host.version}`);
  return join(packageRoot, ...host.binary);
}

function createWrapper(root: string, markers: string) {
  const plugin = join(root, "plugin");
  const entrypoint = join(plugin, "index.js");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "package.json"),
    `${JSON.stringify({ private: true, type: "module", main: "./index.js" })}\n`,
  );
  writeFileSync(
    entrypoint,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import productionDefault from ${JSON.stringify(pathToFileURL(realpathSync(DIST)).href)};

const markers = ${JSON.stringify(markers)};
const mark = (name) => writeFileSync(join(markers, name), name + "\\n");

export default {
  id: productionDefault.id,
  server(...args) {
    mark("server.marker");
    return productionDefault.server.apply(productionDefault, args);
  },
  async setup(...args) {
    mark("setup.marker");
    const cleanup = await productionDefault.setup.apply(productionDefault, args);
    if (typeof cleanup !== "function") throw new TypeError("production setup did not return cleanup");
    return async (...cleanupArgs) => {
      await cleanup(...cleanupArgs);
      mark("cleanup.marker");
    };
  },
};
`,
  );
  return { directory: plugin, entrypoint };
}

function observed(markers: string) {
  return MARKERS.filter((marker) => existsSync(join(markers, marker)));
}

function assertMarkers(markers: string, expected: readonly (typeof MARKERS)[number][], phase: string) {
  const actual = observed(markers);
  if (actual.length !== expected.length || actual.some((marker, index) => marker !== expected[index])) {
    throw new Error(`${phase} markers: [${actual.join(", ")}], expected [${expected.join(", ")}]`);
  }
}

function waitForMarker(markers: string, marker: (typeof MARKERS)[number]) {
  const delay = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(join(markers, marker))) return;
    Atomics.wait(delay, 0, 0, 100);
  }
  throw new Error(`timed out after 5s waiting for ${marker}`);
}

function runHost(root: string, host: (typeof HOSTS)[number]) {
  const markers = join(root, "markers");
  const project = join(root, "project");
  mkdirSync(markers, { recursive: true });
  mkdirSync(project, { recursive: true });
  const plugin = createWrapper(root, markers);
  const pluginReference = host.generation === "V1" ? pathToFileURL(plugin.entrypoint).href : plugin.directory;
  writeFileSync(
    join(project, "opencode.json"),
    `${JSON.stringify({ [host.generation === "V1" ? "plugin" : "plugins"]: [pluginReference] })}\n`,
  );
  const env = isolatedEnvironment(root, markers);
  const binary = installHost(root, host, env);

  if (host.generation === "V1") {
    run(binary, ["debug", "config"], project, env);
    assertMarkers(markers, ["server.marker"], "V1");
    return;
  }

  let primaryFailure: unknown;
  try {
    run(binary, ["debug", "config"], project, env);
    run(binary, ["plugin", "list"], project, env);
    waitForMarker(markers, "setup.marker");
    assertMarkers(markers, ["setup.marker"], "V2 before shutdown");
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      run(binary, ["service", "stop"], project, env);
      waitForMarker(markers, "cleanup.marker");
      assertMarkers(markers, ["setup.marker", "cleanup.marker"], "V2 after shutdown");
    } catch (stopFailure) {
      if (!primaryFailure) throw stopFailure;
      console.error(`V2 service stop or cleanup also failed: ${String(stopFailure)}`);
    }
  }
  if (primaryFailure) throw primaryFailure;
}

if (!existsSync(DIST)) throw new Error(`missing built production entrypoint: ${DIST}`);

const parent = join(tmpdir(), "opencode");
mkdirSync(parent, { recursive: true });
const sandbox = mkdtempSync(join(parent, "stm-production-host-load-"));
console.log(`sandbox: ${sandbox}`);
try {
  for (const host of HOSTS) runHost(join(sandbox, host.generation.toLowerCase()), host);
  rmSync(sandbox, { recursive: true, force: true });
  console.log(`VERDICT: PASS; removed successful sandbox ${sandbox}`);
} catch (error) {
  console.error(`VERDICT: FAIL; retained evidence at ${sandbox}`);
  throw error;
}
