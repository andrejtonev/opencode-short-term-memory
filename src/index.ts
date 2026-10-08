import type { Plugin } from "@opencode/plugin";
import type { Plugin as V1HostPlugin } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { SessionMemoryPlugin as InternalSessionMemoryPlugin } from "./v1-adapter";
import { createV2Adapter, type V2SessionCompaction, type V2SessionContext } from "./v2-adapter";
import { createV2ContextInjection } from "./v2-context-injection";
import { createV2MemoryUpdater, isV2MemoryUpdateInFlight } from "./v2-memory-update";
import { createV2MemoryToolRegistrations } from "./v2-memory-tools";
import { setupStatusCommand } from "./v2-status-command";
import { createV2ReminderCadence } from "./v2-reminder-cadence";
import { createV2IdleUpdateScheduler } from "./v2-idle-update";
import { readV2CurrentHistory } from "./v2-current-history";
import { DEFAULT_CONFIG, logEvent, readConfig } from "./memory-utils";

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
    const cadence = createV2ReminderCadence(context, context.location.directory);
    const injection = createV2ContextInjection(context, context.location.directory, cadence);
    const compactionInjection = createV2ContextInjection(context, context.location.directory);
    const lifetime = new AbortController();
    const updater = createV2MemoryUpdater(context, context.location.directory, { lifetimeSignal: lifetime.signal });
    const idle = createV2IdleUpdateScheduler(context, context.location.directory, updater, lifetime.signal);
    const callback = async (input: V2SessionContext) => {
      if (lifetime.signal.aborted) return;
      if (isV2MemoryUpdateInFlight(context.location.directory, input.sessionID)) return;
      await updater(input);
      await injection(input);
    };
    const compactionCallback = async (input: V2SessionCompaction) => {
      if (lifetime.signal.aborted) return;
      const logRefreshFailure = async (reason: string) => {
        try {
          const config = await readConfig(undefined, context.location.directory);
          await logEvent(config, "v2_compaction_refresh_failed", { sessionID: input.sessionID, reason });
        } catch {
          try {
            await logEvent(DEFAULT_CONFIG, "v2_compaction_refresh_failed", {
              sessionID: input.sessionID,
              reason,
            });
          } catch {}
        }
      };
      try {
        const current = await readV2CurrentHistory(context, input.sessionID, 1_000);
        if (lifetime.signal.aborted) return;
        if (current.status !== "ready") {
          await logRefreshFailure(`history_${current.status}`);
        } else if (current.history.stoppedBeforeMessageID !== undefined) {
          await logRefreshFailure("history_unfinished_prefix");
        } else {
          await updater({
            sessionID: input.sessionID,
            model: current.history.model,
            messages: current.history.messages,
          });
        }
      } catch {
        await logRefreshFailure("refresh_error");
      } finally {
        if (lifetime.signal.aborted) return;
        await compactionInjection(input);
      }
    };
    let disposeStatus: (() => Promise<void>) | undefined;
    let disposePrompt: (() => Promise<void>) | undefined;
    try {
      await adapter.runtime.registerSystemContextMutation(callback);
      await adapter.runtime.registerCompactionMutation(compactionCallback);
      const promptRegistration = await context.session.hook("prompt", (input) => cadence.record(input));
      disposePrompt = promptRegistration.dispose;
      for (const registration of createV2MemoryToolRegistrations(context, lifetime.signal)) {
        await adapter.runtime.registerTool(registration);
      }
      disposeStatus = await setupStatusCommand(context, adapter.runtime);
    } catch (error) {
      lifetime.abort();
      await idle.dispose().catch(() => undefined);
      try {
        await adapter.dispose();
      } catch {}
      try {
        const prompt = disposePrompt;
        disposePrompt = undefined;
        await prompt?.();
      } catch {}
      try {
        cadence.dispose();
      } catch {}
      throw error;
    }
    return async () => {
      try {
        lifetime.abort();
        await idle.dispose();
        await disposeStatus?.();
      } finally {
        try {
          const prompt = disposePrompt;
          disposePrompt = undefined;
          await prompt?.();
        } finally {
          try {
            await adapter.dispose();
          } finally {
            cadence.dispose();
          }
        }
      }
    };
  },
} satisfies Plugin.Plugin & { readonly server: typeof SessionMemoryPlugin };
