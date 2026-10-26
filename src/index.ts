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
import { classifyV2Session } from "./v2-child-memory";
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
    const lifetime = new AbortController();
    const cadence = createV2ReminderCadence(context, context.location.directory);
    const injection = createV2ContextInjection(context, context.location.directory, cadence, lifetime.signal);
    const compactionInjection = createV2ContextInjection(
      context,
      context.location.directory,
      undefined,
      lifetime.signal,
    );
    const updater = createV2MemoryUpdater(context, context.location.directory, { lifetimeSignal: lifetime.signal });
    const idle = createV2IdleUpdateScheduler(context, context.location.directory, updater, lifetime.signal);
    const logRefreshFailure = async (
      event: "v2_context_refresh_failed" | "v2_compaction_refresh_failed",
      sessionID: string,
      reason: string,
    ) => {
      try {
        await logEvent(await readConfig(undefined, context.location.directory), event, { sessionID, reason });
      } catch {
        try {
          await logEvent(DEFAULT_CONFIG, event, { sessionID, reason });
        } catch {}
      }
    };
    const callback = async (input: V2SessionContext) => {
      if (lifetime.signal.aborted) return;
      try {
        const config = await readConfig(undefined, context.location.directory);
        if (config.enabled && !isV2MemoryUpdateInFlight(context.location.directory, input.sessionID)) {
          const lineage = await classifyV2Session(context, input.sessionID);
          if (lifetime.signal.aborted) return;
          if (lineage.kind === "primary") {
            // Model-facing messages have lost durable provenance: synthetic/skill/shell
            // records can look like user text, while idle anchors disappear entirely.
            const current = await readV2CurrentHistory(context, input.sessionID, 5_000, input.model);
            if (lifetime.signal.aborted) return;
            if (current.status === "ready") await updater(current.history);
            else await logRefreshFailure("v2_context_refresh_failed", input.sessionID, `history_${current.status}`);
          }
        }
      } catch {
        await logRefreshFailure("v2_context_refresh_failed", input.sessionID, "refresh_error");
        // Injection has its own conservative config/error handling and can still
        // use existing memory if refreshing it is unavailable.
      }
      if (lifetime.signal.aborted) return;
      // A background producer being busy must not suppress reading saved memory.
      await injection(input);
    };
    const compactionCallback = async (input: V2SessionCompaction) => {
      if (lifetime.signal.aborted) return;
      try {
        const current = await readV2CurrentHistory(context, input.sessionID, 1_000);
        if (lifetime.signal.aborted) return;
        if (current.status !== "ready") {
          await logRefreshFailure("v2_compaction_refresh_failed", input.sessionID, `history_${current.status}`);
        } else if (current.history.stoppedBeforeMessageID !== undefined) {
          await logRefreshFailure("v2_compaction_refresh_failed", input.sessionID, "history_unfinished_prefix");
        } else {
          await updater({
            sessionID: input.sessionID,
            model: current.history.model,
            messages: current.history.messages,
          });
        }
      } catch {
        await logRefreshFailure("v2_compaction_refresh_failed", input.sessionID, "refresh_error");
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
      disposeStatus = await setupStatusCommand(context, adapter.runtime, lifetime.signal);
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
