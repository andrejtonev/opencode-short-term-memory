import type { Plugin } from "@opencode/plugin";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

function markHostSelection(marker: string) {
  const directory = process.env.STM_HOST_MARKER_DIR;
  if (directory) writeFileSync(join(directory, marker), `${marker}\n`);
}

const legacyV1Server = async () => {
  markHostSelection("server.marker");
  return {};
};

const dualRuntimeProof = {
  id: "opencode-short-term-memory-dual-proof",
  server: legacyV1Server,
  async setup(context) {
    markHostSelection("setup.marker");
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
