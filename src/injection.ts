import type { SystemTransformInput, SystemTransformOutput, Client } from "./types";
import type { SessionMemoryConfig, RuntimeState } from "./memory-utils";
import type { RuntimeContract } from "./runtime-contract";
import { logEvent, readText, memoryPathFor, INJECTION_PREFIX, showToast } from "./memory-utils";
import {
  type SessionRuntimeState,
  claimMemoryDelivery,
  completeMemoryDelivery,
  ensureSessionState,
  MAX_SESSION_STATES,
  releaseMemoryDelivery,
} from "./session-state";
import { compactMemoryForInjection } from "./summarizer";

const TAGGED_MEMORY_PREAMBLE = `${INJECTION_PREFIX}\nUse this short-term session memory to preserve current instructions and conclusions. Do not mention it unless asked.\n\n`;

function caughtValueMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (message) return String(message);
  }
  return String(error ?? "");
}

export function buildTaggedMemoryForInjection(memory: string, maxMemoryLength: number): string {
  const compactMemory = compactMemoryForInjection(memory);
  if (!compactMemory.trim()) return "";
  const clippedMemory = compactMemory.slice(0, maxMemoryLength);
  return `${TAGGED_MEMORY_PREAMBLE}${clippedMemory}`;
}

async function recordMemoryInjection(
  sessionID: string,
  memory: string,
  injectedMessage: string,
  config: SessionMemoryConfig,
  globalState: RuntimeState,
): Promise<void> {
  globalState.injectCount += 1;
  globalState.injectCharCount += injectedMessage.length;
  globalState.lastInjectAt = new Date().toISOString();
  await logEvent(config, "memory_inject_done", { sessionID, bytes: memory.length });
}

export async function deliverMemoryViaNoReply(
  runtime: Pick<RuntimeContract, "deliverContextNoReply">,
  sessionID: string,
  turnID: string,
  expectedMemoryRevision: number,
  memory: string,
  config: SessionMemoryConfig,
  globalState: RuntimeState,
  state: SessionRuntimeState,
): Promise<boolean> {
  if (!config.enabled || !sessionID || !turnID || !memory.trim()) return false;
  const injectedMessage = buildTaggedMemoryForInjection(memory, config.maxMemoryLength);
  if (!injectedMessage) {
    await logEvent(config, "memory_inject_skipped", { sessionID, reason: "empty_compacted_memory" });
    return false;
  }

  const claim = claimMemoryDelivery(state, turnID, expectedMemoryRevision);
  if (!claim) {
    await logEvent(config, "memory_inject_skipped", {
      sessionID,
      reason: "delivery_claim_unavailable",
      expectedMemoryRevision,
      currentMemoryRevision: state.memoryRevision,
    });
    return false;
  }

  await logEvent(config, "memory_inject_start", {
    sessionID,
    bytes: memory.length,
    transport: "prompt_no_reply",
    memoryRevision: claim.memoryRevision,
  });
  if (config.debug) {
    await logEvent(config, "memory_inject_message", {
      sessionID,
      messageChars: injectedMessage.length,
      injectedMessage,
    });
  }

  try {
    await runtime.deliverContextNoReply({
      sessionId: sessionID,
      context: {
        parts: [{ type: "text" as const, text: injectedMessage }],
      },
      noReply: true,
    });
    completeMemoryDelivery(state, claim);
    await recordMemoryInjection(sessionID, memory, injectedMessage, config, globalState);
    return true;
  } catch (error) {
    releaseMemoryDelivery(state, claim);
    await logEvent(config, "memory_inject_failed", {
      sessionID,
      transport: "prompt_no_reply",
      memoryRevision: claim.memoryRevision,
      error: caughtValueMessage(error),
    });
    return false;
  }
}

export async function appendChildMemoryToSystem(
  output: SystemTransformOutput,
  sessionID: string,
  memory: string,
  config: SessionMemoryConfig,
  globalState: RuntimeState,
): Promise<boolean> {
  if (!config.enabled || !memory.trim()) return false;
  try {
    if (!Array.isArray(output.system)) output.system = [];
    if (output.system.some((item: unknown) => String(item || "").includes(INJECTION_PREFIX))) return false;
  } catch (error) {
    await logEvent(config, "memory_inject_failed", {
      sessionID,
      transport: "child_system",
      error: caughtValueMessage(error),
    });
    return false;
  }

  const injectedMessage = buildTaggedMemoryForInjection(memory, config.maxMemoryLength);
  if (!injectedMessage) {
    await logEvent(config, "memory_inject_skipped", { sessionID, reason: "empty_compacted_memory" });
    return false;
  }

  await logEvent(config, "memory_inject_start", { sessionID, bytes: memory.length, transport: "child_system" });
  if (config.debug) {
    await logEvent(config, "memory_inject_message", {
      sessionID,
      messageChars: injectedMessage.length,
      injectedMessage,
    });
  }
  try {
    output.system.push(injectedMessage);
  } catch (error) {
    await logEvent(config, "memory_inject_failed", {
      sessionID,
      transport: "child_system",
      error: caughtValueMessage(error),
    });
    return false;
  }
  await recordMemoryInjection(sessionID, memory, injectedMessage, config, globalState);
  return true;
}

export async function injectMemoryIntoSystemTransform(
  input: SystemTransformInput,
  output: SystemTransformOutput,
  config: SessionMemoryConfig,
  globalState: RuntimeState,
  sessionStates: Map<string, SessionRuntimeState>,
  sessionStatesOrder: string[],
  client: Client,
): Promise<void> {
  if (!config.enabled) return;
  const sessionID = input.sessionID;
  if (!sessionID) {
    await logEvent(config, "memory_inject_skipped", { reason: "missing_session_id" });
    return;
  }
  const memory = await readText(memoryPathFor(sessionID, config.memoryDir), "");
  if (!memory.trim()) return;
  if (!Array.isArray(output.system)) output.system = [];
  const remindEveryN = Math.max(1, Math.trunc(config.remindEveryN || 1));
  const messageID = String(input.messageID || (input.message as { id?: string } | undefined)?.id || input.id || "");
  const s = ensureSessionState(sessionID, sessionStates, sessionStatesOrder, MAX_SESSION_STATES);
  const stateForSession = s.userTurnInjectState;
  const isDuplicateTurn = Boolean(messageID && messageID === stateForSession.lastMessageID);
  if (!isDuplicateTurn) {
    stateForSession.count += 1;
    if (messageID) stateForSession.lastMessageID = messageID;
  }
  const shouldInjectThisTurn = remindEveryN <= 1 || stateForSession.count % remindEveryN === 0;
  if (!shouldInjectThisTurn) {
    await logEvent(config, "memory_inject_skipped", {
      sessionID,
      reason: "remind_every_n",
      remindEveryN,
      userTurnCount: stateForSession.count,
    });
    return;
  }

  if (
    Array.isArray(output?.system) &&
    output.system.some((item: unknown) => String(item || "").includes(INJECTION_PREFIX))
  ) {
    await logEvent(config, "memory_inject_skipped", { sessionID, reason: "already_present_in_system" });
    return;
  }

  const injectedSystemMessage = buildTaggedMemoryForInjection(memory, config.maxMemoryLength);
  if (!injectedSystemMessage) {
    showToast(client, "Session Memory", "Memory injection skipped — all sections are empty. Run /stm update.");
    await logEvent(config, "memory_inject_skipped", { sessionID, reason: "empty_compacted_memory" });
    return;
  }

  const clippedMemory = injectedSystemMessage.slice(TAGGED_MEMORY_PREAMBLE.length);
  const signature = `${messageID}|${clippedMemory.length}:${clippedMemory.slice(0, 120)}`;
  const previous = s.lastInjectedSignature;
  const now = Date.now();
  const duplicateWindowMs = Math.max(config.debounceMs * 2, 2500);
  if (previous && previous.signature === signature && now - previous.at < duplicateWindowMs) {
    await logEvent(config, "memory_inject_skipped", { sessionID, reason: "duplicate_transform", duplicateWindowMs });
    return;
  }

  await logEvent(config, "memory_inject_start", { sessionID, bytes: memory.length });
  if (config.debug) {
    await logEvent(config, "memory_inject_message", {
      sessionID,
      messageChars: injectedSystemMessage.length,
      injectedMessage: injectedSystemMessage,
    });
  }
  output.system.push(injectedSystemMessage);
  s.lastInjectedSignature = { signature, at: now };
  await recordMemoryInjection(sessionID, memory, injectedSystemMessage, config, globalState);
}
