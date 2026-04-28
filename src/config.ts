import { join } from "node:path";
import { type SessionMemoryConfig, type RuntimeState, logEvent, readConfig } from "./memory-utils";

export interface ConfigContext {
  config: SessionMemoryConfig;
  cache: { config: SessionMemoryConfig; at: number } | null;
  lastWarning: string;
  globalState: RuntimeState;
  baseDir?: string;
}

const CONFIG_CACHE_TTL_MS = 60_000;

export async function resolveCleanExecutable(config: SessionMemoryConfig) {
  const configured = String(config.opencodeExecutable || "opencode").trim() || "opencode";
  if (configured !== "opencode") return configured;
  if (Bun.which("opencode")) return "opencode";

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const userProfile = process.env.USERPROFILE;
    const candidates = [
      localAppData ? join(localAppData, "OpenCode", "opencode-cli.exe") : "",
      localAppData ? join(localAppData, "OpenCode", "opencode-cli") : "",
      userProfile ? join(userProfile, "AppData", "Local", "OpenCode", "opencode-cli.exe") : "",
      userProfile ? join(userProfile, "AppData", "Local", "OpenCode", "opencode-cli") : "",
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (await Bun.file(candidate).exists()) return candidate;
    }
  }

  return configured;
}

export async function validateRuntimeConfig(ctx: ConfigContext) {
  let warning = "";
  if (ctx.config.summarizerMode === "clean") {
    const resolvedExecutable = await resolveCleanExecutable(ctx.config);
    if (!Bun.which(resolvedExecutable) && !(await Bun.file(resolvedExecutable).exists())) {
      warning = `opencodeExecutable not found: ${resolvedExecutable}`;
    }
  }
  ctx.globalState.startupWarning = warning || undefined;
  if (warning && warning !== ctx.lastWarning) {
    await logEvent(ctx.config, "config_warning", { warning });
  }
  ctx.lastWarning = warning;
}

export async function reloadConfig(ctx: ConfigContext, force = false) {
  const now = Date.now();
  if (!force && ctx.cache && now - ctx.cache.at < CONFIG_CACHE_TTL_MS) {
    ctx.config = ctx.cache.config;
    return ctx.config;
  }
  ctx.config = await readConfig(undefined, ctx.baseDir);
  ctx.cache = { config: ctx.config, at: now };
  await validateRuntimeConfig(ctx);
  return ctx.config;
}
