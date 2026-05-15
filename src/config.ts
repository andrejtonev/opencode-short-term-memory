import { type SessionMemoryConfig, type RuntimeState, readConfig } from "./memory-utils";

export interface ConfigContext {
  config: SessionMemoryConfig;
  cache: { config: SessionMemoryConfig; at: number } | null;
  lastWarning: string;
  globalState: RuntimeState;
  baseDir?: string;
}

const CONFIG_CACHE_TTL_MS = 60_000;

export async function reloadConfig(ctx: ConfigContext, force = false) {
  const now = Date.now();
  if (!force && ctx.cache && now - ctx.cache.at < CONFIG_CACHE_TTL_MS) {
    ctx.config = ctx.cache.config;
    return ctx.config;
  }
  ctx.config = await readConfig(undefined, ctx.baseDir);
  ctx.cache = { config: ctx.config, at: now };
  return ctx.config;
}
