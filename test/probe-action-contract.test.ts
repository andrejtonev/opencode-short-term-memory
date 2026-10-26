import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createV2MemoryActions } from "../src/v2-memory-tools";
import type { V2Context } from "../src/v2-adapter";
import { expectedDiagnosticsSettings } from "../fixtures/v2-generation-probe/diagnostics-evidence";
import { SETUP_CAVEAT } from "../fixtures/v2-generation-probe/setup-evidence";

test("maintained probe oracle matches real public settings and path-only Logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stm-probe-contract-"));
  try {
    const memoryDir = join(directory, "memory");
    const expected = expectedDiagnosticsSettings(memoryDir);
    await mkdir(join(directory, ".opencode"));
    await writeFile(join(directory, ".opencode", "stm.json"), JSON.stringify(expected.resolvedConfig));
    const actions = createV2MemoryActions({ location: { directory } } as V2Context);
    expect(JSON.parse(await actions.settings(""))).toEqual(expected);
    expect(await actions.logs("")).toBe(join(memoryDir, "session-memory.log"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maintained setup oracle describes the actual clean override contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stm-probe-setup-contract-"));
  try {
    const actions = createV2MemoryActions({ location: { directory } } as V2Context);
    expect(await actions.setup("", { confirm: true })).toContain(SETUP_CAVEAT);
    expect(SETUP_CAVEAT).toContain("explicit memoryModel overrides apply to clean mode");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
