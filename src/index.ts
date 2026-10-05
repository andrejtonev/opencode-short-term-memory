import type { Plugin } from "@opencode/plugin";
import type { Plugin as V1HostPlugin } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { SessionMemoryPlugin as InternalSessionMemoryPlugin } from "./v1-adapter";
import { createV2Adapter, type V2SessionContext } from "./v2-adapter";
import { createV2ContextInjection } from "./v2-context-injection";
import { createV2MemoryUpdater, isV2MemoryUpdateInFlight } from "./v2-memory-update";
import { createV2MemoryToolRegistrations } from "./v2-memory-tools";
import { setupStatusCommand } from "./v2-status-command";

export type V1MemoryPlugin = (input: {
  client: OpencodeClient;
  directory?: string;
  worktree?: string;
  serverUrl?: URL;
}) => Promise<Record<string, unknown>>;

export const SessionMemoryPlugin: V1MemoryPlugin = InternalSessionMemoryPlugin;

type Assert<T extends true> = T;
type V1HostPluginContract = Assert<typeof SessionMemoryPlugin extends V1HostPlugin ? true : false>;

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
