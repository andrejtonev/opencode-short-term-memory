import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "index.ts", tui: "src/tui.ts", rpc: "src/v2-status-output.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "esnext",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  bundle: true,
  external: ["@opencode/plugin", "@opencode-ai/plugin", "@opencode-ai/sdk", "jsonc-parser"],
});
