import { describe, expect, test } from "bun:test";
import { readV2CurrentHistory, type V2CurrentHistoryContext, type V2CurrentModel } from "../src/v2-current-history";
import type { V2Context } from "../src/v2-adapter";

const model = { id: "gpt-test", providerID: "openai", variant: "fast" } as V2CurrentModel;
const user = (id: string, text = id) => ({ id, type: "user", text, time: { created: 1 } });
const assistant = (id: string, text: string, completed?: number) => ({
  id,
  type: "assistant",
  agent: "default",
  model,
  content: [
    { type: "text", text },
    { type: "reasoning", text: "hidden" },
    { type: "tool", id: "call", name: "read", state: { status: "streaming", input: "" }, time: { created: 1 } },
  ],
  time: completed === undefined ? { created: 1 } : { created: 1, completed },
});
const host = (records: unknown, sessionModel: unknown = model, sessionID = "s1") => {
  const calls: { method: string; input: unknown; options: { signal?: AbortSignal } }[] = [];
  return {
    calls,
    context: {
      session: {
        context: async (input: unknown, options: { signal?: AbortSignal }) => {
          calls.push({ method: "context", input, options });
          return records;
        },
        get: async (input: unknown, options: { signal?: AbortSignal }) => {
          calls.push({ method: "get", input, options });
          return { id: sessionID, model: sessionModel };
        },
      },
    } as V2CurrentHistoryContext,
  };
};

describe("readV2CurrentHistory", () => {
  test("accepts the actual host context type without invoking unrelated APIs", () => {
    const read: (context: V2Context) => ReturnType<typeof readV2CurrentHistory> = (context) =>
      readV2CurrentHistory(context, "s1");
    expect(typeof read).toBe("function");
  });

  test("projects settled visible text in raw order and preserves every pre-stop anchor", async () => {
    const settled = assistant("msg_a", "answer", 2);
    settled.content.push({ type: "text", text: " continued" });
    const h = host([
      user("msg_z", "  raw user text\n"),
      { id: "msg_system", type: "system", text: "excluded", time: { created: 1 } },
      settled,
      assistant("msg_empty", "", 2),
      { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 1 } },
    ]);
    expect(await readV2CurrentHistory(h.context, "s1")).toEqual({
      status: "ready",
      history: {
        source: "durable-visible-text",
        sessionID: "s1",
        model,
        messages: [
          { id: "msg_z", role: "user", content: [{ type: "text", text: "  raw user text\n" }] },
          { id: "msg_system", role: "tool", content: [] },
          { id: "msg_a", role: "assistant", content: [{ type: "text", text: "answer continued" }] },
          { id: "msg_empty", role: "tool", content: [] },
          { id: "msg_idle", role: "tool", content: [] },
        ],
      },
    });
    expect(h.calls.map(({ method, input }) => ({ method, input }))).toEqual([
      { method: "context", input: { sessionID: "s1" } },
      { method: "get", input: { sessionID: "s1" } },
    ]);
    expect(h.calls[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(h.calls[1].options.signal).toBe(h.calls[0].options.signal);
  });

  test("stops before unfinished assistant without reading later malformed records", async () => {
    expect(
      await readV2CurrentHistory(host([user("msg_u"), assistant("msg_pending", "partial"), null]).context, "s1"),
    ).toEqual({
      status: "ready",
      history: {
        source: "durable-visible-text",
        sessionID: "s1",
        model,
        stoppedBeforeMessageID: "msg_pending",
        messages: [{ id: "msg_u", role: "user", content: [{ type: "text", text: "msg_u" }] }],
      },
    });
  });

  test("fails closed for malformed host records and duplicate anchors", async () => {
    for (const records of [
      null,
      {},
      "not an array",
      [null],
      [{ ...user("msg_u"), id: "" }],
      [user("wrong_prefix")],
      [user("msg_u"), user("msg_u")],
      [{ ...user("msg_u"), text: 1 }],
      [{ ...user("msg_u"), time: undefined }],
      [{ ...user("msg_u"), type: undefined }],
      [{ ...user("msg_u"), type: "unknown" }],
      [{ id: "msg_tool", type: "tool", time: { created: 1 } }],
      [assistant("msg_a", "x", Number.NaN)],
      [{ ...assistant("msg_a", "x", 2), time: { created: 1, completed: null } }],
      [{ ...assistant("msg_a", "x", 2), content: [{ type: "text" }] }],
      [{ ...assistant("msg_a", "x", 2), content: [{ type: "reasoning" }] }],
      [{ ...assistant("msg_a", "x", 2), content: [{ type: "tool", id: "call" }] }],
      [{ ...assistant("msg_a", "x", 2), content: [{ type: "file", text: "x" }] }],
      [{ ...assistant("msg_a", "x", 2), content: null }],
    ]) {
      expect((await readV2CurrentHistory(host(records).context, "s1")).status).toBe("invalid-history");
    }
    expect((await readV2CurrentHistory(host([], model, "other").context, "s1")).status).toBe("invalid-history");
    const malformed = {
      session: { context: async () => [], get: async () => null },
    } as unknown as V2CurrentHistoryContext;
    expect(await readV2CurrentHistory(malformed, "s1")).toEqual({
      status: "invalid-history",
      sessionID: "s1",
      reason: "invalid_session_record",
    });
  });

  test("requires the current model and never falls back to historical assistant model", async () => {
    for (const unavailable of [
      null,
      {},
      { providerID: "openai", model: "legacy" },
      { ...model, id: "" },
      { ...model, providerID: "" },
      { ...model, variant: 1 },
    ]) {
      expect((await readV2CurrentHistory(host([assistant("msg_a", "x", 2)], unavailable).context, "s1")).status).toBe(
        "no-model",
      );
    }
    const current = { id: "new-model", providerID: "other-provider" };
    expect(await readV2CurrentHistory(host([assistant("msg_a", "x", 2)], current).context, "s1")).toMatchObject({
      status: "ready",
      history: { model: current },
    });
    expect(await readV2CurrentHistory(host([]).context, "s1")).toMatchObject({
      status: "ready",
      history: { messages: [] },
    });
  });

  test("preserves schema-known excluded anchors and rejects malformed required payloads", async () => {
    const records = [
      { type: "synthetic", text: "hidden" },
      { type: "skill", text: "hidden", skill: "skill", name: "name" },
      { type: "agent-switched", agent: "default" },
      { type: "model-switched", model },
      { type: "location-switched", location: { directory: "/tmp" } },
      { type: "shell", shellID: "shell", command: "pwd", status: "exited" },
      { type: "compaction", reason: "auto", status: "completed", summary: "summary", recent: "recent" },
    ].map((record, index) => ({ ...record, id: `msg_${index}`, time: { created: 1 } }));
    expect(await readV2CurrentHistory(host(records).context, "s1")).toMatchObject({
      status: "ready",
      history: { messages: records.map(({ id }) => ({ id, role: "tool", content: [] })) },
    });
    for (const record of records)
      expect(
        (await readV2CurrentHistory(host([{ id: record.id, type: record.type, time: record.time }]).context, "s1"))
          .status,
      ).toBe("invalid-history");
    const settled = {
      ...assistant("msg_tool", "visible", 2),
      content: [
        { type: "text", text: "visible" },
        {
          type: "tool",
          id: "call",
          name: "read",
          time: { created: 1, completed: 2 },
          state: { status: "completed", input: {}, content: [{ type: "text", text: "hidden result" }] },
        },
      ],
    };
    expect(await readV2CurrentHistory(host([settled]).context, "s1")).toMatchObject({
      status: "ready",
      history: { messages: [{ content: [{ type: "text", text: "visible" }] }] },
    });
    settled.content[1].state!.content = [];
    expect((await readV2CurrentHistory(host([settled]).context, "s1")).status).toBe("invalid-history");
  });

  test("rejects invalid inputs before host reads", async () => {
    const h = host([]);
    for (const id of ["", "bad/id", "   "])
      expect((await readV2CurrentHistory(h.context, id)).status).toBe("invalid-history");
    for (const timeout of [0, -1, 0.5, Number.NaN, Infinity, 2_147_483_648])
      expect(await readV2CurrentHistory(h.context, "s1", timeout)).toEqual({
        status: "error",
        sessionID: "s1",
        reason: "invalid_timeout",
      });
    expect(h.calls).toEqual([]);
  });

  test("bounds either operational read even when the host ignores cancellation", async () => {
    for (const method of ["context", "get"] as const) {
      let timeoutSignal: AbortSignal | undefined;
      const h = host([]);
      h.context.session[method] = async (_input: unknown, options?: { signal?: AbortSignal | null }) => {
        timeoutSignal = options?.signal ?? undefined;
        return await new Promise<never>(() => undefined);
      };
      expect((await readV2CurrentHistory(h.context, "s1", 5)).status).toBe("error");
      expect(timeoutSignal?.aborted).toBe(true);
    }
  });

  test("reports failures from either host read", async () => {
    for (const method of ["context", "get"] as const) {
      const h = host([]);
      h.context.session[method] = async () => {
        throw new Error("rejected");
      };
      expect(await readV2CurrentHistory(h.context, "s1")).toEqual({
        status: "error",
        sessionID: "s1",
        reason: "rejected",
      });
    }
  });
});
