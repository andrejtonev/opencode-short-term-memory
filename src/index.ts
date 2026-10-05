import type { Plugin } from "@opencode/plugin";
import { SessionMemoryPlugin } from "./v1-adapter";
import { createV2Adapter, type V2SessionContext } from "./v2-adapter";
import { createV2ContextInjection } from "./v2-context-injection";
import { createV2MemoryUpdater, isV2MemoryUpdateInFlight } from "./v2-memory-update";
import { createV2MemoryToolRegistrations } from "./v2-memory-tools";
import { setupStatusCommand } from "./v2-status-command";

export { SessionMemoryPlugin };

export default {
  id: "opencode-short-term-memory",
  server: SessionMemoryPlugin,
  async setup(context) {
    const adapter = createV2Adapter(context);
    const injection = createV2ContextInjection(context.location.directory);
    const updater = createV2MemoryUpdater(context, context.location.directory);
    const callback = async (input: V2SessionContext) => {
      if (isV2MemoryUpdateInFlight(context.location.directory, input.sessionID)) return;
      await updater(input);
      await injection(input);
    };
    let disposeStatus: (() => Promise<void>) | undefined;
    try {
      await adapter.runtime.registerSystemContextMutation(callback);
      await adapter.runtime.registerCompactionMutation(injection);
      for (const registration of createV2MemoryToolRegistrations(context)) {
        await adapter.runtime.registerTool(registration);
      }
      disposeStatus = await setupStatusCommand(context, adapter.runtime);
    } catch (error) {
      try {
        await adapter.dispose();
      } catch {}
      throw error;
    }
    return async () => {
      try {
        await disposeStatus?.();
      } finally {
        await adapter.dispose();
      }
    };
  },
} satisfies Plugin.Plugin & { readonly server: typeof SessionMemoryPlugin };
