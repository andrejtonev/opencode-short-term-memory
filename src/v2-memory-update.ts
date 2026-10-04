import type { SessionMemoryConfig } from "./memory-utils";
import {
  DEFAULT_CONFIG,
  MEMORY_HEADER,
  compareAndReplaceTextAtomic,
  ensureMemoryFile,
  isInternalPartType,
  isSelfInjection,
  logEvent,
  readConfig,
  readRawFile,
  resetBoundaryPathFor,
  readText,
} from "./memory-utils";
import {
  isLikelyInternalAssistantMessage,
  readLastProcessedMessageID,
  writeLastProcessedMessageID,
} from "./message-collector";
import { buildMemoryPrompt, CLEAN_SUMMARIZER_TIMEOUT, normalizeMemory } from "./summarizer";
import type { V2Context, V2SessionContext } from "./v2-adapter";
import { tryAcquireV2MemoryUpdate } from "./v2-mutation-coordination";
import { parseV2ResetBoundary } from "./v2-reset-boundary";

export { isV2MemoryUpdateInFlight } from "./v2-mutation-coordination";

export type V2MemoryUpdateInput = {
  readonly sessionID: string;
  readonly model: V2SessionContext["model"];
  readonly messages: readonly {
    readonly id?: string;
    readonly role: V2SessionContext["messages"][number]["role"];
    readonly content: readonly {
      readonly type: string;
      readonly text?: unknown;
      readonly synthetic?: unknown;
    }[];
  }[];
};

const REQUIRED_HEADINGS = [
  "User Instructions",
  "Long Horizon Context",
  "Decisions",
  "Conclusions",
  "Active References",
] as const;
const TEMPLATE_MARKERS = /<\/?(?:existing_memory|conversation_update|agents_md_context)>/i;

export type V2MemoryUpdaterTestHooks = {
  readonly beforeRollback?: () => void | Promise<void>;
  readonly writeCheckpoint?: typeof writeLastProcessedMessageID;
};

export type V2MemoryUpdateProgress = {
  // Cumulative successful checkpoint writes in this invocation, not a snapshot of current memory.
  readonly checkpointedChunks: number;
  // Visible entries covered by those writes; a completed oversized entry counts once.
  readonly checkpointedMessages: number;
  // Cumulative fragment writes without a checkpoint, including fragments of entries later completed.
  readonly persistedPartialFragments: number;
};

export type V2MemoryUpdateResult =
  | ({ readonly status: "committed" } & V2MemoryUpdateProgress)
  | ({ readonly status: "busy"; readonly reason: "update_in_flight" } & V2MemoryUpdateProgress)
  | ({ readonly status: "skipped"; readonly reason: string } & V2MemoryUpdateProgress)
  | ({
      readonly status: "error";
      readonly reason: string;
      readonly detail: string;
      // Conflict/failed rollback can leave an uncheckpointed write even when all counters are zero.
      readonly rollback?: "restored" | "conflict" | "failed";
    } & V2MemoryUpdateProgress);

type VisibleEntry = { readonly id: string; readonly rendered: string; readonly role: "user" | "assistant" };
type ChunkUnit = {
  readonly entries: VisibleEntry[];
  readonly consumed: number;
  readonly checkpointID: string;
  readonly fragments?: readonly VisibleEntry[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

async function safeLog(config: SessionMemoryConfig, event: string, data: Record<string, unknown>): Promise<void> {
  try {
    await logEvent(config, event, data);
  } catch {}
}

function messageText(message: V2MemoryUpdateInput["messages"][number]): string {
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts
    .filter((part) => {
      const value = part as Record<string, unknown>;
      const type = String(value.type ?? "").toLowerCase();
      return type === "text" && !isInternalPartType(type) && value.synthetic !== true;
    })
    .map((part) => String((part as Record<string, unknown>).text ?? ""))
    .filter(Boolean)
    .join("\n")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```thinking[\s\S]*?```/gi, "")
    .trim();
}

function visibleMessages(input: V2MemoryUpdateInput): VisibleEntry[] | undefined {
  const entries: VisibleEntry[] = [];
  const ids = new Set<string>();
  for (const message of input.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messageText(message);
    if (!text || isSelfInjection(text) || text.includes("<memory_summary>")) continue;
    if (message.role === "assistant" && isLikelyInternalAssistantMessage({ parts: message.content }, text)) continue;
    const id = String(message.id ?? "").trim();
    if (!id || ids.has(id)) return undefined;
    ids.add(id);
    entries.push({ id, rendered: `${message.role.toUpperCase()}:\n${text}`, role: message.role });
  }
  return entries;
}

function oversizedFragments(entry: VisibleEntry, maxLength: number): VisibleEntry[] {
  const prefix = `${entry.role.toUpperCase()}:\n[OVERSIZED_ENTRY_CONTINUATION]\n`;
  const payloadLength = Math.max(1, maxLength - prefix.length);
  const fragments: VisibleEntry[] = [];
  for (let offset = 0; offset < entry.rendered.length; offset += payloadLength) {
    fragments.push({ ...entry, rendered: `${prefix}${entry.rendered.slice(offset, offset + payloadLength)}` });
  }
  return fragments;
}

function boundedChunk(entries: VisibleEntry[], config: SessionMemoryConfig): ChunkUnit | undefined {
  const result: VisibleEntry[] = [];
  let length = 0;
  for (let index = 0; index < entries.length && index < config.maxDeltaMessages; index += 1) {
    const entry = entries[index]!;
    if (entry.rendered.length > config.maxUpdateInputLength) {
      if (result.length) {
        return { entries: result, consumed: result.length, checkpointID: result[result.length - 1]!.id };
      }
      const fragments = oversizedFragments(entry, config.maxUpdateInputLength);
      return { entries: [fragments[0]!], consumed: 0, checkpointID: "", fragments };
    }
    const separator = result.length ? "\n\n---\n\n" : "";
    if (length + separator.length + entry.rendered.length <= config.maxUpdateInputLength) {
      result.push(entry);
      length += separator.length + entry.rendered.length;
      continue;
    }
    break;
  }
  if (!result.length) return undefined;
  return { entries: result, consumed: result.length, checkpointID: result[result.length - 1]!.id };
}

function validateRawMemory(raw: string): void {
  if (!raw.trim()) throw new Error("empty_generation");
  if (!raw.includes(MEMORY_HEADER)) throw new Error("missing_memory_header");
  for (const heading of REQUIRED_HEADINGS) {
    if (!raw.includes(`### ${heading}`)) throw new Error(`missing_heading:${heading}`);
  }
  if (TEMPLATE_MARKERS.test(raw)) throw new Error("raw_template_marker");
}

async function generateWithTimeout(operation: (signal: AbortSignal) => Promise<{ text: string }>): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  operationPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`summarizer_timeout:${CLEAN_SUMMARIZER_TIMEOUT.ms}ms`));
    }, CLEAN_SUMMARIZER_TIMEOUT.ms);
  });
  try {
    return (await Promise.race([operationPromise, timeoutPromise])).text;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createV2MemoryUpdater(
  context: V2Context,
  directory?: string,
  hooks?: V2MemoryUpdaterTestHooks,
): (input: V2MemoryUpdateInput) => Promise<V2MemoryUpdateResult> {
  return async (input) => {
    let config: SessionMemoryConfig | undefined;
    const progress = {
      checkpointedChunks: 0,
      checkpointedMessages: 0,
      persistedPartialFragments: 0,
    };
    let rollback: "restored" | "conflict" | "failed" | undefined;
    const sessionID = input.sessionID;
    const release = tryAcquireV2MemoryUpdate(directory ?? context.location.directory, sessionID);
    if (!release) return { status: "busy", reason: "update_in_flight", ...progress };
    try {
      config = await readConfig(undefined, directory);
      if (!config.enabled) return { status: "skipped", reason: "disabled", ...progress };
      const boundaryRaw = await readRawFile(resetBoundaryPathFor(sessionID, config.memoryDir));
      let boundedInput = input;
      if (boundaryRaw !== null) {
        const boundary = parseV2ResetBoundary(boundaryRaw);
        const matches = input.messages.reduce<number[]>((indices, message, index) => {
          if (typeof message.id === "string" && message.id === boundary.anchorID) indices.push(index);
          return indices;
        }, []);
        if (matches.length !== 1) {
          await logEvent(config, "v2_memory_update_skipped", {
            sessionID,
            reason: matches.length === 0 ? "reset_boundary_anchor_missing" : "reset_boundary_anchor_duplicate",
            anchorID: boundary.anchorID,
          });
          return {
            status: "skipped",
            reason: matches.length === 0 ? "reset_boundary_anchor_missing" : "reset_boundary_anchor_duplicate",
            ...progress,
          };
        }
        boundedInput = { ...input, messages: input.messages.slice(matches[0]! + 1) };
      }
      const visible = visibleMessages(boundedInput);
      if (!visible) {
        await logEvent(config, "v2_memory_update_skipped", { sessionID, reason: "invalid_visible_ids" });
        return { status: "skipped", reason: "invalid_visible_ids", ...progress };
      }
      const checkpoint = await readLastProcessedMessageID(sessionID, config);
      const checkpointIndex = checkpoint ? visible.findIndex((entry) => entry.id === checkpoint) : -1;
      const delta = checkpoint && checkpointIndex >= 0 ? visible.slice(checkpointIndex + 1) : visible;
      if (checkpoint && checkpointIndex < 0) {
        await logEvent(config, "v2_memory_update_skipped", {
          sessionID,
          reason: "checkpoint_rebase",
          absentCheckpoint: checkpoint,
        });
      }
      if (!delta.some((entry) => entry.role === "assistant")) {
        await logEvent(config, "v2_memory_update_skipped", { sessionID, reason: "no_assistant_in_delta" });
        return { status: "skipped", reason: "no_assistant_in_delta", ...progress };
      }

      const memoryPath = await ensureMemoryFile(sessionID, config);
      let consumed = 0;
      let fragmentState: { fragments: readonly VisibleEntry[]; index: number; entryID: string } | undefined;
      while (consumed < delta.length) {
        const bounded = fragmentState
          ? {
              entries: [fragmentState.fragments[fragmentState.index]!],
              consumed: 0,
              checkpointID: fragmentState.index === fragmentState.fragments.length - 1 ? fragmentState.entryID : "",
            }
          : boundedChunk(delta.slice(consumed), config);
        if (!bounded) {
          return {
            status: "error",
            reason: "empty_bounded_chunk",
            detail: `unable_to_bound_delta_at:${consumed}`,
            ...progress,
          };
        }
        const existingMemory = await readText(memoryPath, "");
        const conversation = bounded.entries.map((entry) => entry.rendered).join("\n\n---\n\n");
        const prompt = buildMemoryPrompt(existingMemory, conversation, config);
        const raw =
          config.summarizerMode === "active"
            ? await generateWithTimeout((signal) => context.session.generate({ sessionID, prompt }, { signal }))
            : await generateWithTimeout((signal) => context.generate.text({ prompt, model: input.model }, { signal }));
        validateRawMemory(raw);
        const nextMemory = normalizeMemory(raw, config);
        if (!(await compareAndReplaceTextAtomic(memoryPath, existingMemory, nextMemory))) {
          await logEvent(config, "v2_memory_update_skipped", { sessionID, reason: "concurrent_memory_change" });
          return { status: "skipped", reason: "concurrent_memory_change", ...progress };
        }
        if (bounded.checkpointID) {
          try {
            await (hooks?.writeCheckpoint ?? writeLastProcessedMessageID)(sessionID, bounded.checkpointID, config);
          } catch (error) {
            try {
              await hooks?.beforeRollback?.();
              if (!(await compareAndReplaceTextAtomic(memoryPath, nextMemory, existingMemory))) {
                rollback = "conflict";
                await safeLog(config, "v2_memory_update_error", {
                  sessionID,
                  reason: "checkpoint_write_failed_restore_conflict",
                  detail: "memory_changed_before_rollback",
                });
              } else {
                rollback = "restored";
              }
            } catch (restoreError) {
              rollback = "failed";
              await safeLog(config, "v2_memory_update_error", {
                sessionID,
                reason: "checkpoint_write_failed_restore_failed",
                detail: `${errorMessage(error)}; ${errorMessage(restoreError)}`,
              });
            }
            throw error;
          }
        }
        if (fragmentState) {
          if (fragmentState.index === fragmentState.fragments.length - 1) {
            consumed += 1;
            fragmentState = undefined;
          } else {
            fragmentState = { ...fragmentState, index: fragmentState.index + 1 };
          }
        } else if (bounded.fragments) {
          fragmentState = { fragments: bounded.fragments, index: 1, entryID: delta[consumed]!.id };
          if (bounded.fragments.length === 1) {
            consumed += 1;
            fragmentState = undefined;
          }
        } else {
          consumed += bounded.consumed;
        }
        if (bounded.checkpointID) {
          progress.checkpointedChunks += 1;
          progress.checkpointedMessages += bounded.consumed || 1;
        }
        if (!bounded.checkpointID) {
          progress.persistedPartialFragments += 1;
        }
        try {
          await logEvent(config, "v2_memory_update_committed", {
            sessionID,
            reason: "fresh_context",
            checkpointID: bounded.checkpointID,
          });
        } catch (error) {
          await safeLog(config, "v2_memory_update_error", {
            sessionID,
            reason: "operational_failure",
            detail: errorMessage(error),
          });
          return {
            status: "error",
            reason: "postcommit_logging_failure",
            detail: errorMessage(error),
            ...progress,
          };
        }
      }
      return { status: "committed", ...progress };
    } catch (error) {
      await safeLog(config ?? DEFAULT_CONFIG, "v2_memory_update_error", {
        sessionID,
        reason: "operational_failure",
        detail: errorMessage(error),
      });
      return {
        status: "error",
        reason: "operational_failure",
        detail: errorMessage(error),
        ...(rollback ? { rollback } : {}),
        ...progress,
      };
    } finally {
      release();
    }
  };
}
