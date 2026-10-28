import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticErrorMessage, diagnosticJson, redactDiagnostic } from "../src/diagnostics";
import {
  DEFAULT_CONFIG,
  MEMORY_HEADER,
  createRuntimeState,
  logEvent,
  logPath,
  memoryPathFor,
} from "../src/memory-utils";
import { processMemoryChunks } from "../src/memory-lifecycle";
import { appendChildMemoryToSystem } from "../src/injection";
import { recordV2Telemetry, readV2Telemetry } from "../src/v2-telemetry";
import type { V2Context } from "../src/v2-adapter";
import type { Client } from "../src/types";
import type { SummarizerRuntime } from "../src/summarizer";
import { generationErrorMessage, isPermanentGenerationError, providerGenerationError } from "../src/provider-error";

describe("diagnostic credential boundary", () => {
  test("unclassified errors redact inherited opaque credentials without losing operation or code", () => {
    const name = "STM_TEST_API_KEY";
    const previous = process.env[name];
    const credential = "opaque-test-value-975318642";
    process.env[name] = credential;
    try {
      const error = new Error(`session.generate failed ECONNRESET for credential ${credential}`);
      expect(generationErrorMessage(error)).toBe("session.generate failed ECONNRESET for credential [REDACTED]");
      expect(error.message).toContain(credential);
      expect(providerGenerationError(error)).toBeUndefined();
      expect(isPermanentGenerationError(error)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  test("redacts credential fields, authorization schemes, tokens and URL userinfo", () => {
    const samples = [
      'apiKey="field-value with spaces"',
      "Authorization: Bearer header-value-123",
      "Cookie: first=session-value; second=private-cookie-value",
      "Basic dGVzdDpzdXBlcnNlY3JldA==",
      "https://user:password-value@provider.test/path?api_key=query-value",
      "https://blob.test/container?sv=2020&sig=sas-signature-value&se=tomorrow",
      'requestBody={"message":"arbitrary private text"}',
      "npm_abcdefghijklmnopqrstuvwx",
      "sk-abcdefghijklmnopqrstuvwx",
      "-----BEGIN PRIVATE KEY-----\nprivate-bytes\n-----END PRIVATE KEY-----",
    ];
    for (const sample of samples) expect(redactDiagnostic(sample)).toContain("[REDACTED]");
    const output = samples.map(redactDiagnostic).join("\n");
    for (const secret of [
      "field-value",
      "header-value",
      "dGVzdD",
      "password-value",
      "query-value",
      "sas-signature-value",
      "arbitrary private text",
      "abcdefghijkl",
      "private-bytes",
      "session-value",
      "private-cookie-value",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("provider.test/path");
  });

  test("plain diagnostics and permanent/retryable classification stay intact", () => {
    const message = "session.generate failed ECONNRESET; retry 2; checkpoint msg_42";
    expect(diagnosticErrorMessage(new Error(message))).toBe(message);
    for (const statusCode of [401, 403, 503]) {
      const error = { data: { statusCode, isRetryable: true, responseBody: '{"error":{"message":"private"}}' } };
      const before = providerGenerationError(error);
      generationErrorMessage(error);
      expect(providerGenerationError(error)).toEqual(before);
      expect(isPermanentGenerationError(error)).toBe(statusCode !== 503);
    }
  });

  test("generic inherited token values are removed and oversized remote diagnostics are discarded whole", () => {
    const names = ["NPM_TOKEN", "GH_TOKEN", "NODE_AUTH_TOKEN"];
    for (const name of names) {
      const previous = process.env[name];
      process.env[name] = "opaque-inherited-token-1357913579";
      try {
        expect(redactDiagnostic("request rejected opaque-inherited-token-1357913579")).toBe(
          "request rejected [REDACTED]",
        );
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
    const text = "raw-private-value".repeat(2_000);
    expect(redactDiagnostic(text)).toBe(`Diagnostic text omitted (${text.length} characters).`);
  });

  test("persistent diagnostic serialization omits raw provider dumps without mutating inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stm-safe-log-"));
    const data = {
      sessionID: "session_42",
      checkpointID: "msg_42",
      bytes: 100,
      error: 'provider disconnected; password="opaque-secret"',
      provider: {
        apiKey: "nested-secret",
        responseBody: "raw-private-body",
        responseHeaders: { extra: "raw-private-header" },
      },
      auth: { azure: { key: "nested-auth-key" }, token: "nested-token" },
    };
    const original = JSON.stringify(data);
    try {
      await logEvent({ ...DEFAULT_CONFIG, memoryDir: directory }, "generation_failed", data);
      const output = await readFile(logPath(directory), "utf8");
      const entry = JSON.parse(output);
      expect(entry).toMatchObject({
        event: "generation_failed",
        sessionID: "session_42",
        checkpointID: "msg_42",
        bytes: 100,
      });
      for (const secret of [
        "opaque-secret",
        "nested-secret",
        "raw-private-body",
        "raw-private-header",
        "nested-auth-key",
        "nested-token",
      ])
        expect(output).not.toContain(secret);
      expect(JSON.stringify(data)).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("JSON protection preserves ordinary values and invokes normal serialization once", () => {
    let calls = 0;
    const input = {
      code: "ECONNRESET",
      retryable: true,
      counts: [1, 2],
      details: {
        toJSON: () => {
          calls++;
          return { password: "private", requestID: "req42" };
        },
      },
    };
    expect(JSON.parse(diagnosticJson(input))).toEqual({
      code: "ECONNRESET",
      retryable: true,
      counts: [1, 2],
      details: { password: "[REDACTED]", requestID: "req42" },
    });
    expect(calls).toBe(1);
  });

  test("debug generation and injection logs contain counts while real prompt and memory retain content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stm-private-content-"));
    const memory = `${MEMORY_HEADER}\n\n### User Instructions\n- PRIVATE_MEMORY_CONTENT`;
    const conversation = "USER:\nPRIVATE_CONVERSATION_CONTENT";
    let actualPrompt = "";
    const runtime: SummarizerRuntime = {
      deliverGeneratedPrompt: async (request) => {
        actualPrompt = request.prompt.parts[0].text;
        return { data: { info: { role: "assistant" }, parts: [{ type: "text", text: memory }] } };
      },
      createTemporarySession: async () => ({ id: "side-private" }),
      abortTemporarySession: async () => {},
      deleteTemporarySession: async () => {},
    };
    const config = { ...DEFAULT_CONFIG, memoryDir: directory, debug: true, summarizerMode: "active" as const };
    const state = createRuntimeState();
    try {
      expect(
        await processMemoryChunks(
          {} as Client,
          runtime,
          "session_private",
          "test",
          config,
          memoryPathFor("session_private", directory),
          "",
          [{ rendered: conversation, lastMessageID: "msg_private" }],
          "",
          state,
        ),
      ).toBe(true);
      expect(actualPrompt).toContain(conversation);
      expect(await readFile(memoryPathFor("session_private", directory), "utf8")).toContain("PRIVATE_MEMORY_CONTENT");
      const output = { system: [] as string[] };
      expect(await appendChildMemoryToSystem(output, "child_private", memory, config, state)).toBe(true);
      expect(output.system.join("\n")).toContain("PRIVATE_MEMORY_CONTENT");
      const log = await readFile(logPath(directory), "utf8");
      expect(log).not.toContain("PRIVATE_MEMORY_CONTENT");
      expect(log).not.toContain("PRIVATE_CONVERSATION_CONTENT");
      const events = log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.find((entry) => entry.event === "memory_update_prompt").promptChars).toBe(actualPrompt.length);
      expect(events.find((entry) => entry.event === "memory_inject_message").messageChars).toBeGreaterThan(0);
      expect(state).toMatchObject({ updateCount: 1, injectCount: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("V2 status telemetry stores redacted errors and preserves success counters", () => {
    const context = {} as V2Context;
    recordV2Telemetry(context, "error", "session.generate ECONNRESET apiKey=opaque-secret");
    expect(readV2Telemetry(context).lastError).toBe("session.generate ECONNRESET apiKey=[REDACTED]");
    recordV2Telemetry(context, "update");
    recordV2Telemetry(context, "inject", 42);
    expect(readV2Telemetry(context)).toMatchObject({
      updateCount: 1,
      injectCount: 1,
      injectCharCount: 42,
      lastError: undefined,
    });
  });
});
