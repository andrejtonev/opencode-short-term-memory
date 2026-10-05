import { expect, test } from "bun:test";
import type { CommandInvocation } from "@opencode/plugin/promise/command";
import { parseV2MemoryCommand, type V2MemoryCommandActions } from "../src/v2-memory-command";

const invocation = (text: string, sessionID = "ses_authoritative") =>
  ({ sessionID, prompt: { text } }) as CommandInvocation;
export function commandActions() {
  const calls: { action: string; sessionID: string; input?: unknown }[] = [];
  const actions = Object.fromEntries(
    ["show", "status", "logs", "settings", "update", "setup", "reset"].map((action) => [
      action,
      async (sessionID: string, input?: unknown) => {
        calls.push({ action, sessionID, input });
        return `${action} result`;
      },
    ]),
  ) as V2MemoryCommandActions;
  return { calls, actions };
}

test.each([
  "",
  "  ",
  "status",
  "STATUS",
  "show",
  "logs",
  "settings",
  "update",
  "setup confirm true",
  "RESET confirm true",
])("parses deferred action: %j", async (text) => {
  const { calls, actions } = commandActions();
  const request = parseV2MemoryCommand(invocation(text), actions);
  const action = text.trim().split(/\s+/)[0]?.toLowerCase() || "status";
  expect(calls).toEqual([]);
  expect(request.title).toBe(`STM ${action}`);
  expect(await request.run()).toBe(`${action} result`);
  expect(calls).toEqual([
    {
      action,
      sessionID: "ses_authoritative",
      input: action === "reset" || action === "setup" ? { confirm: true } : undefined,
    },
  ]);
});

test.each(["reset", "setup", "setup confirm false", "reset confirm TRUE", 'reset confirm "true"'])(
  "unconfirmed action renders guidance without mutation: %s",
  async (text) => {
    const { calls, actions } = commandActions();
    const request = parseV2MemoryCommand(invocation(text), actions);
    expect(request.mutating).toBe(false);
    expect(await request.run()).toContain("confirm true with exact literal confirmation");
    expect(calls).toEqual([]);
  },
);

test.each([
  "/stm status",
  "unknown",
  "status ses_other",
  "show extra",
  "update confirm true",
  "reset confirm true extra",
  "setup CONFIRM true",
  "setup true",
])("rejects invalid arguments: %s", (text) => {
  const { calls, actions } = commandActions();
  expect(() => parseV2MemoryCommand(invocation(text), actions)).toThrow();
  expect(calls).toEqual([]);
});

test("rejects invalid identity, missing prompt and attachments without actions", () => {
  const { calls, actions } = commandActions();
  for (const id of ["", " ", "../escape", "a/b"])
    expect(() => parseV2MemoryCommand(invocation("reset confirm true", id), actions)).toThrow("sessionID");
  expect(() => parseV2MemoryCommand({ sessionID: "s" } as CommandInvocation, actions)).toThrow("prompt");
  for (const key of ["files", "agents", "skills"]) {
    const input = invocation("setup confirm true");
    (input.prompt as unknown as Record<string, unknown>)[key] = [{}];
    expect(() => parseV2MemoryCommand(input, actions)).toThrow("attachments");
  }
  expect(calls).toEqual([]);
});
