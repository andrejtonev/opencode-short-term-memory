import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "esnext",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  bundle: true,
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "jsonc-parser"],
});
