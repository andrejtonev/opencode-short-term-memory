import { createHash } from "node:crypto";
import type { SessionPrompt } from "@opencode/plugin/promise/session";
import type { V2Context } from "./v2-adapter";
import type { SessionMemoryConfig } from "./memory-utils";
import { buildTaggedMemoryForInjection } from "./injection";
import { DEFAULT_CONFIG, isSelfInjection, logEvent, memoryPathFor, readConfig, readText } from "./memory-utils";
import { classifyV2Session } from "./v2-child-memory";
import {
  getV2MemoryReadRevision,
  getV2MemorySessionSignal,
  getV2MemoryGenerationSignal,
  isV2MemorySessionDeleted,
  withV2MemoryMutation,
} from "./v2-mutation-coordination";
import { boundedV2Operation } from "./v2-bounded-operation";
import type { ReturnTypeOfReminderCadence } from "./v2-reminder-cadence";

type DeliveryClaim = {
  syntheticID: string;
  text?: string;
  state: "pending" | "complete" | "retryable";
};

const MAX_SESSION_CLAIMS = 256;
const MAX_CLAIMS_PER_SESSION = 4096;
type SyntheticID = NonNullable<Parameters<V2Context["session"]["synthetic"]>[0]["id"]>;

function syntheticID(sessionID: string, messageID: string, revision: number): SyntheticID {
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionID, messageID, revision]))
    .digest("hex")
    .slice(0, 26);
  return `msg_${digest}` as SyntheticID;
}

export type V2MessageInjectionHandler = ((input: SessionPrompt) => Promise<void>) & {
  dispose(): void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function isMessageSelected(config: SessionMemoryConfig): boolean {
  return !config.enableLegacyPeriodicSystemTransform || config.summarizerMode === "active";
}

export function createV2MessageInjection(
  context: Parameters<typeof classifyV2Session>[0],
  directory?: string,
  cadence?: ReturnTypeOfReminderCadence,
  lifetimeSignal?: AbortSignal,
  isOwnedSession?: (sessionID: string) => boolean,
): V2MessageInjectionHandler {
  const resolvedDirectory = directory ?? context.location.directory;
  const queues = new Map<string, Promise<void>>();
  const claims = new Map<string, Map<string, DeliveryClaim>>();
  let disposed = false;

  const owned = (sessionID: string) => {
    try {
      return isOwnedSession?.(sessionID) === true;
    } catch {
      return true;
    }
  };

  function live(sessionID: string, revision: number): boolean {
    if (
      disposed ||
      lifetimeSignal?.aborted ||
      owned(sessionID) ||
      isV2MemorySessionDeleted(resolvedDirectory, sessionID)
    )
      return false;
    return getV2MemoryReadRevision(resolvedDirectory, sessionID) === revision;
  }

  function stateFor(sessionID: string): Map<string, DeliveryClaim> {
    let state = claims.get(sessionID);
    if (!state) {
      if (claims.size >= MAX_SESSION_CLAIMS) claims.delete(claims.keys().next().value as string);
      state = new Map();
      claims.set(sessionID, state);
    }
    return state;
  }

  function claimDelivery(sessionID: string, messageID: string, revision: number): DeliveryClaim | undefined {
    const state = stateFor(sessionID);
    const key = JSON.stringify([messageID, revision]);
    const existing = state.get(key);
    if (existing?.state === "pending" || existing?.state === "complete") return undefined;
    const claim: DeliveryClaim = existing ?? {
      syntheticID: syntheticID(sessionID, messageID, revision),
      state: "retryable",
    };
    claim.state = "pending";
    if (!existing && state.size >= MAX_CLAIMS_PER_SESSION) state.delete(state.keys().next().value as string);
    state.set(key, claim);
    return claim;
  }

  function finishClaim(
    sessionID: string,
    messageID: string,
    revision: number,
    claim: DeliveryClaim,
    complete: boolean,
  ) {
    const state = claims.get(sessionID);
    const key = JSON.stringify([messageID, revision]);
    if (!state || state.get(key) !== claim) return;
    if (complete) claim.state = "complete";
    else claim.state = "retryable";
  }

  async function debugLog(config: SessionMemoryConfig, event: string, data: Record<string, unknown>): Promise<void> {
    if (!config.debug) return;
    try {
      await logEvent(config, event, data);
    } catch {}
  }

  async function deliver(input: SessionPrompt): Promise<void> {
    const { sessionID, messageID } = input;
    if (!sessionID || !messageID || !input.prompt?.text?.trim() || isSelfInjection(input.prompt.text)) return;
    const revision = getV2MemoryReadRevision(resolvedDirectory, sessionID);
    if (!live(sessionID, revision)) return;
    let config: SessionMemoryConfig | undefined;
    try {
      config = await readConfig(undefined, resolvedDirectory);
      if (!live(sessionID, revision) || !config.enabled) return;
      const lineage = await classifyV2Session(context, sessionID);
      if (!live(sessionID, revision)) return;
      if (lineage.kind !== "primary") {
        await debugLog(config, "v2_message_injection_skip", {
          sessionID,
          reason: lineage.kind === "metadata-error" ? "metadata-error" : "task-child",
          transport: "message",
        });
        return;
      }
      cadence?.record({ sessionID, messageID });

      if (!isMessageSelected(config)) return;
      cadence?.selectTransport(sessionID, "message", [{ id: messageID, role: "user" }]);
      if (
        cadence &&
        !(await cadence.shouldInjectPrompt({ sessionID, messageID }, config.remindEveryN, config.memoryDir))
      ) {
        await debugLog(config, "v2_message_injection_skip", {
          sessionID,
          reason: "cadence",
          transport: "message",
          messageID,
        });
        return;
      }
      if (!live(sessionID, revision)) return;

      const claim = claimDelivery(sessionID, messageID, revision);
      if (!claim) {
        await debugLog(config, "v2_message_injection_skip", {
          sessionID,
          reason: "delivery_claim_unavailable",
          transport: "message",
          messageID,
          memoryRevision: revision,
        });
        return;
      }

      let delivered = false;
      const admissionSignal = AbortSignal.any([
        ...(lifetimeSignal ? [lifetimeSignal] : []),
        getV2MemorySessionSignal(resolvedDirectory, sessionID),
        getV2MemoryGenerationSignal(resolvedDirectory, sessionID),
      ]);
      try {
        delivered = await boundedV2Operation(
          (queueSignal) =>
            withV2MemoryMutation(resolvedDirectory, sessionID, async () => {
              queueSignal.throwIfAborted();
              if (!live(sessionID, revision)) return false;
              const currentConfig = await readConfig(undefined, resolvedDirectory);
              if (!live(sessionID, revision) || !currentConfig.enabled || !isMessageSelected(currentConfig))
                return false;
              const memory = await readText(memoryPathFor(sessionID, currentConfig.memoryDir), "");
              if (!live(sessionID, revision)) return false;
              const taggedMemory = claim.text ?? buildTaggedMemoryForInjection(memory, currentConfig.maxMemoryLength);
              if (!taggedMemory.trim()) {
                await debugLog(currentConfig, "v2_message_injection_skip", {
                  sessionID,
                  reason: "empty_memory",
                  transport: "message",
                  messageID,
                });
                return false;
              }
              claim.text = taggedMemory;
              if (!live(sessionID, revision)) return false;
              await boundedV2Operation(
                (signal) =>
                  context.session.synthetic(
                    {
                      sessionID,
                      id: claim.syntheticID,
                      text: taggedMemory,
                      description: "Short-term session memory",
                      metadata: { source: "opencode-short-term-memory", primaryMessageID: messageID },
                      delivery: "steer",
                      resume: false,
                    },
                    { signal },
                  ),
                queueSignal,
                5_000,
              );
              await debugLog(currentConfig, "v2_message_injection_success", {
                sessionID,
                messageID,
                memoryRevision: revision,
                transport: "message",
                memoryChars: memory.length,
                injectedChars: taggedMemory.length,
              });
              return true;
            }),
          admissionSignal,
          5_000,
        );
      } catch (error) {
        finishClaim(sessionID, messageID, revision, claim, false);
        await logEvent(config, "v2_message_injection_error", {
          sessionID,
          messageID,
          transport: "message",
          memoryRevision: revision,
          error: errorMessage(error),
        }).catch(() => undefined);
        return;
      }
      finishClaim(sessionID, messageID, revision, claim, delivered);
    } catch (error) {
      try {
        await logEvent(config ?? DEFAULT_CONFIG, "v2_message_injection_error", {
          sessionID,
          messageID,
          transport: "message",
          error: errorMessage(error),
        });
      } catch {}
    }
  }

  return Object.assign(
    (input: SessionPrompt) => {
      if (disposed || !input.sessionID) return Promise.resolve();
      const previous = queues.get(input.sessionID) ?? Promise.resolve();
      const next = previous.then(
        () => deliver(input),
        () => deliver(input),
      );
      queues.set(input.sessionID, next);
      void next.then(
        () => {
          if (queues.get(input.sessionID) === next) queues.delete(input.sessionID);
        },
        () => {
          if (queues.get(input.sessionID) === next) queues.delete(input.sessionID);
        },
      );
      return next;
    },
    {
      dispose() {
        disposed = true;
        queues.clear();
        claims.clear();
      },
    },
  );
}
