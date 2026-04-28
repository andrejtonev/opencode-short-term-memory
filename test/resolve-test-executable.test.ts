import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightCleanSummarizerExecutable, resolveTestExecutable } from "./resolve-test-executable";

describe("resolve-test-executable", () => {
  const originalEnv = { ...process.env } as Record<string, string | undefined>;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "opencode-resolve-exec-test-"));
    delete process.env.OPENCODE_EXECUTABLE_FOR_TESTS;
    delete process.env.LOCALAPPDATA;
    delete process.env.USERPROFILE;
  });

  afterEach(async () => {
    for (const key of ["OPENCODE_EXECUTABLE_FOR_TESTS", "LOCALAPPDATA", "USERPROFILE"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await rm(testDir, { recursive: true, force: true });
  });

  test("resolveTestExecutable prefers explicit env override", async () => {
    process.env.OPENCODE_EXECUTABLE_FOR_TESTS = "custom-opencode-test-bin";
    const resolved = await resolveTestExecutable();
    expect(resolved).toBe("custom-opencode-test-bin");
  });

  test("resolveTestExecutable discovers LOCALAPPDATA candidate on windows-like env", async () => {
    const localAppData = join(testDir, "LocalAppData");
    const openCodeDir = join(localAppData, "OpenCode");
    const fakeExe = join(openCodeDir, "opencode-cli.exe");
    await mkdir(openCodeDir, { recursive: true });
    await writeFile(fakeExe, "echo fake\n", "utf8");
    process.env.LOCALAPPDATA = localAppData;

    const resolved = await resolveTestExecutable();
    if (process.platform === "win32") {
      expect(resolved.toLowerCase().includes("opencode-cli")).toBe(true);
    } else {
      expect(resolved).toBe("opencode");
    }
  });

  test("preflight returns not ok when executable is empty", async () => {
    const result = await preflightCleanSummarizerExecutable("   ");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("No executable configured");
  });

  test("preflight returns not ok for missing executable", async () => {
    const result = await preflightCleanSummarizerExecutable("definitely-missing-opencode-binary-for-tests");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Cannot spawn");
  });

  test("preflight returns a structured result for a discovered executable", async () => {
    const executable = Bun.which("bun") || "bun";
    const result = await preflightCleanSummarizerExecutable(executable);
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok) {
      expect(String(result.reason || "")).toContain("Cannot spawn");
    }
  });
});
