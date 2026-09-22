import type { Plugin } from "@opencode/plugin";
import { SessionMemoryPlugin } from "./v1-adapter";
import { createV2Adapter } from "./v2-adapter";
import { createV2ContextInjection } from "./v2-context-injection";

export { SessionMemoryPlugin };

export default {
  id: "opencode-short-term-memory",
  server: SessionMemoryPlugin,
  async setup(context) {
    const adapter = createV2Adapter(context);
    const callback = createV2ContextInjection(context.location.directory);
    try {
      await adapter.runtime.registerSystemContextMutation(callback);
      await adapter.runtime.registerCompactionMutation(callback);
    } catch (error) {
      try {
        await adapter.dispose();
      } catch {}
      throw error;
    }
    return adapter.dispose;
  },
} satisfies Plugin.Plugin & { readonly server: typeof SessionMemoryPlugin };
