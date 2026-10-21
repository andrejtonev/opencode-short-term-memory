type Message = { role: string; content: string | { type?: string; text?: string }[] };
export type KeyboardRequest = { index: number; summary?: boolean; messages: Message[] };

export function keyboardRequestsByTurn<T extends KeyboardRequest>(
  requests: readonly T[],
  prompts: readonly string[],
): T[][] {
  return prompts.map((prompt) =>
    requests.filter((request) => {
      if (request.summary) return false;
      const genuineUsers = request.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => part.text ?? "").join("\n"),
        )
        .filter((text) => !text.trimStart().startsWith("[MEMORY_SYSTEM]"));
      return genuineUsers.at(-1) === prompt;
    }),
  );
}
