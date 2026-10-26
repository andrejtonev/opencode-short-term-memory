import type {
  OpencodeConfig,
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
  UserExecutionMetadata,
} from "./types";
import type { RuntimeContract } from "./runtime-contract";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  createRuntimeState,
  bootstrapInstalledConfig,
  ensureMemoryFile,
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
  writeTextAtomic,
  sanitizeMessage,
  type SessionMemoryConfig,
  type RuntimeState,
  DEFAULT_CONFIG,
  loadActiveSideSessions,
  mutateActiveSideSessions,
  SIDE_SESSION_TITLE,
} from "./memory-utils";
import { type ConfigContext, reloadConfig } from "./config";
import {
  readLastProcessedMessageID,
  writeLastProcessedMessageID,
  collectRecentVisibleMessages,
  getMessageID,
} from "./message-collector";
import { executeMemoryAction, type CommandContext } from "./commands";
import { createV1ActionReceiver } from "./v1-native-actions";
import { appendChildMemoryToSystem, deliverMemoryViaNoReply, injectMemoryIntoSystemTransform } from "./injection";
import { createTools, type CreateToolsContext } from "./tools";
import type { MemoryUpdateResult } from "./memory-update-result";
import { generationErrorMessage } from "./provider-error";
import type { SummarizerRuntime } from "./summarizer";

import {
  type SessionRuntimeState,
  type IdleWaiter,
  MAX_SESSION_STATES,
  bumpMemoryRevision,
  ensureSessionState,
  isSessionBusy,
  notifySessionIdle,
  rememberCanonicalTurn,
  waitForSessionIdle,
  waitForSessionUpdateDrain,
  rememberAssistantOriginOwner,
  resetSessionDeliveryState,
  admitOriginUserTurn,
  rememberTaggedOriginAlias,
} from "./session-state";
import { maybeBootstrapSessionHistory, processMemoryChunks } from "./memory-lifecycle";
import {
  persistV1Reset,
  readV1ResetBoundary,
  selectV1ResetBoundary,
  v1ResetBoundaryPathFor,
} from "./v1-reset-boundary";

type SharedRuntime = Pick<
  RuntimeContract,
  | "readSessionMessages"
  | "deliverContextNoReply"
  | "listTemporarySessions"
  | "deleteTemporarySessionForCleanup"
  | "getTemporarySession"
> &
  SummarizerRuntime;

function snapshotUserExecutionMetadata(
  preferred: ChatMessageOutput["message"] | undefined,
  fallback: ChatMessageInput,
): UserExecutionMetadata {
  const agent = preferred?.agent ?? fallback.agent ?? fallback.message?.agent;
  const model = preferred?.model ?? fallback.model ?? fallback.message?.model;
  const tools = preferred?.tools ?? fallback.tools ?? fallback.message?.tools;
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model: { providerID: model.providerID, modelID: model.modelID } }),
    ...(tools === undefined ? {} : { tools: { ...tools } }),
  };
}

// ── Centralised constants ─────────────────────────────────
const MEMORY_DIR_FALLBACK = ".opencode/memory";

// ── Plugin factory with encapsulated instance state ─────────

export const SessionMemoryPlugin = async (
  {
    client,
    directory,
  }: {
    client: Client;
    directory?: string;
  },
  runtime: SharedRuntime,
): Promise<Record<string, unknown>> => {
  // Start-of-factory clock. We want the factory body (synchronous setup)
  // to complete in <10ms; the diff is what the e2e harness greps for.
  const __stmT0 = performance.now();
  // ── Instance‑local runtime state ─────────────────────────
  let globalState = createRuntimeState();
  const sessionStates = new Map<string, SessionRuntimeState>();
  const sessionStatesOrder: string[] = []; // LRU order
  let updateInFlight = new Set<string>();
  let pendingUpdateAfterInFlight = new Map<string, number>();
  const configCtx: ConfigContext = {
    config: DEFAULT_CONFIG,
    cache: null,
    lastWarning: "",
    globalState,
    baseDir: directory,
  };

  // Sub-agent tracking
  const sessionParents = new Map<string, string>(); // childID → parentID
  // Keep internal identity for this plugin instance, including after deletion:
  // native session IDs are unique and delayed events must not revive them.
  // Deletion still runs its normal cleanup path independently of this set.
  const internalSessionIDs = new Set<string>();
  const ownedPromptIDs = new Map<string, Set<string>>();
  const lastActiveInputFingerprints = new Map<string, string>();
  const sessionsAwaitingIdle = new Set<string>();
  // I2 – Reverse mapping for cleanup
  const parentToChildren = new Map<string, Set<string>>(); // parentID → set of childIDs
  const childDeliveryMetadata = new Map<
    string,
    { startupSnapshot: string; startupInjectionPending: boolean; dcpInjectionPending: boolean }
  >();
  const pendingChildInitializations = new Map<string, { generation: number; promise: Promise<void> }>();

  function registerOwnedPrompt(sessionID: string, messageID: string): void {
    const ids = ownedPromptIDs.get(sessionID) ?? new Set<string>();
    ids.add(messageID);
    ownedPromptIDs.set(sessionID, ids);
  }

  function ownsPrompt(sessionID: string, messageID: string | undefined): boolean {
    return Boolean(messageID && ownedPromptIDs.get(sessionID)?.has(messageID));
  }

  function registerInternalSession(sessionID: string): void {
    if (internalSessionIDs.has(sessionID)) return;
    internalSessionIDs.add(sessionID);
    // Invalidate work that passed admission before the create response or
    // title identified this session. Preserve an existing deletion tombstone.
    invalidateSession(sessionID, isSessionTerminal(sessionID));
    sessionsAwaitingIdle.delete(sessionID);
  }

  function parentMessageID(row: unknown): string {
    const r = row as Record<string, unknown>;
    const message = r?.message as Record<string, unknown> | undefined;
    const info = r?.info as Record<string, unknown> | undefined;
    const messageInfo = message?.info as Record<string, unknown> | undefined;
    const parent = message?.parent as Record<string, unknown> | undefined;
    return String(
      r?.parentID ||
        r?.parentId ||
        info?.parentID ||
        info?.parentId ||
        message?.parentID ||
        message?.parentId ||
        messageInfo?.parentID ||
        messageInfo?.parentId ||
        parent?.id ||
        "",
    ).trim();
  }

  function activeInputFingerprint(
    recentEntries: unknown,
    existingMemory: string,
    agentsMdContext: string,
    currentConfig: SessionMemoryConfig,
    operationGeneration: number,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          recentEntries,
          existingMemory,
          agentsMdContext,
          config: currentConfig,
          operationGeneration,
        }),
      )
      .digest("hex");
  }

  function wrapperSummarizerRuntime(sessionID: string, onActivePromptDispatch?: () => void): SharedRuntime {
    return {
      ...runtime,
      cleanSessionToolGuard: true,
      readSessionMessages: async (readSessionID, options) => {
        const rows = await runtime.readSessionMessages(readSessionID, options);
        return rows.filter((row) => {
          const messageID = getMessageID(row);
          return !ownsPrompt(readSessionID, messageID) && !ownsPrompt(readSessionID, parentMessageID(row));
        });
      },
      createTemporarySession: async (request) => {
        const created = await runtime.createTemporarySession(request);
        registerInternalSession(created.id);
        return created;
      },
      deliverGeneratedPrompt: async (request) => {
        if (request.sessionId !== sessionID) return runtime.deliverGeneratedPrompt(request);
        const messageID = `msg_${randomUUID()}`;
        registerOwnedPrompt(request.sessionId, messageID);
        onActivePromptDispatch?.();
        return runtime.deliverGeneratedPrompt({
          ...request,
          prompt: { ...request.prompt, messageID } as typeof request.prompt,
        });
      },
      deleteTemporarySession: async (request) => {
        await runtime.deleteTemporarySession(request);
        invalidateSession(request.id, true);
      },
    };
  }

  // I3 / I11 – Idle waiters per session
  const idleWaiters = new Map<string, IdleWaiter>();

  type SessionLifecycle = { generation: number; terminal: boolean; persistenceTail: Promise<void> };
  const sessionLifecycles = new Map<string, SessionLifecycle>();

  function lifecycleFor(sessionID: string): SessionLifecycle {
    let lifecycle = sessionLifecycles.get(sessionID);
    if (!lifecycle) {
      lifecycle = { generation: 0, terminal: false, persistenceTail: Promise.resolve() };
      sessionLifecycles.set(sessionID, lifecycle);
    }
    return lifecycle;
  }

  function isCurrentGeneration(sessionID: string, generation: number): boolean {
    const lifecycle = lifecycleFor(sessionID);
    return !lifecycle.terminal && lifecycle.generation === generation;
  }

  function invalidateSession(sessionID: string, terminal: boolean): SessionLifecycle {
    const lifecycle = lifecycleFor(sessionID);
    lifecycle.generation += 1;
    lifecycle.terminal = terminal;
    pendingUpdateAfterInFlight.delete(sessionID);
    const state = sessionStates.get(sessionID);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    return lifecycle;
  }

  async function withPersistenceLock<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    const lifecycle = lifecycleFor(sessionID);
    const previous = lifecycle.persistenceTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    lifecycle.persistenceTail = queued;
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (lifecycle.persistenceTail === queued) lifecycle.persistenceTail = Promise.resolve();
    }
  }

  function isSessionTerminal(sessionID: string): boolean {
    return lifecycleFor(sessionID).terminal;
  }

  async function awaitChildInitialization(sessionID: string): Promise<void> {
    const pending = pendingChildInitializations.get(sessionID);
    if (!pending || !isCurrentGeneration(sessionID, pending.generation)) return;
    await pending.promise;
  }

  async function ensureMemoryFileForGeneration(
    sessionID: string,
    generation: number,
    currentConfig: SessionMemoryConfig,
  ): Promise<boolean> {
    return withPersistenceLock(sessionID, async () => {
      if (!isCurrentGeneration(sessionID, generation) || isInternalSession(sessionID)) return false;
      await ensureMemoryFile(sessionID, currentConfig);
      return isCurrentGeneration(sessionID, generation) && !isInternalSession(sessionID);
    });
  }

  // ── Context wrappers for session-state module ──────────
  const isBusyCtx = (sid: string) =>
    isSessionBusy(sid, sessionStates, updateInFlight, new Set(pendingUpdateAfterInFlight.keys()));
  const waitForIdleCtx = (sid: string, ms: number) => waitForSessionIdle(sid, ms, isBusyCtx, idleWaiters);

  // ── Initialisation helpers inside factory ────────────────
  // Heavy I/O (config read, directory creation,
  // log write, orphan cleanup) is deferred to a microtask so the plugin
  // factory returns in <10ms and does not block opencode startup.
  let config: SessionMemoryConfig = DEFAULT_CONFIG;
  const cmdCtx: CommandContext = {
    config,
    baseDir: directory,
    sessionStates,
    globalState,
    clearSessionDeliveryMetadata: (sessionID) => childDeliveryMetadata.delete(sessionID),
    resetSessionPersistence: async (sessionID, resetConfig) => {
      await withPersistenceLock(sessionID, async () => {
        if (isSessionTerminal(sessionID)) throw new Error("Cannot reset a deleted session.");
        // Read and validate before invalidating work or erasing saved state.
        // Use the collector's ownership filter too: an active summarizer's own
        // prompt/reply cannot anchor a history from which those rows are removed.
        const boundary = selectV1ResetBoundary(
          await wrapperSummarizerRuntime(sessionID).readSessionMessages(sessionID),
        );
        if (isSessionTerminal(sessionID)) throw new Error("Cannot reset a deleted session.");
        invalidateSession(sessionID, false);
        await persistV1Reset(sessionID, resetConfig, boundary);
      });
    },
  };
  let backgroundInitPromise: Promise<void> | undefined;
  let backgroundInitDone = false;
  let finishInitialConfigRead!: () => void;
  const initialConfigRead = new Promise<void>((resolve) => {
    finishInitialConfigRead = resolve;
  });

  async function runBackgroundInit() {
    if (backgroundInitDone) return;
    try {
      await reloadConfig(configCtx, true);
      config = configCtx.config;
      cmdCtx.config = config;
      cmdCtx.configuration = configCtx.configuration;
      finishInitialConfigRead();
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

      await cleanupOrphanedSideSessions();
    } catch (error) {
      try {
        await logEvent(config, "plugin_background_init_error", {
          error: (error as Error).message || String(error || ""),
        });
      } catch {}
    } finally {
      finishInitialConfigRead();
      // Set the flag only after the work actually completes (or fails).
      // Setting it earlier would race with concurrent reloadConfigLocal()
      // calls, which check this flag to decide whether to wait.
      backgroundInitDone = true;
    }
  }

  function scheduleBackgroundInit() {
    if (backgroundInitPromise) return backgroundInitPromise;
    backgroundInitPromise = runBackgroundInit();
    return backgroundInitPromise;
  }

  // Kick off the background work as a microtask so we never block the
  // caller. The factory still returns the plugin object synchronously.
  scheduleBackgroundInit();

  async function reloadConfigLocal(force = false) {
    if (!backgroundInitDone) await scheduleBackgroundInit();
    await reloadConfig(configCtx, force);
    config = configCtx.config;
    cmdCtx.config = config;
    cmdCtx.configuration = configCtx.configuration;
    return config;
  }

  // ── Orphan side-session cleanup ────────────────────────────
  // On startup, delete any side sessions left behind by a previous run
  // (crash, OOM, kill -9, etc.) so they don't accumulate in the session list.
  async function cleanupOrphanedSideSessions() {
    let orphans: string[];
    try {
      orphans = await loadActiveSideSessions(config.memoryDir);
      for (const id of orphans) registerInternalSession(id);
    } catch (error) {
      await logEvent(config, "orphan_side_sessions_load_error", {
        error: (error as Error).message || String(error || ""),
      });
      return;
    }

    // Also scan the live session list for any "Session Memory Summarizer"
    // sessions we might have missed (e.g. created before this plugin version
    // shipped the tracking file). This is a best-effort supplement.
    let liveOrphans: string[] = [];
    try {
      const rows = await runtime.listTemporarySessions({});
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        if (typeof r?.id !== "string") continue;
        if (r?.title === SIDE_SESSION_TITLE) {
          registerInternalSession(r.id);
          liveOrphans.push(r.id);
        }
      }
    } catch {}

    const all = Array.from(new Set([...orphans, ...liveOrphans]));
    if (!all.length) return;
    await logEvent(config, "orphan_side_sessions_cleanup_start", { count: all.length });

    // Track which IDs we could not delete so we can keep them in the tracking
    // file for retry on the next startup. A partial failure must not drop a
    // legitimate tracked session from the file.
    //
    // Special case: a 404 / NotFoundError means the session is already gone,
    // which is exactly what we wanted. Some opencode builds (e.g. 1.17.x)
    // respond with a generic "Unexpected server error" wrapped as an
    // UnknownError for missing sessions — the session is gone either way,
    // so drop the tracking entry so we don't leak it forever.
    const failedToDelete: string[] = [];
    let deleted = 0;
    for (const id of all) {
      try {
        const result = await runtime.deleteTemporarySessionForCleanup({ id });
        if (!result.deleted) {
          const errObj =
            typeof result.error === "object" && result.error !== null
              ? (result.error as { name?: string; data?: { message?: string } })
              : undefined;
          const errName = errObj?.name;
          const errMsg = errObj?.data?.message ?? (typeof result.error === "string" ? result.error : "");
          const isAlreadyGone =
            errName === "NotFoundError" || /not\s*found/i.test(errMsg) || /Unexpected server error/i.test(errMsg);
          if (isAlreadyGone) {
            deleted += 1;
            continue;
          }
          failedToDelete.push(id);
          await logEvent(config, "orphan_side_sessions_cleanup_failed", {
            sessionID: id,
            error: errMsg || "delete returned error",
          });
        } else {
          deleted += 1;
        }
      } catch (error) {
        failedToDelete.push(id);
        await logEvent(config, "orphan_side_sessions_cleanup_failed", {
          sessionID: id,
          error: (error as Error).message || String(error || ""),
        });
      }
    }

    // Persist the survivors atomically. The next startup's live scan will
    // supplement anything that has since been renamed or moved out of band.
    try {
      await mutateActiveSideSessions(config.memoryDir, () => failedToDelete);
    } catch (error) {
      await logEvent(config, "orphan_side_sessions_save_error", {
        error: (error as Error).message || String(error || ""),
      });
    }

    await logEvent(config, "orphan_side_sessions_cleanup_done", {
      deleted,
      remaining: failedToDelete.length,
    });
  }

  async function isSessionDeleted(sessionID: string): Promise<boolean> {
    try {
      await runtime.getTemporarySession({ id: sessionID });
      return false;
    } catch {
      return true;
    }
  }

  // ── Helper functions that require instance state ──────────
  function scheduleMemoryUpdate(
    client: Client,
    sessionID: string,
    reason: string,
    config: SessionMemoryConfig,
    schedulingGeneration = lifecycleFor(sessionID).generation,
  ) {
    if (!isCurrentGeneration(sessionID, schedulingGeneration) || isInternalSession(sessionID)) return;
    const s = ensureSessionState(sessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = undefined;
      updateMemory(client, sessionID, reason, config, schedulingGeneration).catch(async (error) => {
        globalState.lastError = (error as Error).message;
        showToast(client, "Session Memory", "Summarization failed — check /stm logs for details.");
        await logEvent(config, "memory_update_uncaught_error", { sessionID, error: globalState.lastError });
      });
    }, config.debounceMs);
  }

  async function attemptPendingMainDcpDelivery(sessionID: string, config: SessionMemoryConfig) {
    const s = sessionStates.get(sessionID);
    if (!s?.mainDcpDeliveryPending || !s.lastDcpCompressAt || isSessionTerminal(sessionID)) return;

    const dcpIdentity = s.lastDcpCompressAt;
    const pendingOrigin = s.pendingDcpOrigin;
    const generation = lifecycleFor(sessionID).generation;
    if (pendingOrigin && pendingOrigin.generation !== generation) {
      if (s.pendingDcpOrigin?.identity === pendingOrigin.identity) {
        s.mainDcpDeliveryPending = false;
        s.pendingDcpOrigin = undefined;
      }
      return;
    }
    if (!isCurrentGeneration(sessionID, generation)) return;
    const clearMatchingPending = () => {
      if (pendingOrigin && s.pendingDcpOrigin?.identity !== pendingOrigin.identity) return;
      s.mainDcpDeliveryPending = false;
      s.pendingDcpOrigin = undefined;
    };
    if (
      !pendingOrigin?.originUserID ||
      !pendingOrigin.executionMetadata ||
      pendingOrigin.originUserID !== s.latestOriginUserID
    ) {
      await logEvent(config, "dcp_origin_context_skipped", {
        sessionID,
        reason: !pendingOrigin?.originUserID ? "missing_native_owner_context" : "stale_origin_context",
        ownerID: pendingOrigin?.ownerID,
        originUserID: pendingOrigin?.originUserID,
      });
      clearMatchingPending();
      return;
    }
    const memoryRevision = s.memoryRevision;
    const memory = await readText(memoryPathFor(sessionID, config.memoryDir), "");
    if (
      !isCurrentGeneration(sessionID, generation) ||
      sessionStates.get(sessionID) !== s ||
      s.pendingDcpOrigin?.identity !== pendingOrigin.identity ||
      s.latestOriginUserID !== pendingOrigin.originUserID ||
      s.originUserContexts.get(pendingOrigin.originUserID) !== pendingOrigin.executionMetadata
    ) {
      clearMatchingPending();
      return;
    }
    const executionMetadata = pendingOrigin.executionMetadata;
    const delivered = await deliverMemoryViaNoReply(
      runtime,
      sessionID,
      `dcp:${pendingOrigin?.identity || dcpIdentity}`,
      memoryRevision,
      memory,
      config,
      globalState,
      s,
      executionMetadata,
      () =>
        isCurrentGeneration(sessionID, generation) &&
        sessionStates.get(sessionID) === s &&
        s.pendingDcpOrigin?.identity === pendingOrigin.identity &&
        s.latestOriginUserID === pendingOrigin.originUserID &&
        s.originUserContexts.get(pendingOrigin.originUserID!) === executionMetadata,
    );
    if (
      delivered &&
      s.lastDcpCompressAt === dcpIdentity &&
      (!pendingOrigin || s.pendingDcpOrigin?.identity === pendingOrigin.identity)
    ) {
      s.mainDcpDeliveryPending = false;
      if (!pendingOrigin || s.pendingDcpOrigin?.identity === pendingOrigin.identity) s.pendingDcpOrigin = undefined;
    }
  }

  async function updateMemory(
    client: Client,
    sessionID: string,
    reason: string,
    config: SessionMemoryConfig,
    schedulingGeneration?: number,
  ): Promise<MemoryUpdateResult> {
    if (!config.enabled) return { status: "skipped", reason: "disabled" };
    const operationGeneration = schedulingGeneration ?? lifecycleFor(sessionID).generation;
    if (!isCurrentGeneration(sessionID, operationGeneration)) return { status: "skipped", reason: "stale_session" };
    if (isInternalSession(sessionID)) return { status: "skipped", reason: "internal_session" };

    const isAutomaticUpdate =
      reason === "session_idle" ||
      reason === "post_in_flight_replay" ||
      reason === "session_created_bootstrap" ||
      reason === "session_updated_bootstrap";
    if (
      isAutomaticUpdate &&
      (config.summarizerMode === "active" || config.cleanFallbackToActiveSession) &&
      sessionsAwaitingIdle.has(sessionID)
    ) {
      await logEvent(config, "memory_update_skipped", {
        sessionID,
        reason,
        detail: "awaiting_session_idle",
      });
      return { status: "deferred" };
    }

    // Sub-agent sessions never update memory
    if (sessionParents.has(sessionID)) {
      await logEvent(config, "subagent_update_skipped", { sessionID, reason });
      return { status: "skipped", reason: "subagent_session" };
    }

    if (isSessionTerminal(sessionID)) {
      await logEvent(config, "memory_update_skipped", { sessionID, reason, detail: "session_deleted" });
      return { status: "skipped", reason: "session_deleted" };
    }

    if (updateInFlight.has(sessionID)) {
      pendingUpdateAfterInFlight.set(sessionID, operationGeneration);
      await logEvent(config, "memory_update_skipped", { sessionID, reason, detail: "update_in_flight" });
      return { status: "deferred" };
    }
    updateInFlight.add(sessionID);
    let wroteMemory = false;
    let failure: string | undefined;
    let partiallyUpdated = false;

    try {
      // Outer try/catch to record any unexpected error
      try {
        const prepared = await withPersistenceLock(sessionID, async () => {
          if (!isCurrentGeneration(sessionID, operationGeneration) || isInternalSession(sessionID)) return undefined;
          const memoryPath = await ensureMemoryFile(sessionID, config);
          if (!isCurrentGeneration(sessionID, operationGeneration)) return undefined;
          return { memoryPath, existing: await readText(memoryPath, "") };
        });
        if (!prepared) return { status: "skipped", reason: "stale_session" };
        const { memoryPath, existing } = prepared;
        const isFirstUpdateForSession = !(await readLastProcessedMessageID(sessionID, config));
        const agentsMdContextRaw =
          config.includeAgentsMdOnFirstUpdate && isFirstUpdateForSession
            ? await readText(join(directory || ".", "AGENTS.md"), "")
            : "";
        const agentsMdContext = sanitizeMessage(agentsMdContextRaw).slice(0, config.maxUpdateInputLength);
        if (!isCurrentGeneration(sessionID, operationGeneration) || isInternalSession(sessionID))
          return { status: "skipped", reason: "stale_session" };
        let inputFingerprint = "";
        const wrapperRuntime = wrapperSummarizerRuntime(sessionID, () => {
          lastActiveInputFingerprints.set(sessionID, inputFingerprint);
        });
        const recent = await collectRecentVisibleMessages(wrapperRuntime, client, sessionID, config, globalState);
        if (!isCurrentGeneration(sessionID, operationGeneration) || isInternalSession(sessionID))
          return { status: "skipped", reason: "stale_session" };
        inputFingerprint = activeInputFingerprint(
          {
            entries: recent.entries,
            newestMessageID: recent.newestMessageID,
            sinceMessageID: recent.sinceMessageID,
          },
          existing,
          agentsMdContext,
          config,
          operationGeneration,
        );
        if (isAutomaticUpdate && lastActiveInputFingerprints.get(sessionID) === inputFingerprint) {
          await logEvent(config, "memory_update_skipped", {
            sessionID,
            reason,
            detail: "unchanged_active_summary_input",
          });
          return { status: "skipped", reason: "unchanged_active_summary_input" };
        }
        if (!recent.entries.length) {
          await logEvent(config, "memory_update_skipped", { sessionID, reason, detail: "no_visible_recent_messages" });
          return { status: "skipped", reason: "no_visible_recent_messages" };
        }
        await logEvent(config, "memory_update_start", {
          sessionID,
          reason,
          mode: config.summarizerMode,
          model: config.memoryModel,
          deltaEntries: recent.entries.length,
        });

        if (!isCurrentGeneration(sessionID, operationGeneration)) {
          await logEvent(config, "memory_update_skipped", {
            sessionID,
            reason,
            detail: "stale_generation_after_collection",
          });
          return { status: "skipped", reason: "stale_session" };
        }

        // I13 – delegate chunk processing to extracted helper
        wroteMemory = await processMemoryChunks(
          client,
          wrapperRuntime,
          sessionID,
          reason,
          config,
          memoryPath,
          existing,
          recent.entries,
          agentsMdContext,
          globalState,
          async (previousMemory, nextMemory, checkpointID) =>
            await withPersistenceLock(sessionID, async () => {
              if (!isCurrentGeneration(sessionID, operationGeneration)) return "stale";
              if (isInternalSession(sessionID)) return "stale";
              const currentOnDisk = await readText(memoryPath, "");
              if (currentOnDisk !== previousMemory) return "concurrent_change";
              if (!isCurrentGeneration(sessionID, operationGeneration) || isInternalSession(sessionID)) return "stale";
              await writeTextAtomic(memoryPath, nextMemory);
              try {
                if (checkpointID) {
                  if (!isCurrentGeneration(sessionID, operationGeneration)) return "stale";
                  await writeLastProcessedMessageID(sessionID, checkpointID, config);
                }
              } catch (error) {
                if (isCurrentGeneration(sessionID, operationGeneration)) {
                  await writeTextAtomic(memoryPath, previousMemory);
                }
                throw error;
              }
              return isCurrentGeneration(sessionID, operationGeneration) ? "committed" : "stale";
            }),
          (detail, partial) => {
            failure = detail;
            partiallyUpdated = partial;
          },
        );
        if (!isCurrentGeneration(sessionID, operationGeneration) || isInternalSession(sessionID)) wroteMemory = false;
        if (wroteMemory) {
          const s = ensureSessionState(sessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
          bumpMemoryRevision(s);
        }
      } catch (error) {
        failure = generationErrorMessage(error);
        if (partiallyUpdated && isCurrentGeneration(sessionID, operationGeneration) && !isInternalSession(sessionID)) {
          const state = ensureSessionState(sessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
          bumpMemoryRevision(state);
        }
        globalState.lastError = failure;
        showToast(client, "Session Memory", failure);
        await logEvent(config, "memory_update_error", { sessionID, reason, error: globalState.lastError });
      }
    } finally {
      try {
        await attemptPendingMainDcpDelivery(sessionID, config);
      } catch (error) {
        try {
          await logEvent(config, "dcp_delivery_error", {
            sessionID,
            error: (error as Error).message || String(error || ""),
          });
        } catch {}
      }
      updateInFlight.delete(sessionID);
      const replayGeneration = pendingUpdateAfterInFlight.get(sessionID);
      if (replayGeneration !== undefined) {
        pendingUpdateAfterInFlight.delete(sessionID);
        if (isCurrentGeneration(sessionID, replayGeneration)) {
          scheduleMemoryUpdate(client, sessionID, "post_in_flight_replay", config, replayGeneration);
        }
      } else if (!isBusyCtx(sessionID)) {
        notifySessionIdle(sessionID, idleWaiters);
      }
    }
    if (failure) return { status: "error", detail: failure, partial: wroteMemory || partiallyUpdated };
    return wroteMemory ? { status: "updated" } : { status: "skipped", reason: "no_memory_committed" };
  }

  // ── Tool context ───────────────────────────────────────
  const toolCtx: CreateToolsContext = {
    cmdCtx,
    globalState,
    client,
    reloadConfigLocal,
    updateMemory: async (toolClient, sessionID, reason, toolConfig) => {
      // An active-session prompt cannot finish while its calling tool is still
      // executing in that session. Let the existing idle path perform the update.
      // Clean mode with active fallback has the same risk if clean generation fails.
      if (
        toolConfig.enabled &&
        (toolConfig.summarizerMode === "active" || toolConfig.cleanFallbackToActiveSession) &&
        sessionsAwaitingIdle.has(sessionID) &&
        !isInternalSession(sessionID) &&
        !isSessionTerminal(sessionID)
      ) {
        await logEvent(toolConfig, "memory_update_deferred", { sessionID, reason, detail: "awaiting_session_idle" });
        return { status: "deferred" };
      }
      return await updateMemory(toolClient, sessionID, reason, toolConfig);
    },
  };
  const tools = createTools(toolCtx);

  function isInternalSession(sessionID: string): boolean {
    return internalSessionIDs.has(sessionID);
  }

  const receiveNativeAction = createV1ActionReceiver({
    directory: directory ?? process.cwd(),
    client,
    isInternal: isInternalSession,
    execute: async (request) => {
      await reloadConfigLocal();
      if (request.sessionID && isSessionTerminal(request.sessionID))
        throw new Error("This session has ended. No action ran.");
      if (request.action === "show")
        return await readText(memoryPathFor(request.sessionID!, config.memoryDir), "No memory file exists yet.");
      return await executeMemoryAction(request.action, request.sessionID, cmdCtx, client, updateMemory, {
        confirm: request.confirm,
      });
    },
  });

  // Diagnostic: emit a single stderr line with the factory wall-clock
  // duration. The e2e harness greps for the [STM-STARTUP] marker; for
  // interactive users the line is harmless. The env gate keeps it opt-in
  // for production: STM_STARTUP_TIMING=1 or OPENCODE_E2E=1 enables it.
  if (process.env.STM_STARTUP_TIMING === "1" || process.env.OPENCODE_E2E === "1") {
    const __elapsed = performance.now() - __stmT0;
    process.stderr.write(`[STM-STARTUP] factory_returned_ms=${__elapsed.toFixed(3)}\n`);
  }

  // ── Return the plugin object ─────────────────────────────
  const plugin = {
    config: async (opencodeConfig: OpencodeConfig) => {
      // Scope is only available here. Do not wait for unrelated orphan cleanup
      // (which can call the host API) while registering the plugin's commands.
      await initialConfigRead;
      const installation = await bootstrapInstalledConfig(opencodeConfig.plugin_origins);
      configCtx.configuration = { ...configCtx.configuration!, installation };
      await reloadConfig(configCtx, true);
      config = configCtx.config;
      cmdCtx.config = config;
      cmdCtx.configuration = configCtx.configuration;
      if (installation.status === "error") {
        await logEvent(config, "config_installation_error", { ...installation });
      }
      // Native /stm owns the user command. Do not register a server command
      // whose host pipeline necessarily starts another model response.
    },

    event: async (input: EventInput): Promise<void> => {
      const evt = (input?.event || {}) as Record<string, unknown>;
      const name = evt?.type || evt?.name || evt?.event || evt?.kind || "unknown_event";
      const properties = evt.properties as Record<string, unknown> | undefined;
      if (name === "tui.command.execute") {
        await receiveNativeAction(properties?.command);
        return;
      }
      const info = properties?.info as Record<string, unknown> | undefined;
      const nativeSessionID =
        (typeof info?.id === "string" && info.id) ||
        (typeof info?.sessionID === "string" && info.sessionID) ||
        (typeof info?.sessionId === "string" && info.sessionId) ||
        getSessionID(evt) ||
        getSessionID(input);
      const messageSessionID =
        (typeof info?.sessionID === "string" && info.sessionID) ||
        (typeof info?.sessionId === "string" && info.sessionId) ||
        (typeof properties?.sessionID === "string" && properties.sessionID) ||
        (typeof properties?.sessionId === "string" && properties.sessionId) ||
        getSessionID(evt) ||
        getSessionID(input);

      const lifecycleEventSessionID = getSessionID(evt) || getSessionID(input);
      if (name === "session.idle" && lifecycleEventSessionID) {
        sessionsAwaitingIdle.delete(lifecycleEventSessionID);
      }
      if (name === "session.status" && lifecycleEventSessionID) {
        const rawStatus = properties?.status ?? info?.status;
        const statusType =
          typeof rawStatus === "string"
            ? rawStatus
            : rawStatus && typeof rawStatus === "object"
              ? String(
                  (rawStatus as Record<string, unknown>).type || (rawStatus as Record<string, unknown>).status || "",
                )
              : "";
        if (
          !internalSessionIDs.has(lifecycleEventSessionID) &&
          !isSessionTerminal(lifecycleEventSessionID) &&
          !sessionParents.has(lifecycleEventSessionID)
        ) {
          if (statusType === "busy") sessionsAwaitingIdle.add(lifecycleEventSessionID);
          if (statusType === "idle") sessionsAwaitingIdle.delete(lifecycleEventSessionID);
        }
      }

      // The native dispatcher emits lifecycle events through the generic
      // event hook. Route them to the concrete hooks so existing direct-hook
      // consumers and tests retain exactly the same behavior. In particular,
      // dispatch deletion before any config await so its generation is
      // invalidated before outstanding work can commit.
      if (name === "session.created") {
        // Native session IDs are never reused. Keep the direct hook's legacy
        // recreation behavior, but never use it for a generic native event.
        if (nativeSessionID && isSessionTerminal(nativeSessionID)) return;
        await plugin["session.created"]({
          sessionID: nativeSessionID,
          event: {
            properties: {
              info: {
                parentID: typeof info?.parentID === "string" ? info.parentID : undefined,
                title: info?.title,
              },
            },
          },
        } as SessionCreatedInput);
        return;
      }
      if (name === "session.updated") {
        if (nativeSessionID && info?.title === SIDE_SESSION_TITLE) registerInternalSession(nativeSessionID);
        await plugin["session.updated"]({
          sessionID: nativeSessionID,
          event: { properties: { info } },
        } as SessionUpdatedInput & { event: { properties: { info?: Record<string, unknown> } } });
        return;
      }
      if (name === "session.deleted") {
        await plugin["session.deleted"]({ sessionID: nativeSessionID });
        return;
      }
      if (name === "message.updated") {
        await plugin["message.updated"]({
          sessionID: messageSessionID,
          message: info as MessageUpdatedInput["message"],
          parts: Array.isArray((info as Record<string, unknown> | undefined)?.parts)
            ? ((info as Record<string, unknown>).parts as unknown[])
            : undefined,
        });
        return;
      }

      await reloadConfigLocal();
      // ── DCP compress tool detection ────────────────────────
      if (config.enabled && name === "message.part.updated") {
        const props = evt?.properties as Record<string, unknown> | undefined;
        const part = props?.part as Record<string, unknown> | undefined;
        const partState = part?.state as Record<string, unknown> | undefined;
        if (part?.type === "tool" && part?.tool === "compress" && partState?.status === "completed") {
          const sessionID =
            props?.sessionID && typeof props.sessionID === "string"
              ? props.sessionID
              : typeof part?.sessionID === "string"
                ? part.sessionID
                : getSessionID(input);
          if (sessionID) {
            if (isInternalSession(sessionID)) return;
            if (isSessionTerminal(sessionID)) return;
            if (sessionParents.has(sessionID)) {
              const metadata = childDeliveryMetadata.get(sessionID);
              if (metadata) metadata.dcpInjectionPending = true;
              await logEvent(config, "dcp_compress_child_injection_pending", { sessionID });
              return;
            }
            const s = ensureSessionState(sessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
            const now = Date.now();

            // Debounce: skip if already detected recently
            if (s.lastDcpCompressAt && now - s.lastDcpCompressAt < config.debounceMs * 2) {
              await logEvent(config, "dcp_compress_skipped_duplicate", { sessionID });
              return;
            }
            s.lastDcpCompressAt = now;
            s.mainDcpDeliveryPending = true;
            const ownerID = typeof part?.messageID === "string" ? part.messageID : "";
            const originUserID = ownerID ? s.assistantOriginOwners.get(ownerID) : undefined;
            const originMetadata = originUserID ? s.originUserContexts.get(originUserID) : undefined;
            const identity = ownerID || `dcp:${now}`;
            s.pendingDcpOrigin = {
              identity,
              ownerID,
              originUserID,
              executionMetadata: originMetadata,
              generation: lifecycleFor(sessionID).generation,
            };

            // If an update is already in-flight, queue a pending replay
            if (updateInFlight.has(sessionID)) {
              pendingUpdateAfterInFlight.set(sessionID, lifecycleFor(sessionID).generation);
              await logEvent(config, "dcp_compress_queued_after_inflight", { sessionID });
              return;
            }

            await logEvent(config, "dcp_compress_triggered", { sessionID });
            await updateMemory(client, sessionID, "dcp_compress", config);
          }
        }
      }

      if (config.enabled && name === "session.idle") {
        const sessionID = lifecycleEventSessionID;
        if (sessionID) {
          if (isInternalSession(sessionID)) return;
          if (isSessionTerminal(sessionID)) return;
          if (pendingChildInitializations.has(sessionID)) return;
          if (sessionParents.has(sessionID)) return;
          const schedulingGeneration = lifecycleFor(sessionID).generation;
          if (!(await ensureMemoryFileForGeneration(sessionID, schedulingGeneration, config))) return;
          scheduleMemoryUpdate(client, sessionID, "session_idle", config, schedulingGeneration);
        }
      }

      if (!config.debug) return;
      await logEvent(config, "sdk_event", {
        name,
        keys: Object.keys(evt).slice(0, 40),
      });
    },

    tool: tools,

    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }) => {
      // Created IDs are fenced before the summarization prompt is dispatched.
      // Recover title-identified sessions too, including startup orphans whose
      // lifecycle event has not yet reached this plugin instance.
      if (!isInternalSession(input.sessionID) && !sessionStates.has(input.sessionID)) {
        const session = await runtime.getTemporarySession({ id: input.sessionID });
        if (session.title === SIDE_SESSION_TITLE) registerInternalSession(input.sessionID);
      }
      if (isInternalSession(input.sessionID)) {
        throw new Error(
          "STM clean summarizer sessions cannot execute tools. Summarize the supplied conversation only.",
        );
      }
    },

    "permission.ask": async (input: { sessionID: string }, output: { status: "ask" | "deny" | "allow" }) => {
      if (isInternalSession(input.sessionID)) output.status = "deny";
    },

    "command.execute.before": async (input: CommandExecuteBeforeInput, _output: CommandExecuteBeforeOutput) => {
      if (input.command.toLowerCase() === "stm")
        throw new Error(
          "The legacy STM server command was retired. Remove it from opencode.json and select /stm from native autocomplete. No STM action ran.",
        );
    },

    "session.created": async (input: SessionCreatedInput) => {
      const sessionID = getSessionID(input);
      if (!sessionID) return;

      const info = input?.event?.properties?.info;
      const parentID = info?.parentID;

      if ((info as { title?: unknown } | undefined)?.title === SIDE_SESSION_TITLE) registerInternalSession(sessionID);
      if (isInternalSession(sessionID)) return;

      const lifecycle = lifecycleFor(sessionID);
      const generationBeforeReload = lifecycle.generation;
      const wasTerminal = lifecycle.terminal;

      // Direct-hook consumers may recreate a terminal session. Advance that
      // generation synchronously so the barrier is attached to the new life.
      if (wasTerminal) {
        lifecycle.generation += 1;
        lifecycle.terminal = false;
        ownedPromptIDs.delete(sessionID);
        lastActiveInputFingerprints.delete(sessionID);
        sessionsAwaitingIdle.delete(sessionID);
      }
      const childGeneration = lifecycle.generation;
      let resolveChildInitialization: (() => void) | undefined;
      let childInitialization: Promise<void> | undefined;
      if (parentID) {
        // Install child identity and the barrier before the first await. Native
        // hooks can run concurrently with session.created.
        childInitialization = new Promise<void>((resolve) => {
          resolveChildInitialization = resolve;
        });
        sessionParents.set(sessionID, parentID);
        let children = parentToChildren.get(parentID);
        if (!children) {
          children = new Set();
          parentToChildren.set(parentID, children);
        }
        children.add(sessionID);
        childDeliveryMetadata.set(sessionID, {
          startupSnapshot: "",
          startupInjectionPending: false,
          dcpInjectionPending: false,
        });
        pendingChildInitializations.set(sessionID, { generation: childGeneration, promise: childInitialization });
      }

      try {
        await reloadConfigLocal();
        // A native create event can arrive after deletion has started. Do not
        // revive that generation merely because config reload yielded.
        if (lifecycle.generation !== generationBeforeReload + (wasTerminal ? 1 : 0)) return;
        if (!isCurrentGeneration(sessionID, childGeneration)) return;
        if (isInternalSession(sessionID)) return;
        globalState.lastActiveSessionID = sessionID;
        if (!(await ensureMemoryFileForGeneration(sessionID, childGeneration, config))) return;

        if (parentID) {
          const metadata = childDeliveryMetadata.get(sessionID);
          if (!metadata || !isCurrentGeneration(sessionID, childGeneration)) return;
          if (config.injectInSubagents && !(await readV1ResetBoundary(sessionID, config.memoryDir))) {
            const parentMemory = await readText(memoryPathFor(parentID, config.memoryDir), "");
            if (!isCurrentGeneration(sessionID, childGeneration)) return;
            metadata.startupSnapshot = parentMemory;
            metadata.startupInjectionPending = Boolean(parentMemory.trim());
            await logEvent(config, "subagent_created_with_memory", { sessionID, parentID });
          } else {
            await logEvent(config, "subagent_created_skipped_injection", { sessionID, parentID });
          }
          return;
        }

        // Main session
        await logEvent(config, "session_created", { sessionID });
        await maybeBootstrapSessionHistory(
          sessionID,
          "session_created_bootstrap",
          config,
          client,
          (client, id, reason, cfg) => scheduleMemoryUpdate(client, id, reason, cfg, childGeneration),
        );
      } finally {
        if (parentID) {
          if (childInitialization && pendingChildInitializations.get(sessionID)?.promise === childInitialization) {
            pendingChildInitializations.delete(sessionID);
          }
          resolveChildInitialization?.();
        }
      }
    },

    "session.updated": async (input: SessionUpdatedInput) => {
      await reloadConfigLocal();
      const sessionID = getSessionID(input);
      if (!sessionID) return;
      if (isSessionTerminal(sessionID)) return;
      if (pendingChildInitializations.has(sessionID)) return;
      const generation = lifecycleFor(sessionID).generation;
      const title = (input as SessionUpdatedInput & { event?: { properties?: { info?: { title?: unknown } } } }).event
        ?.properties?.info?.title;
      if (title === SIDE_SESSION_TITLE) registerInternalSession(sessionID);
      if (isInternalSession(sessionID)) return;
      globalState.lastActiveSessionID = sessionID;
      if (!(await ensureMemoryFileForGeneration(sessionID, generation, config))) return;
      await logEvent(config, "session_updated", { sessionID });
      if (sessionParents.has(sessionID)) return;
      await maybeBootstrapSessionHistory(
        sessionID,
        "session_updated_bootstrap",
        config,
        client,
        (client, id, reason, cfg) => scheduleMemoryUpdate(client, id, reason, cfg, generation),
      );
    },

    "session.deleted": async (input: SessionDeletedInput) => {
      const sessionID = getSessionID(input);
      if (!sessionID) return;
      ownedPromptIDs.delete(sessionID);
      lastActiveInputFingerprints.delete(sessionID);
      sessionsAwaitingIdle.delete(sessionID);
      invalidateSession(sessionID, true);
      const children = parentToChildren.get(sessionID);
      if (children) {
        for (const child of children) invalidateSession(child, true);
      }
      await reloadConfigLocal();
      await withPersistenceLock(sessionID, async () => {
        await removePath(memoryPathFor(sessionID, config.memoryDir));
        await removePath(checkpointPathFor(sessionID, config.memoryDir));
        await removePath(v1ResetBoundaryPathFor(sessionID, config.memoryDir));
      });
      // Clean up per‑session runtime state
      const s = sessionStates.get(sessionID);
      if (s?.timer) clearTimeout(s.timer);
      if (s) resetSessionDeliveryState(s);
      sessionStates.delete(sessionID);
      childDeliveryMetadata.delete(sessionID);
      // I2 – Cleanup parent/child mappings
      sessionParents.delete(sessionID);
      if (children) {
        for (const child of children) {
          ownedPromptIDs.delete(child);
          lastActiveInputFingerprints.delete(child);
          sessionsAwaitingIdle.delete(child);
          await withPersistenceLock(child, async () => {
            await removePath(memoryPathFor(child, config.memoryDir));
            await removePath(checkpointPathFor(child, config.memoryDir));
            await removePath(v1ResetBoundaryPathFor(child, config.memoryDir));
          });
          sessionParents.delete(child);
          childDeliveryMetadata.delete(child);
          const childState = sessionStates.get(child);
          if (childState?.timer) clearTimeout(childState.timer);
          if (childState) resetSessionDeliveryState(childState);
          sessionStates.delete(child);
          const childIdx = sessionStatesOrder.indexOf(child);
          if (childIdx !== -1) sessionStatesOrder.splice(childIdx, 1);
          updateInFlight.delete(child);
          pendingUpdateAfterInFlight.delete(child);
          notifySessionIdle(child, idleWaiters);
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
      const earlySessionID = input.sessionID;
      const earlyMessage = input.message;
      const earlyOwnerID = earlyMessage?.id || earlyMessage?.messageID;
      const earlyParentID =
        earlyMessage?.parentID || earlyMessage?.parentId || earlyMessage?.parent?.id || earlyMessage?.parent?.messageID;
      if (earlySessionID && (ownsPrompt(earlySessionID, earlyOwnerID) || ownsPrompt(earlySessionID, earlyParentID)))
        return;
      if (earlySessionID && earlyOwnerID && earlyParentID) {
        const earlyState = sessionStates.get(earlySessionID);
        if (earlyState?.originUserContexts.has(earlyParentID)) {
          rememberAssistantOriginOwner(earlyState, earlyOwnerID, earlyParentID);
        }
      }
      await reloadConfigLocal();
      if (!config.enabled) return;
      const sessionID = getSessionID(input);
      if (!sessionID) return;
      if (ownsPrompt(sessionID, earlyOwnerID) || ownsPrompt(sessionID, earlyParentID)) return;
      if (isSessionTerminal(sessionID)) return;
      if (isInternalSession(sessionID)) return;
      const generation = lifecycleFor(sessionID).generation;
      globalState.lastActiveSessionID = sessionID;
      if (!(await ensureMemoryFileForGeneration(sessionID, generation, config))) return;

      const role = getMessageRole(input.message || input);
      if (role === "assistant") {
        const message = (input.message || input) as MessageUpdatedInput["message"];
        const ownerID = message?.id || message?.messageID;
        const parentID = message?.parentID || message?.parentId || message?.parent?.id || message?.parent?.messageID;
        if (ownerID && parentID) {
          const originUserID = parentID;
          const state = sessionStates.get(sessionID);
          if (state) rememberAssistantOriginOwner(state, ownerID, originUserID);
        }
      }
      const text = getMessageText(input);
      if (!text || isSelfInjection(text)) return;

      await logEvent(config, "message_updated", { sessionID, role, textBytes: text.length });
    },

    "chat.message": async (input: ChatMessageInput, output: ChatMessageOutput) => {
      const executionMetadata = snapshotUserExecutionMetadata(output?.message, input);
      const userID =
        input.messageID ||
        input.messageId ||
        input.message?.id ||
        input.id ||
        output?.messageID ||
        output?.messageId ||
        output?.message?.id ||
        output?.id;
      const earlyRole = getMessageRole(output?.message) ?? getMessageRole(input.message || input);
      const hasOriginMetadata = executionMetadata.agent !== undefined && executionMetadata.model !== undefined;
      const taggedOutput = [
        ...(Array.isArray(input.parts) ? input.parts : []),
        ...(Array.isArray(output?.parts) ? output.parts : []),
      ].some(
        (part) =>
          typeof (part as { text?: unknown })?.text === "string" &&
          String((part as { text: string }).text).includes("[MEMORY_SYSTEM]"),
      );
      const explicitSessionID = input.sessionID;
      const earlyText = getMessageText(input) || getMessageText({ message: output?.message, parts: output?.parts });
      const earlyEligible =
        explicitSessionID &&
        !internalSessionIDs.has(explicitSessionID) &&
        !isSessionTerminal(explicitSessionID) &&
        !sessionParents.has(explicitSessionID);
      if (earlyEligible && userID && ownsPrompt(explicitSessionID, String(userID))) return;
      if (earlyEligible && earlyRole === "user" && earlyText && !isSelfInjection(earlyText)) {
        sessionsAwaitingIdle.add(explicitSessionID);
      }
      if (earlyEligible && userID && earlyRole === "user" && !taggedOutput) {
        const earlyState = ensureSessionState(explicitSessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
        admitOriginUserTurn(earlyState, String(userID), hasOriginMetadata ? executionMetadata : undefined);
      } else if (earlyEligible && userID && earlyRole === "user" && taggedOutput && hasOriginMetadata) {
        const earlyState = sessionStates.get(explicitSessionID);
        if (earlyState) rememberTaggedOriginAlias(earlyState, String(userID), executionMetadata);
      }
      await reloadConfigLocal();
      if (!config.enabled) return;

      const sessionID = input.sessionID || globalState.lastActiveSessionID;
      if (!sessionID) return;
      if (isInternalSession(sessionID)) return;
      await awaitChildInitialization(sessionID);
      if (isSessionTerminal(sessionID)) return;
      if (sessionParents.has(sessionID)) return;
      const generation = lifecycleFor(sessionID).generation;

      const role = getMessageRole(output?.message) ?? getMessageRole(input.message || input);
      if (role !== "user") return;

      if (ownsPrompt(sessionID, userID ? String(userID) : undefined)) return;

      globalState.lastActiveSessionID = sessionID;
      if (!(await ensureMemoryFileForGeneration(sessionID, generation, config))) return;

      const text = getMessageText(input) || getMessageText({ message: output?.message, parts: output?.parts });
      if (!text || isSelfInjection(text)) return;

      await logEvent(config, "chat_message", {
        sessionID,
        role,
        textBytes: text.length,
        hasParts: Array.isArray(output?.parts),
      });

      if (config.enableLegacyPeriodicSystemTransform) {
        await logEvent(config, "memory_inject_skipped", { sessionID, reason: "using_chat_system_transform" });
        return;
      }

      const runtimeTurnID =
        input.messageID ||
        input.messageId ||
        input.message?.id ||
        input.id ||
        output?.messageID ||
        output?.messageId ||
        output?.message?.id ||
        output?.id;
      const s = ensureSessionState(sessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
      const hasRuntimeTurnID =
        runtimeTurnID !== undefined && runtimeTurnID !== null && String(runtimeTurnID).length > 0;
      if (!hasRuntimeTurnID) s.userTurnInvocationSequence += 1;
      const turnID = hasRuntimeTurnID ? String(runtimeTurnID) : `anonymous:${s.userTurnInvocationSequence}`;
      const isDistinctTurn = rememberCanonicalTurn(s, turnID);
      const retryableClaim = s.retryableDeliveryClaim;
      const isRetryableDuplicate =
        hasRuntimeTurnID &&
        !isDistinctTurn &&
        retryableClaim?.turnID === turnID &&
        retryableClaim.memoryRevision === s.memoryRevision;
      if (hasRuntimeTurnID && !isDistinctTurn && !isRetryableDuplicate) return;
      if (isDistinctTurn) s.userTurnInjectState.count += 1;

      const remindEveryN = Math.max(1, Math.trunc(config.remindEveryN || 1));
      if (!isRetryableDuplicate && s.userTurnInjectState.count % remindEveryN !== 0) {
        await logEvent(config, "memory_inject_skipped", {
          sessionID,
          reason: "remind_every_n",
          remindEveryN,
          userTurnCount: s.userTurnInjectState.count,
        });
        return;
      }

      const memoryRevision = s.memoryRevision;
      const memory = await readText(memoryPathFor(sessionID, config.memoryDir), "");
      await deliverMemoryViaNoReply(
        runtime,
        sessionID,
        turnID,
        memoryRevision,
        memory,
        config,
        globalState,
        s,
        executionMetadata,
      );
    },

    "experimental.chat.system.transform": async (input: SystemTransformInput, output: SystemTransformOutput) => {
      await reloadConfigLocal();
      if (!config.enabled) return;
      const sessionID = input.sessionID;
      if (!sessionID) {
        await logEvent(config, "memory_inject_skipped", { reason: "missing_session_id" });
        return;
      }
      await awaitChildInitialization(sessionID);
      if (isInternalSession(sessionID)) return;
      if (isSessionTerminal(sessionID)) return;
      if (sessionParents.has(sessionID)) {
        if (!config.injectInSubagents) return;
        const metadata = childDeliveryMetadata.get(sessionID);
        if (!metadata) return;
        const snapshot = metadata.startupSnapshot;
        if (metadata.startupInjectionPending) {
          const appended = await appendChildMemoryToSystem(output, sessionID, snapshot, config, globalState);
          if (appended) metadata.startupInjectionPending = false;
          return;
        }
        if (metadata.dcpInjectionPending) {
          const appended = await appendChildMemoryToSystem(output, sessionID, snapshot, config, globalState);
          if (appended) metadata.dcpInjectionPending = false;
        }
        return;
      }
      if (!config.enableLegacyPeriodicSystemTransform) return;
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
      await awaitChildInitialization(sessionID);
      if (isInternalSession(sessionID)) return;
      if (isSessionTerminal(sessionID)) return;
      globalState.compactCount += 1;
      const generation = lifecycleFor(sessionID).generation;
      if (!(await ensureMemoryFileForGeneration(sessionID, generation, config))) return;

      const parentID = sessionParents.get(sessionID);
      if (parentID) {
        if (!config.injectInSubagents) return;
        const snapshot = childDeliveryMetadata.get(sessionID)?.startupSnapshot || "";
        if (!snapshot.trim()) return;
        output.context.push(`${MEMORY_HEADER}\n\n${snapshot.slice(0, config.maxMemoryLength)}`);
        await logEvent(config, "compaction_context_pushed", { sessionID, bytes: snapshot.length });
        return;
      }

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

      const memory = await readText(memoryPathFor(sessionID, config.memoryDir), "");
      if (!memory.trim()) return;
      output.context.push(`${MEMORY_HEADER}\n\n${memory.slice(0, config.maxMemoryLength)}`);
      await logEvent(config, "compaction_context_pushed", { sessionID, bytes: memory.length });
    },
  };
  return plugin;
};

export default SessionMemoryPlugin;
