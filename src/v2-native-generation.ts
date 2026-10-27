import { randomUUID } from "node:crypto";
import type { V2Context, V2SessionContext } from "./v2-adapter";

export const V2_OWNED_SUMMARY_SESSION_METADATA_KEY = "stmInternalSummary";
const OWNED_SUMMARY_MARKER = "v1";
const OWNED_SESSION_TITLE = "STM internal summary";
const CLEAN_SUMMARY_SYSTEM =
  "You are a clean short-term memory summarizer. Return only the updated Session Memory markdown.";
const CLEANUP_TIMEOUT_MS = 5_000;

type NativeSessionModel = { readonly providerID: string; readonly id: string; readonly variant?: string };
export type V2NativeGenerationModel = NativeSessionModel;
type NativeSessionCreateInput = {
  readonly id: string;
  readonly title: string;
  readonly agent?: string;
  readonly model?: NativeSessionModel;
  readonly location: { readonly directory: string };
  readonly metadata: Record<string, unknown>;
};
type NativeSessionRuntime = {
  create(input: NativeSessionCreateInput, options?: { signal?: AbortSignal }): Promise<{ id: string }>;
  get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<unknown>;
  generate(input: { sessionID: string; prompt: string }, options?: { signal?: AbortSignal }): Promise<{ text: string }>;
  remove?: (input: { sessionID: string }, options?: { signal?: AbortSignal }) => Promise<void>;
};
type NativeGenerationSnapshot = {
  readonly system: V2SessionContext["system"];
  readonly messages: V2SessionContext["messages"];
  readonly options: V2SessionContext["options"];
};
type OwnedRequestTransform = (request: V2SessionContext, markedPrompt: string, sessionID: string) => boolean;
type OwnedState = {
  readonly sessionIDs: Set<string>;
  observer?: AbortController;
};

const ownedByContext = new WeakMap<object, OwnedState>();

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isV2OwnedSummarySessionMetadata(metadata: unknown): boolean {
  return record(metadata)?.[V2_OWNED_SUMMARY_SESSION_METADATA_KEY] === OWNED_SUMMARY_MARKER;
}

function ownedState(context: V2Context): OwnedState {
  let state = ownedByContext.get(context);
  if (!state) {
    state = { sessionIDs: new Set<string>() };
    ownedByContext.set(context, state);
  }
  return state;
}

function stopDeletionObserverIfIdle(state: OwnedState): void {
  if (state.sessionIDs.size !== 0) return;
  state.observer?.abort();
  state.observer = undefined;
}

/** Stop the auxiliary deletion listener when the plugin context is being disposed. */
export function disposeV2NativeGeneration(context: V2Context): void {
  ownedByContext.get(context)?.observer?.abort();
}

function observeOwnedSessionDeletion(context: V2Context, state: OwnedState): void {
  if (state.observer && !state.observer.signal.aborted) return;
  const controller = new AbortController();
  state.observer = controller;
  void (async () => {
    try {
      const source = context.event.subscribe({ signal: controller.signal });
      for await (const event of source) {
        if (event.type !== "session.deleted") continue;
        const sessionID = record(event.data)?.sessionID;
        if (typeof sessionID !== "string") continue;
        state.sessionIDs.delete(sessionID);
        if (state.sessionIDs.size === 0) {
          controller.abort();
          break;
        }
      }
    } catch {
      // Losing the deletion stream must leave owned sessions fenced in memory.
    } finally {
      if (state.observer === controller) state.observer = undefined;
    }
  })();
}

function registerOwnedSummarySession(context: V2Context, sessionID: string): void {
  const state = ownedState(context);
  state.sessionIDs.add(sessionID);
  observeOwnedSessionDeletion(context, state);
}

function releaseOwnedSummarySession(context: V2Context, sessionID: string): void {
  const state = ownedByContext.get(context);
  if (!state) return;
  state.sessionIDs.delete(sessionID);
  stopDeletionObserverIfIdle(state);
}

/** Session IDs are preselected so hooks and ownership guards are armed before create emits events. */
export function isV2OwnedSummarySession(context: V2Context, sessionID: string): boolean {
  return ownedByContext.get(context)?.sessionIDs.has(sessionID) ?? false;
}

function nativeSession(context: V2Context): NativeSessionRuntime {
  return context.session as unknown as NativeSessionRuntime;
}

function newSessionID(): string {
  return `ses_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

function marker(kind: string): string {
  return `[STM_${kind}:${randomUUID()}]`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function finalUserTextPart(request: V2SessionContext, markedPrompt: string): number | undefined {
  const message = request.messages.at(-1);
  if (message?.role !== "user") return undefined;
  const matches = message.content.flatMap((part, index) =>
    part.type === "text" && part.text === markedPrompt ? [index] : [],
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function stripMarkerFromFinalPrompt(
  request: V2SessionContext,
  markedPrompt: string,
  prompt: string,
): V2SessionContext["messages"] {
  const index = finalUserTextPart(request, markedPrompt);
  if (index === undefined) throw new Error("summary_generation_marker_not_found");
  const messages = clone(request.messages);
  const last = messages.at(-1)!;
  messages[messages.length - 1] = {
    ...last,
    content: last.content.map((part, partIndex) => (partIndex === index ? { type: "text", text: prompt } : part)),
  };
  return messages;
}

function snapshotActiveRequest(
  request: V2SessionContext,
  markedPrompt: string,
  prompt: string,
): NativeGenerationSnapshot {
  return {
    system: clone(request.system),
    messages: stripMarkerFromFinalPrompt(request, markedPrompt, prompt),
    options: genericGenerationOptions(request.options),
  };
}

function genericGenerationOptions(options: V2SessionContext["options"]): V2SessionContext["options"] {
  const allowed = ["maxTokens", "temperature", "topP", "topK", "frequencyPenalty", "presencePenalty", "seed", "stop"];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.hasOwn(options, key)) result[key] = clone(options[key]);
  }
  return result;
}

async function removeOwnedSessionBounded(context: V2Context, sessionID: string): Promise<void> {
  const remove = nativeSession(context).remove;
  if (typeof remove !== "function") return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(() =>
    remove.call(nativeSession(context), { sessionID }, { signal: controller.signal }),
  );
  // If removal settles after the bounded wait, clear ownership only on success.
  operation.then(
    () => releaseOwnedSummarySession(context, sessionID),
    () => undefined,
  );
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("owned_summary_cleanup_timeout"));
      resolve("timeout");
    }, CLEANUP_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([operation.then(() => "removed" as const), timeout]);
    if (outcome === "removed") releaseOwnedSummarySession(context, sessionID);
  } catch {
    // Keep failed removals fenced; a session.deleted event releases the ID later.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function generateOwnedSession(
  context: V2Context,
  input: {
    readonly mode: "clean" | "active_override";
    readonly prompt: string;
    readonly model?: NativeSessionModel;
    readonly transform: OwnedRequestTransform;
  },
  signal: AbortSignal,
): Promise<{ text: string }> {
  signal.throwIfAborted();
  const runtime = nativeSession(context);
  if (typeof runtime.remove !== "function") throw new Error("native_session_remove_unavailable");
  const sessionID = newSessionID();
  const createdSessionIDs = new Set([sessionID]);
  const markedPrompt = `${marker("SUMMARY_REQUEST")}\n${input.prompt}`;
  registerOwnedSummarySession(context, sessionID);
  let createAttempted = false;
  let registration: { dispose: () => Promise<void> } | undefined;
  let result: { text: string } | undefined;
  let fenced = false;
  let failure: unknown;
  try {
    const hook = await context.session.hook("generate", (request) => {
      if (request.sessionID !== sessionID) return;
      if (!input.transform(request, markedPrompt, sessionID)) return;
      signal.throwIfAborted();
      fenced = true;
    });
    registration = hook;
    signal.throwIfAborted();
    createAttempted = true;
    const created = await runtime.create(
      {
        id: sessionID,
        title: OWNED_SESSION_TITLE,
        ...(input.model ? { model: input.model } : {}),
        location: { directory: context.location.directory },
        metadata: {
          [V2_OWNED_SUMMARY_SESSION_METADATA_KEY]: OWNED_SUMMARY_MARKER,
          stmSummaryMode: input.mode,
        },
      },
      { signal },
    );
    if (typeof created?.id === "string" && created.id !== sessionID) {
      createdSessionIDs.add(created.id);
      registerOwnedSummarySession(context, created.id);
      throw new Error("native_summary_session_id_mismatch");
    }
    if (created?.id !== sessionID) throw new Error("native_summary_session_id_missing");
    signal.throwIfAborted();
    result = await runtime.generate({ sessionID, prompt: markedPrompt }, { signal });
    signal.throwIfAborted();
    if (!fenced) throw new Error("owned_summary_generation_fence_not_applied");
  } catch (error) {
    failure = error;
  } finally {
    if (registration) {
      try {
        await registration.dispose();
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
    if (createAttempted) {
      for (const createdSessionID of createdSessionIDs) {
        await removeOwnedSessionBounded(context, createdSessionID);
      }
    } else releaseOwnedSummarySession(context, sessionID);
  }
  if (failure !== undefined) throw failure;
  if (!result) throw new Error("owned_summary_generation_missing_result");
  return result;
}

/** Generate on a fresh native session, omitting model to use the host default. */
export function generateV2CleanMemory(
  context: V2Context,
  input: { readonly prompt: string; readonly model?: NativeSessionModel },
  signal: AbortSignal,
): Promise<{ text: string }> {
  return generateOwnedSession(
    context,
    {
      ...input,
      mode: "clean",
      transform(request, markedPrompt) {
        const messages = stripMarkerFromFinalPrompt(request, markedPrompt, input.prompt);
        if (messages.length !== 1 || messages[0]?.role !== "user")
          throw new Error("clean_summary_context_not_isolated");
        request.system = [{ type: "text", text: CLEAN_SUMMARY_SYSTEM }];
        request.messages = messages;
        request.options = {};
        return true;
      },
    },
    signal,
  );
}

/** Copy the exact active request into an owned session when an explicit model is required. */
export async function generateV2ActiveOverrideMemory(
  context: V2Context,
  input: { readonly sessionID: string; readonly prompt: string; readonly model: NativeSessionModel },
  signal: AbortSignal,
): Promise<{ text: string }> {
  signal.throwIfAborted();
  const markedPrompt = `${marker("ACTIVE_CAPTURE")}\n${input.prompt}`;
  const ownedPrompt = `${marker("ACTIVE_OVERRIDE")}\n${input.prompt}`;
  const captureSentinel = marker("CAPTURE_FENCE");
  let snapshot: NativeGenerationSnapshot | undefined;
  let captureSentinelThrown = false;
  const registration = await context.session.hook("generate", (request) => {
    if (request.sessionID === input.sessionID && finalUserTextPart(request, markedPrompt) !== undefined) {
      signal.throwIfAborted();
      snapshot = snapshotActiveRequest(request, markedPrompt, input.prompt);
      captureSentinelThrown = true;
      // The native host aborts request preparation on a hook throw, before provider dispatch.
      throw new Error(captureSentinel);
    }
  });
  try {
    let captureRejected = false;
    try {
      await context.session.generate({ sessionID: input.sessionID, prompt: markedPrompt }, { signal });
    } catch (error) {
      signal.throwIfAborted();
      if (!captureSentinelThrown || !snapshot) throw error;
      // Plugin hook errors are surfaced by 2.0.32 as a generic request failure. The exact ID,
      // random marker, and local flag above are the only conditions that permit this handoff.
      captureRejected = true;
    }
    if (!captureRejected) throw new Error("active_summary_capture_fence_not_applied");
    signal.throwIfAborted();
    const result = await generateOwnedSession(
      context,
      {
        mode: "active_override",
        prompt: ownedPrompt,
        model: input.model,
        transform(request, markedPrompt, sessionID) {
          if (finalUserTextPart(request, markedPrompt) === undefined) return false;
          if (!snapshot) throw new Error("active_summary_context_snapshot_missing");
          request.system = clone(snapshot.system);
          request.messages = clone(snapshot.messages);
          request.options = clone(snapshot.options);
          request.tools = {};
          return true;
        },
      },
      signal,
    );
    return result;
  } finally {
    await registration.dispose();
  }
}
