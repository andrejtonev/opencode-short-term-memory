import { expect, test } from "bun:test";
import { parseV2MemoryAction, type V2MemoryCommandActions } from "../src/v2-memory-command";

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

const actionRequest = (action: string, overrides: Record<string, unknown> = {}) => ({
  requestID: "request_1",
  sessionID: "ses_authoritative",
  action,
  ...(action === "reset" || action === "setup" ? { confirm: true } : {}),
  ...overrides,
});

test.each(["show", "status", "logs", "settings", "update", "setup", "reset"])(
  "parses one admitted menu action without running it: %s",
  async (action) => {
    const { calls, actions } = commandActions();
    const request = parseV2MemoryAction(actionRequest(action), actions);
    expect(calls).toEqual([]);
    expect(request).toMatchObject({
      requestID: "request_1",
      sessionID: "ses_authoritative",
      title: `STM ${action}`,
      mutating: action === "update" || action === "reset" || action === "setup",
    });
    expect(await request.run()).toBe(`${action} result`);
    expect(calls).toEqual([
      {
        action,
        sessionID: "ses_authoritative",
        input: action === "reset" || action === "setup" ? { confirm: true } : undefined,
      },
    ]);
  },
);

test.each(["reset", "setup"])("requires literal confirmation for %s before admission", (action) => {
  const { calls, actions } = commandActions();
  for (const confirm of [undefined, false]) {
    expect(() => parseV2MemoryAction(actionRequest(action, { confirm }), actions)).toThrow("Explicit confirmation");
  }
  for (const confirm of ["true", 1]) {
    expect(() => parseV2MemoryAction(actionRequest(action, { confirm }), actions)).toThrow("must be a boolean");
  }
  expect(calls).toEqual([]);
});

test.each([
  { requestID: "../escape" },
  { requestID: "" },
  { sessionID: "" },
  { sessionID: "../escape" },
  { sessionID: "a/b" },
  { action: "unknown" },
  { confirm: "true" },
])("rejects malformed action requests before running an action: %j", (overrides) => {
  const { calls, actions } = commandActions();
  expect(() => parseV2MemoryAction(actionRequest("show", overrides), actions)).toThrow();
  expect(calls).toEqual([]);
});
