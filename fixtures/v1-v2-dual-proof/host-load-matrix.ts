import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BUN = process.execPath;
const HOSTS = [
  {
    generation: "V1",
    packageName: "opencode-ai",
    version: "1.14.25",
    binary: ["node_modules", "opencode-ai", "bin", ".opencode"],
    expectedMarker: "server.marker",
  },
  {
    generation: "V2",
    packageName: "@opencode/cli",
    version: "2.0.8",
    binary: ["node_modules", "@opencode", "cli", "bin", "opencode.exe"],
    expectedMarker: "setup.marker",
  },
] as const;

function run(
  command: string,
  args: string[],
  cwd: string,
  env = process.env,
  acceptedStatuses: readonly number[] = [0],
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const rendered = [command, ...args].join(" ");
  console.log(`$ ${rendered}`);
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.log(result.stderr.trim());
  if (result.error) throw result.error;
  if (!acceptedStatuses.includes(result.status ?? -1)) {
    throw new Error(`${rendered} exited with status ${String(result.status)}`);
  }
  return result;
}

function isolatedEnvironment(root: string, markerDirectory: string) {
  const directories = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"),
  };
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
  return {
    ...directories,
    PATH: "/home/dev/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    NO_COLOR: "1",
    STM_HOST_MARKER_DIR: markerDirectory,
  };
}

function installHost(root: string, host: (typeof HOSTS)[number]) {
  const installDirectory = join(root, "install");
  mkdirSync(installDirectory, { recursive: true });
  writeFileSync(
    join(installDirectory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        trustedDependencies: [host.packageName],
        dependencies: { [host.packageName]: host.version },
      },
      null,
      2,
    )}\n`,
  );
  run(BUN, ["install", "--exact"], installDirectory);

  const packageJsonPath = join(installDirectory, "node_modules", ...host.packageName.split("/"), "package.json");
  const installedVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
  if (installedVersion !== host.version) {
    throw new Error(`${host.generation} installed ${String(installedVersion)}, expected ${host.version}`);
  }
  return join(installDirectory, ...host.binary);
}

function runHost(root: string, host: (typeof HOSTS)[number]) {
  const markerDirectory = join(root, "markers");
  const projectDirectory = join(root, "project");
  mkdirSync(markerDirectory, { recursive: true });
  mkdirSync(projectDirectory, { recursive: true });

  const pluginDirectory = join(projectDirectory, "dual-host-proof");
  const pluginPath = join(pluginDirectory, "index.js");
  mkdirSync(pluginDirectory);
  writeFileSync(join(pluginDirectory, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    pluginPath,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";

const markers = process.env.STM_HOST_MARKER_DIR;
if (!markers) throw new Error("STM_HOST_MARKER_DIR is required");

export default {
  id: "opencode-short-term-memory-host-load-proof",
  async server() {
    writeFileSync(join(markers, "server.marker"), "V1 server selected\\n");
    return {};
  },
  async setup() {
    writeFileSync(join(markers, "setup.marker"), "V2 setup selected\\n");
  },
};
`,
  );
  writeFileSync(
    join(projectDirectory, "opencode.json"),
    `${JSON.stringify(
      {
        [host.generation === "V1" ? "plugin" : "plugins"]: [
          host.generation === "V1" ? pathToFileURL(pluginPath).href : pluginDirectory,
        ],
      },
      null,
      2,
    )}\n`,
  );

  const binary = installHost(root, host);
  const env = isolatedEnvironment(root, markerDirectory);
  let result: ReturnType<typeof run> | undefined;
  if (host.generation === "V2") {
    let primaryFailure: unknown;
    let failed = false;
    try {
      result = run(binary, ["debug", "config"], projectDirectory, env);
      run(binary, ["plugin", "list"], projectDirectory, env);
    } catch (error) {
      failed = true;
      primaryFailure = error;
    } finally {
      try {
        run(binary, ["service", "stop"], projectDirectory, env);
      } catch (cleanupError) {
        if (!failed) throw cleanupError;
      }
    }
    if (failed) throw primaryFailure;
    if (result === undefined) throw new Error("V2 debug config did not produce a result");
  } else {
    result = run(binary, ["debug", "config"], projectDirectory, env);
  }
  const markers = ["server.marker", "setup.marker"].filter((marker) => existsSync(join(markerDirectory, marker)));
  if (markers.length !== 1 || markers[0] !== host.expectedMarker) {
    throw new Error(
      `${host.generation} produced markers [${markers.join(", ")}], expected only ${host.expectedMarker}`,
    );
  }
  console.log(
    `${host.generation} ${host.packageName}@${host.version}: ${host.expectedMarker} (${readFileSync(
      join(markerDirectory, host.expectedMarker),
      "utf8",
    ).trim()})`,
  );
  return result;
}

const sandboxParent = join(tmpdir(), "opencode");
mkdirSync(sandboxParent, { recursive: true });
const sandbox = mkdtempSync(join(sandboxParent, "stm-v1-v2-host-load-"));
console.log(`sandbox: ${sandbox}`);
try {
  for (const host of HOSTS) {
    console.log(`\n=== ${host.generation}: ${host.packageName}@${host.version} ===`);
    runHost(join(sandbox, host.generation.toLowerCase()), host);
  }
  console.log("\nVERDICT: PASS - V1 selected server only; V2 selected setup only.");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
  console.log(`cleanup: removed ${sandbox}`);
}
