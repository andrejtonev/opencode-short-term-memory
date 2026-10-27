import { expect, test } from "bun:test";
import { conversationDelta } from "../scripts/acceptance-memory-fixture.cjs";

test("acceptance reads the actual delta after tag mentions and retained injected memory", () => {
  const text =
    "Policy: <conversation_update> is a slice.\n<existing_memory>\n[MEMORY_SYSTEM] OLD\n</existing_memory>\n\n<conversation_update>\nUSER: NEW\n</conversation_update>";
  expect(conversationDelta({ messages: [{ role: "user", content: [{ type: "text", text }] }] })).toBe("USER: NEW");
});

test("acceptance rejects missing delta data instead of passing an empty exclusion assertion", () => {
  expect(() =>
    conversationDelta({ messages: [{ content: "<existing_memory> Policy mentions <conversation_update>" }] }),
  ).toThrow("no complete conversation data block");
});
