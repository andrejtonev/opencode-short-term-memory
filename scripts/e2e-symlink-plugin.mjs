#!/usr/bin/env node
// Symlink the opencode-short-term-memory plugin source into the user-supplied
// $XDG_CONFIG_HOME/opencode/plugins/ directory. This is the e2e harness's
// "use the local version" path: opencode discovers the symlink, bun loads
// the TS source directly, and the temp XDG dir is thrown away with the
// project dir at the end of the test run. No global config pollution.
//
// Usage:  node scripts/e2e-symlink-plugin.mjs <xdg-config-home> <plugin-source>
// Exits 0 on success, 1 if the symlink already exists (caller decides).

import { mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const xdgHome = process.argv[2];
const source = process.argv[3];
if (!xdgHome || !source) {
  console.error("usage: e2e-symlink-plugin.mjs <xdg-config-home> <plugin-source>");
  process.exit(2);
}

const target = resolve(source);
const pluginsDir = join(xdgHome, "opencode", "plugins");
const linkPath = join(pluginsDir, "opencode-short-term-memory.ts");

mkdirSync(dirname(pluginsDir), { recursive: true });
mkdirSync(pluginsDir, { recursive: true });

if (existsSync(linkPath)) {
  try {
    rmSync(linkPath);
  } catch (err) {
    console.error(`Failed to remove existing symlink: ${err.message}`);
    process.exit(1);
  }
}

try {
  symlinkSync(target, linkPath);
  console.log(`Symlinked: ${linkPath} -> ${target}`);
} catch (err) {
  console.error(`Failed to create symlink: ${err.message}`);
  process.exit(1);
}
