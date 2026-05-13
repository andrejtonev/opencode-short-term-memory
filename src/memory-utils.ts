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
  opencodeExecutable: string;
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
  memoryModel: "opencode/minimax-m2.5-free",
  summarizerMode: "clean",
  cleanFallbackToActiveSession: false,
  includeAgentsMdOnFirstUpdate: false,
  injectInSubagents: true, // default: inject parent memory into sub-agents
  opencodeExecutable: "opencode",
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

export async function writeTextAtomic(path: string, text: string) {
  await withPathWriteLock(path, async () => {
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
    opencodeExecutable: normalizeString(merged.opencodeExecutable, DEFAULT_CONFIG.opencodeExecutable),
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

export async function ensureDefaultConfigFile(projectOpencodeDir: string) {
  for (const fileName of CONFIG_FILE_CANDIDATES) {
    const fullPath = join(projectOpencodeDir, fileName);
    try {
      const info = await stat(fullPath);
      if (info.isFile()) return; // Config already exists
    } catch {}
  }

  const defaultContent = `{
  // Session memory plugin on/off
  "enabled": true,

  // Model used by the summarizer (provider/model)
  "memoryModel": "${DEFAULT_CONFIG.memoryModel}",

  // clean | active
  "summarizerMode": "${DEFAULT_CONFIG.summarizerMode}",

  // Interval at which to inject memory summarization into chat (every N user turns)
  "remindEveryN": ${DEFAULT_CONFIG.remindEveryN},

  // Max chars stored in session memory markdown
  "maxMemoryLength": ${DEFAULT_CONFIG.maxMemoryLength},

  // Debug logging
  "debug": ${DEFAULT_CONFIG.debug},
}
`;

  await ensureDir(projectOpencodeDir);
  await writeFile(join(projectOpencodeDir, "stm.jsonc"), defaultContent, "utf8");
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

  const envExecutable = process.env.OPENCODE_EXECUTABLE?.trim();
  if (envExecutable) {
    merged = { ...merged, opencodeExecutable: envExecutable };
  }

  return normalizeConfig(merged);
}

export function memoryPathFor(sessionID: string, memoryDir = DEFAULT_CONFIG.memoryDir) {
  return join(memoryDir, `session_${safeSessionID(sessionID)}.md`);
}

export function checkpointPathFor(sessionID: string, memoryDir = DEFAULT_CONFIG.memoryDir) {
  return join(memoryDir, "checkpoints", `${safeSessionID(sessionID)}.last-message-id.txt`);
}

export function logPath(memoryDir = DEFAULT_CONFIG.memoryDir) {
  return join(memoryDir, "session-memory.log");
}

export function safeSessionID(sessionID: string) {
  return String(sessionID).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export async function ensureMemoryFile(sessionID: string, config: SessionMemoryConfig) {
  const path = memoryPathFor(sessionID, config.memoryDir);
  const existing = await readText(path, "");
  if (existing.trim()) return path;
  await writeText(
    path,
    `${MEMORY_FORMAT_VERSION}\n${MEMORY_HEADER}\n\n### User Instructions\n- None captured yet.\n\n### Long Horizon Context\n- None captured yet.\n\n### Decisions\n- None captured yet.\n\n### Conclusions\n- None captured yet.\n\n### Active References\n- None captured yet.\n`,
  );
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
  await appendText(logPath(config.memoryDir), JSON.stringify(entry) + "\n").catch(() => {});
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
  const text = await readText(logPath(config.memoryDir), "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= config.logMaxLines) return;
  await writeTextAtomic(logPath(config.memoryDir), lines.slice(-config.logMaxLines).join("\n") + "\n");
}
