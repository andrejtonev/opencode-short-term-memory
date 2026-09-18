import type { Plugin } from "@opencode/plugin";

const legacyV1Server = async () => ({});

const dualRuntimeProof = {
  id: "opencode-short-term-memory-dual-proof",
  server: legacyV1Server,
  async setup(context) {
    const location = context.location;

    await context.session.hook("context", () => {
      void location;
    });

    await context.tool.transform((tools) => {
      tools.add({
        name: "stm_v2_proof",
        description: "Proves named V2 tool registration without STM behavior.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          return {
            title: "STM V2 proof",
            output: "fixture only",
            metadata: {},
          };
        },
      });
    });
  },
} satisfies Plugin.Plugin & { readonly server: typeof legacyV1Server };

export default dualRuntimeProof;
