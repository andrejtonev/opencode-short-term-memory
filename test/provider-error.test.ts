import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeMemoryAction, type CommandContext } from "../src/commands";
import { DEFAULT_CONFIG, memoryPathFor, writeText } from "../src/memory-utils";
import type { MemoryUpdateDisposition } from "../src/memory-update-result";
import { providerGenerationError } from "../src/provider-error";
import type { Client } from "../src/types";

function rejection(statusCode: number, type: string, isRetryable = false) {
  return {
    name: "APIError",
    data: {
      statusCode,
      isRetryable,
      message: "raw sensitive provider message",
      responseHeaders: { authorization: "secret-header-value" },
      responseBody: JSON.stringify({ error: { type, message: "secret-body-value" } }),
    },
  };
}

describe("provider generation diagnostics", () => {
  test("preserves the free-tier restriction without retaining raw provider details", () => {
    const failure = providerGenerationError(rejection(403, "FreeTierError"));
    expect(failure).toMatchObject({ kind: "model_restricted", statusCode: 403, retryable: false });
    expect(failure?.message).toContain("FreeTierError (403)");
    expect(failure?.message).toContain("memoryModel");
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(failure?.message).not.toContain("sensitive");
  });

  test("expired API key guidance distinguishes Console login from replacing a legacy key", () => {
    const error = rejection(401, "authentication_error");
    error.data.responseBody = JSON.stringify({
      error: { type: "authentication_error", code: "api_key_expired", message: "secret-body-value" },
    });
    const failure = providerGenerationError(error);
    expect(failure).toMatchObject({ kind: "authentication_failed", retryable: false });
    expect(failure?.message).toContain("opencode console login");
    expect(failure?.message).toContain("legacy API key");
  });

  test("arbitrary 401 errors do not assume an OpenCode provider", () => {
    const failure = providerGenerationError(rejection(401, "AuthenticationError"));
    expect(failure?.message).toContain("For OpenCode V1 models");
    expect(failure?.message).toContain("For other providers");
  });

  test("403 stays permanent even if the provider erroneously calls it retryable", () => {
    expect(providerGenerationError(rejection(403, "ForbiddenError", true))?.retryable).toBe(false);
  });

  test("explicit retryable 503 remains retryable", () => {
    expect(providerGenerationError(rejection(503, "UnavailableError", true))?.retryable).toBe(true);
  });

  test("wrapped provider rejection preserves its category through a bounded error cause chain", () => {
    const wrapped = new Error("host generation failed", { cause: rejection(403, "FreeTierError") });
    expect(providerGenerationError(wrapped)?.kind).toBe("model_restricted");
    const cycle = new Error("unknown failure");
    cycle.cause = cycle;
    expect(providerGenerationError(cycle)).toBeUndefined();
  });

  test("non-JSON body is not interpreted as a free-tier error", () => {
    const error = rejection(403, "FreeTierError");
    error.data.responseBody = "FreeTierError secret-body-value";
    expect(providerGenerationError(error)?.kind).toBe("provider_error");
  });
});

describe("memory update command outcomes", () => {
  let directory = "";
  let context: CommandContext;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stm-update-outcome-"));
    context = {
      config: { ...DEFAULT_CONFIG, memoryDir: directory },
      globalState: { updateCount: 0, injectCount: 0, injectCharCount: 0, compactCount: 0 },
      sessionStates: new Map(),
    };
    await writeText(memoryPathFor("session", directory), "previous memory bytes");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const invoke = (result: MemoryUpdateDisposition) =>
    executeMemoryAction("update", "session", context, {} as Client, async () => result);

  test("failure reports the failure instead of returning old memory as a refreshed result", async () => {
    const result = await invoke({ status: "error", detail: "FreeTierError (403)" });
    expect(result).toBe("Memory update failed: FreeTierError (403)");
    expect(result).not.toContain("previous memory bytes");
  });

  test("partial failure reports saved earlier chunks and incomplete update", async () => {
    expect(await invoke({ status: "error", detail: "provider failed", partial: true })).toContain(
      "Some earlier chunks were saved; the update did not complete.",
    );
  });

  test("skip and deferred results do not imply refreshed memory", async () => {
    expect(await invoke({ status: "skipped", reason: "disabled" })).toBe("Memory update skipped: disabled.");
    expect(await invoke({ status: "deferred" })).toContain("has not refreshed the memory yet");
    expect(await invoke("deferred")).toContain("has not refreshed the memory yet");
  });

  test("successful updates and legacy void callbacks return the resulting memory", async () => {
    expect(await invoke({ status: "updated" })).toBe("previous memory bytes");
    expect(await invoke(undefined)).toBe("previous memory bytes");
  });
});
