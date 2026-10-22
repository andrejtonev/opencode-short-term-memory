import {
  type SessionMemoryConfig,
  type RuntimeState,
  type ConfigDiagnostics,
  readConfig,
  readConfigDiagnostics,
} from "./memory-utils";

export interface ConfigContext {
  config: SessionMemoryConfig;
  cache: { config: SessionMemoryConfig; at: number } | null;
  lastWarning: string;
  globalState: RuntimeState;
  baseDir?: string;
  configuration?: ConfigDiagnostics;
}

const CONFIG_CACHE_TTL_MS = 60_000;

export async function reloadConfig(ctx: ConfigContext, force = false) {
  const now = Date.now();
  if (!force && ctx.cache && now - ctx.cache.at < CONFIG_CACHE_TTL_MS) {
    ctx.config = ctx.cache.config;
    return ctx.config;
  }
  ctx.config = await readConfig(undefined, ctx.baseDir);
  const installation = ctx.configuration?.installation;
  ctx.configuration = { ...(await readConfigDiagnostics(ctx.baseDir)), ...(installation ? { installation } : {}) };
  ctx.cache = { config: ctx.config, at: now };
  return ctx.config;
}
