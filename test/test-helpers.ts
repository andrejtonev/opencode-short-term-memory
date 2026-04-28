import { join } from "node:path";
import { rm } from "node:fs/promises";
import SessionMemoryPlugin from "../src/session-memory";
import { DEFAULT_CONFIG, writeText } from "../src/memory-utils";
import type { Client } from "../src/types";

type TestPlugin = Awaited<ReturnType<typeof SessionMemoryPlugin>>;

type FakeClient = {
  session: {
    messages: (args?: unknown) => Promise<unknown>;
    prompt: (args?: unknown) => Promise<unknown>;
  };
  calls: {
    messages: unknown[];
    prompt: unknown[];
  };
};

export function createFakeClient(options?: {
  messagesRows?: unknown[];
  promptText?: string;
  promptResponder?: (args?: unknown) => string | Promise<string>;
  promptShouldThrow?: boolean;
}) {
  const calls = {
    messages: [] as unknown[],
    prompt: [] as unknown[],
  };

  const messagesRows = options?.messagesRows ?? [];
  const promptText = options?.promptText ?? "## Session Memory\n\n### User Instructions\n- updated from prompt";
  const promptResponder = options?.promptResponder;
  const promptShouldThrow = options?.promptShouldThrow ?? false;

  const client: FakeClient = {
    session: {
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
        if (promptShouldThrow) {
          throw new Error("session.prompt fallback is disabled for this test");
        }
        const resolvedPromptText = promptResponder ? await promptResponder(args) : promptText;
        return { data: { parts: [{ type: "text", text: resolvedPromptText }] } };
      },
    },
    calls,
  };

  return client;
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
