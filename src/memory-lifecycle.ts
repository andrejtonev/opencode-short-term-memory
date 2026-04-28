import {
  ensureMemoryFile,
  logEvent,
  showToast,
  type SessionMemoryConfig,
  type RuntimeState,
  MEMORY_HEADER,
  readText,
  writeTextAtomic,
  trimLog,
} from "./memory-utils";
import type { VisibleDeltaEntry } from "./message-collector";
import { readLastProcessedMessageID, writeLastProcessedMessageID } from "./message-collector";
import {
  buildMemoryPrompt,
  normalizeMemory,
  runActiveSessionSummarizer,
  runCleanOpencodeSummarizer,
} from "./summarizer";
import type { Client } from "./types";

export function shouldBootstrapFromHistory(
  existingMemory: string,
  lastProcessedMessageID: string,
  magicHeader = MEMORY_HEADER,
): boolean {
  if (String(lastProcessedMessageID || "").trim()) return false;
  const normalized = String(existingMemory || "").trim();
  if (!normalized) return true;
  if (!normalized.includes(magicHeader)) return false;
  const noneCapturedCount = (normalized.match(/- None captured yet\./g) || []).length;
  return noneCapturedCount >= 3;
}

export async function maybeBootstrapSessionHistory(
  sessionID: string,
  reason: string,
  config: SessionMemoryConfig,
  client: Client,
  scheduleCb: (client: Client, sessionID: string, reason: string, cfg: SessionMemoryConfig) => void,
): Promise<void> {
  if (!config.enabled) return;
  const memoryPath = await ensureMemoryFile(sessionID, config);
  const [existingMemory, lastProcessedMessageID] = await Promise.all([
    readText(memoryPath, ""),
    readLastProcessedMessageID(sessionID, config),
  ]);
  if (!shouldBootstrapFromHistory(existingMemory, lastProcessedMessageID)) return;
  await logEvent(config, "memory_bootstrap_scheduled", { sessionID, reason });
  scheduleCb(client, sessionID, reason, config);
}

export async function processMemoryChunks(
  client: Client,
  sessionID: string,
  reason: string,
  config: SessionMemoryConfig,
  memoryPath: string,
  existing: string,
  recentEntries: VisibleDeltaEntry[],
  agentsMdContext: string,
  globalState: RuntimeState,
): Promise<void> {
  const separator = "\n\n---\n\n";
  let index = 0;
  let currentExisting = existing;

  while (index < recentEntries.length) {
    const chunkEntries: VisibleDeltaEntry[] = [];
    let chunkLen = 0;
    for (let i = index; i < recentEntries.length; i += 1) {
      const entry = recentEntries[i];
      const plusSep = chunkEntries.length ? separator.length : 0;
      const nextLen = chunkLen + plusSep + entry.rendered.length;
      if (nextLen <= config.maxUpdateInputLength) {
        chunkEntries.push(entry);
        chunkLen = nextLen;
        continue;
      }
      if (!chunkEntries.length) {
        const room = Math.max(64, config.maxUpdateInputLength - plusSep);
        chunkEntries.push({
          rendered: `${entry.rendered.slice(0, room)}\n[TRUNCATED_FOR_MAX_UPDATE_INPUT_LENGTH]`,
          lastMessageID: entry.lastMessageID,
        });
        chunkLen = chunkEntries[0].rendered.length;
      }
      break;
    }
    if (!chunkEntries.length) break;

    const conversation = chunkEntries.map((entry) => entry.rendered).join(separator);
    const includeAgentsMd = Boolean(agentsMdContext && index === 0);
    const prompt = buildMemoryPrompt(currentExisting, conversation, config, includeAgentsMd ? agentsMdContext : "");
    if (config.debug) {
      await logEvent(config, "memory_update_prompt", {
        sessionID,
        reason,
        promptChars: prompt.length,
        prompt,
      });
    }

    let raw = "";
    if (config.summarizerMode === "active") {
      raw = await runActiveSessionSummarizer(client, sessionID, prompt, config);
    } else {
      const maxAttempts = 1 + Math.max(0, Math.trunc(config.sideSessionRetries || 0));
      let lastCleanError = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          raw = await runCleanOpencodeSummarizer(prompt, config);
          if (attempt > 1) {
            await logEvent(config, "memory_update_clean_retry_succeeded", { sessionID, reason, attempt, maxAttempts });
          }
          break;
        } catch (cleanError) {
          lastCleanError = (cleanError as Error).message || String(cleanError || "");
          if (attempt < maxAttempts) {
            await logEvent(config, "memory_update_clean_retry_failed", {
              sessionID,
              reason,
              attempt,
              maxAttempts,
              error: lastCleanError,
            });
            continue;
          }
        }
      }
      if (!raw.trim()) {
        if (!config.cleanFallbackToActiveSession) {
          globalState.lastError = lastCleanError || "Clean summarizer produced empty output";
          showToast(client, "Session Memory", "Summarization failed — check /stm logs for details.");
          await logEvent(config, "memory_update_clean_failed_no_fallback", {
            sessionID,
            reason,
            attempts: maxAttempts,
            error: globalState.lastError,
          });
          return;
        }
        await logEvent(config, "memory_update_clean_failed_fallback", {
          sessionID,
          reason,
          attempts: maxAttempts,
          error: lastCleanError || "Clean summarizer produced empty output",
        });
        try {
          raw = await runActiveSessionSummarizer(client, sessionID, prompt, config);
        } catch (fallbackError) {
          const fallbackMessage = (fallbackError as Error).message || String(fallbackError || "");
          globalState.lastError = fallbackMessage;
          showToast(client, "Session Memory", "Summarization failed — check /stm logs for details.");
          await logEvent(config, "memory_update_fallback_error", { sessionID, reason, error: fallbackMessage });
          return;
        }
      }
    }

    if (!raw.trim()) {
      globalState.lastError = "Summarizer returned empty output";
      showToast(client, "Session Memory", "Summarization failed — empty output. Check /stm logs.");
      await logEvent(config, "memory_update_skipped", { sessionID, reason, detail: "empty_summarizer_output" });
      return;
    }

    const next = normalizeMemory(raw, config);
    if (!next.includes(MEMORY_HEADER) || !next.includes("### ")) {
      globalState.lastError = "Summarizer returned malformed memory output";
      showToast(client, "Session Memory", "Summarization failed — malformed output. Check /stm logs.");
      await logEvent(config, "memory_update_skipped", {
        sessionID,
        reason,
        detail: "malformed_summarizer_output",
        preview: next.slice(0, 240),
      });
      return;
    }

    const currentOnDisk = await readText(memoryPath, "");
    if (currentOnDisk !== currentExisting && currentOnDisk.trim()) {
      await logEvent(config, "memory_update_concurrent_change_detected", {
        sessionID,
        reason,
        bytesBefore: currentExisting.length,
        bytesNow: currentOnDisk.length,
      });
      currentExisting = currentOnDisk;
    }

    await writeTextAtomic(memoryPath, next);
    const checkpointID = chunkEntries[chunkEntries.length - 1]?.lastMessageID || "";
    if (checkpointID) {
      await writeLastProcessedMessageID(sessionID, checkpointID, config);
    }
    currentExisting = next;
    index += chunkEntries.length;
    globalState.updateCount += 1;
    globalState.lastUpdateAt = new Date().toISOString();
    globalState.lastError = undefined;
    await trimLog(config);
    await logEvent(config, "memory_update_chunk_done", {
      sessionID,
      reason,
      chunkEntries: chunkEntries.length,
      processedEntries: index,
      totalEntries: recentEntries.length,
      checkpointID,
      bytes: next.length,
    });
  }

  await logEvent(config, "memory_update_done", {
    sessionID,
    reason,
    processedEntries: recentEntries.length,
    newestMessageID: "",
  });
}
