import type { SessionMemoryConfig } from "./memory-utils";
import type { V2SessionContext } from "./v2-adapter";
import { buildTaggedMemoryForInjection } from "./injection";
import { DEFAULT_CONFIG, INJECTION_PREFIX, logEvent, memoryPathFor, readConfig, readText } from "./memory-utils";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function createV2ContextInjection(directory?: string): (input: V2SessionContext) => Promise<void> {
  return async (input) => {
    let config: SessionMemoryConfig | undefined;
    try {
      config = await readConfig(undefined, directory);
      if (!config.enabled) return;

      const memory = await readText(memoryPathFor(input.sessionID, config.memoryDir), "");
      const taggedMemory = buildTaggedMemoryForInjection(memory, config.maxMemoryLength);
      if (!taggedMemory.trim()) return;
      if (input.system.some((part) => part.type === "text" && part.text.includes(INJECTION_PREFIX))) return;

      input.system.push({ type: "text", text: taggedMemory });
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
