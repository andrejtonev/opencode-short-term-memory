import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { readConfig } from "../src/memory-utils";
import { bootstrapV2InstalledConfig, getV2ConfigInstallation } from "../src/v2-config-installation";
import { supportsFileSymlinks } from "./platform-capabilities";

const STM = "@atonev/opencode-short-term-memory@1.4.0-rc.11";

describe("V2 installation-scoped config bootstrap", () => {
  const originalCwd = process.cwd();
  const originalEnvironment = new Map<string, string | undefined>();
  let root: string;
  let project: string;
  let globalDirectory: string;
  let context: Context;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stm-v2-config-installation-"));
    project = join(root, "workspace");
    globalDirectory = join(root, "xdg", "opencode");
    await mkdir(project, { recursive: true });
    for (const name of [
      "XDG_CONFIG_HOME",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_PROJECT_DISABLE",
      "OPENCODE_CONFIG_GLOBAL_DISABLE",
    ]) {
      originalEnvironment.set(name, process.env[name]);
      delete process.env[name];
    }
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    process.chdir(project);
    context = { location: { directory: project } } as Context;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originalEnvironment.clear();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("a global JSONC package declaration creates a sparse config at the native global root", async () => {
    await writeConfig(
      join(globalDirectory, "opencode.jsonc"),
      `{
        // Native JSONC comments and trailing commas are supported.
        "plugins": ["${STM}",],
      }`,
    );

    const result = await bootstrapV2InstalledConfig(context);

    expect(result).toMatchObject({ status: "created", scope: "global", configPath: join(globalDirectory, "stm.json") });
    expect(await readFile(join(globalDirectory, "stm.json"), "utf8")).toBe("{}\n");
    expect(getV2ConfigInstallation(context)).toEqual(result);
  });

  test("a local static package declaration creates config in the exact project settings directory", async () => {
    await writeConfig(
      join(project, ".opencode", "opencode.json"),
      JSON.stringify({ plugins: [{ package: STM, options: { mode: "local" } }] }),
    );
    await writeConfig(join(globalDirectory, "stm.json"), '{"enabled":false,"remindEveryN":19}');
    const before = await readConfig(undefined, project);

    const result = await bootstrapV2InstalledConfig(context);

    expect(result).toMatchObject({
      status: "created",
      scope: "local",
      configPath: join(project, ".opencode", "stm.json"),
    });
    expect(await readFile(join(project, ".opencode", "stm.json"), "utf8")).toBe("{}\n");
    expect(await readConfig(undefined, project)).toEqual(before);
  });

  test("a local direct config targets the project's searched .opencode directory", async () => {
    await mkdir(join(project, ".opencode"), { recursive: true });
    await writeConfig(join(project, "opencode.jsonc"), `{"plugins":["${STM}",],}`);

    const result = await bootstrapV2InstalledConfig(context);

    expect(result).toMatchObject({
      status: "created",
      scope: "local",
      configPath: join(project, ".opencode", "stm.json"),
    });
  });

  test("native later removal cancels a global declaration without creating local config", async () => {
    const unversioned = "@atonev/opencode-short-term-memory";
    await writeConfig(join(globalDirectory, "opencode.json"), JSON.stringify({ plugins: [unversioned] }));
    await writeConfig(join(project, ".opencode", "opencode.jsonc"), JSON.stringify({ plugins: [`-${unversioned}`] }));

    const result = await bootstrapV2InstalledConfig(context);

    expect(result.status).toBe("skipped");
    expect(await exists(join(globalDirectory, "stm.json"))).toBe(false);
    expect(await exists(join(project, ".opencode", "stm.json"))).toBe(false);
  });

  test("duplicate active declarations are ambiguous and do not choose a scope", async () => {
    await writeConfig(join(globalDirectory, "opencode.json"), JSON.stringify({ plugins: [STM] }));
    await writeConfig(join(project, ".opencode", "opencode.json"), JSON.stringify({ plugins: [STM] }));

    const result = await bootstrapV2InstalledConfig(context);

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("More than one active STM package declaration");
    expect(await exists(join(globalDirectory, "stm.json"))).toBe(false);
    expect(await exists(join(project, ".opencode", "stm.json"))).toBe(false);
  });

  test("an ancestor local declaration outside readConfig's nearest directory is skipped", async () => {
    const outerProject = join(root, "outer");
    const nestedProject = join(outerProject, "nested");
    await mkdir(join(nestedProject, ".opencode"), { recursive: true });
    await writeConfig(join(outerProject, ".opencode", "opencode.json"), JSON.stringify({ plugins: [STM] }));
    context = { location: { directory: nestedProject } } as Context;

    const result = await bootstrapV2InstalledConfig(context);

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("does not map to a directory read by STM config discovery");
    expect(await exists(join(outerProject, ".opencode", "stm.json"))).toBe(false);
    expect(await exists(join(nestedProject, ".opencode", "stm.json"))).toBe(false);
  });

  test("explicit and virtual config sources skip without creating files", async () => {
    await writeConfig(join(globalDirectory, "opencode.json"), JSON.stringify({ plugins: [STM] }));
    for (const [name, value] of [
      ["OPENCODE_CONFIG", join(root, "explicit.json")],
      ["OPENCODE_CONFIG_CONTENT", JSON.stringify({ plugins: [STM] })],
    ] as const) {
      process.env[name] = value;
      expect((await bootstrapV2InstalledConfig(context)).status).toBe("skipped");
      delete process.env[name];
    }
    expect(await exists(join(globalDirectory, "stm.json"))).toBe(false);
  });

  test("native project discovery disable flag skips a declaration in project config", async () => {
    await writeConfig(join(project, ".opencode", "opencode.json"), JSON.stringify({ plugins: [STM] }));
    process.env.OPENCODE_CONFIG_PROJECT_DISABLE = "1";

    const result = await bootstrapV2InstalledConfig(context);

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("project config discovery is disabled");
    expect(await exists(join(project, ".opencode", "stm.json"))).toBe(false);
  });

  test("substitution targets and malformed native JSONC are skipped", async () => {
    await writeConfig(join(globalDirectory, "opencode.json"), JSON.stringify({ plugins: ["${STM_PLUGIN}"] }));
    expect((await bootstrapV2InstalledConfig(context)).status).toBe("skipped");
    await rm(join(globalDirectory, "opencode.json"), { force: true });
    await writeConfig(join(globalDirectory, "opencode.jsonc"), '{ "plugins": ["@atonev/opencode-short-term-memory", ');
    expect((await bootstrapV2InstalledConfig(context)).status).toBe("skipped");
    expect(await exists(join(globalDirectory, "stm.json"))).toBe(false);
  });

  test.skipIf(!supportsFileSymlinks)("a symlinked native config document is skipped", async () => {
    const target = join(root, "target.json");
    await writeConfig(target, JSON.stringify({ plugins: [STM] }));
    await mkdir(globalDirectory, { recursive: true });
    await symlink(target, join(globalDirectory, "opencode.json"));

    const result = await bootstrapV2InstalledConfig(context);

    expect(result.status).toBe("skipped");
    expect(await exists(join(globalDirectory, "stm.json"))).toBe(false);
  });

  test("a native plugin source directory makes configured provenance ambiguous", async () => {
    await writeConfig(join(globalDirectory, "opencode.json"), JSON.stringify({ plugins: [STM] }));
    await mkdir(join(globalDirectory, "plugins"), { recursive: true });

    const result = await bootstrapV2InstalledConfig(context);

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("plugin source directory");
    expect(await exists(join(globalDirectory, "stm.json"))).toBe(false);
  });
});

async function writeConfig(path: string, contents: string): Promise<void> {
  const directory = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
  await mkdir(directory, { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
