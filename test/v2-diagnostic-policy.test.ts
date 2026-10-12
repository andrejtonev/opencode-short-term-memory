import { describe, expect, test } from "bun:test";
import {
  classifyV2Diagnostics,
  type ExpectedV2Failure,
  type V2DiagnosticContext,
} from "../scripts/v2-diagnostic-policy";

const candidateTarget = "@atonev/opencode-short-term-memory@file:/tmp/stm-candidate.tgz";
const cleanupStartedAt = Date.parse("2026-10-10T12:00:00.000Z");

const expected = (overrides: Partial<ExpectedV2Failure> = {}): ExpectedV2Failure => ({
  phaseName: "generation",
  phasePassed: true,
  sessionID: "session-1",
  event: "v2_generation_attempt_outcome",
  fields: { outcome: "failure", mode: "clean", providerID: "stm-probe", modelID: "deterministic", attempt: 1 },
  ...overrides,
});

const context = (overrides: Partial<V2DiagnosticContext> = {}): V2DiagnosticContext => ({
  candidateTarget,
  cleanupStartedAt,
  expectedFailures: [],
  stmLog: "",
  hostLogs: [],
  ...overrides,
});

const host = (line: string) => [{ file: "host-0.log", lines: [line] }];

describe("pure V2 diagnostic policy", () => {
  test.each([
    [
      "generation retry",
      expected(),
      {
        event: "v2_generation_attempt_outcome",
        outcome: "failure",
        mode: "clean",
        providerID: "stm-probe",
        modelID: "deterministic",
        attempt: 1,
      },
    ],
    [
      "generation fallback",
      expected({
        phaseName: "clean-retry",
        fields: { outcome: "failure", mode: "clean", providerID: "stm-probe", modelID: "probe-model", attempt: 1 },
      }),
      {
        event: "v2_generation_attempt_outcome",
        outcome: "failure",
        mode: "clean",
        providerID: "stm-probe",
        modelID: "probe-model",
        attempt: 1,
      },
    ],
    [
      "memory update error",
      expected({
        phaseName: "deletion-cancellation",
        event: "v2_memory_update_error",
        fields: { reason: "operational_failure", detail: "summarizer_cancelled" },
      }),
      { event: "v2_memory_update_error", reason: "operational_failure", detail: "summarizer_cancelled" },
    ],
    [
      "second memory update error",
      expected({
        phaseName: "deletion-cancellation",
        event: "v2_generation_attempt_outcome",
        fields: {
          outcome: "failure",
          failureKind: "V2GenerationCancelledError",
          mode: "clean",
          providerID: "stm-probe",
          modelID: "probe-model",
          attempt: 1,
        },
      }),
      {
        event: "v2_generation_attempt_outcome",
        outcome: "failure",
        failureKind: "V2GenerationCancelledError",
        mode: "clean",
        providerID: "stm-probe",
        modelID: "probe-model",
        attempt: 1,
      },
    ],
  ])("matches one intentional injected failure for each passing phase: %s", (_name, item, row) => {
    const result = classifyV2Diagnostics(
      context({
        expectedFailures: [item],
        stmLog:
          JSON.stringify({
            sessionID: "session-1",
            phaseName: item.phaseName,
            tsISO: "2026-10-10T12:01:00.000Z",
            ...row,
          }) + "\n",
      }),
    );
    expect(result.expectedMatched).toHaveLength(1);
    expect(result.unexpectedStm).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });

  test.each([
    [
      "duplicate expected count",
      [
        {
          event: "v2_generation_attempt_outcome",
          sessionID: "session-1",
          tsISO: "2026-10-10T12:01:00.000Z",
          outcome: "failure",
          mode: "clean",
          providerID: "stm-probe",
          modelID: "deterministic",
          attempt: 1,
        },
        {
          event: "v2_generation_attempt_outcome",
          sessionID: "session-1",
          tsISO: "2026-10-10T12:02:00.000Z",
          outcome: "failure",
          mode: "clean",
          providerID: "stm-probe",
          modelID: "deterministic",
          attempt: 1,
        },
      ],
      1,
      0,
      1,
    ],
    ["missing expected failure", [], 0, 1, 0],
    [
      "wrong session",
      [
        {
          event: "v2_generation_attempt_outcome",
          sessionID: "other",
          outcome: "failure",
          mode: "clean",
          providerID: "stm-probe",
          modelID: "deterministic",
          attempt: 1,
        },
      ],
      0,
      1,
      1,
    ],
    [
      "phase not passed",
      [
        {
          event: "v2_generation_attempt_outcome",
          sessionID: "session-1",
          outcome: "failure",
          failureKind: "retry",
          mode: "fallback",
          modelID: "model-1",
          attempt: 1,
        },
      ],
      0,
      1,
      1,
    ],
    [
      "wrong model",
      [
        {
          event: "v2_generation_attempt_outcome",
          sessionID: "session-1",
          outcome: "failure",
          mode: "clean",
          providerID: "stm-probe",
          modelID: "other",
          attempt: 1,
        },
      ],
      0,
      1,
      1,
    ],
    [
      "wrong attempt",
      [
        {
          event: "v2_generation_attempt_outcome",
          sessionID: "session-1",
          outcome: "failure",
          mode: "clean",
          providerID: "stm-probe",
          modelID: "deterministic",
          attempt: 9,
        },
      ],
      0,
      1,
      1,
    ],
  ])("rejects %s rather than broadly suppressing it", (_name, rows, matched, missing, unexpected) => {
    const phasePassed = _name !== "phase not passed";
    const result = classifyV2Diagnostics(
      context({
        expectedFailures: [expected({ phasePassed })],
        stmLog: rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      }),
    );
    expect(result.expectedMatched).toHaveLength(matched);
    expect(result.missing).toHaveLength(missing);
    expect(result.unexpectedStm).toHaveLength(unexpected);
    if (_name === "duplicate expected count") expect(result.duplicate).toHaveLength(1);
  });

  test.each([
    ["string payload", "ordinary_error", "failed outside an expected phase"],
    ["object payload", "v2_generation_attempt_outcome", { message: "failed outside the expected tuple" }],
  ])("treats any ordinary nonempty error payload as unexpected: %s", (_name, event, error) => {
    const result = classifyV2Diagnostics(
      context({
        expectedFailures: [expected()],
        stmLog:
          JSON.stringify({
            event,
            sessionID: "session-1",
            phaseName: "generation",
            tsISO: "2026-10-10T12:01:00.000Z",
            error,
          }) + "\n",
      }),
    );
    expect(result.expectedMatched).toHaveLength(0);
    expect(result.unexpectedStm).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
  });

  test.each([
    [
      "exact candidate warning",
      JSON.stringify({
        level: "WARN",
        message: "failed to check plugin update",
        target: candidateTarget,
        cause:
          "Cause([Fail(NpmInstallFailedError (cause: Error: Package checks only support registry and Git package specs))])",
        role: "server",
      }),
      0,
    ],
    [
      "other target",
      JSON.stringify({
        level: "WARN",
        message: "failed to check plugin update",
        target: "@atonev/opencode-short-term-memory@file:/tmp/other.tgz",
        cause:
          "Cause([Fail(NpmInstallFailedError (cause: Error: Package checks only support registry and Git package specs))])",
        role: "server",
      }),
      1,
    ],
    [
      "extra other error cause",
      JSON.stringify({
        level: "WARN",
        message: "failed to check plugin update",
        target: candidateTarget,
        cause: "OtherError",
        role: "server",
      }),
      1,
    ],
    [
      "registry candidate",
      JSON.stringify({
        level: "WARN",
        message: "failed to check plugin update",
        target: "@scope/pkg@1.0.0",
        cause:
          "Cause([Fail(NpmInstallFailedError (cause: Error: Package checks only support registry and Git package specs))])",
        role: "server",
      }),
      1,
    ],
  ])("allows only the exact candidate-file warning: %s", (_name, line, unexpected) => {
    expect(classifyV2Diagnostics(context({ hostLogs: host(line) })).unexpectedHost).toHaveLength(unexpected);
  });

  test.each([
    [
      "after cleanup",
      {
        level: "INFO",
        cause: "InterruptError: All fibers interrupted without error",
        role: "server",
        "http.method": "GET",
        "http.url": "/api/event",
        "http.status": 200,
        tsISO: "2026-10-10T12:00:01.000Z",
      },
      0,
    ],
    [
      "before cleanup",
      {
        level: "INFO",
        cause: "InterruptError: All fibers interrupted without error",
        role: "server",
        "http.method": "GET",
        "http.url": "/api/event",
        "http.status": 200,
        tsISO: "2026-10-09T12:00:01.000Z",
      },
      1,
    ],
    [
      "missing timestamp",
      {
        level: "INFO",
        cause: "InterruptError: All fibers interrupted without error",
        role: "server",
        "http.method": "GET",
        "http.url": "/api/event",
        "http.status": 200,
      },
      1,
    ],
    [
      "error severity",
      {
        level: "ERROR",
        cause: "InterruptError: All fibers interrupted without error",
        role: "server",
        "http.method": "GET",
        "http.url": "/api/event",
        "http.status": 200,
        tsISO: "2026-10-10T12:00:01.000Z",
      },
      1,
    ],
    [
      "different endpoint",
      {
        level: "INFO",
        cause: "InterruptError: All fibers interrupted without error",
        role: "server",
        "http.method": "GET",
        "http.url": "/api/other",
        "http.status": 200,
        tsISO: "2026-10-10T12:00:01.000Z",
      },
      1,
    ],
  ])("requires an exact post-cleanup interrupt event: %s", (_name, entry, unexpected) => {
    expect(classifyV2Diagnostics(context({ hostLogs: host(JSON.stringify(entry)) })).unexpectedHost).toHaveLength(
      unexpected,
    );
  });

  test.each([
    ["WARN", 1],
    ["ERROR", 1],
  ])("rejects unknown host %s entries", (level, unexpected) => {
    expect(
      classifyV2Diagnostics(context({ hostLogs: host(`${level} unrelated failure`) })).unexpectedHost,
    ).toHaveLength(unexpected);
  });

  test("accepts INFO errorCount=0", () => {
    expect(classifyV2Diagnostics(context({ hostLogs: host("INFO errorCount=0") })).unexpectedHost).toHaveLength(0);
  });

  test.each([
    ["malformed complete row", '{"event":', false],
    ["complete nonobject", "[]", false],
    ["bad known field", '{"event":"v2_generation_attempt_outcome","error":"failed","attempt":"one"}', false],
    ["incomplete tail", '{"event":"v2_generation_attempt_outcome"', true],
    [
      "valid ISO failure",
      JSON.stringify({
        event: "v2_generation_attempt_outcome",
        sessionID: "session-1",
        tsISO: "2026-10-10T12:01:00.000Z",
        outcome: "failure",
        modelID: "model-1",
        attempt: 1,
      }),
      true,
    ],
  ])("reports parser evidence without retaining invalid payloads: %s", (_name, line, validOrTail) => {
    const suffix = _name === "incomplete tail" ? "" : "\n";
    const result = classifyV2Diagnostics(context({ stmLog: line + suffix }));
    expect(JSON.stringify(result.parsedIssues)).not.toContain("rawinvalidpayload");
    if (_name === "incomplete tail") expect(result.tail).toMatchObject({ unterminated: true });
    else if (_name === "valid ISO failure") expect(result.parsedIssues).toHaveLength(0);
    else expect(result.parsedIssues.length).toBeGreaterThan(0);
  });

  test("accepts the structured key=value plugin warning without truncating quoted fields", () => {
    const line = [
      "level=WARN",
      'message="failed to check plugin update"',
      `target=${JSON.stringify(candidateTarget)}`,
      'cause="Cause([Fail(NpmInstallFailedError (cause: Error: Package checks only support registry and Git package specs))])"',
      "role=server",
      `note=${JSON.stringify('quoted"value')}`,
    ].join(" ");

    expect(classifyV2Diagnostics(context({ hostLogs: host(line) })).unexpectedHost).toHaveLength(0);
  });

  test("accepts a structured post-cleanup interrupt with escaped multiline cause text", () => {
    const line = [
      "level=INFO",
      `cause=${JSON.stringify('InterruptError: All fibers interrupted without error\nstack: "cleanup"')}`,
      "role=server",
      'http.method="GET"',
      'http.url="/api/event"',
      "http.status=200",
      "tsISO=2026-10-10T12:00:01.000Z",
    ].join(" ");

    expect(classifyV2Diagnostics(context({ hostLogs: host(line) })).unexpectedHost).toHaveLength(0);
  });

  test.each([
    [
      "after cleanup",
      'level=INFO message="event stream disconnected" component=client attempt=1 error=Transport role=cli tsISO="2026-10-10T12:00:01.000Z"',
      0,
      "exact post-cleanup client transport disconnect",
    ],
    [
      "before cleanup",
      'level=INFO message="event stream disconnected" component=client attempt=1 error=Transport role=cli tsISO="2026-10-09T12:00:01.000Z"',
      1,
      undefined,
    ],
    [
      "missing timestamp",
      'level=INFO message="event stream disconnected" component=client attempt=1 error=Transport role=cli',
      1,
      undefined,
    ],
    [
      "WARN severity",
      'level=WARN message="event stream disconnected" component=client attempt=1 error=Transport role=cli tsISO="2026-10-10T12:00:01.000Z"',
      1,
      undefined,
    ],
    [
      "ERROR severity",
      'level=ERROR message="event stream disconnected" component=client attempt=1 error=Transport role=cli tsISO="2026-10-10T12:00:01.000Z"',
      1,
      undefined,
    ],
    [
      "wrong error",
      'level=INFO message="event stream disconnected" component=client attempt=1 error=OtherTransport role=cli tsISO="2026-10-10T12:00:01.000Z"',
      1,
      undefined,
    ],
    [
      "wrong component",
      'level=INFO message="event stream disconnected" component=server attempt=1 error=Transport role=cli tsISO="2026-10-10T12:00:01.000Z"',
      1,
      undefined,
    ],
    [
      "wrong role",
      'level=INFO message="event stream disconnected" component=client attempt=1 error=Transport role=server tsISO="2026-10-10T12:00:01.000Z"',
      1,
      undefined,
    ],
    [
      "extra cause",
      'level=INFO message="event stream disconnected" component=client attempt=1 error=Transport role=cli cause=unexpected tsISO="2026-10-10T12:00:01.000Z"',
      1,
      undefined,
    ],
  ])("classifies the structured post-cleanup transport disconnect: %s", (_name, line, unexpected, reason) => {
    const result = classifyV2Diagnostics(context({ hostLogs: host(line) }));
    expect(result.unexpectedHost).toHaveLength(unexpected);
    if (reason) expect(result.expectedHost).toMatchObject([{ reason }]);
  });

  test.each([
    [
      "duplicate cause keys",
      'level=WARN message="failed to check plugin update" target="@atonev/opencode-short-term-memory@file:/tmp/stm-candidate.tgz" cause="Cause([Fail(NpmInstallFailedError (cause: Error: Package checks only support registry and Git package specs))])" cause="OtherError" role=server',
    ],
    [
      "unterminated quoted warning",
      'level=WARN message="failed to check plugin update target="@atonev/opencode-short-term-memory@file:/tmp/stm-candidate.tgz" role=server',
    ],
    [
      "malformed quoted JSON escape",
      'level=WARN message="failed\\q" target="@atonev/opencode-short-term-memory@file:/tmp/stm-candidate.tgz" role=server',
    ],
    [
      "WARNING severity",
      'level=WARNING message="failed to check plugin update" target="@atonev/opencode-short-term-memory@file:/tmp/stm-candidate.tgz" cause="Cause([Fail(NpmInstallFailedError (cause: Error: Package checks only support registry and Git package specs))])" role=server',
    ],
    [
      "interrupt error field",
      'level=INFO cause="InterruptError: All fibers interrupted without error" error="unexpected" role=server http.method=GET http.url=/api/event http.status=200 tsISO=2026-10-10T12:00:01.000Z',
    ],
    [
      "nonfinite cleanup timestamp",
      'level=INFO cause="InterruptError: All fibers interrupted without error" role=server http.method=GET http.url=/api/event http.status=200 tsISO=2026-10-10T12:00:01.000Z',
    ],
  ])("rejects malformed or unsafe structured host entries: %s", (_name, line) => {
    const cleanup = _name === "nonfinite cleanup timestamp" ? Number.NaN : cleanupStartedAt;
    expect(
      classifyV2Diagnostics(context({ cleanupStartedAt: cleanup, hostLogs: host(line) })).unexpectedHost,
    ).toHaveLength(1);
  });

  test("does not match an expected STM failure when it carries an extra error field", () => {
    const item = expected();
    const stmLog =
      JSON.stringify({
        sessionID: item.sessionID,
        phaseName: item.phaseName,
        tsISO: "2026-10-10T12:01:00.000Z",
        event: item.event,
        ...item.fields,
        error: "unexpected extra error",
      }) + "\n";
    const result = classifyV2Diagnostics(context({ expectedFailures: [item], stmLog }));

    expect(result.expectedMatched).toHaveLength(0);
    expect(result.missing).toHaveLength(1);
    expect(result.unexpectedStm).toHaveLength(1);
  });
});
