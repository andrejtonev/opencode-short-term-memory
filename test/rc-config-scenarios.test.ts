import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  buildConfigScenario,
  CONFIG_SCENARIO_IDS,
  expectedSettingsMetadata,
  KNOWN_DEFAULT_CONFIG17,
  type ConfigGeneration,
  type ConfigScenario,
  type ConfigScenarioPaths,
  type PlannedConfigFile,
  type SettingsMetadata,
} from "../scripts/rc-config-scenarios";
import type { V2Context } from "../src/v2-adapter";
import type { Client } from "../src/types";

const CONFIG_KEYS = Object.keys(KNOWN_DEFAULT_CONFIG17).sort();
const REPO_ROOT = resolve(import.meta.dir, "..");
const BUN_PATH = process.execPath;
const CHILD_SCRIPT = `
  const payload = JSON.parse(process.argv.at(-1));
  const { pathToFileURL } = await import("node:url");
  const root = payload.repoRoot;
  const { readConfig } = await import(pathToFileURL(root + "/src/memory-utils.ts").href);
  const { executeMemoryAction } = await import(pathToFileURL(root + "/src/commands.ts").href);
  const { createV2MemoryActions } = await import(pathToFileURL(root + "/src/v2-memory-tools.ts").href);
  const actualConfig = await readConfig(undefined, payload.launchDirectory);
  const v1Context = {
    config: actualConfig,
    baseDir: payload.launchDirectory,
    sessionStates: new Map(),
    globalState: { updateCount: 0, injectCount: 0, injectCharCount: 0, compactCount: 0 },
  };
  const v1Raw = await executeMemoryAction("settings", undefined, v1Context, {}, async () => undefined);
  const v2Actions = createV2MemoryActions({ location: { directory: payload.launchDirectory } });
  const v2Raw = await v2Actions.settings("scenario");
  process.stdout.write(JSON.stringify({
    actualConfig,
    v1Settings: JSON.parse(v1Raw),
    v2Settings: JSON.parse(v2Raw),
    homedir: (await import("node:os")).homedir(),
  }));
`;

describe("independent RC configuration scenarios", () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stm-rc-config-scenarios-"));
    process.env.HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    process.env.OPENCODE_CONFIG_DIR = join(root, "env-config");
    await mkdir(join(root, "project"), { recursive: true });
    process.chdir(join(root, "project"));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    await rm(root, { recursive: true, force: true });
  });

  function scenarioPaths(): ConfigScenarioPaths {
    return {
      globalConfigDirectory: join(root, "xdg", "opencode"),
      legacyGlobalDirectory: join(root, "home", ".opencode"),
      environmentConfigDirectory: join(root, "env-config"),
      projectDirectory: join(root, "project"),
      memoryDirectory: join(root, "memory"),
    };
  }

  function assertOwnedPath(path: string) {
    const rel = relative(root, path);
    expect(isAbsolute(path) ? rel.startsWith("..") || isAbsolute(rel) : false).toBe(false);
  }

  async function observeInFreshChild(scenario: ConfigScenario, expectedHome: string) {
    const payload = JSON.stringify({
      repoRoot: REPO_ROOT,
      launchDirectory: scenario.launchDirectory,
    });
    const child = Bun.spawn([BUN_PATH, "-e", CHILD_SCRIPT, "--", payload], {
      cwd: scenario.launchDirectory,
      env: {
        ...process.env,
        HOME: expectedHome,
        USERPROFILE: expectedHome,
        XDG_CONFIG_HOME: join(root, "xdg"),
        OPENCODE_CONFIG_DIR: join(root, "env-config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let settled = false;
    try {
      const result = await Promise.race([
        (async () => ({
          exitCode: await child.exited,
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
        }))(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("config observer timed out after 2s")), 2000),
        ),
      ]);
      settled = true;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout, result.stderr).not.toBe("");
      const observation = JSON.parse(result.stdout) as {
        actualConfig: SessionMemoryConfig;
        v1Settings: Record<string, unknown>;
        v2Settings: { effective: Record<string, unknown> };
        homedir: string;
      };
      expect(observation.homedir).toBe(expectedHome);
      return observation;
    } finally {
      if (!settled) child.kill();
      await child.exited;
    }
  }

  async function materialize(scenario: ConfigScenario) {
    for (const directory of scenario.directoriesToCreate) {
      assertOwnedPath(directory);
      await mkdir(directory, { recursive: true });
    }
    for (const planned of scenario.plannedFiles) {
      assertOwnedPath(planned.path);
      if (planned.content === null) {
        await rm(planned.path, { force: true });
        continue;
      }
      await mkdir(join(planned.path, ".."), { recursive: true });
      await writeFile(planned.path, planned.content, "utf8");
    }
  }

  function assertConfig17(actual: SessionMemoryConfig, expected: SessionMemoryConfig, label: string) {
    expect(Object.keys(actual).sort(), `${label}: normalized keyset`).toEqual(CONFIG_KEYS);
    expect(actual, `${label}: normalized config`).toEqual(expected);
  }

  function parseV1Metadata(
    value: SessionMemoryConfig & {
      effectiveDeliveryMode: SettingsMetadata["effectiveDeliveryMode"];
      memoryModelSelection: SettingsMetadata["memoryModelSelection"];
    },
  ): SettingsMetadata {
    return {
      memoryModelSelection: value.memoryModelSelection,
      effectiveDeliveryMode: value.effectiveDeliveryMode,
      effectiveMemoryModel: value.memoryModelSelection === "explicit-override" ? value.memoryModel : null,
    };
  }

  function parseV2Metadata(value: {
    effective: {
      memoryModel: string | null;
      memoryModelSelection: SettingsMetadata["memoryModelSelection"];
      enableLegacyPeriodicSystemTransform: boolean;
    };
  }): SettingsMetadata {
    return {
      memoryModelSelection: value.effective.memoryModelSelection,
      effectiveDeliveryMode: value.effective.enableLegacyPeriodicSystemTransform
        ? "legacySystemTransform"
        : "promptNoReply",
      effectiveMemoryModel: value.effective.memoryModel,
    };
  }

  for (const id of CONFIG_SCENARIO_IDS) {
    for (const generation of ["v1", "v2"] as const) {
      test(`${id} resolves all 17 fields and ${generation} settings metadata`, async () => {
        const scenario = buildConfigScenario(id, scenarioPaths(), generation);
        await materialize(scenario);

        const observation = await observeInFreshChild(scenario, join(root, "home"));
        assertConfig17(observation.actualConfig, scenario.expectedConfig17, `${id}/${generation}`);
        expect(parseV1Metadata(observation.v1Settings), `${id}/${generation}: V1 settings metadata`).toEqual(
          expectedSettingsMetadata("v1", observation.actualConfig),
        );
        expect(parseV2Metadata(observation.v2Settings), `${id}/${generation}: V2 settings metadata`).toEqual(
          expectedSettingsMetadata("v2", observation.actualConfig),
        );
        expect(scenario.expectedSettingsMetadata).toEqual(
          expectedSettingsMetadata(generation, observation.actualConfig),
        );
      });
    }
  }

  test("hot-reload observes the edited 17-field config without waiting", async () => {
    for (const generation of ["v1", "v2"] as const) {
      const scenario = buildConfigScenario("hot-reload", scenarioPaths(), generation);
      await materialize(scenario);
      const mutation = scenario.hotReload!.mutationFiles[0] as PlannedConfigFile;
      await writeFile(mutation.path, mutation.content!, "utf8");
      const observation = await observeInFreshChild(scenario, join(root, "home"));
      assertConfig17(observation.actualConfig, scenario.hotReload!.expectedAfterEdit17, `${generation}/after-edit`);
      expect(scenario.hotReload!.waitMsByGeneration[generation]).toBe(generation === "v1" ? 61000 : 0);
      expect(scenario.hotReload!.immediateByGeneration[generation]).toEqual(
        generation === "v1" ? scenario.expectedConfig17 : scenario.hotReload!.expectedAfterEdit17,
      );
    }
  });
});
