import type { Plugin } from "@opencode/plugin";
import type { Plugin as V1HostPlugin } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { SessionMemoryPlugin as InternalSessionMemoryPlugin } from "./v1-adapter";
import { createV2Adapter, type V2SessionCompaction, type V2SessionContext } from "./v2-adapter";
import { createV2ContextInjection } from "./v2-context-injection";
import { createV2MessageInjection } from "./v2-message-injection";
import { disposeV2NativeGeneration, isV2OwnedSummarySession } from "./v2-native-generation";
import { createV2MemoryUpdater } from "./v2-memory-update";
import { createV2MemoryToolRegistrations } from "./v2-memory-tools";
import { setupStatusCommand } from "./v2-status-command";
import { createV2ReminderCadence } from "./v2-reminder-cadence";
import { createV2IdleUpdateScheduler } from "./v2-idle-update";
import { readV2CurrentHistory } from "./v2-current-history";
import { registerV2DcpCompletion } from "./v2-dcp";
import { bootstrapV2InstalledConfig } from "./v2-config-installation";
import { DEFAULT_CONFIG, logEvent, readConfig } from "./memory-utils";
import { initializeV2Telemetry, recordV2Telemetry } from "./v2-telemetry";
import { retainV2MemoryCoordination } from "./v2-mutation-coordination";

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
    initializeV2Telemetry(context, lifetime.signal);
    const releaseCoordination = retainV2MemoryCoordination(context.location.directory);
    await bootstrapV2InstalledConfig(context);
    const cadence = createV2ReminderCadence(context, context.location.directory);
    const isOwnedSession = (sessionID: string) => isV2OwnedSummarySession(context, sessionID);
    const messageInjection = createV2MessageInjection(
      context,
      context.location.directory,
      cadence,
      lifetime.signal,
      isOwnedSession,
    );
    const injection = createV2ContextInjection(
      context,
      context.location.directory,
      cadence,
      lifetime.signal,
      isOwnedSession,
    );
    const compactionInjection = createV2ContextInjection(
      context,
      context.location.directory,
      undefined,
      lifetime.signal,
      isOwnedSession,
      "compaction",
    );
    const updater = createV2MemoryUpdater(context, context.location.directory, { lifetimeSignal: lifetime.signal });
    const idle = createV2IdleUpdateScheduler(context, context.location.directory, updater, lifetime.signal);
    const logRefreshFailure = async (
      event: "v2_context_refresh_failed" | "v2_compaction_refresh_failed",
      sessionID: string,
      reason: string,
    ) => {
      recordV2Telemetry(context, "error", reason);
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
      if (isOwnedSession(input.sessionID)) return;
      // Like V1, primary context reads saved memory. Idle events own background
      // updates; a slow summarizer must never hold up the user's model request.
      await injection(input);
    };
    const compactionCallback = async (input: V2SessionCompaction) => {
      if (lifetime.signal.aborted) return;
      if (isOwnedSession(input.sessionID)) return;
      try {
        const compactionConfig = await readConfig(undefined, context.location.directory);
        if (compactionConfig.enabled) recordV2Telemetry(context, "compact");
        const current = await readV2CurrentHistory(context, input.sessionID, 1_000);
        if (lifetime.signal.aborted) return;
        if (current.status !== "ready") {
          await logRefreshFailure("v2_compaction_refresh_failed", input.sessionID, `history_${current.status}`);
        } else if (current.history.stoppedBeforeMessageID !== undefined) {
          await logRefreshFailure("v2_compaction_refresh_failed", input.sessionID, "history_unfinished_prefix");
        } else {
          const config = await readConfig(undefined, context.location.directory);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              updater({
                sessionID: input.sessionID,
                model: current.history.model,
                messages: current.history.messages,
              }),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, Math.max(3_000, config.debounceMs * 5));
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
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
    let disposeDcp: (() => Promise<void>) | undefined;
    try {
      try {
        disposeDcp = (await registerV2DcpCompletion(context, context.location.directory, updater, lifetime.signal))
          .dispose;
      } catch (error) {
        try {
          await logEvent(await readConfig(undefined, context.location.directory), "v2_dcp_hook_unavailable", {
            reason: error instanceof Error ? error.message : String(error),
          });
        } catch {}
      }
      await adapter.runtime.registerSystemContextMutation(callback);
      await adapter.runtime.registerCompactionMutation(compactionCallback);
      const promptRegistration = await context.session.hook("prompt", messageInjection);
      disposePrompt = promptRegistration.dispose;
      for (const registration of createV2MemoryToolRegistrations(context, lifetime.signal)) {
        await adapter.runtime.registerTool(registration);
      }
      disposeStatus = await setupStatusCommand(context, adapter.runtime, lifetime.signal);
    } catch (error) {
      lifetime.abort();
      releaseCoordination();
      disposeV2NativeGeneration(context);
      messageInjection.dispose();
      await disposeDcp?.().catch(() => undefined);
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
    let disposal: Promise<void> | undefined;
    return () =>
      (disposal ??= (async () => {
        try {
          lifetime.abort();
          disposeV2NativeGeneration(context);
          messageInjection.dispose();
          const prompt = disposePrompt;
          disposePrompt = undefined;
          const results = await Promise.allSettled([
            Promise.resolve().then(() => disposeDcp?.()),
            Promise.resolve().then(() => idle.dispose()),
            Promise.resolve().then(() => disposeStatus?.()),
            Promise.resolve().then(() => prompt?.()),
            Promise.resolve().then(() => adapter.dispose()),
          ]);
          const failure = results.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        } finally {
          cadence.dispose();
          releaseCoordination();
        }
      })());
  },
} satisfies Plugin.Plugin & { readonly server: typeof SessionMemoryPlugin };
