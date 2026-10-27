import { randomUUID } from "node:crypto";
import type { V2Context } from "./v2-adapter";
import { generateV2ActiveOverrideMemory, type V2NativeGenerationModel } from "./v2-native-generation";

/** Fence only this auxiliary request; other plugins share the generate hook. */
export async function generateV2ActiveMemory(
  context: V2Context,
  input: { sessionID: string; prompt: string; model?: V2NativeGenerationModel },
  signal: AbortSignal,
): Promise<{ text: string }> {
  signal.throwIfAborted();
  if (input.model) return generateV2ActiveOverrideMemory(context, { ...input, model: input.model }, signal);

  const markedPrompt = `[STM_SUMMARY_REQUEST:${randomUUID()}]\n${input.prompt}`;
  let fenced = false;
  const registration = await context.session.hook("generate", (request) => {
    if (request.sessionID !== input.sessionID) return;
    const message = request.messages.at(-1);
    if (message?.role !== "user") return;
    const part = message.content.find((value) => value.type === "text" && value.text === markedPrompt);
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
    const result = await context.session.generate({ sessionID: input.sessionID, prompt: markedPrompt }, { signal });
    // A host that does not invoke the hook cannot qualify text-only generation.
    if (!fenced) throw new Error("active_summary_fence_not_applied");
    return result;
  } finally {
    await registration.dispose();
  }
}
