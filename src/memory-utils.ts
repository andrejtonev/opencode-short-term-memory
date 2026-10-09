import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse } from "jsonc-parser";
import type { Client } from "./types";

export type SessionMemoryConfig = {
  enabled: boolean;
  memoryModel: string;
  summarizerMode: "clean" | "active";
  cleanFallbackToActiveSession: boolean;
  includeAgentsMdOnFirstUpdate: boolean;
  injectInSubagents: boolean;
  enableLegacyPeriodicSystemTransform: boolean;
  sideSessionRetries: number;
  remindEveryN: number;
  maxMemoryLength: number;
  maxUpdateInputLength: number;
  debounceMs: number;
  debug: boolean;
  logMaxLines: number;
  maxDeltaMessages: number;
  collapseAssistantBursts: boolean;
  memoryDir: string;
};

export const MEMORY_HEADER = "## Session Memory";
export const INJECTION_PREFIX = "[MEMORY_SYSTEM]";
export const MEMORY_FORMAT_VERSION = "<!-- stm:v1 -->";
const DEFAULT_PROJECT_CONFIG_PATH = ".opencode/stm.json";
const CONFIG_FILE_CANDIDATES = ["stm.jsonc", "stm.json"] as const;

export const DEFAULT_CONFIG: SessionMemoryConfig = {
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

export type RuntimeState = {
  lastActiveSessionID?: string;
  lastUpdateAt?: string;
  lastInjectAt?: string;
  lastError?: string;
  startupWarning?: string;
  updateCount: number;
  injectCount: number;
  injectCharCount: number;
  compactCount: number;
};

export const createRuntimeState = (): RuntimeState => ({
  updateCount: 0,
  injectCount: 0,
  injectCharCount: 0,
  compactCount: 0,
});

const pathWriteLocks = new Map<string, Promise<void>>();

async function withPathWriteLock<T>(path: string, op: () => Promise<T>) {
  const prev = pathWriteLocks.get(path) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pathWriteLocks.set(
    path,
    prev.then(() => current),
  );
  await prev;
  try {
    return await op();
  } finally {
    release();
    if (pathWriteLocks.get(path) === current) {
      pathWriteLocks.delete(path);
    }
  }
}

async function waitForPathWrites(path: string) {
  const pending = pathWriteLocks.get(path);
  if (pending) {
    await pending;
  }
}

export async function ensureDir(path: string) {
  try {
    await mkdir(path, { recursive: true });
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== "EEXIST") throw error;
  }
}

export async function readText(path: string, fallback = "") {
  await waitForPathWrites(path);
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

export async function writeText(path: string, text: string) {
  await withPathWriteLock(path, async () => {
    await ensureDir(dirname(path));
    await writeFile(path, text, "utf8");
  });
}

async function writeTextAtomicUnlocked(path: string, text: string) {
  await ensureDir(dirname(path));
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const tmpHandle = await open(tmpPath, "w");
  try {
    await tmpHandle.writeFile(text, "utf8");
    await tmpHandle.sync();
  } finally {
    await tmpHandle.close();
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tmpPath, path);
      return;
    } catch (err: unknown) {
      lastError = err;
      const errCode = (err as { code?: string }).code;
      if (process.platform === "win32" && (errCode === "EPERM" || errCode === "EBUSY")) {
        try {
          await rm(path, { force: true });
        } catch {}
        try {
          await rename(tmpPath, path);
          return;
        } catch {}
      }
      const waitMs = 10 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  await rm(tmpPath, { force: true }).catch(() => {});
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "atomic rename failed"));
}

export type RawFileSnapshot = Buffer | null;

export type PreparedRawFile = {
  readonly path: string;
  readonly committed: Buffer;
  commit: (expected: RawFileSnapshot) => Promise<boolean>;
  discard: () => Promise<void>;
};

export async function readRawFile(path: string): Promise<RawFileSnapshot> {
  await waitForPathWrites(path);
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "ENOENT") return null;
    throw error;
  }
}

export async function prepareRawFile(path: string, data: Buffer): Promise<PreparedRawFile> {
  await ensureDir(dirname(path));
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await handle.close();
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  let consumed = false;
  return {
    path,
    committed: data,
    commit: async (expected) =>
      await withPathWriteLock(path, async () => {
        let current: RawFileSnapshot;
        try {
          current = await readFile(path);
        } catch (error: unknown) {
          if ((error as { code?: string })?.code !== "ENOENT") throw error;
          current = null;
        }
        const matches = current === null ? expected === null : expected !== null && current.equals(expected);
        if (!matches || consumed) return false;
        await rename(tempPath, path);
        consumed = true;
        return true;
      }),
    discard: async () => {
      if (consumed) return;
      await rm(tempPath, { force: true });
    },
  };
}

export async function removeRawFileIfCurrent(path: string, expected: Buffer): Promise<boolean> {
  return await withPathWriteLock(path, async () => {
    let current: RawFileSnapshot;
    try {
      current = await readFile(path);
    } catch (error: unknown) {
      if ((error as { code?: string })?.code !== "ENOENT") throw error;
      current = null;
    }
    const matches = current !== null && current.equals(expected);
    if (!matches) return false;
    await rm(path, { force: true });
    return true;
  });
}

export async function writeTextAtomic(path: string, text: string) {
  await withPathWriteLock(path, () => writeTextAtomicUnlocked(path, text));
}

export async function compareAndReplaceTextAtomic(path: string, expected: string, replacement: string) {
  return await withPathWriteLock(path, async () => {
    let current = "";
    try {
      current = await readFile(path, "utf8");
    } catch (error: unknown) {
      if ((error as { code?: string })?.code !== "ENOENT") throw error;
    }
    if (current !== expected) return false;
    await writeTextAtomicUnlocked(path, replacement);
    return true;
  });
}

export async function appendText(path: string, text: string) {
  await withPathWriteLock(path, async () => {
    await ensureDir(dirname(path));
    await appendFile(path, text, "utf8");
  });
}

export async function removePath(path: string) {
  await rm(path, { force: true, recursive: true });
}

function normalizeSummarizerMode(value: unknown): SessionMemoryConfig["summarizerMode"] {
  return String(value || "").toLowerCase() === "active" ? "active" : "clean";
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return fallback;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  const int = Math.trunc(parsed);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

function normalizeString(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeConfig(merged: Record<string, unknown>): SessionMemoryConfig {
  return {
    enabled: normalizeBoolean(merged.enabled, DEFAULT_CONFIG.enabled),
    memoryModel: normalizeString(merged.memoryModel, DEFAULT_CONFIG.memoryModel),
    summarizerMode: normalizeSummarizerMode(merged.summarizerMode),
    cleanFallbackToActiveSession: normalizeBoolean(
      merged.cleanFallbackToActiveSession,
      DEFAULT_CONFIG.cleanFallbackToActiveSession,
    ),
    includeAgentsMdOnFirstUpdate: normalizeBoolean(
      merged.includeAgentsMdOnFirstUpdate,
      DEFAULT_CONFIG.includeAgentsMdOnFirstUpdate,
    ),
    injectInSubagents: normalizeBoolean(merged.injectInSubagents, DEFAULT_CONFIG.injectInSubagents),
    enableLegacyPeriodicSystemTransform: normalizeBoolean(
      merged.enableLegacyPeriodicSystemTransform,
      DEFAULT_CONFIG.enableLegacyPeriodicSystemTransform,
    ),
    sideSessionRetries: normalizeInteger(merged.sideSessionRetries, DEFAULT_CONFIG.sideSessionRetries, 0, 10),
    remindEveryN: normalizeInteger(merged.remindEveryN, DEFAULT_CONFIG.remindEveryN, 1, 1000),
    maxMemoryLength: normalizeInteger(merged.maxMemoryLength, DEFAULT_CONFIG.maxMemoryLength, 200, 50000),
    maxUpdateInputLength: normalizeInteger(
      merged.maxUpdateInputLength,
      DEFAULT_CONFIG.maxUpdateInputLength,
      500,
      200000,
    ),
    debounceMs: normalizeInteger(merged.debounceMs, DEFAULT_CONFIG.debounceMs, 100, 120000),
    debug: normalizeBoolean(merged.debug, DEFAULT_CONFIG.debug),
    logMaxLines: normalizeInteger(merged.logMaxLines, DEFAULT_CONFIG.logMaxLines, 20, 20000),
    maxDeltaMessages: normalizeInteger(merged.maxDeltaMessages, DEFAULT_CONFIG.maxDeltaMessages, 20, 10000),
    collapseAssistantBursts: normalizeBoolean(merged.collapseAssistantBursts, DEFAULT_CONFIG.collapseAssistantBursts),
    memoryDir: normalizeString(merged.memoryDir, DEFAULT_CONFIG.memoryDir),
  };
}

async function loadConfigFromPath(path: string) {
  const raw = await readText(path, "");
  if (!raw.trim()) return undefined;
  try {
    const errors: Array<{ error: number; offset: number; length: number }> = [];
    const parsed = parse(raw, errors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: false,
    });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function findFirstExistingConfig(baseDir: string) {
  for (const fileName of CONFIG_FILE_CANDIDATES) {
    const fullPath = join(baseDir, fileName);
    const parsed = await loadConfigFromPath(fullPath);
    if (parsed) return parsed;
  }
  return undefined;
}

const EXAMPLE_CONFIG_CONTENT = `{
  // Session memory plugin on/off
  "enabled": true,

  // Model used by the summarizer (provider/model). V1 clean: empty uses the fresh host default;
  // V1 active supports an explicit override. V2 clean: empty uses the current model or an override;
  // V2 active does not support an explicit override.
  "memoryModel": "",

  // clean | active
  "summarizerMode": "${DEFAULT_CONFIG.summarizerMode}",

  // Delivery cadence: every N eligible user turns while delivery is enabled.
  "remindEveryN": ${DEFAULT_CONFIG.remindEveryN},

  // V1: select legacy system-transform delivery instead of normal noReply.
  // V2: opt in to all system injection, independent of updates.
  "enableLegacyPeriodicSystemTransform": ${DEFAULT_CONFIG.enableLegacyPeriodicSystemTransform},

  // Target length used to normalize stored session memory; not a strict file limit.
  "maxMemoryLength": ${DEFAULT_CONFIG.maxMemoryLength},

  // Debug logging
  "debug": ${DEFAULT_CONFIG.debug},
}
`;

export type ExampleConfigResult = {
  created: boolean;
  configDir: string;
  configPath: string;
  message: string;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "ENOENT") return false;
    throw error;
  }
}

async function createExampleConfigFile(configDir: string): Promise<ExampleConfigResult> {
  const configPath = join(configDir, "stm.jsonc");
  return await withPathWriteLock(`example-config:${configDir}`, async () => {
    for (const fileName of CONFIG_FILE_CANDIDATES) {
      if (await pathExists(join(configDir, fileName))) {
        return {
          created: false,
          configDir,
          configPath,
          message: `No example config created: ${fileName} already exists in ${configDir}.`,
        };
      }
    }

    await ensureDir(configDir);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(configPath, "wx");
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === "EEXIST") {
        return {
          created: false,
          configDir,
          configPath,
          message: `No example config created: stm.jsonc already exists in ${configDir}.`,
        };
      }
      throw error;
    }

    try {
      await handle.writeFile(EXAMPLE_CONFIG_CONTENT, "utf8");
    } finally {
      await handle.close();
    }

    return {
      created: true,
      configDir,
      configPath,
      message: `Created project example config at ${configPath}.`,
    };
  });
}

/** Create a project-local example config after the caller has confirmed. */
export async function createProjectExampleConfig(pluginBaseDir?: string): Promise<ExampleConfigResult> {
  const baseDir = pluginBaseDir || process.cwd();
  const configDir = baseDir.endsWith(".opencode") ? baseDir : join(baseDir, ".opencode");
  return await createExampleConfigFile(configDir);
}

async function findOpencodeDir(startDir: string): Promise<string | undefined> {
  let current = startDir;
  while (true) {
    const candidate = join(current, ".opencode");
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch {}
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function resolveProjectOpencodeDir(baseDir?: string) {
  const cwd = baseDir || process.cwd();
  if (cwd.endsWith(".opencode")) return cwd;
  const found = await findOpencodeDir(cwd);
  if (found) return found;
  return join(cwd, ".opencode");
}

function candidateGlobalConfigDirs() {
  const dirs: string[] = [];

  if (process.env.XDG_CONFIG_HOME) {
    dirs.push(join(process.env.XDG_CONFIG_HOME, "opencode"));
  } else {
    dirs.push(join(homedir(), ".config", "opencode"));
  }

  // Match OpenCode's own conventions ($HOME/.opencode/commands/, $HOME/.opencode.json)
  dirs.push(join(homedir(), ".opencode"));

  return Array.from(new Set(dirs));
}

export function resolveGlobalOpencodeDir() {
  return candidateGlobalConfigDirs()[0];
}

export async function readConfig(
  configPath = DEFAULT_PROJECT_CONFIG_PATH,
  baseDir?: string,
): Promise<SessionMemoryConfig> {
  if (configPath !== DEFAULT_PROJECT_CONFIG_PATH) {
    const parsed = await loadConfigFromPath(configPath);
    if (!parsed) return DEFAULT_CONFIG;
    return normalizeConfig(parsed);
  }

  let merged: Record<string, unknown> = {};
  const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const projectOpencodeDir = await resolveProjectOpencodeDir(baseDir);

  for (const globalBaseDir of candidateGlobalConfigDirs()) {
    const globalConfig = await findFirstExistingConfig(globalBaseDir);
    if (globalConfig) merged = { ...merged, ...globalConfig };
  }

  if (opencodeConfigDir) {
    const envConfig = await findFirstExistingConfig(opencodeConfigDir);
    if (envConfig) merged = { ...merged, ...envConfig };
  }

  const projectConfig = await findFirstExistingConfig(projectOpencodeDir);
  if (projectConfig) merged = { ...merged, ...projectConfig };

  return normalizeConfig(merged);
}

export function memoryPathFor(sessionID: string, memoryDir = DEFAULT_CONFIG.memoryDir) {
  return join(memoryDir, `session_${safeSessionID(sessionID)}.md`);
}

export function checkpointPathFor(sessionID: string, memoryDir = DEFAULT_CONFIG.memoryDir) {
  return join(memoryDir, "checkpoints", `${safeSessionID(sessionID)}.last-message-id.txt`);
}

export function resetBoundaryPathFor(sessionID: string, memoryDir = DEFAULT_CONFIG.memoryDir) {
  return join(memoryDir, "reset-boundaries", `${safeSessionID(sessionID)}.json`);
}

export function logPath(memoryDir = DEFAULT_CONFIG.memoryDir) {
  return join(memoryDir, "session-memory.log");
}

export const SIDE_SESSION_TITLE = "Session Memory Summarizer";

export const STANDARD_MEMORY_TEMPLATE = `${MEMORY_FORMAT_VERSION}
${MEMORY_HEADER}

### User Instructions
- None captured yet.

### Long Horizon Context
- None captured yet.

### Decisions
- None captured yet.

### Conclusions
- None captured yet.

### Active References
- None captured yet.
`;

export function sideSessionsStatePath(memoryDir = DEFAULT_CONFIG.memoryDir) {
  return join(memoryDir, "side-sessions.json");
}

export async function loadActiveSideSessions(memoryDir: string): Promise<string[]> {
  const raw = await readText(sideSessionsStatePath(memoryDir), "");
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

export async function saveActiveSideSessions(memoryDir: string, ids: string[]) {
  const sanitized = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
  await writeTextAtomic(sideSessionsStatePath(memoryDir), JSON.stringify(sanitized));
}

function sanitizeSideSessionIDs(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
}

const SIDE_SESSIONS_LOCK_KEY = "__side_sessions_tracking__";

export async function mutateActiveSideSessions<T>(
  memoryDir: string,
  mutator: (current: string[]) => T | Promise<T>,
): Promise<T> {
  return await withPathWriteLock(SIDE_SESSIONS_LOCK_KEY, async () => {
    const current = await loadActiveSideSessions(memoryDir);
    const next = await mutator(current);
    if (!Array.isArray(next)) return next;
    const sanitized = sanitizeSideSessionIDs(next);
    await writeTextAtomic(sideSessionsStatePath(memoryDir), JSON.stringify(sanitized));
    return next as T;
  });
}

export function safeSessionID(sessionID: string) {
  return String(sessionID).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export async function ensureMemoryFile(sessionID: string, config: SessionMemoryConfig) {
  const path = memoryPathFor(sessionID, config.memoryDir);
  const existing = await readText(path, "");
  if (existing.trim()) return path;
  await writeText(path, STANDARD_MEMORY_TEMPLATE);
  return path;
}

export function getSessionID(input: unknown, ctx?: unknown): string | undefined {
  const i = input as Record<string, unknown> | undefined;
  const c = ctx as Record<string, unknown> | undefined;
  const event = i?.event as Record<string, unknown> | undefined;
  const eventProps = event?.properties as Record<string, unknown> | undefined;
  const props = i?.properties as Record<string, unknown> | undefined;
  const session = i?.session as Record<string, unknown> | undefined;
  const message = i?.message as Record<string, unknown> | undefined;
  const info = i?.info as Record<string, unknown> | undefined;
  const sessionID =
    c?.sessionID ||
    i?.sessionID ||
    event?.sessionID ||
    eventProps?.sessionID ||
    eventProps?.sessionId ||
    props?.sessionID ||
    props?.sessionId ||
    session?.id ||
    message?.sessionID ||
    message?.sessionId ||
    info?.sessionID ||
    info?.sessionId;
  if (sessionID === undefined || sessionID === null) return undefined;
  const normalized = String(sessionID).trim();
  return normalized || undefined;
}

export function getMessageRole(message: unknown): string | undefined {
  const m = message as Record<string, unknown> | undefined;
  const role = m?.role || (m?.info as Record<string, unknown>)?.role;
  if (role === undefined || role === null) return undefined;
  return String(role) || undefined;
}

export function getMessageTime(row: unknown): number | undefined {
  const r = row as Record<string, unknown> | undefined;
  const message = r?.message as Record<string, unknown> | undefined;
  const info = r?.info as Record<string, unknown> | undefined;
  const messageInfo = message?.info as Record<string, unknown> | undefined;
  const time =
    (r?.time as Record<string, unknown> | undefined)?.created ??
    (message?.time as Record<string, unknown> | undefined)?.created ??
    (info?.time as Record<string, unknown> | undefined)?.created ??
    (messageInfo?.time as Record<string, unknown> | undefined)?.created;
  if (typeof time === "number" && Number.isFinite(time)) return time;
  return undefined;
}

const INTERNAL_PART_TYPES = new Set([
  "reasoning",
  "thinking",
  "tool",
  "tool_result",
  "step-start",
  "step-finish",
  "retry",
  "compaction",
  "subtask",
  "agent",
  "snapshot",
  "patch",
]);

export function isInternalPartType(type: string): boolean {
  return INTERNAL_PART_TYPES.has(String(type || "").toLowerCase());
}

export function getMessageTextFromParts(parts: unknown[] | undefined) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => {
      const p = part as Record<string, unknown>;
      const type = String(p?.type || p?.kind || "").toLowerCase();
      if (isInternalPartType(type)) return false;
      if (p?.synthetic === true) return false;
      return true;
    })
    .map((part) => {
      const p = part as Record<string, unknown>;
      return String(p?.text || p?.content || "");
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function getMessageText(input: unknown) {
  const i = input as Record<string, unknown> | undefined;
  const message = i?.message as Record<string, unknown> | undefined;
  const direct =
    typeof message?.content === "string"
      ? message.content
      : typeof i?.content === "string"
        ? i.content
        : typeof i?.text === "string"
          ? i.text
          : "";
  const parts = getMessageTextFromParts((i?.parts || message?.parts) as unknown[] | undefined);
  return sanitizeMessage(direct || parts || "");
}

export function isSelfInjection(content: string) {
  return (
    content.includes(INJECTION_PREFIX) || content.includes(MEMORY_HEADER) || content.includes("Session Memory plugin")
  );
}

export function sanitizeMessage(content: string) {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```thinking[\s\S]*?```/gi, "")
    .trim();
}

export function clampText(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

export function showToast(
  client: Client,
  title: string,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "error",
  duration = 8000,
) {
  client?.tui?.showToast?.({ body: { title, message, variant, duration } })?.catch?.(() => {});
}

export function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const [providerID, ...rest] = String(model || "").split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

export async function logEvent(config: SessionMemoryConfig, event: string, data: Record<string, unknown> = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };
  const path = logPath(config.memoryDir);
  await withPathWriteLock(path, async () => {
    await ensureDir(dirname(path));
    await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
    await trimLogUnlocked(path, config.logMaxLines);
  }).catch(() => {});
}

export async function tailLog(lines = 80, memoryDir = DEFAULT_CONFIG.memoryDir) {
  if (lines <= 0) return "";
  const path = logPath(memoryDir);
  await waitForPathWrites(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (info.size <= 0) return "";
    const chunkSize = 8192;
    let offset = info.size;
    let text = "";
    let newlineCount = 0;
    while (offset > 0 && newlineCount <= lines) {
      const readSize = Math.min(chunkSize, offset);
      offset -= readSize;
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, offset);
      text = buffer.toString("utf8") + text;
      newlineCount = (text.match(/\n/g) || []).length;
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function trimLog(config: SessionMemoryConfig) {
  const path = logPath(config.memoryDir);
  await withPathWriteLock(path, () => trimLogUnlocked(path, config.logMaxLines));
}

async function trimLogUnlocked(path: string, maxLines: number): Promise<void> {
  if (maxLines <= 0) return;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= maxLines) return;
  await writeTextAtomicUnlocked(path, `${lines.slice(-maxLines).join("\n")}\n`);
}
