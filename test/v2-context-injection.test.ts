import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionCompaction } from "@opencode/plugin/promise/session";
import { buildTaggedMemoryForInjection } from "../src/injection";
import {
  DEFAULT_CONFIG,
  INJECTION_PREFIX,
  MEMORY_FORMAT_VERSION,
  MEMORY_HEADER,
  logPath,
  memoryPathFor,
  readText,
  writeText,
} from "../src/memory-utils";
import type { V2SessionContext } from "../src/v2-adapter";
import { createV2ContextInjection } from "../src/v2-context-injection";

function sessionContext(sessionID: string, system: V2SessionContext["system"] = []): V2SessionContext {
  return {
    sessionID,
    agent: "test-agent",
    model: { providerID: "test-provider", modelID: "test-model" },
    system,
    messages: [],
    options: {},
    tools: {},
  } as unknown as V2SessionContext;
}

function sessionCompaction(
  sessionID: string,
  system: SessionCompaction["system"] = [],
  result?: SessionCompaction["result"],
): SessionCompaction {
  return {
    ...sessionContext(sessionID, system),
    ...(result === undefined ? {} : { result }),
  } as SessionCompaction;
}

describe("V2 context injection", () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let testDir = "";
  let projectDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-v2-context-injection-"));
    projectDir = join(testDir, "project");
    process.env.HOME = join(testDir, "home");
    process.env.XDG_CONFIG_HOME = join(testDir, "xdg");
    process.env.OPENCODE_CONFIG_DIR = join(testDir, "config");
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
    await rm(testDir, { recursive: true, force: true });
  });

  test("discovers project config while resolving relative memoryDir from process cwd", async () => {
    const sessionID = "relative-session";
    const memoryDir = "relative-memory";
    const memory = `${MEMORY_HEADER}\n\n### Decisions\n- Resolve from cwd.\n`;
    const expectedTagged = buildTaggedMemoryForInjection(memory, DEFAULT_CONFIG.maxMemoryLength);
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    await writeText(memoryPathFor(sessionID, memoryDir), memory);
    await writeText(memoryPathFor(sessionID, join(projectDir, memoryDir)), `${MEMORY_HEADER}\n\n- Wrong location.\n`);
    const input = sessionContext(sessionID);

    await createV2ContextInjection(projectDir)(input);

    expect(input.system).toEqual([{ type: "text", text: expectedTagged }]);
    expect(input.system).toHaveLength(1);
  });

  test("uses an absolute configured memoryDir exactly", async () => {
    const sessionID = "absolute-session";
    const memoryDir = join(testDir, "absolute-memory");
    const memory = `${MEMORY_HEADER}\n\n### Conclusions\n- Absolute path selected.\n`;
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    await writeText(memoryPathFor(sessionID, memoryDir), memory);
    await writeText(memoryPathFor(sessionID, DEFAULT_CONFIG.memoryDir), `${MEMORY_HEADER}\n\n- Decoy.\n`);
    const input = sessionContext(sessionID);

    await createV2ContextInjection(projectDir)(input);

    expect(input.system).toEqual([
      { type: "text", text: buildTaggedMemoryForInjection(memory, DEFAULT_CONFIG.maxMemoryLength) },
    ]);
  });

  test("leaves system unchanged when project config disables memory", async () => {
    const memoryDir = join(testDir, "disabled-memory");
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ enabled: false, memoryDir }));
    await writeText(memoryPathFor("disabled-session", memoryDir), `${MEMORY_HEADER}\n\n- Must not inject.\n`);
    const existing = { type: "text" as const, text: "existing system" };
    const input = sessionContext("disabled-session", [existing]);

    await createV2ContextInjection(projectDir)(input);

    expect(input.system).toEqual([existing]);
    expect(input.system[0]).toBe(existing);
  });

  test.each([
    ["missing memory", undefined],
    ["empty memory", "   \n"],
    [
      "default empty-section memory",
      `${MEMORY_FORMAT_VERSION}\n${MEMORY_HEADER}\n\n### User Instructions\n- None captured yet.\n\n### Decisions\n- None captured yet.\n`,
    ],
  ])("leaves system unchanged for %s", async (_caseName, memory) => {
    const sessionID = "empty-session";
    const memoryDir = join(testDir, "empty-memory");
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    if (memory !== undefined) await writeText(memoryPathFor(sessionID, memoryDir), memory);
    const existing = { type: "text" as const, text: "preserved" };
    const input = sessionContext(sessionID, [existing]);

    await createV2ContextInjection(projectDir)(input);

    expect(input.system).toEqual([existing]);
    expect(input.system[0]).toBe(existing);
  });

  test("deduplicates only text containing the injection prefix and is idempotent", async () => {
    const sessionID = "dedupe-session";
    const memoryDir = join(testDir, "dedupe-memory");
    const memory = `${MEMORY_HEADER}\n\n### Active References\n- Keep one tagged part.\n`;
    const tagged = buildTaggedMemoryForInjection(memory, DEFAULT_CONFIG.maxMemoryLength);
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    await writeText(memoryPathFor(sessionID, memoryDir), memory);
    const callback = createV2ContextInjection(projectDir);
    const unrelated = { type: "text" as const, text: "unrelated system text" };
    const input = sessionContext(sessionID, [unrelated]);

    await callback(input);
    await callback(input);

    expect(input.system).toEqual([unrelated, { type: "text", text: tagged }]);
    expect(input.system.filter((part) => part.text.includes(INJECTION_PREFIX))).toHaveLength(1);

    const existingTagged = { type: "text" as const, text: `already present ${INJECTION_PREFIX}` };
    const prepopulated = sessionContext(sessionID, [existingTagged]);
    await callback(prepopulated);
    expect(prepopulated.system).toEqual([existingTagged]);
  });

  test("adds persisted memory to an exact V2 compaction without creating a result", async () => {
    const sessionID = "compaction-no-result";
    const memoryDir = join(testDir, "compaction-memory");
    const memory = `${MEMORY_HEADER}\n\n### Decisions\n- Preserve compaction result absence.\n`;
    const tagged = buildTaggedMemoryForInjection(memory, DEFAULT_CONFIG.maxMemoryLength);
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    await writeText(memoryPathFor(sessionID, memoryDir), memory);
    const input = sessionCompaction(sessionID);

    await createV2ContextInjection(projectDir)(input);

    expect(input.system).toEqual([{ type: "text", text: tagged }]);
    expect(input.result).toBeUndefined();
    expect("result" in input).toBe(false);
  });

  test("adds persisted memory to an exact V2 compaction while preserving its result identity", async () => {
    const sessionID = "compaction-sentinel-result";
    const memoryDir = join(testDir, "compaction-sentinel-memory");
    const memory = `${MEMORY_HEADER}\n\n### Decisions\n- Preserve the sentinel result.\n`;
    const tagged = buildTaggedMemoryForInjection(memory, DEFAULT_CONFIG.maxMemoryLength);
    const result = { summary: "sentinel compaction result", metadata: { sentinel: true } };
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    await writeText(memoryPathFor(sessionID, memoryDir), memory);
    const input = sessionCompaction(sessionID, [], result);

    await createV2ContextInjection(projectDir)(input);

    expect(input.system).toEqual([{ type: "text", text: tagged }]);
    expect(input.result).toBe(result);
    expect(input.result).toEqual(result);
  });

  test("deduplicates tagged persisted memory across repeated exact V2 compaction callbacks", async () => {
    const sessionID = "compaction-dedupe";
    const memoryDir = join(testDir, "compaction-dedupe-memory");
    const memory = `${MEMORY_HEADER}\n\n### Decisions\n- Keep one compaction memory part.\n`;
    const tagged = buildTaggedMemoryForInjection(memory, DEFAULT_CONFIG.maxMemoryLength);
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    await writeText(memoryPathFor(sessionID, memoryDir), memory);
    const callback = createV2ContextInjection(projectDir);
    const input = sessionCompaction(sessionID);

    await callback(input);
    await callback(input);

    expect(input.system).toEqual([{ type: "text", text: tagged }]);
    expect(input.system.filter((part) => part.type === "text" && part.text.includes(INJECTION_PREFIX))).toHaveLength(1);
  });

  test("reads separator and metacharacter session IDs through memoryPathFor sanitization", async () => {
    const sessionID = "parent/child:topic*?[v2]";
    const memoryDir = join(testDir, "sanitized-memory");
    const memory = `${MEMORY_HEADER}\n\n### Long Horizon Context\n- Sanitized lookup works.\n`;
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    const sanitizedPath = memoryPathFor(sessionID, memoryDir);
    await writeText(sanitizedPath, memory);
    const input = sessionContext(sessionID);

    await createV2ContextInjection(projectDir)(input);

    expect(sanitizedPath).toBe(join(memoryDir, "session_parent_child_topic___v2_.md"));
    expect(input.system).toEqual([
      { type: "text", text: buildTaggedMemoryForInjection(memory, DEFAULT_CONFIG.maxMemoryLength) },
    ]);
  });

  test("resolves after frozen-system mutation failure and records a deterministic error event", async () => {
    const sessionID = "frozen-session";
    const memoryDir = join(testDir, "failure-memory");
    const memory = `${MEMORY_HEADER}\n\n### Decisions\n- Trigger frozen push.\n`;
    await writeText(join(projectDir, ".opencode", "stm.json"), JSON.stringify({ memoryDir }));
    await writeText(memoryPathFor(sessionID, memoryDir), memory);
    const frozenSystem = Object.freeze([]) as unknown as V2SessionContext["system"];
    const input = sessionContext(sessionID, frozenSystem);

    await expect(createV2ContextInjection(projectDir)(input)).resolves.toBeUndefined();

    expect(input.system).toBe(frozenSystem);
    expect(input.system).toHaveLength(0);
    const entries = (await readText(logPath(memoryDir), ""))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: "v2_context_injection_error", sessionID });
    expect(entries[0]?.error).toBeString();
  });
});
