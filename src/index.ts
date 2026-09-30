import type { Plugin } from "@opencode/plugin";
import { SessionMemoryPlugin } from "./v1-adapter";
import { createV2Adapter } from "./v2-adapter";
import { createV2ContextInjection } from "./v2-context-injection";
import { createV2MemoryUpdater, isV2MemoryUpdateInFlight } from "./v2-memory-update";
import { createV2MemoryToolRegistrations } from "./v2-memory-tools";

export { SessionMemoryPlugin };

export default {
  id: "opencode-short-term-memory",
  server: SessionMemoryPlugin,
  async setup(context) {
    const adapter = createV2Adapter(context);
    const injection = createV2ContextInjection(context.location.directory);
    const updater = createV2MemoryUpdater(context, context.location.directory);
    const callback = async (input: Parameters<typeof updater>[0]) => {
      if (isV2MemoryUpdateInFlight(context.location.directory, input.sessionID)) return;
      await updater(input);
      await injection(input);
    };
    try {
      await adapter.runtime.registerSystemContextMutation(callback);
      await adapter.runtime.registerCompactionMutation(injection);
      for (const registration of createV2MemoryToolRegistrations(context)) {
        await adapter.runtime.registerTool(registration);
      }
    } catch (error) {
      try {
        await adapter.dispose();
      } catch {}
      throw error;
    }
    return adapter.dispose;
  },
} satisfies Plugin.Plugin & { readonly server: typeof SessionMemoryPlugin };
