const assert = require("node:assert/strict");

// Inspect the supplied data block, not policy text mentioning the same tags.
function conversationDelta(body) {
  const parts = body.messages.flatMap((message) =>
    typeof message.content === "string" ? [message.content] : (message.content ?? []).map((part) => part.text ?? ""),
  );
  const prompt = parts.findLast((text) => text.includes("<existing_memory>"));
  const match = /(?:^|\n)<conversation_update>\r?\n([\s\S]*)\r?\n<\/conversation_update>\s*$/.exec(prompt ?? "");
  assert.ok(match, "Summary request has no complete conversation data block");
  return match[1];
}

function assertGeneratedMemoryInjection(body, mode) {
  // The original user instruction is already in chat history. Only generated
  // text plus the STM marker proves that saved memory was actually injected.
  const injected = body.messages.filter((message) => {
    const content = JSON.stringify(message.content);
    return content.includes("[MEMORY_SYSTEM]") && content.includes("ACCEPTANCE_MEMORY_LINE_000");
  });
  assert.ok(injected.length, "Primary request missing generated memory injection");
  assert.equal(
    injected.every((message) => message.role === (mode === "system" ? "system" : "user")),
    true,
    "Wrong memory injection transport",
  );
  if (mode === "message")
    assert.ok(
      injected.some((message) => message.role === "user"),
      "Memory was not delivered as a session message",
    );
}

function assertOrdinaryConversationDelta(body) {
  const users = new Set([
    "Remember ACCEPTANCE_FACT_OLD for this conversation.",
    "Continue using the remembered instruction.",
    "Remember ACCEPTANCE_PENDING while the background memory update is held.",
    "Remember ACCEPTANCE_FACT_NEW after the reset.",
  ]);
  for (const block of conversationDelta(body).split("\n\n---\n\n")) {
    const message = /^(USER|ASSISTANT):\n([\s\S]+)$/.exec(block.trim());
    assert.ok(message, "Summary delta contains an unexpected message format");
    assert.ok(
      message[1] === "USER" ? users.has(message[2]) : message[2] === "Acknowledged the user's instruction.",
      "Summary delta contains injected memory or owned-summary content",
    );
  }
}

function assertNativeSummarySystem(body, ordinaryBody) {
  const nativeSystem = ordinaryBody.messages.find((message) => message.role === "system");
  assert.ok(nativeSystem, "Ordinary native request has no agent identity to compare");
  const systems = body.messages.filter((message) => message.role === "system");
  // OpenCode 2.0.32 combines its agent and initial model/project parts into
  // one wire message. Compare the native agent prefix, before the model block.
  const boundary = "\n# Your Model\n";
  assert.ok(
    nativeSystem.content.includes(boundary),
    "Native agent/model boundary not found; requalify host wire format",
  );
  const expected = nativeSystem.content.slice(0, nativeSystem.content.indexOf(boundary)).trimEnd();
  assert.ok(expected, "Empty native agent identity");
  assert.equal(systems.length, 1, "Summary must preserve only the first native agent system instruction");
  assert.equal(
    systems[0].content.trimEnd(),
    expected,
    "Summary must preserve only the first native agent system instruction",
  );
}

module.exports = {
  conversationDelta,
  assertGeneratedMemoryInjection,
  assertOrdinaryConversationDelta,
  assertNativeSummarySystem,
};
