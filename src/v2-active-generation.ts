import { randomUUID } from "node:crypto";
import type { V2Context } from "./v2-adapter";

/** Fence only this auxiliary request; other plugins share the generate hook. */
export async function generateV2ActiveMemory(
  context: V2Context,
  input: { sessionID: string; prompt: string },
  signal: AbortSignal,
): Promise<{ text: string }> {
  signal.throwIfAborted();
  const markedPrompt = `[STM_SUMMARY_REQUEST:${randomUUID()}]\n${input.prompt}`;
  let fenced = false;
  const registration = await context.session.hook("generate", (request) => {
    if (request.sessionID !== input.sessionID) return;
    const message = request.messages.at(-1);
    if (message?.role !== "user") return;
    const part = message.content.find((part) => part.type === "text" && part.text === markedPrompt);
    if (!part || part.type !== "text") return;
    signal.throwIfAborted();
    request.messages[request.messages.length - 1] = {
      ...message,
      content: message.content.map((value) => (value === part ? { ...part, text: input.prompt } : value)),
    };
    request.tools = {};
    fenced = true;
  });
  try {
    signal.throwIfAborted();
    const result = await context.session.generate({ ...input, prompt: markedPrompt }, { signal });
    // A host that does not invoke the hook cannot qualify text-only generation.
    if (!fenced) throw new Error("active_summary_fence_not_applied");
    return result;
  } finally {
    await registration.dispose();
  }
}
