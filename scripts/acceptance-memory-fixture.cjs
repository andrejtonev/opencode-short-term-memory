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

module.exports = { conversationDelta };
