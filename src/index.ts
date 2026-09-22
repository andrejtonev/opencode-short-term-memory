import type { Plugin } from "@opencode/plugin";
import { SessionMemoryPlugin } from "./v1-adapter";
import { createV2Adapter } from "./v2-adapter";

export { SessionMemoryPlugin };

export default {
  id: "opencode-short-term-memory",
  server: SessionMemoryPlugin,
  setup(context) {
    const adapter = createV2Adapter(context);
    return adapter.dispose;
  },
} satisfies Plugin.Plugin & { readonly server: typeof SessionMemoryPlugin };
