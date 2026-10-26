import type { V2SessionContext } from "../src/v2-adapter";

/** Model the native auxiliary generate-hook dispatch before provider invocation. */
export function createV2GenerateHookHarness() {
  const callbacks = new Set<(input: V2SessionContext) => void | Promise<void>>();
  return {
    async hook(name: string, callback: (input: V2SessionContext) => void | Promise<void>) {
      if (name === "generate") callbacks.add(callback);
      return {
        dispose: async () => {
          callbacks.delete(callback);
        },
      };
    },
    async dispatch(input: { sessionID: string; prompt: string }) {
      const request = {
        sessionID: input.sessionID,
        agent: "build",
        model: { providerID: "provider", id: "model" },
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
        options: {},
        tools: { stm_memory_update: { description: "Update", input: {} } },
      } as V2SessionContext;
      for (const callback of callbacks) await callback(request);
      return request;
    },
  };
}
