import { describe, expect, test } from "bun:test";
import { modelFreeLog, validateLogBaseline } from "./contract.js";

test("model-free log allowlist rejects generation, prompt, synthetic, tool and usage evidence", () => {
  expect(modelFreeLog([{ type: "session.created" }, { type: "session.viewed" }, { type: "log.synced" }])).toBe(true);
  for (const type of [
    "session.execution.started",
    "session.inbox.enqueued",
    "session.synthetic",
    "session.step.started",
    "session.tool.called",
    "session.usage.recorded",
    "unknown",
  ]) {
    expect(modelFreeLog([{ type }])).toBe(false);
  }
});

describe("session log baseline witness", () => {
  const created = {
    id: "session-a",
    projectID: "project-a",
    title: "isolated",
    location: { directory: "/isolated" },
    time: { created: 1_791_105_848_247 },
  };
  const marker = { type: "log.synced", aggregateID: created.id, seq: 0 };
  const event = (type: string, seq: number) => ({
    type,
    durable: { aggregateID: created.id, seq },
    data: { sessionID: created.id },
  });
  const validate = (log: Parameters<typeof validateLogBaseline>[0], session = created) =>
    validateLogBaseline(log, created, session, "/isolated");

  test("catalog creation plus matching marker-only replay is valid even at sequence zero", () => {
    expect(() => validate([marker])).not.toThrow();
    expect(() => validate([{ type: "log.synced", aggregateID: created.id }])).not.toThrow();
    // The watermark is not proof that event payloads were retained.
    expect(() => validate([{ ...marker, seq: 5 }])).not.toThrow();
    expect(() =>
      validate([event("session.viewed", 2), event("session.model.selected", 5), { ...marker, seq: 9 }]),
    ).not.toThrow();
  });

  test("missing, foreign, duplicated or nonterminal sync witnesses fail closed", () => {
    for (const log of [
      [],
      [event("session.created", 0)],
      [{ ...marker, aggregateID: "other" }],
      [marker, marker],
      [marker, event("session.viewed", 1)],
      [{ ...marker, seq: -1 }],
      [{ ...marker, seq: 0.5 }],
      [{ ...marker, seq: NaN }],
    ])
      expect(() => validate(log)).toThrow();
  });

  test("events require matching aggregate/session and increasing sequences within watermark", () => {
    const viewed = event("session.viewed", 1);
    for (const log of [
      [viewed, marker],
      [viewed, { type: "log.synced", aggregateID: created.id }],
      [
        { ...viewed, durable: undefined },
        { ...marker, seq: 2 },
      ],
      [
        { ...viewed, durable: { aggregateID: "other", seq: 1 } },
        { ...marker, seq: 2 },
      ],
      [
        { ...viewed, data: { sessionID: "other" } },
        { ...marker, seq: 2 },
      ],
      [event("session.viewed", -1), marker],
      [event("session.viewed", 0.5), marker],
      [viewed, viewed, { ...marker, seq: 2 }],
      [event("session.viewed", 2), viewed, { ...marker, seq: 2 }],
    ])
      expect(() => validate(log)).toThrow("aggregate or replay sequence");
  });

  test("valid replay envelopes do not excuse forbidden activity", () => {
    for (const type of [
      "session.inbox.enqueued",
      "session.execution.started",
      "session.synthetic",
      "session.step.started",
      "session.tool.called",
      "session.usage.recorded",
      "session.generate",
      "unknown",
    ]) {
      expect(() => validate([event(type, 0), marker])).toThrow("Unexpected durable session activity");
    }
  });

  test("marker-only replay cannot replace matching create/get catalog evidence", () => {
    for (const session of [
      { ...created, id: "other" },
      { ...created, projectID: "other" },
      { ...created, location: { directory: "/other" } },
      { ...created, title: "other" },
      { ...created, time: { created: created.time.created + 1 } },
    ])
      expect(() => validate([marker], session)).toThrow("catalog witness mismatch");
    expect(() => validateLogBaseline([marker], { ...created, time: { created: NaN } }, created, "/isolated")).toThrow();
    expect(() => validateLogBaseline([marker], created, created, "/other")).toThrow();
  });
});
