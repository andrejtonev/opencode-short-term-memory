import { Model, Plugin, Provider } from "@opencode/plugin";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Usage } from "@ai-sdk/provider";

import {
  createProbeTelemetryWriter,
  normalizeV2Messages,
  type CallbackOperation,
  type OperationOutcome,
  type ProbeTelemetryWriter,
} from "./telemetry.js";

export const PROBE_PLUGIN_ID = "stm-v2-generation-probe";
export const PROBE_PROVIDER_ID = "stm-probe";
export const PROBE_MODEL_ID = "deterministic";
export const PROBE_GENERATE_SENTINEL = "STM_PROBE_GENERATE_SENTINEL";
export const PROBE_STREAM_SENTINEL = "STM_PROBE_STREAM_SENTINEL";
export const PROBE_MEMORY_SENTINEL = "STM_PROBE_MEMORY_SENTINEL";
export const PROBE_COMPACTION_SUMMARY = `## Objective
Preserve deterministic probe context across compaction.

## Requirements
Return the complete structured continuation summary.

## Decisions
Use the probe compaction summary sentinel.

## Work State

### Completed
Compaction prompt detection completed.

### Active
(none)

### Blocked
(none)

## Next Move
Continue from the compacted probe context.

## Relevant Files
fixtures/v2-generation-probe/index.ts

## Important Context
Ordinary generation sentinels remain unchanged.`;
export const PROBE_SESSION_PROMPT_SENTINEL = "STM_PROBE_SESSION_GENERATE_PROMPT";
export const PROBE_STANDALONE_PROMPT_SENTINEL = "STM_PROBE_STANDALONE_GENERATE_PROMPT";
export const PROBE_GENERATION_TIMEOUT_MS = 5_000;

const COMPACTION_TEMPLATE_HEADINGS = [
  "## Objective",
  "## Requirements",
  "## Decisions",
  "## Work State",
  "### Completed",
  "### Active",
  "### Blocked",
  "## Next Move",
  "## Relevant Files",
  "## Important Context",
] as const;

const MEMORY_UPDATE_PROMPT_MARKERS = [
  "You are a short‑term session memory processor for an OpenCode plugin.",
  "<conversation_update>",
  "### User Instructions",
  "### Long Horizon Context",
  "### Decisions",
  "### Conclusions",
  "### Active References",
] as const;

function isCompactionPrompt(options: LanguageModelV3CallOptions): boolean {
  try {
    const prompt = JSON.stringify(options.prompt);
    return COMPACTION_TEMPLATE_HEADINGS.every((heading) => prompt.includes(heading));
  } catch {
    return false;
  }
}

export function isMemoryUpdatePrompt(options: LanguageModelV3CallOptions): boolean {
  try {
    const prompt = JSON.stringify(options.prompt);
    return MEMORY_UPDATE_PROMPT_MARKERS.every((marker) => prompt.includes(marker));
  } catch {
    return false;
  }
}

export function memoryUpdateResponse(runId: string): string {
  return `## Session Memory

### User Instructions
- Preserve the deterministic production update probe.

### Long Horizon Context
- The production V2 updater generated this memory document.

### Decisions
- Use the clean summarizer path.

### Conclusions
- ${PROBE_MEMORY_SENTINEL}:${runId}

### Active References
- fixtures/v2-generation-probe/production-update-probe.ts
`;
}

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function availableFunctionToolNames(options: LanguageModelV3CallOptions): string[] {
  if (!Array.isArray(options.tools)) return [];
  return options.tools
    .flatMap((tool) => {
      if (tool.type !== "function" || typeof tool.name !== "string") return [];
      return [tool.name];
    })
    .sort();
}

class ProbeTimeoutError extends Error {
  constructor(operationId: string) {
    super(`${operationId} timed out after ${PROBE_GENERATION_TIMEOUT_MS}ms`);
    this.name = "ProbeTimeoutError";
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  return String(error);
}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(operationId: string, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(operationId)), PROBE_GENERATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function eventType(value: unknown): string {
  if (typeof value !== "object" || value === null || !("type" in value)) return "unknown";
  return typeof value.type === "string" ? value.type : "unknown";
}

async function emitSnapshots(writer: ProbeTelemetryWriter, messages: readonly unknown[]): Promise<void> {
  for (const message of normalizeV2Messages(messages)) {
    await writer.emit({ event: "message.snapshot", boundary: "during", ...message });
  }
}

const probe = {
  id: PROBE_PLUGIN_ID,
  async setup(context) {
    const writer = createProbeTelemetryWriter();
    const registrations: Array<{ readonly name: string; readonly dispose: () => Promise<void> }> = [];
    const eventController = new AbortController();
    let eventConsumer: Promise<void> | undefined;
    let eventFailurePresent = false;
    let eventFailure: unknown;
    let cleanupPromise: Promise<void> | undefined;
    let generationStarted = false;
    let modelInvocation = 0;
    const callbackState: Record<CallbackOperation, { count: number; depth: number; maxDepth: number }> = {
      context: { count: 0, depth: 0, maxDepth: 0 },
      generate: { count: 0, depth: 0, maxDepth: 0 },
      compaction: { count: 0, depth: 0, maxDepth: 0 },
    };

    const rememberFailure = (
      error: unknown,
      state: { present: boolean; value: unknown },
    ): { present: boolean; value: unknown } => (state.present ? state : { present: true, value: error });

    const cleanup = (): Promise<void> => {
      if (cleanupPromise !== undefined) return cleanupPromise;
      cleanupPromise = (async () => {
        let failure = { present: false, value: undefined as unknown };
        const attempt = async (operation: () => Promise<void>): Promise<void> => {
          try {
            await operation();
          } catch (error) {
            failure = rememberFailure(error, failure);
          }
        };

        await attempt(() => writer.emit({ event: "cleanup", details: { phase: "start" } }).then(() => undefined));
        eventController.abort();
        if (eventConsumer !== undefined) await attempt(() => eventConsumer!);
        if (eventFailurePresent) failure = rememberFailure(eventFailure, failure);

        for (const registration of [...registrations].reverse()) {
          await attempt(() =>
            writer.emit({ event: "disposal", details: { resource: registration.name } }).then(() => undefined),
          );
          await attempt(() => registration.dispose());
        }
        await attempt(() =>
          writer
            .emit({
              event: "cleanup",
              details: {
                phase: "complete",
                callbacks: callbackState,
              },
            })
            .then(() => undefined),
        );
        await attempt(() => writer.flush());
        await attempt(() => writer.dispose());
        if (failure.present) throw failure.value;
      })();
      return cleanupPromise;
    };

    const acquire = async (
      name: string,
      registration: Promise<{ readonly dispose: () => Promise<void> }>,
    ): Promise<void> => {
      const acquired = await registration;
      registrations.push({ name, dispose: acquired.dispose });
      await writer.emit({ event: "registration", name });
    };

    const runGeneration = async (operationId: string, operation: () => Promise<{ text: string }>): Promise<void> => {
      await writer.emit({ event: "operation.start", operation: "generate", operationId, source: "plugin" });
      try {
        const result = await withTimeout(operationId, operation());
        await writer.emit({
          event: "language-model",
          name: "operation.result",
          provider: PROBE_PROVIDER_ID,
          model: PROBE_MODEL_ID,
          details: { operationId, text: result.text },
        });
        await writer.emit({ event: "operation.success", operation: "generate", operationId, source: "plugin" });
      } catch (error) {
        const outcome = error instanceof ProbeTimeoutError ? "operation.timeout" : "operation.failure";
        await writer.emit({
          event: outcome,
          operation: "generate",
          operationId,
          source: "plugin",
          error: describeError(error),
        });
        throw error;
      }
    };

    const instrument = async (
      operation: CallbackOperation,
      messages: readonly unknown[],
      callback?: () => Promise<void>,
    ): Promise<void> => {
      const state = callbackState[operation];
      const invocationCount = ++state.count;
      const depth = ++state.depth;
      state.maxDepth = Math.max(state.maxDepth, depth);
      let outcome: OperationOutcome = "success";
      let failure: unknown;
      try {
        await writer.emit({ event: "callback.enter", operation, depth, invocationCount });
        await emitSnapshots(writer, messages);
        await callback?.();
      } catch (error) {
        outcome = error instanceof ProbeTimeoutError ? "timeout" : "failure";
        failure = error;
        throw error;
      } finally {
        try {
          await writer.emit({
            event: "callback.exit",
            operation,
            depth,
            invocationCount,
            outcome,
            ...(outcome === "success" ? {} : { error: describeError(failure) }),
          });
        } finally {
          state.depth--;
        }
      }
    };

    try {
      await writer.emit({ event: "setup", name: PROBE_PLUGIN_ID });

      const providerInfo: Provider.Info = {
        ...Provider.Info.empty(Provider.ID.make(PROBE_PROVIDER_ID)),
        package: "aisdk:@ai-sdk/cohere",
      };
      const modelInfo = Model.Info.default(providerInfo.id, Model.ID.make(PROBE_MODEL_ID));
      await acquire(
        "provider.transform",
        context.provider.transform((editor) => editor.add({ info: providerInfo, models: [modelInfo] })),
      );
      await writer.emit({
        event: "provider",
        provider: PROBE_PROVIDER_ID,
        model: PROBE_MODEL_ID,
      });

      await acquire(
        "aisdk.language",
        context.aisdk.hook(
          "language",
          (input) => {
            if (input.model.providerID !== providerInfo.id || input.model.id !== modelInfo.id) return;
            const language: LanguageModelV3 = {
              specificationVersion: "v3",
              provider: PROBE_PROVIDER_ID,
              modelId: PROBE_MODEL_ID,
              supportedUrls: {},
              async doGenerate(options) {
                const invocation = ++modelInvocation;
                const responseText = isCompactionPrompt(options)
                  ? PROBE_COMPACTION_SUMMARY
                  : isMemoryUpdatePrompt(options)
                    ? memoryUpdateResponse(writer.runId)
                    : PROBE_GENERATE_SENTINEL;
                await writer.emit({
                  event: "model.invocation",
                  provider: PROBE_PROVIDER_ID,
                  model: PROBE_MODEL_ID,
                  requestKind: "doGenerate",
                  invocation,
                  sentinel: responseText,
                  details: { toolNames: availableFunctionToolNames(options) },
                });
                return {
                  content: [{ type: "text", text: responseText }],
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: ZERO_USAGE,
                  warnings: [],
                };
              },
              async doStream(options) {
                const invocation = ++modelInvocation;
                const responseText = isCompactionPrompt(options)
                  ? PROBE_COMPACTION_SUMMARY
                  : isMemoryUpdatePrompt(options)
                    ? memoryUpdateResponse(writer.runId)
                    : PROBE_STREAM_SENTINEL;
                await writer.emit({
                  event: "model.invocation",
                  provider: PROBE_PROVIDER_ID,
                  model: PROBE_MODEL_ID,
                  requestKind: "doStream",
                  invocation,
                  sentinel: responseText,
                  details: { toolNames: availableFunctionToolNames(options) },
                });
                const textId = `stm-probe-text-${invocation}`;
                return {
                  stream: new ReadableStream({
                    start(controller) {
                      controller.enqueue({ type: "stream-start", warnings: [] });
                      controller.enqueue({ type: "text-start", id: textId });
                      controller.enqueue({ type: "text-delta", id: textId, delta: responseText });
                      controller.enqueue({ type: "text-end", id: textId });
                      controller.enqueue({
                        type: "finish",
                        usage: ZERO_USAGE,
                        finishReason: { unified: "stop", raw: "stop" },
                      });
                      controller.close();
                    },
                  }),
                };
              },
            };
            input.language = language;
          },
          { providerID: PROBE_PROVIDER_ID },
        ),
      );
      await writer.emit({
        event: "language-model",
        name: "deterministic-v3",
        provider: PROBE_PROVIDER_ID,
        model: PROBE_MODEL_ID,
      });

      await acquire(
        "session.context",
        context.session.hook("context", async (input) => {
          await instrument("context", input.messages, async () => {
            if (generationStarted) return;
            if (writer.mode === "session-generate") {
              generationStarted = true;
              const operationId = `${writer.runId}:session-generate`;
              await runGeneration(operationId, () =>
                context.session.generate({
                  sessionID: input.sessionID,
                  prompt: `${PROBE_SESSION_PROMPT_SENTINEL}:${writer.runId}`,
                }),
              );
            } else if (writer.mode === "standalone-generate") {
              generationStarted = true;
              const operationId = `${writer.runId}:standalone-generate`;
              await runGeneration(operationId, () =>
                context.generate.text({
                  prompt: `${PROBE_STANDALONE_PROMPT_SENTINEL}:${writer.runId}`,
                  model: { providerID: PROBE_PROVIDER_ID, id: PROBE_MODEL_ID },
                }),
              );
            }
          });
        }),
      );
      await acquire(
        "session.generate",
        context.session.hook("generate", (input) => instrument("generate", input.messages)),
      );
      await acquire(
        "session.compaction",
        context.session.hook("compaction", (input) => instrument("compaction", input.messages)),
      );
      await acquire(
        "session.model.request",
        context.session.hook("model.request", (input) =>
          writer
            .emit({
              event: "model.request",
              provider: input.model.providerID,
              model: input.model.id,
              requestKind: input.kind,
            })
            .then(() => undefined),
        ),
      );

      eventConsumer = (async () => {
        try {
          for await (const event of context.event.subscribe({ signal: eventController.signal })) {
            const observedEvent = eventType(event);
            const details =
              observedEvent === "session.compaction.failed" && isNonArrayObject(event) && isNonArrayObject(event.data)
                ? event.data
                : undefined;
            await writer.emit({
              event: "event.observed",
              observedEvent,
              ...(details === undefined ? {} : { details }),
            });
          }
        } catch (error) {
          if (eventController.signal.aborted) return;
          eventFailurePresent = true;
          eventFailure = error;
          try {
            await writer.emit({
              event: "event.observed",
              observedEvent: "consumer.error",
              details: { error: describeError(error) },
            });
          } catch {
            // Cleanup preserves the original event-consumer failure.
          }
        }
      })();
      await writer.emit({ event: "registration", name: "event.subscribe" });

      return cleanup;
    } catch (error) {
      try {
        await cleanup();
      } catch {
        // Setup must preserve its original failure after best-effort cleanup.
      }
      throw error;
    }
  },
} satisfies Plugin.Plugin;

export default probe;
