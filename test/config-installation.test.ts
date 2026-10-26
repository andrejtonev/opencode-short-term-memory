import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapInstalledConfig,
  createProjectExampleConfig,
  readConfig,
  readConfigDiagnostics,
  readText,
  resolveProjectOpencodeDir,
  writeText,
} from "../src/memory-utils";
import SessionMemoryPlugin from "../src/v1-adapter";
import { createFakeClient } from "./test-helpers";
import { supportsFileSymlinks } from "./platform-capabilities";

const STM = "@atonev/opencode-short-term-memory@1.4.0-rc.7";

describe("installation-scoped STM configuration", () => {
  const originalCwd = process.cwd();
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let directory: string;
  let globalDirectory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stm-config-installation-"));
    process.chdir(directory);
    process.env.XDG_CONFIG_HOME = join(directory, "xdg");
    globalDirectory = join(process.env.XDG_CONFIG_HOME, "opencode");
    process.env.OPENCODE_CONFIG_DIR = join(directory, "env-config");
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    await rm(directory, { recursive: true, force: true });
  });

  test("local first activation creates sparse JSON at the installation root and preserves inherited settings", async () => {
    const project = join(directory, "project");
    await writeText(join(globalDirectory, "stm.json"), '{"memoryModel":"example/model","enabled":false}');
    await writeText(join(process.env.OPENCODE_CONFIG_DIR!, "stm.json"), '{"remindEveryN":17}');
    const before = await readConfig(undefined, project);
    const plugin = (await SessionMemoryPlugin({ client: createFakeClient() as any, directory: project })) as any;
    const origin = { spec: STM, source: join(project, ".opencode", "opencode.json"), scope: "local" };
    await plugin.config({ plugin_origins: [origin] });

    expect(await readFile(join(project, ".opencode", "stm.json"), "utf8")).toBe("{}\n");
    expect(await readConfig(undefined, project)).toEqual(before);
    const settings = JSON.parse(String(await plugin.tool.stm_memory_settings.execute({}, {})));
    expect(settings.configuration.installation.status).toBe("created");
    expect(settings.configuration.installation.scope).toBe("local");
    expect(settings.configuration.configFiles).toContain(join(project, ".opencode", "stm.json"));
    const status = String(await plugin.tool.stm_memory_status.execute({}, {}));
    expect(status).toContain(`Created local STM config at ${join(project, ".opencode", "stm.json")}`);
  });

  test("global first activation creates only the selected global config", async () => {
    const project = join(directory, "project");
    const plugin = (await SessionMemoryPlugin({ client: createFakeClient() as any, directory: project })) as any;
    await plugin.config({
      plugin_origins: [{ spec: STM, source: join(globalDirectory, "opencode.jsonc"), scope: "global" }],
    });
    await plugin.tool.stm_memory_status.execute({}, {});
    expect(await readFile(join(globalDirectory, "stm.json"), "utf8")).toBe("{}\n");
    expect(await readText(join(project, ".opencode", "stm.json"), "missing")).toBe("missing");
    expect(await readText(join(process.env.OPENCODE_CONFIG_DIR!, "stm.json"), "missing")).toBe("missing");
  });

  test("automatic bootstrap and confirmed example setup share directory ownership", async () => {
    const origin = { spec: STM, source: join(directory, ".opencode", "opencode.json"), scope: "local" };
    const [bootstrap, example] = await Promise.all([
      bootstrapInstalledConfig([origin]),
      createProjectExampleConfig(directory),
    ]);
    expect(Number(bootstrap.status === "created") + Number(example.created)).toBe(1);
    const diagnostics = await readConfigDiagnostics(directory);
    expect(diagnostics.configFiles.filter((path) => path.startsWith(join(directory, ".opencode")))).toHaveLength(1);
    expect(bootstrap.status === "existing" || !example.created).toBe(true);
  });

  test.skipIf(process.platform !== "win32")(
    "case-aliased Windows bootstrap and example setup create only one config and preserve its bytes",
    async () => {
      const alias = directory.toUpperCase();
      // Verify this fixture uses the supported case-insensitive directory
      // contract, rather than claiming aliases on case-sensitive Windows dirs.
      await writeFile(join(directory, "case-probe"), "same-directory");
      expect(await readText(join(alias, "case-probe"), "")).toBe("same-directory");
      const origin = { spec: STM, source: join(directory, "opencode.json"), scope: "local" };
      const [bootstrap, example] = await Promise.all([
        bootstrapInstalledConfig([origin]),
        createProjectExampleConfig(alias),
      ]);
      expect(Number(bootstrap.status === "created") + Number(example.created)).toBe(1);
      const configDir = join(directory, ".opencode");
      const files = (await readdir(configDir)).filter((file) => file === "stm.json" || file === "stm.jsonc");
      expect(files).toHaveLength(1);
      const selectedPath = join(configDir, files[0]!);
      await writeFile(selectedPath, '{"enabled":false,"remindEveryN":17}\n');
      expect((await bootstrapInstalledConfig([origin])).status).toBe("existing");
      expect((await createProjectExampleConfig(alias)).created).toBe(false);
      expect(await readFile(selectedPath, "utf8")).toBe('{"enabled":false,"remindEveryN":17}\n');
      expect(await readConfig(undefined, directory)).toMatchObject({ enabled: false, remindEveryN: 17 });
    },
  );

  test("native global directory provenance creates config in that directory rather than its parent", async () => {
    const result = await bootstrapInstalledConfig([{ spec: STM, source: globalDirectory, scope: "global" }]);
    expect(result).toMatchObject({ status: "created", scope: "global", configPath: join(globalDirectory, "stm.json") });
    expect(await readFile(join(globalDirectory, "stm.json"), "utf8")).toBe("{}\n");
    expect(await readText(join(process.env.XDG_CONFIG_HOME!, "stm.json"), "missing")).toBe("missing");
  });

  test("manual project-root configuration creates STM in the project .opencode directory", async () => {
    const result = await bootstrapInstalledConfig([
      { spec: [STM, {}], source: join(directory, "opencode.json"), scope: "local" },
    ]);
    expect(result).toMatchObject({
      status: "created",
      scope: "local",
      configPath: join(directory, ".opencode", "stm.json"),
    });
    expect(await readText(join(directory, "stm.json"), "missing")).toBe("missing");
  });

  test("scoped registration does not wait for unrelated host orphan-cleanup requests", async () => {
    const client = createFakeClient();
    let finishCleanup!: () => void;
    let cleanupStarted!: () => void;
    const cleanupPending = new Promise<void>((resolve) => (finishCleanup = resolve));
    const cleanupAdmission = new Promise<void>((resolve) => (cleanupStarted = resolve));
    client.session.list = async () => {
      cleanupStarted();
      await cleanupPending;
      return { data: [] };
    };
    const plugin = (await SessionMemoryPlugin({ client: client as any, directory })) as any;
    const registration = plugin.config({
      plugin_origins: [{ spec: STM, source: join(globalDirectory, "opencode.json"), scope: "global" }],
    });
    await cleanupAdmission;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), 1_000)));
      expect(await Promise.race([registration.then(() => true), timeout])).toBe(true);
    } finally {
      clearTimeout(timer);
      finishCleanup();
      await registration;
      await plugin.tool.stm_memory_status.execute({}, {});
    }
  });

  test("last matching provenance selects local scope without writing the global scope", async () => {
    const result = await bootstrapInstalledConfig([
      { spec: STM, source: join(globalDirectory, "opencode.json"), scope: "global" },
      { spec: "another-plugin", source: join(globalDirectory, "opencode.json"), scope: "global" },
      { spec: STM, source: join(directory, ".opencode", "opencode.json"), scope: "local" },
    ]);
    expect(result.scope).toBe("local");
    expect(await readText(join(globalDirectory, "stm.json"), "missing")).toBe("missing");
  });

  test("an environment-directory origin preserves global defaults and creates only its scoped starter", async () => {
    await writeText(join(globalDirectory, "stm.json"), '{"enabled":false,"memoryModel":"example/model"}');
    const before = await readConfig(undefined, directory);
    const configDirectory = process.env.OPENCODE_CONFIG_DIR!;
    const result = await bootstrapInstalledConfig([{ spec: STM, source: configDirectory, scope: "global" }]);
    expect(result).toMatchObject({ status: "created", scope: "global", configPath: join(configDirectory, "stm.json") });
    expect(await readConfig(undefined, directory)).toEqual(before);
    expect(await readFile(join(globalDirectory, "stm.json"), "utf8")).toBe(
      '{"enabled":false,"memoryModel":"example/model"}',
    );
    expect(await readText(join(directory, ".opencode", "stm.json"), "missing")).toBe("missing");
  });

  for (const fileName of ["stm.json", "stm.jsonc"]) {
    test(`preserves existing ${fileName} even when malformed and never creates its sibling`, async () => {
      const configPath = join(directory, ".opencode", fileName);
      const content = "{ deliberately incomplete user configuration";
      await writeText(configPath, content);
      const result = await bootstrapInstalledConfig([
        { spec: STM, source: join(directory, ".opencode", "opencode.json"), scope: "local" },
      ]);
      expect(result).toMatchObject({ status: "existing", configPath });
      expect(await readFile(configPath, "utf8")).toBe(content);
      const sibling = fileName === "stm.json" ? "stm.jsonc" : "stm.json";
      expect(await readText(join(directory, ".opencode", sibling), "missing")).toBe("missing");
      const details = await readConfigDiagnostics(directory);
      expect(details.configFiles).toContain(configPath);
      expect(details.configSources.find((source) => source.scope === "project")?.selectedPath).toBeUndefined();
    });
  }

  test("repeated and concurrent activation never replaces edited configuration", async () => {
    const origin = [{ spec: STM, source: join(directory, ".opencode", "opencode.json"), scope: "local" }];
    const results = await Promise.all(Array.from({ length: 8 }, () => bootstrapInstalledConfig(origin)));
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "existing")).toHaveLength(7);
    const configPath = join(directory, ".opencode", "stm.json");
    await writeFile(configPath, '{"debug":true}\n');
    expect((await bootstrapInstalledConfig(origin)).status).toBe("existing");
    expect(await readFile(configPath, "utf8")).toBe('{"debug":true}\n');
  });

  test("filesystem creation failure is reported and does not fail the config hook", async () => {
    await writeFile(join(directory, ".opencode"), "this is a file");
    const plugin = (await SessionMemoryPlugin({ client: createFakeClient() as any, directory })) as any;
    await expect(
      plugin.config({ plugin_origins: [{ spec: STM, source: join(directory, "opencode.json"), scope: "local" }] }),
    ).resolves.toBeUndefined();
    const settings = JSON.parse(String(await plugin.tool.stm_memory_settings.execute({}, {})));
    expect(settings.configuration.installation.status).toBe("error");
    expect(settings.configuration.installation.message).toContain("Existing settings and defaults remain available");
    expect(await readFile(join(directory, ".opencode"), "utf8")).toBe("this is a file");
  });

  test("unknown, inline, remote and unsupported global origins never guess a write target", async () => {
    for (const origins of [
      undefined,
      [{ spec: "another-plugin", source: join(globalDirectory, "opencode.json"), scope: "global" }],
      [{ spec: STM, source: "OPENCODE_CONFIG_CONTENT", scope: "local" }],
      [{ spec: STM, source: "https://example.com/opencode.json", scope: "global" }],
      [{ spec: STM, source: join(directory, "unrecognized", "config.json"), scope: "global" }],
    ]) {
      expect((await bootstrapInstalledConfig(origins)).status).toBe("skipped");
    }
    expect(await readText(join(directory, ".opencode", "stm.json"), "missing")).toBe("missing");
    expect(await readText(join(globalDirectory, "stm.json"), "missing")).toBe("missing");
  });

  test("read-only discovery does not materialize configuration", async () => {
    const before = await readConfig(undefined, directory);
    const details = await readConfigDiagnostics(directory);
    expect(details.configPaths).toContain(join(await resolveProjectOpencodeDir(directory), "stm.json"));
    expect(await readConfig(undefined, directory)).toEqual(before);
    expect(await readText(join(directory, ".opencode", "stm.json"), "missing")).toBe("missing");
  });

  test.skipIf(!supportsFileSymlinks)("preserves a dangling user config symlink", async () => {
    const configPath = join(directory, ".opencode", "stm.json");
    await writeText(join(directory, ".opencode", "sentinel"), "preserve");
    await symlink(join(directory, "missing-target"), configPath);
    const result = await bootstrapInstalledConfig([
      { spec: STM, source: join(directory, ".opencode", "opencode.json"), scope: "local" },
    ]);
    expect(result).toMatchObject({ status: "existing", configPath });
    expect(await readText(join(directory, "missing-target"), "missing")).toBe("missing");
  });
});
