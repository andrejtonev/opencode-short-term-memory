import {
  type SessionMemoryConfig,
  type RuntimeState,
  getMessageRole,
  getMessageText,
  getMessageTextFromParts,
  isInternalPartType,
  sanitizeMessage,
  INJECTION_PREFIX,
  MEMORY_HEADER,
  checkpointPathFor,
  readText,
  writeTextAtomic,
  logEvent,
  showToast,
} from "./memory-utils";
import type { Client } from "./types";
import type { RuntimeContract } from "./runtime-contract";
import { getV1HistoryMessageID, historyAfterV1Reset, readV1ResetBoundary, sortV1History } from "./v1-reset-boundary";

type MessageReader = Pick<RuntimeContract, "readSessionMessages">;

function caughtValueMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return "Unknown error";

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error !== "object") return String(error);

  const value = error as Record<string, unknown>;
  const data = value.data as Record<string, unknown> | undefined;
  const message = [value.message, data?.message].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
  );
  const name = [value.name, data?.name].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
  );

  if (message) return name && name !== "Error" ? `${name}: ${message}` : message;

  const safeDetails: Record<string, string | number> = {};
  for (const key of ["name", "code", "status"]) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number") safeDetails[key] = candidate;
  }
  return Object.keys(safeDetails).length > 0 ? JSON.stringify(safeDetails) : "Unknown error";
}

export type VisibleDeltaEntry = {
  rendered: string;
  lastMessageID?: string;
};

export function isLikelyInternalAssistantMessage(row: unknown, cleanText: string) {
  const r = row as Record<string, unknown>;
  const rowType = String(r?.type || r?.kind || "").toLowerCase();
  if (isInternalPartType(rowType)) return true;

  if (r?.synthetic === true || r?.internal === true) {
    return true;
  }

  const rawParts = r?.parts;
  const messageParts = (r?.message as Record<string, unknown> | undefined)?.parts;
  const parts: unknown[] = Array.isArray(rawParts) ? rawParts : Array.isArray(messageParts) ? messageParts : [];
  if (parts.length > 0) {
    const visibleText = getMessageTextFromParts(parts);
    if (!visibleText) return true;
  }

  const lowered = String(cleanText || "")
    .trim()
    .toLowerCase();
  if (!lowered) return true;
  if (/^assistant internal chunk\b/.test(lowered)) return true;
  if (/^thinking[:\s]/.test(lowered)) return true;
  if (/^tool (call|result)[:\s]/.test(lowered)) return true;
  return false;
}

export const getMessageID = getV1HistoryMessageID;

export async function readLastProcessedMessageID(sessionID: string, config: SessionMemoryConfig) {
  return (await readText(checkpointPathFor(sessionID, config.memoryDir), "")).trim();
}

export async function writeLastProcessedMessageID(sessionID: string, messageID: string, config: SessionMemoryConfig) {
  if (!messageID) {
    await logEvent(config, "empty_message_id_skip_checkpoint", { sessionID });
    return;
  }
  await writeTextAtomic(checkpointPathFor(sessionID, config.memoryDir), `${messageID.trim()}\n`);
}

export async function collectVisibleMessagesSinceCheckpoint(
  runtime: MessageReader,
  sessionID: string,
  config: SessionMemoryConfig,
) {
  try {
    const sinceMessageID = await readLastProcessedMessageID(sessionID, config);
    if (sinceMessageID === "") {
      await logEvent(config, "checkpoint_empty_id_warning", {
        sessionID,
        detail:
          "lastProcessedMessageID is empty, treating as no checkpoint. Delta will start from most recent messages.",
      });
    }

    const boundary = await readV1ResetBoundary(sessionID, config.memoryDir);
    // A recent window cannot prove a reset anchor disappeared rather than just
    // falling outside maxDeltaMessages. Locate it in durable history first.
    const rows = await runtime.readSessionMessages(
      sessionID,
      boundary ? undefined : { limit: config.maxDeltaMessages },
    );
    const list = boundary ? historyAfterV1Reset(rows, boundary).slice(-config.maxDeltaMessages) : sortV1History(rows);

    let startIndex = 0;
    if (sinceMessageID) {
      let found = false;
      for (let idx = list.length - 1; idx >= 0; idx -= 1) {
        if (getMessageID(list[idx]) === sinceMessageID) {
          startIndex = idx + 1;
          found = true;
          break;
        }
      }
      if (!found) {
        await logEvent(config, "checkpoint_not_found_in_recent", { sessionID, sinceMessageID });
      }
    }

    const deltaRows = list.slice(startIndex);

    const renderVisible = (inputRows: unknown[]): VisibleDeltaEntry[] => {
      const renderedEntries = (inputRows || [])
        .map((row: unknown) => {
          const r = row as Record<string, unknown>;
          const normalizedRole = getMessageRole(r);
          if (normalizedRole !== "user" && normalizedRole !== "assistant") return null;
          const text =
            getMessageText(r) ||
            getMessageText({
              message: r?.message,
              parts: r?.parts,
            }) ||
            "";
          const clean = sanitizeMessage(String(text || ""));
          if (!clean) return null;
          if (clean.includes(INJECTION_PREFIX) || clean.includes(MEMORY_HEADER)) return null;
          if (normalizedRole === "assistant" && isLikelyInternalAssistantMessage(r, clean)) return null;
          return {
            role: normalizedRole,
            rendered: `${normalizedRole.toUpperCase()}:\n${clean}`,
            rowID: getMessageID(r),
          };
        })
        .filter((entry): entry is { role: "user" | "assistant"; rendered: string; rowID: string } => Boolean(entry));

      const collapsed: Array<{ role: string; rendered: string; lastMessageID?: string }> = [];
      for (const entry of renderedEntries as Array<{ role: string; rendered: string; rowID?: string }>) {
        const last = collapsed[collapsed.length - 1];
        if (config.collapseAssistantBursts && last && last.role === "assistant" && entry.role === "assistant") {
          collapsed[collapsed.length - 1] = {
            role: entry.role,
            rendered: entry.rendered,
            lastMessageID: entry.rowID,
          };
        } else {
          collapsed.push({
            role: entry.role,
            rendered: entry.rendered,
            lastMessageID: entry.rowID,
          });
        }
      }

      return collapsed.map((entry) => ({
        rendered: entry.rendered,
        lastMessageID: entry.lastMessageID,
      }));
    };

    const entries = renderVisible(deltaRows);

    return {
      entries,
      newestMessageID: getMessageID(list[list.length - 1] || {}),
      rowCount: list.length,
      sinceMessageID,
      foundCheckpoint: sinceMessageID ? startIndex > 0 : false,
    };
  } catch (error) {
    throw new Error(`Failed to collect visible messages: ${caughtValueMessage(error)}`, { cause: error });
  }
}

export async function collectRecentVisibleMessages(
  runtime: MessageReader,
  client: Client,
  sessionID: string,
  config: SessionMemoryConfig,
  globalState: RuntimeState,
) {
  try {
    const collected = await collectVisibleMessagesSinceCheckpoint(runtime, sessionID, config);
    if (!collected.entries.length) {
      await logEvent(config, "collect_recent_messages_empty", {
        sessionID,
        rows: collected.rowCount,
        sinceMessageID: collected.sinceMessageID,
        foundCheckpoint: collected.foundCheckpoint,
      });
    }
    return collected;
  } catch (error) {
    globalState.lastError = `Failed to collect recent messages: ${caughtValueMessage(error)}`;
    showToast(client, "Session Memory", "Failed to read conversation history — check /stm logs for details.");
    await logEvent(config, "collect_recent_messages_error", { sessionID, error: globalState.lastError });
    throw error;
  }
}
