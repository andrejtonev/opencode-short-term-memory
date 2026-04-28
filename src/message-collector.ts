import {
  type SessionMemoryConfig,
  type RuntimeState,
  getMessageRole,
  getMessageText,
  getMessageTextFromParts,
  getMessageTime,
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

export function getMessageID(row: unknown) {
  const r = row as Record<string, unknown>;
  const message = r?.message as Record<string, unknown> | undefined;
  const info = r?.info as Record<string, unknown> | undefined;
  const messageInfo = message?.info as Record<string, unknown> | undefined;
  const candidate = r?.id ?? r?.messageID ?? r?.messageId ?? message?.id ?? info?.id ?? messageInfo?.id;
  return String(candidate || "").trim();
}

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
  client: Client,
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

    const fetchLimit = config.maxDeltaMessages;
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { limit: fetchLimit },
    });
    const maybeData = (response as { data?: unknown[] })?.data;
    const rows: unknown[] = Array.isArray(maybeData)
      ? maybeData
      : Array.isArray(response)
        ? (response as unknown[])
        : [];
    const list = Array.isArray(rows) ? [...rows] : [];

    list.sort((a, b) => {
      const timeA = getMessageTime(a);
      const timeB = getMessageTime(b);
      if (timeA !== undefined && timeB !== undefined) {
        return timeA - timeB;
      }
      const idA = getMessageID(a);
      const idB = getMessageID(b);
      if (idA < idB) return -1;
      if (idA > idB) return 1;
      return 0;
    });

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
    throw new Error(`Failed to collect visible messages: ${(error as Error).message}`);
  }
}

export async function collectRecentVisibleMessages(
  client: Client,
  sessionID: string,
  config: SessionMemoryConfig,
  globalState: RuntimeState,
) {
  try {
    const collected = await collectVisibleMessagesSinceCheckpoint(client, sessionID, config);
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
    globalState.lastError = `Failed to collect recent messages: ${(error as Error).message}`;
    showToast(client, "Session Memory", "Failed to read conversation history — check /stm logs for details.");
    await logEvent(config, "collect_recent_messages_error", { sessionID, error: globalState.lastError });
    return {
      entries: [] as VisibleDeltaEntry[],
      newestMessageID: "",
      rowCount: 0,
      sinceMessageID: "",
      foundCheckpoint: false,
    };
  }
}
