import { expect, test } from "bun:test";
import {
  conversationDelta,
  assertGeneratedMemoryInjection,
  assertOrdinaryConversationDelta,
  assertNativeSummarySystem,
} from "../scripts/acceptance-memory-fixture.cjs";

test("acceptance reads the actual delta after tag mentions and retained injected memory", () => {
  const text =
    "Policy: <conversation_update> is a slice.\n<existing_memory>\n[MEMORY_SYSTEM] OLD\n</existing_memory>\n\n<conversation_update>\nUSER: NEW\n</conversation_update>";
  expect(conversationDelta({ messages: [{ role: "user", content: [{ type: "text", text }] }] })).toBe("USER: NEW");
});

test("V2 acceptance rejects a replacement system instruction even when the fixture can generate memory", () => {
  const native = { role: "system", content: "Native OpenCode agent identity" };
  const ordinary = {
    messages: [{ role: "system", content: native.content + "\n\n# Your Model\nImplicit project instructions" }],
  };
  expect(() => assertNativeSummarySystem({ messages: [native] }, ordinary)).not.toThrow();
  expect(() =>
    assertNativeSummarySystem({ messages: [{ role: "system", content: "Generic memory summarizer" }] }, ordinary),
  ).toThrow("preserve only the first native");
  expect(() => assertNativeSummarySystem(ordinary, ordinary)).toThrow("preserve only the first native");
});

test("acceptance rejects missing delta data instead of passing an empty exclusion assertion", () => {
  expect(() =>
    conversationDelta({ messages: [{ content: "<existing_memory> Policy mentions <conversation_update>" }] }),
  ).toThrow("no complete conversation data block");
});

test("earlier chat instructions cannot stand in for an injected generated memory", () => {
  expect(() =>
    assertGeneratedMemoryInjection(
      { messages: [{ role: "user", content: "Remember ACCEPTANCE_FACT_OLD" }] },
      "message",
    ),
  ).toThrow("missing generated memory injection");
});

test("acceptance verifies the transport of generated memory independently of ordinary history", () => {
  const content = "[MEMORY_SYSTEM] ACCEPTANCE_MEMORY_LINE_000";
  const body = { messages: [{ role: "user", content }] };
  expect(() => assertGeneratedMemoryInjection(body, "message")).not.toThrow();
  expect(() => assertGeneratedMemoryInjection(body, "system")).toThrow("Wrong memory injection transport");
  expect(() => assertGeneratedMemoryInjection({ messages: [{ role: "system", content }] }, "system")).not.toThrow();
});

test.each(["message", "system"])("fresh fixed-%s acceptance rejects dual delivery", (mode) => {
  const content = "[MEMORY_SYSTEM] ACCEPTANCE_MEMORY_LINE_000";
  expect(() =>
    assertGeneratedMemoryInjection(
      {
        messages: [
          { role: "user", content },
          { role: "system", content },
        ],
      },
      mode,
    ),
  ).toThrow("Wrong memory injection transport");
});

test("summary provenance permits V1 user-only updates while rejecting summarizer recursion", () => {
  const body = (delta: string) => ({
    messages: [
      { content: `<existing_memory>\n</existing_memory>\n<conversation_update>\n${delta}\n</conversation_update>` },
    ],
  });
  expect(() =>
    assertOrdinaryConversationDelta(body("USER:\nRemember ACCEPTANCE_FACT_OLD for this conversation.")),
  ).not.toThrow();
  expect(() => assertOrdinaryConversationDelta(body("ASSISTANT:\nAcknowledged the user's instruction."))).not.toThrow();
  expect(() =>
    assertOrdinaryConversationDelta(body("ASSISTANT:\n## Session Memory\nACCEPTANCE_MEMORY_LINE_000")),
  ).toThrow("owned-summary content");
});
