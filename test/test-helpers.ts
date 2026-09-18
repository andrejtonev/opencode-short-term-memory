import { join } from "node:path";
import { rm } from "node:fs/promises";
import SessionMemoryPlugin from "../src/session-memory";
import { DEFAULT_CONFIG, INJECTION_PREFIX, writeText } from "../src/memory-utils";
import type { Client } from "../src/types";

type TestPlugin = Awaited<ReturnType<typeof SessionMemoryPlugin>>;

type FakeClient = {
  session: {
    create: (args?: unknown) => Promise<unknown>;
    messages: (args?: unknown) => Promise<unknown>;
    prompt: (args?: unknown) => Promise<unknown>;
    delete: (args?: unknown) => Promise<unknown>;
    list?: (args?: unknown) => Promise<unknown>;
    get?: (args?: unknown) => Promise<unknown>;
    abort?: (args?: unknown) => Promise<unknown>;
  };
  calls: {
    create: unknown[];
    messages: unknown[];
    prompt: unknown[];
    summarizerPrompts: unknown[];
    noReplyDeliveries: unknown[];
    delete: unknown[];
    list: unknown[];
    abort: unknown[];
  };
};

export function createFakeClient(options?: {
  messagesRows?: unknown[];
  promptText?: string;
  promptResponder?: (args?: unknown) => string | Promise<string>;
  promptShouldThrow?: boolean;
  noReplyFailures?: number;
  noReplyResolvedErrors?: number;
}) {
  const calls = {
    create: [] as unknown[],
    messages: [] as unknown[],
    prompt: [] as unknown[],
    summarizerPrompts: [] as unknown[],
    noReplyDeliveries: [] as unknown[],
    delete: [] as unknown[],
    list: [] as unknown[],
    abort: [] as unknown[],
  };

  const messagesRows = options?.messagesRows ?? [];
  const promptText = options?.promptText ?? "## Session Memory\n\n### User Instructions\n- updated from prompt";
  const promptResponder = options?.promptResponder;
  const promptShouldThrow = options?.promptShouldThrow ?? false;
  let noReplyFailures = Math.max(0, Math.trunc(options?.noReplyFailures ?? 0));
  let noReplyResolvedErrors = Math.max(0, Math.trunc(options?.noReplyResolvedErrors ?? 0));

  const client: FakeClient = {
    session: {
      create: async (args?: unknown) => {
        calls.create.push(args);
        return { data: { id: `side-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } };
      },
      messages: async (args?: unknown) => {
        calls.messages.push(args);
        const a = args as Record<string, unknown>;
        const limit = Number((a?.query as Record<string, unknown>)?.limit);
        if (!Number.isFinite(limit) || limit <= 0) {
          return { data: messagesRows };
        }
        return { data: messagesRows.slice(-Math.trunc(limit)) };
      },
      prompt: async (args?: unknown) => {
        calls.prompt.push(args);
        const body = (args as { body?: Record<string, unknown> } | undefined)?.body;
        const isSummarizerPrompt = typeof body?.system === "string";
        const isNoReplyDelivery = body?.noReply === true && !isSummarizerPrompt;
        if (isSummarizerPrompt) calls.summarizerPrompts.push(args);
        if (isNoReplyDelivery) calls.noReplyDeliveries.push(args);
        if (promptShouldThrow) {
          throw new Error("session.prompt is disabled for this test");
        }
        if (isNoReplyDelivery) {
          if (noReplyFailures > 0) {
            noReplyFailures -= 1;
            throw new Error("session.prompt noReply delivery failed for this test");
          }
          if (noReplyResolvedErrors > 0) {
            noReplyResolvedErrors -= 1;
            return { error: { name: "UnknownError", data: { message: "noReply delivery failed for this test" } } };
          }
          return { data: { parts: [] } };
        }
        const resolvedPromptText = promptResponder ? await promptResponder(args) : promptText;
        return {
          data: {
            info: { role: "assistant" },
            parts: [{ type: "text", text: resolvedPromptText }],
          },
        };
      },
      delete: async (args?: unknown) => {
        calls.delete.push(args);
        return { data: true };
      },
      list: async (args?: unknown) => {
        calls.list.push(args);
        return { data: [] };
      },
      abort: async (args?: unknown) => {
        calls.abort.push(args);
        return { data: true };
      },
    },
    calls,
  };

  return client;
}

export function extractTaggedChildSystemDeliveries(output?: { system?: unknown }): string[] {
  if (!Array.isArray(output?.system)) return [];
  return output.system.filter((item): item is string => typeof item === "string" && item.includes(INJECTION_PREFIX));
}

export async function createPlugin(configOverrides: Partial<typeof DEFAULT_CONFIG> = {}, client?: FakeClient) {
  const configPath = process.cwd().endsWith(".opencode") ? "stm.json" : join(".opencode", "stm.json");
  await writeText(configPath, JSON.stringify({ ...configOverrides }, null, 2));

  const resolvedClient = client ?? createFakeClient();
  const plugin = (await SessionMemoryPlugin({ client: resolvedClient as unknown as Client })) as TestPlugin;

  const cleanup = async () => {
    try {
      await rm(join(".opencode"), { recursive: true, force: true });
    } catch {}
    try {
      await rm("AGENTS.md", { force: true });
    } catch {}
  };

  return { plugin, client: resolvedClient, cleanup };
}
