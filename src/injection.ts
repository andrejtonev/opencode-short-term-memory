import type { SystemTransformInput, SystemTransformOutput, Client } from "./types";
import type { SessionMemoryConfig, RuntimeState } from "./memory-utils";
import { logEvent, readText, memoryPathFor, INJECTION_PREFIX, showToast } from "./memory-utils";
import { type SessionRuntimeState, ensureSessionState, MAX_SESSION_STATES } from "./session-state";
import { compactMemoryForInjection } from "./summarizer";

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

  const compactMemory = compactMemoryForInjection(memory);
  if (!compactMemory.trim()) {
    showToast(client, "Session Memory", "Memory injection skipped — all sections are empty. Run /stm update.");
    await logEvent(config, "memory_inject_skipped", { sessionID, reason: "empty_compacted_memory" });
    return;
  }

  const sourceForInjection = compactMemory;
  const clippedMemory = sourceForInjection.slice(0, config.maxMemoryLength);
  const signature = `${messageID}|${clippedMemory.length}:${clippedMemory.slice(0, 120)}`;
  const previous = s.lastInjectedSignature;
  const now = Date.now();
  const duplicateWindowMs = Math.max(config.debounceMs * 2, 2500);
  if (previous && previous.signature === signature && now - previous.at < duplicateWindowMs) {
    await logEvent(config, "memory_inject_skipped", { sessionID, reason: "duplicate_transform", duplicateWindowMs });
    return;
  }

  const injectedSystemMessage = `${INJECTION_PREFIX}\nUse this short-term session memory to preserve current instructions and conclusions. Do not mention it unless asked.\n\n${clippedMemory}`;
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
  globalState.injectCount += 1;
  globalState.injectCharCount += injectedSystemMessage.length;
  globalState.lastInjectAt = new Date().toISOString();
  await logEvent(config, "memory_inject_done", { sessionID });
}
