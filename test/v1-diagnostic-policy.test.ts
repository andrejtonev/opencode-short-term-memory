import { describe, expect, test } from "bun:test";
import { classifyDiagnosticRows, parseDiagnosticLog, type DiagnosticRow } from "../scripts/v1-diagnostic-policy";

const row = (fields: Record<string, unknown>): DiagnosticRow => ({ event: "diagnostic", ...fields }) as DiagnosticRow;

describe("pure V1 diagnostic policy", () => {
  test.each([
    ["malformed JSON", '{"event":', "invalid JSON row"],
    ["primitive", "42", "row must be a complete JSON object"],
    ["array", "[]", "row must be a complete JSON object"],
    ["missing event", '{"message":"missing event"}', "event must be a nonempty string"],
  ])("rejects %s complete rows without retaining raw payloads", (_name, input, reason) => {
    const result = parseDiagnosticLog(input + "\n");

    expect(result.rows).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ reason });
    expect(result.issues[0]).not.toHaveProperty("payload");
    expect(JSON.stringify(result.issues[0])).not.toContain("missing event");
  });

  test("reports UTF-8 byte length and does not leak a secret invalid line", () => {
    const invalidLine = '{"event": "é", "level": 1, "token": "sentinel-invalidline"}';
    const result = parseDiagnosticLog(invalidLine + "\n");

    expect(result.issues[0]).toMatchObject({ byteLength: new TextEncoder().encode(invalidLine).byteLength });
    expect(JSON.stringify(result.issues[0])).not.toContain("sentinel-invalidline");
  });

  test.each([
    ["known string field with number", '{"event":"x","level":1}', "level must be a string"],
    ["known numeric field with object", '{"event":"x","time":{}}', "time must be a number or string"],
    ["error object", '{"event":"collect_recent_messages_error","error":{"message":"failed"}}', undefined],
    ["error string", '{"event":"collect_recent_messages_error","error":"failed"}', undefined],
  ])("validates known field shapes: %s", (_name, input, reason) => {
    const result = parseDiagnosticLog(input + "\n");

    if (reason) {
      expect(result.rows).toHaveLength(0);
      expect(result.issues[0]?.reason).toBe(reason);
    } else {
      expect(result.rows).toHaveLength(1);
      expect(result.issues).toHaveLength(0);
    }
  });

  test("distinguishes an unterminated tail from terminated rows and ignores blanks", () => {
    const terminated = parseDiagnosticLog('{"event":"first"}\n\n');
    const unterminated = parseDiagnosticLog('{"event":"first"}\n{"event":"tail"');

    expect(terminated.rows).toHaveLength(1);
    expect(terminated.incompleteTail).toBeUndefined();
    expect(unterminated.rows).toHaveLength(1);
    expect(unterminated.incompleteTail).toMatchObject({ unterminated: true, line: 2 });
  });

  test("accepts a no-error row and detects collector errors regardless of event name", () => {
    const result = classifyDiagnosticRows(
      [
        row({ event: "collect_recent_messages_error", error: { message: "failed" } }),
        row({ event: "other", error: "failed" }),
        row({ event: "skip", error: undefined }),
      ],
      "",
    );

    expect(result.stmErrors).toHaveLength(2);
    expect(result.stmErrors.map((item) => item.event)).toEqual(["collect_recent_messages_error", "other"]);
  });

  test.each([
    ["INFO", "INFO errorCount=0", 0],
    ["unsecured warning", "INFO errorCount=3\nWarning: OPENCODE_SERVER_PASSWORD is not set", 1],
  ])("host policy keeps %s out of hostErrors and preserves expected warnings", (_name, hostLog, expectedWarnings) => {
    const result = classifyDiagnosticRows([], hostLog);

    expect(result.hostErrors).toHaveLength(0);
    expect(result.expectedWarnings).toHaveLength(expectedWarnings);
  });

  test("classifies nine snapshot warning pairs as nine warnings", () => {
    const hostLog = Array.from(
      { length: 9 },
      (_, index) =>
        `ERROR service=snapshot attempt=${index} exitCode=128\nfailed to add snapshot files requestID=${index}`,
    ).join("\n");

    expect(classifyDiagnosticRows([], hostLog).snapshotWarnings).toHaveLength(9);
  });

  test("counts a standalone failed-to-add-snapshot warning", () => {
    const result = classifyDiagnosticRows([], "failed to add snapshot files timestamp=123");

    expect(result.snapshotWarnings).toHaveLength(1);
  });

  test("only treats nonzero snapshot exit codes as warnings", () => {
    const result = classifyDiagnosticRows([], "service=snapshot exitCode=128\nservice=snapshot exitCode=0");

    expect(result.snapshotWarnings).toHaveLength(1);
    expect(result.snapshotWarnings[0]).toContain("exitCode=128");
  });

  test.each([
    ["later approved event", 1_000, 2_000, "memory_update_done", "session-1", "operation-1", true],
    ["equal timestamp", 1_000, 1_000, "memory_update_done", "session-1", "operation-1", false],
    ["reversed timestamp", 2_000, 1_000, "memory_update_done", "session-1", "operation-1", false],
    ["other session", 1_000, 2_000, "memory_update_done", "session-2", "operation-1", false],
    ["other operation", 1_000, 2_000, "memory_update_done", "session-1", "operation-2", false],
    ["same success event", 1_000, 2_000, "success", "session-1", "operation-1", false],
  ])(
    "recovers only with same identity, strict time order, and approved event: %s",
    (_name, firstTime, nextTime, event, nextSession, nextOperation, recovered) => {
      const errors = [
        row({
          event: "stm_error",
          error: "failed",
          sessionID: "session-1",
          operationID: "operation-1",
          timestamp: firstTime,
        }),
        row({ event, sessionID: nextSession, operationID: nextOperation, timestamp: nextTime }),
      ];
      const result = classifyDiagnosticRows(errors, "");

      expect(result.recoveredStmErrors).toHaveLength(recovered ? 1 : 0);
      expect(result.stmErrors).toHaveLength(recovered ? 0 : 1);
    },
  );

  test("supports ISO timestamps while requiring the recovery row to follow the error", () => {
    const result = classifyDiagnosticRows(
      [
        row({
          event: "stm_error",
          error: "failed",
          sessionID: "s",
          operationID: "o",
          tsISO: "2026-10-10T00:00:00.000Z",
        }),
        row({ event: "memory_update_done", sessionID: "s", operationID: "o", tsISO: "2026-10-10T00:00:01.000Z" }),
      ],
      "",
    );

    expect(result.recoveredStmErrors).toHaveLength(1);
    expect(result.stmErrors).toHaveLength(0);
  });

  test("does not recover when an approved row precedes the error", () => {
    const result = classifyDiagnosticRows(
      [
        row({ event: "memory_update_done", sessionID: "s", operationID: "o", timestamp: 2_000 }),
        row({ event: "stm_error", error: "failed", sessionID: "s", operationID: "o", timestamp: 1_000 }),
      ],
      "",
    );

    expect(result.recoveredStmErrors).toHaveLength(0);
    expect(result.stmErrors).toHaveLength(1);
  });

  test("does not recover an error row merely because its success field is present", () => {
    const result = classifyDiagnosticRows(
      [row({ event: "stm_error", error: "failed", success: true, sessionID: "s", operationID: "o", ts: 1 })],
      "",
    );

    expect(result.recoveredStmErrors).toHaveLength(0);
    expect(result.stmErrors).toHaveLength(1);
  });
});
