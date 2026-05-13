import type { Config as OpencodeConfig } from "@opencode-ai/plugin";
import type {
  Client,
  SessionCreatedInput,
  SessionUpdatedInput,
  SessionDeletedInput,
  EventInput,
  MessageUpdatedInput,
  ChatMessageInput,
  ChatMessageOutput,
  SystemTransformInput,
  SystemTransformOutput,
  CompactionInput,
  CompactionOutput,
  CommandExecuteBeforeInput,
  CommandExecuteBeforeOutput,
} from "./types";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createRuntimeState,
  ensureMemoryFile,
  ensureDefaultConfigFile,
  resolveProjectOpencodeDir,
  getMessageRole,
  getMessageText,
  getSessionID,
  isSelfInjection,
  logEvent,
  showToast,
  MEMORY_HEADER,
  checkpointPathFor,
  memoryPathFor,
  readText,
  removePath,
  sanitizeMessage,
  writeTextAtomic,
  type SessionMemoryConfig,
  type RuntimeState,
  DEFAULT_CONFIG,
} from "./memory-utils";
import { type ConfigContext, reloadConfig } from "./config";
import { readLastProcessedMessageID, collectRecentVisibleMessages } from "./message-collector";
import { parseMemoryActionFromCommandArgument, executeMemoryAction, type CommandContext } from "./commands";
import { injectMemoryIntoSystemTransform } from "./injection";
import { createTools, type CreateToolsContext } from "./tools";

import {
  type SessionRuntimeState,
  type IdleWaiter,
  MAX_SESSION_STATES,
  ensureSessionState,
  isSessionBusy,
  notifySessionIdle,
  waitForSessionIdle,
  waitForSessionUpdateDrain,
} from "./session-state";
import { maybeBootstrapSessionHistory, processMemoryChunks } from "./memory-lifecycle";

// ── Centralised constants ─────────────────────────────────
const MEMORY_DIR_FALLBACK = ".opencode/memory";

// ── Plugin factory with encapsulated instance state ─────────

export const SessionMemoryPlugin = async ({
  client,
  directory,
}: {
  client: Client;
  directory?: string;
}): Promise<Record<string, unknown>> => {
  // ── Instance‑local runtime state ─────────────────────────
  let globalState = createRuntimeState();
  const sessionStates = new Map<string, SessionRuntimeState>();
  const sessionStatesOrder: string[] = []; // LRU order
  let updateInFlight = new Set<string>();
  let pendingUpdateAfterInFlight = new Set<string>();
  const configCtx: ConfigContext = {
    config: DEFAULT_CONFIG,
    cache: null,
    lastWarning: "",
    globalState,
    baseDir: directory,
  };

  // Sub-agent tracking
  const sessionParents = new Map<string, string>(); // childID → parentID
  // I2 – Reverse mapping for cleanup
  const parentToChildren = new Map<string, Set<string>>(); // parentID → set of childIDs

  // I3 / I11 – Idle waiters per session
  const idleWaiters = new Map<string, IdleWaiter>();

  // Deleted-session guard to prevent in-flight updates from recreating files
  const deletedSessions = new Set<string>();

  // ── Context wrappers for session-state module ──────────
  const isBusyCtx = (sid: string) => isSessionBusy(sid, sessionStates, updateInFlight, pendingUpdateAfterInFlight);
  const waitForIdleCtx = (sid: string, ms: number) => waitForSessionIdle(sid, ms, isBusyCtx, idleWaiters);

  // ── Initialisation helpers inside factory ────────────────
  await reloadConfig(configCtx, true);
  const projectOpencodeDir = await resolveProjectOpencodeDir(directory);
  await ensureDefaultConfigFile(projectOpencodeDir);
  let config = configCtx.config;
  const cmdCtx: CommandContext = { config, sessionStates, globalState };
  await mkdir(config.memoryDir, { recursive: true });
  await logEvent(config, "plugin_loaded", { model: config.memoryModel, mode: config.summarizerMode });

  if (configCtx.globalState.startupWarning) {
    client?.tui
      ?.showToast?.({
        body: {
          title: "Session Memory Plugin",
          message: configCtx.globalState.startupWarning,
          variant: "warning",
          duration: 8000,
        },
      })
      ?.catch?.(() => {});
  }

  async function reloadConfigLocal(force = false) {
    await reloadConfig(configCtx, force);
    config = configCtx.config;
    cmdCtx.config = config;
    return config;
  }

  // ── Helper functions that require instance state ──────────
  function scheduleMemoryUpdate(client: Client, sessionID: string, reason: string, config: SessionMemoryConfig) {
    if (deletedSessions.has(sessionID)) return;
    const s = ensureSessionState(sessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = undefined;
      updateMemory(client, sessionID, reason, config).catch(async (error) => {
        globalState.lastError = (error as Error).message;
        showToast(client, "Session Memory", "Summarization failed — check /stm logs for details.");
        await logEvent(config, "memory_update_uncaught_error", { sessionID, error: globalState.lastError });
      });
    }, config.debounceMs);
  }

  async function updateMemory(client: Client, sessionID: string, reason: string, config: SessionMemoryConfig) {
    if (!config.enabled) return;

    // Sub-agent sessions never update memory
    if (sessionParents.has(sessionID)) {
      await logEvent(config, "subagent_update_skipped", { sessionID, reason });
      return;
    }

    if (deletedSessions.has(sessionID)) {
      await logEvent(config, "memory_update_skipped", { sessionID, reason, detail: "session_deleted" });
      return;
    }

    if (updateInFlight.has(sessionID)) {
      pendingUpdateAfterInFlight.add(sessionID);
      await logEvent(config, "memory_update_skipped", { sessionID, reason, detail: "update_in_flight" });
      return;
    }
    updateInFlight.add(sessionID);

    try {
      // Outer try/catch to record any unexpected error
      try {
        const memoryPath = await ensureMemoryFile(sessionID, config);
        let existing = await readText(memoryPath, "");
        const isFirstUpdateForSession = !(await readLastProcessedMessageID(sessionID, config));
        const agentsMdContextRaw =
          config.includeAgentsMdOnFirstUpdate && isFirstUpdateForSession
            ? await readText(join(directory || ".", "AGENTS.md"), "")
            : "";
        const agentsMdContext = sanitizeMessage(agentsMdContextRaw).slice(0, config.maxUpdateInputLength);
        const recent = await collectRecentVisibleMessages(client, sessionID, config, globalState);
        if (!recent.entries.length) {
          await logEvent(config, "memory_update_skipped", { sessionID, reason, detail: "no_visible_recent_messages" });
          return;
        }
        await logEvent(config, "memory_update_start", {
          sessionID,
          reason,
          mode: config.summarizerMode,
          model: config.memoryModel,
          executable: config.opencodeExecutable,
          deltaEntries: recent.entries.length,
        });

        if (deletedSessions.has(sessionID)) {
          await logEvent(config, "memory_update_skipped", {
            sessionID,
            reason,
            detail: "session_deleted_during_collection",
          });
          return;
        }

        // I13 – delegate chunk processing to extracted helper
        await processMemoryChunks(
          client,
          sessionID,
          reason,
          config,
          memoryPath,
          existing,
          recent.entries,
          agentsMdContext,
          globalState,
        );
      } catch (error) {
        globalState.lastError = (error as Error).message;
        showToast(client, "Session Memory", "Summarization failed — check /stm logs for details.");
        await logEvent(config, "memory_update_error", { sessionID, reason, error: globalState.lastError });
      }
    } finally {
      updateInFlight.delete(sessionID);
      if (pendingUpdateAfterInFlight.has(sessionID)) {
        pendingUpdateAfterInFlight.delete(sessionID);
        scheduleMemoryUpdate(client, sessionID, "post_in_flight_replay", config);
      } else if (!isBusyCtx(sessionID)) {
        notifySessionIdle(sessionID, idleWaiters);
      }
    }
  }

  // ── Tool context ───────────────────────────────────────
  const toolCtx: CreateToolsContext = {
    cmdCtx,
    globalState,
    client,
    reloadConfigLocal,
    updateMemory,
  };
  const tools = createTools(toolCtx);

  // ── Return the plugin object ─────────────────────────────
  return {
    config: async (opencodeConfig: OpencodeConfig) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command.stm ??= {
        template: "/stm $ARGUMENTS",
        description: "Inspect or control session memory (status|show|logs|settings|update|reset)",
      };
    },

    event: async (input: EventInput) => {
      await reloadConfigLocal();
      const evt = (input?.event || {}) as Record<string, unknown>;
      const name = evt?.type || evt?.name || evt?.event || evt?.kind || "unknown_event";
      // ── DCP compress tool detection ────────────────────────
      if (config.enabled && name === "message.part.updated") {
        const props = evt?.properties as Record<string, unknown> | undefined;
        const part = props?.part as Record<string, unknown> | undefined;
        const partState = part?.state as Record<string, unknown> | undefined;
        if (part?.type === "tool" && part?.tool === "compress" && partState?.status === "completed") {
          const sessionID =
            props?.sessionID && typeof props.sessionID === "string" ? props.sessionID : getSessionID(input);
          if (sessionID && !sessionParents.has(sessionID)) {
            const s = ensureSessionState(sessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
            const now = Date.now();

            // Debounce: skip if already detected recently
            if (s.lastDcpCompressAt && now - s.lastDcpCompressAt < config.debounceMs * 2) {
              await logEvent(config, "dcp_compress_skipped_duplicate", { sessionID });
              return;
            }
            s.lastDcpCompressAt = now;

            // If an update is already in-flight, queue a pending replay
            if (updateInFlight.has(sessionID)) {
              pendingUpdateAfterInFlight.add(sessionID);
              await logEvent(config, "dcp_compress_queued_after_inflight", { sessionID });
              return;
            }

            await logEvent(config, "dcp_compress_triggered", { sessionID });
            await updateMemory(client, sessionID, "dcp_compress", config);
          }
        }
      }

      if (config.enabled && name === "session.idle") {
        const sessionID = getSessionID(evt) || getSessionID(input);
        if (sessionID) {
          const s = ensureSessionState(sessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
          const now = Date.now();
          if (now - s.lastIdleScheduledAt < Math.max(config.debounceMs, 1500)) return;
          s.lastIdleScheduledAt = now;
          await ensureMemoryFile(sessionID, config);
          scheduleMemoryUpdate(client, sessionID, "session_idle", config);
        }
      }

      if (!config.debug) return;
      await logEvent(config, "sdk_event", {
        name,
        keys: Object.keys(evt).slice(0, 40),
      });
    },

    tool: tools,

    "command.execute.before": async (input: CommandExecuteBeforeInput, output: CommandExecuteBeforeOutput) => {
      await reloadConfigLocal();
      const commandName = String(
        input?.command?.name || input?.name || input?.command || input?.args?.name || "",
      ).toLowerCase();
      if (commandName !== "stm") return;

      const sessionID = getSessionID(input) || getSessionID({}, input.ctx) || globalState.lastActiveSessionID;
      const rawArgument =
        input?.command?.argument ?? input?.argument ?? input?.args?.argument ?? input?.args?.value ?? "";
      const action = parseMemoryActionFromCommandArgument(rawArgument);
      const result = await executeMemoryAction(action, sessionID, cmdCtx, client, updateMemory);

      if (output && typeof output === "object") {
        output.stop = true;
        output.message = String(result || "");
      }
    },

    "session.created": async (input: SessionCreatedInput) => {
      await reloadConfigLocal();
      const sessionID = getSessionID(input);
      if (!sessionID) return;

      const info = input?.event?.properties?.info;
      const parentID = info?.parentID;

      deletedSessions.delete(sessionID);
      globalState.lastActiveSessionID = sessionID;
      await ensureMemoryFile(sessionID, config);

      if (parentID) {
        // Sub-agent session
        sessionParents.set(sessionID, parentID);
        // I2 – Track child in reverse mapping
        let children = parentToChildren.get(parentID);
        if (!children) {
          children = new Set();
          parentToChildren.set(parentID, children);
        }
        children.add(sessionID);

        if (config.injectInSubagents) {
          const parentMemory = await readText(memoryPathFor(parentID, config.memoryDir), "");
          if (parentMemory.trim()) {
            await writeTextAtomic(memoryPathFor(sessionID, config.memoryDir), parentMemory);
          }
          await logEvent(config, "subagent_created_with_memory", { sessionID, parentID });
        } else {
          await logEvent(config, "subagent_created_skipped_injection", { sessionID, parentID });
        }
        return;
      }

      // Main session
      await logEvent(config, "session_created", { sessionID });
      await maybeBootstrapSessionHistory(sessionID, "session_created_bootstrap", config, client, scheduleMemoryUpdate);
    },

    "session.updated": async (input: SessionUpdatedInput) => {
      await reloadConfigLocal();
      const sessionID = getSessionID(input);
      if (!sessionID) return;
      deletedSessions.delete(sessionID);
      globalState.lastActiveSessionID = sessionID;
      await ensureMemoryFile(sessionID, config);
      await logEvent(config, "session_updated", { sessionID });
      await maybeBootstrapSessionHistory(sessionID, "session_updated_bootstrap", config, client, scheduleMemoryUpdate);
    },

    "session.deleted": async (input: SessionDeletedInput) => {
      await reloadConfigLocal();
      const sessionID = getSessionID(input);
      if (!sessionID) return;
      deletedSessions.add(sessionID);
      await removePath(memoryPathFor(sessionID, config.memoryDir));
      await removePath(checkpointPathFor(sessionID, config.memoryDir));
      // Clean up per‑session runtime state
      const s = sessionStates.get(sessionID);
      if (s?.timer) clearTimeout(s.timer);
      sessionStates.delete(sessionID);
      // I2 – Cleanup parent/child mappings
      sessionParents.delete(sessionID);
      const children = parentToChildren.get(sessionID);
      if (children) {
        for (const child of children) {
          sessionParents.delete(child);
        }
        parentToChildren.delete(sessionID);
      }
      // Also remove this session from its parent's children set
      for (const [parent, childSet] of parentToChildren.entries()) {
        if (childSet.has(sessionID)) {
          childSet.delete(sessionID);
          if (childSet.size === 0) parentToChildren.delete(parent);
          break;
        }
      }
      // Remove from LRU order if present
      const idx = sessionStatesOrder.indexOf(sessionID);
      if (idx !== -1) sessionStatesOrder.splice(idx, 1);
      updateInFlight.delete(sessionID);
      pendingUpdateAfterInFlight.delete(sessionID);
      // Wake any drain waiters (I3 / I11)
      notifySessionIdle(sessionID, idleWaiters);
      await logEvent(config, "session_deleted_memory_removed", { sessionID });
    },

    "message.updated": async (input: MessageUpdatedInput) => {
      await reloadConfigLocal();
      if (!config.enabled) return;
      const sessionID = getSessionID(input);
      if (!sessionID) return;
      globalState.lastActiveSessionID = sessionID;
      await ensureMemoryFile(sessionID, config);

      const role = getMessageRole(input.message || input);
      const text = getMessageText(input);
      if (!text || isSelfInjection(text)) return;

      await logEvent(config, "message_updated", { sessionID, role, textBytes: text.length });
    },

    "chat.message": async (input: ChatMessageInput, output: ChatMessageOutput) => {
      await reloadConfigLocal();
      if (!config.enabled) return;

      const sessionID = input.sessionID || globalState.lastActiveSessionID;
      if (!sessionID) return;

      // Cast to access the message property (not in official SDK types yet)
      const role = getMessageRole(input.message || input);
      if (role !== "user") return;

      globalState.lastActiveSessionID = sessionID;
      await ensureMemoryFile(sessionID, config);

      const text = getMessageText({ message: output?.message, parts: output?.parts });
      if (!text || isSelfInjection(text)) return;

      await logEvent(config, "chat_message", {
        sessionID,
        role,
        textBytes: text.length,
        hasParts: Array.isArray(output?.parts),
      });

      await logEvent(config, "memory_inject_skipped", { sessionID, reason: "using_chat_system_transform" });
    },

    "experimental.chat.system.transform": async (input: SystemTransformInput, output: SystemTransformOutput) => {
      await reloadConfigLocal();
      await injectMemoryIntoSystemTransform(
        input,
        output,
        config,
        globalState,
        sessionStates,
        sessionStatesOrder,
        client,
      );
    },

    "experimental.session.compacting": async (input: CompactionInput, output: CompactionOutput) => {
      await reloadConfigLocal();
      const sessionID = getSessionID(input) || globalState.lastActiveSessionID;
      if (!sessionID || !config.enabled) return;
      globalState.compactCount += 1;
      await ensureMemoryFile(sessionID, config);

      // Wait for any in-flight update to finish (with retry)
      const drainTimeout = Math.max(3000, config.debounceMs * 5);
      let drained = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        await waitForSessionUpdateDrain(sessionID, attempt === 0 ? drainTimeout : drainTimeout * 2, waitForIdleCtx);
        if (!updateInFlight.has(sessionID)) {
          drained = true;
          break;
        }
        if (attempt === 0) {
          await logEvent(config, "compaction_drain_retry", { sessionID });
        }
      }

      // Always run a fresh update if no update is pending (even if drain timed out we still try)
      if (!updateInFlight.has(sessionID)) {
        await updateMemory(client, sessionID, "before_compaction", config);
        // Wait for the new update to finish
        await waitForSessionUpdateDrain(sessionID, drainTimeout, waitForIdleCtx);
      }

      // If still busy, use whatever is on disk and log a warning
      if (updateInFlight.has(sessionID)) {
        await logEvent(config, "compaction_drain_timeout_using_stale_memory", {
          sessionID,
          timeoutMs: drainTimeout,
        });
      }

      // For sub-agents with injection disabled, do not push any memory
      const parentID = sessionParents.get(sessionID);
      if (parentID && !config.injectInSubagents) {
        return;
      }

      const memory = await readText(memoryPathFor(sessionID, config.memoryDir), "");
      if (!memory.trim()) return;
      output.context.push(`${MEMORY_HEADER}\n\n${memory.slice(0, config.maxMemoryLength)}`);
      await logEvent(config, "compaction_context_pushed", { sessionID, bytes: memory.length });
    },
  };
};

export default SessionMemoryPlugin;
