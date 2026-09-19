import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const BUN = process.execPath;
const FIXTURE = import.meta.dir;
const HOSTS = [
  {
    generation: "V1",
    packageName: "opencode-ai",
    version: "1.14.25",
    binary: ["bin", ".opencode"],
    marker: "server.marker",
  },
  {
    generation: "V2",
    packageName: "@opencode/cli",
    version: "2.0.8",
    binary: ["bin", "opencode.exe"],
    marker: "setup.marker",
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
    PATH: [dirname(BUN), process.env.PATH].filter(Boolean).join(delimiter),
    NO_COLOR: "1",
    STM_HOST_MARKER_DIR: markers,
  };
  for (const directory of new Set(Object.values(env).filter((value) => value.startsWith(root)))) {
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
  run(BUN, ["install", "--exact"], install, env);
  const packageRoot = join(install, "node_modules", ...host.packageName.split("/"));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
  if (manifest.version !== host.version) throw new Error(`installed ${manifest.version}, expected ${host.version}`);
  return join(packageRoot, ...host.binary);
}

function runHost(root: string, host: (typeof HOSTS)[number]) {
  const markers = join(root, "markers");
  const project = join(root, "project");
  mkdirSync(markers, { recursive: true });
  mkdirSync(project, { recursive: true });
  const plugin = host.generation === "V1" ? pathToFileURL(join(FIXTURE, "index.ts")).href : FIXTURE;
  writeFileSync(
    join(project, "opencode.json"),
    `${JSON.stringify({ [host.generation === "V1" ? "plugin" : "plugins"]: [plugin] })}\n`,
  );
  const env = isolatedEnvironment(root, markers);
  const binary = installHost(root, host, env);

  if (host.generation === "V2") {
    let primaryFailure: unknown;
    try {
      run(binary, ["debug", "config"], project, env);
      run(binary, ["plugin", "list"], project, env);
    } catch (error) {
      primaryFailure = error;
    } finally {
      try {
        run(binary, ["service", "stop"], project, env);
      } catch (stopFailure) {
        if (!primaryFailure) throw stopFailure;
        console.error(`V2 service stop also failed: ${String(stopFailure)}`);
      }
    }
    if (primaryFailure) throw primaryFailure;
  } else {
    run(binary, ["debug", "config"], project, env);
  }

  const observed = ["server.marker", "setup.marker"].filter((marker) => existsSync(join(markers, marker)));
  if (observed.length !== 1 || observed[0] !== host.marker) {
    throw new Error(`${host.generation} markers: [${observed.join(", ")}], expected only ${host.marker}`);
  }
  console.log(`${host.generation} ${host.packageName}@${host.version}: only ${host.marker}`);
}

const parent = join(tmpdir(), "opencode");
mkdirSync(parent, { recursive: true });
const sandbox = mkdtempSync(join(parent, "stm-v1-v2-host-load-"));
console.log(`sandbox: ${sandbox}`);
try {
  for (const host of HOSTS) runHost(join(sandbox, host.generation.toLowerCase()), host);
  rmSync(sandbox, { recursive: true, force: true });
  console.log(`VERDICT: PASS; removed successful sandbox ${sandbox}`);
} catch (error) {
  console.error(`VERDICT: FAIL; retained evidence at ${sandbox}`);
  throw error;
}
