import { Model, Plugin, Provider } from "@opencode/plugin";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Usage } from "@ai-sdk/provider";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MANUAL_FIRST_PROMPT, MANUAL_SECOND_PROMPT, MANUAL_CALL_IDS } from "./manual-evidence.js";
import { DIAGNOSTICS_CALLS, DIAGNOSTICS_PROMPT } from "./diagnostics-evidence.js";
import { SETUP_CALLS, SETUP_TOOL, expectedSetupResult, type SetupSnapshot } from "./setup-evidence.js";

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
const RESET_TOOL_NAME = "stm_memory_reset";
const RESET_PROMPT_MARKER = "Use stm_memory_reset to reset this session. Confirm only after the first refusal.";
const RESET_REFUSAL_CALL_ID = "stm-probe-reset-refusal";
const RESET_CONFIRMED_CALL_ID = "stm-probe-reset-confirmed";

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

async function resetExecutionEvidence(event: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = event;
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
  const memoryDir = Bun.env.PROBE_MEMORY_DIR;
  if (sessionID === undefined || memoryDir === undefined) return { eventData: data };
  if (Bun.env.PROBE_SCENARIO === "setup")
    return {
      eventData: data,
      setupSnapshot: await captureSetupSnapshot(
        Bun.env.PROBE_PROJECT_CONFIG_PATH!,
        memoryDir,
        Bun.env.PROBE_PRODUCTION_ACCESS_PATH!,
      ),
    };
  const safe = sessionID.replace(/[^A-Za-z0-9._-]/g, "_");
  const read = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    eventData: data,
    memory: await read(join(memoryDir, `session_${safe}.md`)),
    checkpoint: await read(join(memoryDir, "checkpoints", `${safe}.last-message-id.txt`)),
    boundary: await read(join(memoryDir, "reset-boundaries", `${safe}.json`)),
    ...(DIAGNOSTICS_CALLS.some((call) => call.tool === data.tool)
      ? {
          diagnosticsFiles: Object.fromEntries(
            await Promise.all(
              [
                ["memory", join(memoryDir, `session_${safe}.md`)],
                ["checkpoint", join(memoryDir, "checkpoints", `${safe}.last-message-id.txt`)],
                ["boundary", join(memoryDir, "reset-boundaries", `${safe}.json`)],
                ["log", join(memoryDir, "session-memory.log")],
                ["projectConfig", Bun.env.PROBE_PROJECT_CONFIG_PATH!],
              ].map(async ([key, path]) => {
                try {
                  return [key, (await readFile(path!)).toString("base64")];
                } catch (error) {
                  if (error instanceof Error && "code" in error && error.code === "ENOENT") return [key, null];
                  throw error;
                }
              }),
            ),
          ),
          productionAccess: JSON.parse(await readFile(Bun.env.PROBE_PRODUCTION_ACCESS_PATH!, "utf8")),
        }
      : {}),
  };
}

export async function captureSetupSnapshot(
  configPath: string,
  memoryDir: string,
  accessPath: string,
): Promise<SetupSnapshot> {
  const read = async (path: string): Promise<string | null> => {
    try {
      return (await readFile(path)).toString("base64");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  };
  const project = dirname(dirname(configPath));
  const memoryFiles: Record<string, string | null> = {};
  const tree = async (path: string): Promise<void> => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      memoryFiles[`${path}/`] = Buffer.from("directory").toString("base64");
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await tree(child);
        else memoryFiles[child] = await read(child);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") memoryFiles[`${path}/`] = null;
      else throw error;
    }
  };
  await tree(memoryDir);
  await tree(join(project, ".opencode", "memory"));
  const refs = [
    join(project, "opencode.json"),
    join(project, "AGENTS.md"),
    join(project, ".opencode", "AGENTS.md"),
    ...["stm.jsonc", "stm.json"].map((name) => join(dirname(dirname(accessPath)), "xdg-config", "opencode", name)),
  ];
  return {
    configs: { jsonc: await read(configPath), json: await read(join(dirname(configPath), "stm.json")) },
    memoryFiles,
    readOnlyRefs: Object.fromEntries(await Promise.all(refs.map(async (path) => [path, await read(path)]))),
    productionAccess: JSON.parse(await readFile(accessPath, "utf8")),
  };
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

function pairedToolResults(options: LanguageModelV3CallOptions, toolName: string): Map<string, string> {
  const knownCallIDs = new Set<string>();
  const toolResults = new Map<string, string>();
  const outputText = (output: unknown): string | undefined => {
    if (!isNonArrayObject(output) || typeof output.type !== "string") return undefined;
    if ((output.type === "text" || output.type === "error-text") && typeof output.value === "string")
      return output.value;
    if (output.type === "content" && Array.isArray(output.value)) {
      const text = output.value
        .filter((part): part is Record<string, unknown> => isNonArrayObject(part) && part.type === "text")
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
      return text === "" ? undefined : text;
    }
    return undefined;
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNonArrayObject(value)) return;
    if (value.role === "assistant" && Array.isArray(value.content)) {
      for (const part of value.content) {
        if (
          isNonArrayObject(part) &&
          part.type === "tool-call" &&
          part.toolName === toolName &&
          typeof part.toolCallId === "string"
        )
          knownCallIDs.add(part.toolCallId);
      }
    }
    if (value.role === "tool" && Array.isArray(value.content)) {
      for (const part of value.content) {
        if (
          isNonArrayObject(part) &&
          part.type === "tool-result" &&
          part.toolName === toolName &&
          typeof part.toolCallId === "string"
        ) {
          const text = outputText(part.output);
          if (text !== undefined) toolResults.set(part.toolCallId, text);
        }
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(options.prompt);
  return new Map([...toolResults].filter(([callID]) => knownCallIDs.has(callID)));
}

export function resetToolCallPhase(options: LanguageModelV3CallOptions): 0 | 1 | 2 {
  const resultLines = (result: string): Set<string> =>
    new Set(
      result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
  const results = [...pairedToolResults(options, RESET_TOOL_NAME)];
  if (
    results.some(
      ([callID, result]) => callID === RESET_CONFIRMED_CALL_ID && resultLines(result).has("reset: completed"),
    )
  )
    return 2;
  if (
    results.some(
      ([callID, result]) =>
        callID === RESET_REFUSAL_CALL_ID &&
        [...resultLines(result)].some((line) => line.startsWith("Refused to reset V2 short-term memory:")),
    )
  )
    return 1;
  return 0;
}

function isResetToolRequest(options: LanguageModelV3CallOptions): boolean {
  return (
    (Bun.env.PROBE_SCENARIO === "reset" || Bun.env.PROBE_SCENARIO === "manual-update") &&
    availableFunctionToolNames(options).includes(RESET_TOOL_NAME) &&
    (Bun.env.PROBE_SCENARIO === "reset"
      ? JSON.stringify(options.prompt).includes(RESET_PROMPT_MARKER)
      : primaryMarker(options) === RESET_PROMPT_MARKER)
  );
}

function primaryMarker(options: LanguageModelV3CallOptions): string | undefined {
  if (isMemoryUpdatePrompt(options) || isCompactionPrompt(options)) return undefined;
  const users = options.prompt.filter((message) => message.role === "user");
  const content = users.at(-1)?.content;
  if (!Array.isArray(content) || content.some((part) => part.type !== "text")) return undefined;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export function manualToolDispatch(
  options: LanguageModelV3CallOptions,
): { callID: string; completed: boolean } | undefined {
  if (!availableFunctionToolNames(options).includes("stm_memory_update")) return undefined;
  const marker = primaryMarker(options);
  const callID =
    marker === MANUAL_FIRST_PROMPT
      ? MANUAL_CALL_IDS[0]
      : marker === MANUAL_SECOND_PROMPT
        ? MANUAL_CALL_IDS[1]
        : undefined;
  if (callID === undefined) return undefined;
  const result = pairedToolResults(options, "stm_memory_update").get(callID);
  return { callID, completed: result?.split(/\r?\n/).includes("update: committed") === true };
}

export function diagnosticsToolDispatch(options: LanguageModelV3CallOptions) {
  if (
    primaryMarker(options) !== DIAGNOSTICS_PROMPT ||
    !DIAGNOSTICS_CALLS.every((call) => availableFunctionToolNames(options).includes(call.tool))
  )
    return undefined;
  for (const call of DIAGNOSTICS_CALLS) {
    if (!pairedToolResults(options, call.tool).has(call.id)) return call;
  }
  return undefined;
}

export function setupToolDispatch(options: LanguageModelV3CallOptions) {
  if (!availableFunctionToolNames(options).includes(SETUP_TOOL)) return undefined;
  const index = SETUP_CALLS.findIndex((call) => call.prompt === primaryMarker(options));
  if (index < 0) return undefined;
  const call = SETUP_CALLS[index]!;
  const result = pairedToolResults(options, SETUP_TOOL).get(call.id);
  // Completion comes only from the matching SDK call/result, never user text.
  const configPath = Bun.env.PROBE_PROJECT_CONFIG_PATH;
  return { ...call, completed: configPath !== undefined && result === expectedSetupResult(index, configPath) };
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
    let latestRequestKind = "";
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
                  details: {
                    toolNames: availableFunctionToolNames(options),
                    ...(Bun.env.PROBE_SCENARIO === "reset" ||
                    Bun.env.PROBE_SCENARIO === "manual-update" ||
                    Bun.env.PROBE_SCENARIO === "setup"
                      ? { prompt: JSON.stringify(options.prompt) }
                      : {}),
                  },
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
                    : undefined;
                const resetPhase = isResetToolRequest(options) ? resetToolCallPhase(options) : 2;
                const manual = Bun.env.PROBE_SCENARIO === "manual-update" ? manualToolDispatch(options) : undefined;
                const diagnostic =
                  Bun.env.PROBE_SCENARIO === "manual-update" ? diagnosticsToolDispatch(options) : undefined;
                const setup =
                  Bun.env.PROBE_SCENARIO === "setup" && latestRequestKind === "primary"
                    ? setupToolDispatch(options)
                    : undefined;
                if (responseText === undefined && setup !== undefined && !setup.completed) {
                  await writer.emit({
                    event: "model.invocation",
                    provider: PROBE_PROVIDER_ID,
                    model: PROBE_MODEL_ID,
                    requestKind: "doStream",
                    invocation,
                    sentinel: `${SETUP_TOOL}:${JSON.stringify(setup.input)}`,
                    details: {
                      toolNames: availableFunctionToolNames(options),
                      primaryPrompt: primaryMarker(options),
                      toolCall: { toolCallId: setup.id, toolName: SETUP_TOOL, input: setup.input },
                    },
                  });
                  return {
                    stream: new ReadableStream({
                      start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({
                          type: "tool-call",
                          toolCallId: setup.id,
                          toolName: SETUP_TOOL,
                          input: JSON.stringify(setup.input),
                        });
                        controller.enqueue({
                          type: "finish",
                          usage: ZERO_USAGE,
                          finishReason: { unified: "tool-calls", raw: "tool-calls" },
                        });
                        controller.close();
                      },
                    }),
                  };
                }
                if (responseText === undefined && diagnostic !== undefined) {
                  await writer.emit({
                    event: "model.invocation",
                    provider: PROBE_PROVIDER_ID,
                    model: PROBE_MODEL_ID,
                    requestKind: "doStream",
                    invocation,
                    sentinel: `${diagnostic.tool}:{}`,
                    details: {
                      toolNames: availableFunctionToolNames(options),
                      primaryPrompt: primaryMarker(options),
                      toolCall: { toolCallId: diagnostic.id, toolName: diagnostic.tool, input: {} },
                    },
                  });
                  return {
                    stream: new ReadableStream({
                      start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({
                          type: "tool-call",
                          toolCallId: diagnostic.id,
                          toolName: diagnostic.tool,
                          input: "{}",
                        });
                        controller.enqueue({
                          type: "finish",
                          usage: ZERO_USAGE,
                          finishReason: { unified: "tool-calls", raw: "tool-calls" },
                        });
                        controller.close();
                      },
                    }),
                  };
                }
                if (responseText === undefined && manual !== undefined && !manual.completed) {
                  await writer.emit({
                    event: "model.invocation",
                    provider: PROBE_PROVIDER_ID,
                    model: PROBE_MODEL_ID,
                    requestKind: "doStream",
                    invocation,
                    sentinel: "stm_memory_update:{}",
                    details: {
                      toolNames: availableFunctionToolNames(options),
                      toolCall: { toolCallId: manual.callID, toolName: "stm_memory_update", input: {} },
                    },
                  });
                  return {
                    stream: new ReadableStream({
                      start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({
                          type: "tool-call",
                          toolCallId: manual.callID,
                          toolName: "stm_memory_update",
                          input: "{}",
                        });
                        controller.enqueue({
                          type: "finish",
                          usage: ZERO_USAGE,
                          finishReason: { unified: "tool-calls", raw: "tool-calls" },
                        });
                        controller.close();
                      },
                    }),
                  };
                }
                if (responseText === undefined && isResetToolRequest(options) && resetPhase < 2) {
                  const confirm = resetPhase === 1;
                  const toolCallId = confirm ? "stm-probe-reset-confirmed" : "stm-probe-reset-refusal";
                  await writer.emit({
                    event: "model.invocation",
                    provider: PROBE_PROVIDER_ID,
                    model: PROBE_MODEL_ID,
                    requestKind: "doStream",
                    invocation,
                    sentinel: `${RESET_TOOL_NAME}:${String(confirm)}`,
                    details: {
                      toolNames: availableFunctionToolNames(options),
                      toolCall: { toolCallId, toolName: RESET_TOOL_NAME, input: { confirm } },
                    },
                  });
                  return {
                    stream: new ReadableStream({
                      start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({
                          type: "tool-call",
                          toolCallId,
                          toolName: RESET_TOOL_NAME,
                          input: JSON.stringify({ confirm }),
                        });
                        controller.enqueue({
                          type: "finish",
                          usage: ZERO_USAGE,
                          finishReason: { unified: "tool-calls", raw: "tool-calls" },
                        });
                        controller.close();
                      },
                    }),
                  };
                }
                const text = responseText ?? PROBE_STREAM_SENTINEL;
                await writer.emit({
                  event: "model.invocation",
                  provider: PROBE_PROVIDER_ID,
                  model: PROBE_MODEL_ID,
                  requestKind: "doStream",
                  invocation,
                  sentinel: text,
                  details: {
                    toolNames: availableFunctionToolNames(options),
                    ...(Bun.env.PROBE_SCENARIO === "reset" ||
                    Bun.env.PROBE_SCENARIO === "manual-update" ||
                    Bun.env.PROBE_SCENARIO === "setup"
                      ? { prompt: JSON.stringify(options.prompt) }
                      : {}),
                  },
                });
                const textId = `stm-probe-text-${invocation}`;
                return {
                  stream: new ReadableStream({
                    start(controller) {
                      controller.enqueue({ type: "stream-start", warnings: [] });
                      controller.enqueue({ type: "text-start", id: textId });
                      controller.enqueue({ type: "text-delta", id: textId, delta: text });
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
        context.session.hook("model.request", (input) => {
          latestRequestKind = input.kind;
          return writer
            .emit({
              event: "model.request",
              provider: input.model.providerID,
              model: input.model.id,
              requestKind: input.kind,
            })
            .then(() => undefined);
        }),
      );

      if (Bun.env.PROBE_SCENARIO === "manual-update") {
        await writer.emit({
          event: "event.observed",
          observedEvent: "manual.automatic-context-suppression",
          details: { scope: "production.session.context", strategy: "registered-no-op" },
        });
      }
      if (Bun.env.PROBE_SCENARIO === "setup") {
        await writer.emit({
          event: "event.observed",
          observedEvent: "setup.automatic-context-suppression",
          details: { scope: "production.session.context", strategy: "registered-no-op" },
        });
      }
      if (
        Bun.env.PROBE_SCENARIO === "reset" ||
        Bun.env.PROBE_SCENARIO === "manual-update" ||
        Bun.env.PROBE_SCENARIO === "setup"
      ) {
        await acquire(
          "tool.execute.before",
          context.tool.hook("execute.before", async (input) => {
            await writer.emit({
              event: "event.observed",
              observedEvent: "tool.execute.before",
              details: {
                ...(await resetExecutionEvidence({ ...input, snapshotPhase: "before" })),
                ...(Bun.env.PROBE_SCENARIO === "manual-update" &&
                (input.tool === "stm_memory_update" || input.tool === RESET_TOOL_NAME)
                  ? {
                      hostHistory: await context.session.context({ sessionID: input.sessionID }),
                      hostSession: await context.session.get({ sessionID: input.sessionID }),
                    }
                  : {}),
              },
            });
          }),
        );
        await acquire(
          "tool.execute.after",
          context.tool.hook("execute.after", async (input) => {
            await writer.emit({
              event: "event.observed",
              observedEvent: "tool.execute.after",
              details: {
                ...(await resetExecutionEvidence({ ...input, snapshotPhase: "after" })),
                ...(Bun.env.PROBE_SCENARIO === "manual-update" &&
                (input.tool === "stm_memory_update" || input.tool === RESET_TOOL_NAME)
                  ? {
                      hostHistory: await context.session.context({ sessionID: input.sessionID }),
                      hostSession: await context.session.get({ sessionID: input.sessionID }),
                    }
                  : {}),
              },
            });
          }),
        );
      }

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
