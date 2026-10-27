import type { SessionMemoryConfig } from "../src/memory-utils";

export const CONFIG_SCENARIO_IDS = [
  "defaults",
  "layer-home",
  "layer-env",
  "layer-project",
  "jsonc-precedence",
  "jsonc-empty",
  "jsonc-rejected",
  "mode-typo",
  "mode-whitespace",
  "normalization",
  "invalid-overrides",
  "model-invalid",
  "malformed-recovery",
  "nearest-inherits",
  "nearest-empty",
  "hot-reload",
] as const;

export type ConfigScenarioId = (typeof CONFIG_SCENARIO_IDS)[number];
export type ConfigGeneration = "v1" | "v2";

export interface ConfigScenarioPaths {
  readonly globalConfigDirectory: string;
  readonly legacyGlobalDirectory: string;
  readonly environmentConfigDirectory: string;
  readonly projectDirectory: string;
  readonly memoryDirectory: string;
}

export interface PlannedConfigFile {
  readonly path: string;
  readonly content: string | null;
}

export interface SettingsMetadata {
  readonly memoryModelSelection:
    | "host-default"
    | "explicit-override"
    | "invalid-override"
    | "inherited-current-session"
    | "current-session"
    | "active-override-unsupported";
  readonly effectiveDeliveryMode: "legacySystemTransform" | "promptNoReply";
  readonly effectiveMemoryModel: string | null;
}

export interface HotReloadExpectations {
  readonly mutationFiles: readonly PlannedConfigFile[];
  readonly expectedAfterEdit17: SessionMemoryConfig;
  readonly immediateByGeneration: Readonly<Record<ConfigGeneration, SessionMemoryConfig>>;
  readonly waitMsByGeneration: Readonly<Record<ConfigGeneration, number>>;
}

export interface ConfigScenario {
  readonly id: ConfigScenarioId;
  readonly plannedFiles: readonly PlannedConfigFile[];
  readonly directoriesToCreate: readonly string[];
  readonly launchDirectory: string;
  readonly environmentConfigDir?: string;
  readonly expectedConfig17: SessionMemoryConfig;
  readonly expectedSettingsMetadata: SettingsMetadata;
  readonly knownIssues: readonly string[];
  readonly hotReload?: HotReloadExpectations;
}

export const KNOWN_DEFAULT_CONFIG17: SessionMemoryConfig = {
  enabled: true,
  memoryModel: "",
  summarizerMode: "clean",
  cleanFallbackToActiveSession: false,
  includeAgentsMdOnFirstUpdate: false,
  injectInSubagents: true,
  enableLegacyPeriodicSystemTransform: false,
  sideSessionRetries: 1,
  remindEveryN: 4,
  maxMemoryLength: 10000,
  maxUpdateInputLength: 20000,
  debounceMs: 1200,
  debug: false,
  logMaxLines: 300,
  maxDeltaMessages: 200,
  collapseAssistantBursts: false,
  memoryDir: ".opencode/memory",
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const file = (path: string, value: unknown): PlannedConfigFile => ({ path, content: json(value) });
const rawFile = (path: string, content: string | null): PlannedConfigFile => ({ path, content });

const disabledBaseline = (
  memoryDirectory: string,
  changes: Partial<SessionMemoryConfig> = {},
): SessionMemoryConfig => ({
  enabled: false,
  memoryModel: "stm-probe/deterministic",
  summarizerMode: "active",
  cleanFallbackToActiveSession: false,
  includeAgentsMdOnFirstUpdate: true,
  injectInSubagents: false,
  enableLegacyPeriodicSystemTransform: false,
  sideSessionRetries: 2,
  remindEveryN: 2,
  maxMemoryLength: 2000,
  maxUpdateInputLength: 3000,
  debounceMs: 60000,
  debug: false,
  logMaxLines: 1000,
  maxDeltaMessages: 60,
  collapseAssistantBursts: true,
  memoryDir: memoryDirectory,
  ...changes,
});

const modelMetadata = (generation: ConfigGeneration, value: SessionMemoryConfig): SettingsMetadata => {
  const model = value.memoryModel.trim();
  const [provider, ...rest] = model.split("/");
  const valid = Boolean(provider && rest.join("/"));
  const memoryModelSelection = !model
    ? generation === "v1" || value.summarizerMode === "clean"
      ? "host-default"
      : "current-session"
    : !valid
      ? "invalid-override"
      : "explicit-override";
  return {
    memoryModelSelection,
    effectiveDeliveryMode: value.enableLegacyPeriodicSystemTransform ? "legacySystemTransform" : "promptNoReply",
    effectiveMemoryModel: memoryModelSelection === "explicit-override" ? model : null,
  };
};

export function expectedSettingsMetadata(generation: ConfigGeneration, value: SessionMemoryConfig): SettingsMetadata {
  return modelMetadata(generation, value);
}

export function buildConfigScenario(
  id: ConfigScenarioId,
  paths: ConfigScenarioPaths,
  generation: ConfigGeneration,
): ConfigScenario {
  const globalJsonc = `${paths.globalConfigDirectory}/stm.jsonc`;
  const projectJsonc = `${paths.projectDirectory}/.opencode/stm.jsonc`;
  const projectJson = `${paths.projectDirectory}/.opencode/stm.json`;
  const nested = `${paths.projectDirectory}/nested`;
  const nestedOpencode = `${nested}/.opencode`;
  const memory = paths.memoryDirectory;
  const base = disabledBaseline(memory);
  const baselineFile = file(globalJsonc, base);
  const directoriesToCreate = [paths.globalConfigDirectory, paths.projectDirectory, memory];
  let plannedFiles: PlannedConfigFile[] = [];
  let launchDirectory = paths.projectDirectory;
  let environmentConfigDir: string | undefined;
  let expected: SessionMemoryConfig = base;
  let knownIssues: string[] = [];
  let hotReload: HotReloadExpectations | undefined;

  switch (id) {
    case "defaults":
      expected = KNOWN_DEFAULT_CONFIG17;
      break;
    case "layer-home":
      plannedFiles = [baselineFile, file(`${paths.legacyGlobalDirectory}/stm.json`, { remindEveryN: 3 })];
      directoriesToCreate.push(paths.legacyGlobalDirectory);
      expected = disabledBaseline(memory, { remindEveryN: 3 });
      break;
    case "layer-env":
      environmentConfigDir = paths.environmentConfigDirectory;
      plannedFiles = [
        baselineFile,
        file(`${paths.legacyGlobalDirectory}/stm.json`, { remindEveryN: 3 }),
        file(`${paths.environmentConfigDirectory}/stm.json`, { remindEveryN: 5 }),
      ];
      directoriesToCreate.push(paths.legacyGlobalDirectory, paths.environmentConfigDirectory);
      expected = disabledBaseline(memory, { remindEveryN: 5 });
      break;
    case "layer-project":
      environmentConfigDir = paths.environmentConfigDirectory;
      plannedFiles = [
        baselineFile,
        file(`${paths.legacyGlobalDirectory}/stm.json`, { remindEveryN: 3 }),
        file(`${paths.environmentConfigDirectory}/stm.json`, { remindEveryN: 5 }),
        file(projectJson, { remindEveryN: 7 }),
      ];
      directoriesToCreate.push(paths.legacyGlobalDirectory, paths.environmentConfigDirectory);
      expected = disabledBaseline(memory, { remindEveryN: 7 });
      break;
    case "jsonc-precedence":
      plannedFiles = [
        baselineFile,
        file(projectJsonc, { remindEveryN: 7, summarizerMode: "active" }),
        file(projectJson, { remindEveryN: 9, memoryModel: "other/model" }),
      ];
      expected = disabledBaseline(memory, { remindEveryN: 7 });
      break;
    case "jsonc-empty":
      plannedFiles = [baselineFile, rawFile(projectJsonc, "{}\n"), file(projectJson, { remindEveryN: 9 })];
      expected = base;
      break;
    case "jsonc-rejected":
      plannedFiles = [baselineFile, rawFile(projectJsonc, "[]\n"), file(projectJson, { remindEveryN: 9 })];
      expected = disabledBaseline(memory, { remindEveryN: 9 });
      break;
    case "mode-typo":
      plannedFiles = [
        file(globalJsonc, { ...base, summarizerMode: "clean" }),
        file(projectJson, { summarizerMdoe: "active" }),
      ];
      expected = disabledBaseline(memory, { summarizerMode: "clean" });
      break;
    case "mode-whitespace":
      plannedFiles = [
        file(globalJsonc, { ...base, summarizerMode: "active" }),
        file(projectJson, { summarizerMode: " active " }),
      ];
      expected = disabledBaseline(memory, { summarizerMode: "clean" });
      break;
    case "normalization":
      plannedFiles = [
        baselineFile,
        file(projectJson, {
          sideSessionRetries: -2,
          remindEveryN: 2000,
          maxMemoryLength: 199,
          maxUpdateInputLength: 200001,
          debounceMs: " 1 ",
          logMaxLines: 20001,
          maxDeltaMessages: " 60.9 ",
          enabled: " false ",
          cleanFallbackToActiveSession: "TRUE",
          includeAgentsMdOnFirstUpdate: "FALSE",
          injectInSubagents: "false",
          enableLegacyPeriodicSystemTransform: "TRUE",
          debug: "FALSE",
          collapseAssistantBursts: "true ",
          memoryModel: " stm-probe/deterministic ",
          memoryDir: ` ${paths.memoryDirectory} `,
        }),
      ];
      expected = disabledBaseline(memory, {
        cleanFallbackToActiveSession: true,
        includeAgentsMdOnFirstUpdate: false,
        enableLegacyPeriodicSystemTransform: true,
        sideSessionRetries: 0,
        remindEveryN: 1000,
        maxMemoryLength: 200,
        maxUpdateInputLength: 200000,
        debounceMs: 100,
        logMaxLines: 20000,
        maxDeltaMessages: 60,
      });
      break;
    case "invalid-overrides":
      plannedFiles = [
        file(globalJsonc, { ...base, debug: true }),
        file(projectJson, {
          remindEveryN: "junk",
          debug: 1,
          summarizerMode: "active ",
          memoryModel: " ",
          memoryDir: "   ",
        }),
      ];
      expected = disabledBaseline(".opencode/memory", { remindEveryN: 4, memoryModel: "", summarizerMode: "clean" });
      break;
    case "model-invalid":
      plannedFiles = [baselineFile, file(projectJson, { memoryModel: "not-a-model", summarizerMode: "clean" })];
      expected = disabledBaseline(memory, { memoryModel: "not-a-model", summarizerMode: "clean" });
      break;
    case "malformed-recovery":
      plannedFiles = [
        baselineFile,
        rawFile(projectJsonc, '{"enabled":false,"remindEveryN":9,bad'),
        file(projectJson, { remindEveryN: 8 }),
      ];
      expected = disabledBaseline(memory, { remindEveryN: 8 });
      break;
    case "nearest-inherits":
      launchDirectory = nested;
      plannedFiles = [baselineFile, file(projectJson, { remindEveryN: 9 })];
      directoriesToCreate.push(nested);
      expected = disabledBaseline(memory, { remindEveryN: 9 });
      break;
    case "nearest-empty":
      launchDirectory = nested;
      plannedFiles = [baselineFile, file(projectJson, { remindEveryN: 9 })];
      directoriesToCreate.push(nested, nestedOpencode);
      expected = base;
      break;
    case "hot-reload": {
      const initial = disabledBaseline(memory, { remindEveryN: 7, summarizerMode: "active", enabled: false });
      const after = disabledBaseline(memory, { remindEveryN: 11, summarizerMode: "clean", enabled: false });
      plannedFiles = [baselineFile, file(projectJson, { remindEveryN: 7, summarizerMode: "active", enabled: false })];
      expected = initial;
      hotReload = {
        mutationFiles: [file(projectJson, { remindEveryN: 11, summarizerMode: "clean", enabled: false })],
        expectedAfterEdit17: after,
        immediateByGeneration: { v1: initial, v2: after },
        waitMsByGeneration: { v1: 61000, v2: 0 },
      };
      break;
    }
  }
  return {
    id,
    plannedFiles,
    directoriesToCreate,
    launchDirectory,
    ...(environmentConfigDir ? { environmentConfigDir } : {}),
    expectedConfig17: expected,
    expectedSettingsMetadata: modelMetadata(generation, expected),
    knownIssues,
    ...(hotReload ? { hotReload } : {}),
  };
}
