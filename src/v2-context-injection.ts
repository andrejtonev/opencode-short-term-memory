import type { SessionMemoryConfig } from "./memory-utils";
import type { V2Context, V2SessionContext } from "./v2-adapter";
import { buildTaggedMemoryForInjection } from "./injection";
import { DEFAULT_CONFIG, INJECTION_PREFIX, logEvent, memoryPathFor, readConfig, readText } from "./memory-utils";
import {
  claimV2ChildSystemDelivery,
  classifyV2Session,
  completeV2ChildSystemDelivery,
  getV2ChildSystemDelivery,
  readTaskChildMemory,
  releaseV2ChildSystemDelivery,
} from "./v2-child-memory";
import { getV2MemoryReadRevision, isV2MemorySessionDeleted } from "./v2-mutation-coordination";
import type { ReturnTypeOfReminderCadence } from "./v2-reminder-cadence";

export type V2ContextInjectionTarget = "context" | "compaction";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

async function debugLog(config: SessionMemoryConfig, event: string, data: Record<string, unknown>): Promise<void> {
  if (!config.debug) return;
  try {
    await logEvent(config, event, data);
  } catch {}
}

export function createV2ContextInjection(
  context: V2Context,
  directory?: string,
  cadence?: ReturnTypeOfReminderCadence,
  lifetimeSignal?: AbortSignal,
  isOwnedSession?: (sessionID: string) => boolean,
  target: V2ContextInjectionTarget = "context",
): (input: V2SessionContext) => Promise<void> {
  const resolvedDirectory = directory ?? context.location.directory;
  return async (input) => {
    const revision = getV2MemoryReadRevision(resolvedDirectory, input.sessionID);
    const owned = () => {
      try {
        return isOwnedSession?.(input.sessionID) === true;
      } catch {
        return true;
      }
    };
    const current = () =>
      !lifetimeSignal?.aborted &&
      !owned() &&
      !isV2MemorySessionDeleted(resolvedDirectory, input.sessionID) &&
      getV2MemoryReadRevision(resolvedDirectory, input.sessionID) === revision;
    if (!current()) return;
    let config: SessionMemoryConfig | undefined;
    try {
      config = await readConfig(undefined, resolvedDirectory);
      if (!current() || !config.enabled) return;
      const lineage = await classifyV2Session(context, input.sessionID);
      if (!current()) return;
      if (lineage?.kind === "metadata-error") {
        await debugLog(config, "v2_context_injection_skip", {
          sessionID: input.sessionID,
          reason: "metadata-error",
          transport: "system",
        });
        return;
      }
      const isPrimary = lineage.kind === "primary";
      const isSystemPrimary =
        target === "compaction" || (config.enableLegacyPeriodicSystemTransform && config.summarizerMode !== "active");
      if (isPrimary && !isSystemPrimary) return;
      const isChildContext = target === "context" && lineage.kind === "task-child";
      if (
        isChildContext &&
        (!config.injectInSubagents || !getV2ChildSystemDelivery(resolvedDirectory, input.sessionID))
      )
        return;
      if (target === "context" && isPrimary && cadence) {
        cadence.selectTransport(input.sessionID, "system", input.messages);
      }
      if (
        target === "context" &&
        cadence &&
        isPrimary &&
        !(await cadence.shouldInject(input, config.remindEveryN, config.memoryDir))
      ) {
        await debugLog(config, "v2_context_injection_skip", {
          sessionID: input.sessionID,
          reason: "cadence",
          transport: "system",
        });
        return;
      }

      if (!current()) return;
      const child = await readTaskChildMemory(context, input, config, resolvedDirectory, {}, lifetimeSignal);
      if (!current()) return;
      if (child.status === "metadata-error" || child.status === "invalid-state" || child.status === "suppressed") {
        await debugLog(config, "v2_context_injection_skip", {
          sessionID: input.sessionID,
          reason: child.status,
          transport: "system",
        });
        return;
      }
      if (isChildContext && child.status !== "injected") return;
      const memory = child.memory ?? (await readText(memoryPathFor(input.sessionID, config.memoryDir), ""));
      const taggedMemory = buildTaggedMemoryForInjection(memory, config.maxMemoryLength);
      if (!taggedMemory.trim()) {
        await debugLog(config, "v2_context_injection_skip", {
          sessionID: input.sessionID,
          reason: "empty_memory",
          transport: "system",
        });
        return;
      }
      if (input.system.some((part) => part.type === "text" && part.text.includes(INJECTION_PREFIX))) {
        await debugLog(config, "v2_context_injection_skip", {
          sessionID: input.sessionID,
          reason: "already_present",
          transport: "system",
        });
        return;
      }

      if (!current()) return;
      const delivery = isChildContext ? claimV2ChildSystemDelivery(resolvedDirectory, input.sessionID) : undefined;
      if (isChildContext && !delivery) return;
      try {
        if (!current()) {
          if (delivery) releaseV2ChildSystemDelivery(resolvedDirectory, input.sessionID, delivery);
          return;
        }
        input.system.push({ type: "text", text: taggedMemory });
        if (delivery) completeV2ChildSystemDelivery(resolvedDirectory, input.sessionID, delivery);
      } catch (error) {
        if (delivery) releaseV2ChildSystemDelivery(resolvedDirectory, input.sessionID, delivery);
        throw error;
      }
      await debugLog(config, "v2_context_injection_success", {
        sessionID: input.sessionID,
        transport: "system",
        memoryChars: memory.length,
        injectedChars: taggedMemory.length,
        ...(delivery ? { childDelivery: delivery } : {}),
        ...(target === "compaction" && lineage.kind === "task-child" ? { childDelivery: "compaction" } : {}),
      });
    } catch (error) {
      try {
        await logEvent(config ?? DEFAULT_CONFIG, "v2_context_injection_error", {
          sessionID: input.sessionID,
          error: errorMessage(error),
        });
      } catch {}
    }
  };
}
