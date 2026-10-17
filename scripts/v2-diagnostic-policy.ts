import { parseDiagnosticLog, type DiagnosticParseIssue, type DiagnosticRow } from "./v1-diagnostic-policy";

export type V2FailureField =
  | "outcome"
  | "failureKind"
  | "mode"
  | "providerID"
  | "modelID"
  | "attempt"
  | "reason"
  | "detail";

export interface ExpectedV2Failure {
  readonly phaseName: string;
  readonly phasePassed: boolean;
  readonly sessionID: string;
  readonly event: "v2_generation_attempt_outcome" | "v2_memory_update_error";
  readonly fields: Readonly<Partial<Record<V2FailureField, string | number>>>;
}

export interface V2DiagnosticContext {
  readonly candidateTarget: string;
  readonly cleanupStartedAt: number;
  readonly expectedFailures: readonly ExpectedV2Failure[];
  readonly stmLog: string;
  readonly hostLogs: readonly V2HostLog[];
}

export interface V2HostLog {
  readonly file: string;
  readonly lines: readonly string[];
}

export interface V2IndexedHostLine {
  readonly file: string;
  readonly index: number;
  readonly line: string;
  readonly reason: string;
}

export interface V2DiagnosticClassification {
  readonly parsedRows: readonly DiagnosticRow[];
  readonly parsedIssues: readonly DiagnosticParseIssue[];
  readonly tail: { readonly unterminated: true; readonly line: number; readonly byteLength: number } | undefined;
  readonly unexpectedStm: readonly DiagnosticRow[];
  readonly expectedMatched: readonly ExpectedV2Failure[];
  readonly missing: readonly ExpectedV2Failure[];
  readonly duplicate: readonly DiagnosticRow[];
  readonly expectedHost: readonly V2IndexedHostLine[];
  readonly unexpectedHost: readonly V2IndexedHostLine[];
}

const knownFields: Readonly<Record<string, "string" | "number" | "boolean">> = {
  event: "string",
  ts: "string",
  tsISO: "string",
  sessionID: "string",
  phaseName: "string",
  level: "string",
  outcome: "string",
  failureKind: "string",
  mode: "string",
  providerID: "string",
  modelID: "string",
  reason: "string",
  detail: "string",
  attempt: "number",
  message: "string",
  cause: "string",
  role: "string",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonempty = (value: unknown): boolean => {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
};

const timestamp = (row: Record<string, unknown>): number => {
  const value = row.tsISO ?? row.ts ?? row.timestamp;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  return typeof value === "string" && value.trim() ? Date.parse(value) : Number.NaN;
};

const isFailureRow = (row: DiagnosticRow): boolean =>
  (row.event === "v2_generation_attempt_outcome" && row.outcome === "failure") ||
  row.event === "v2_memory_update_error" ||
  nonempty(row.error) ||
  (typeof row.level === "string" && /^(?:WARN|WARNING|ERROR)$/i.test(row.level));

const validKnownFields = (row: DiagnosticRow): string | undefined => {
  for (const [key, value] of Object.entries(row)) {
    if (key === "error" || key === "timestamp" || key === "time") continue;
    const expected = knownFields[key];
    if (expected && typeof value !== expected) return `${key} must be a ${expected}`;
  }
  return undefined;
};

const sameField = (row: DiagnosticRow, key: V2FailureField, value: string | number): boolean => row[key] === value;

const matches = (row: DiagnosticRow, expected: ExpectedV2Failure): boolean => {
  if (
    !expected.phasePassed ||
    row.event !== expected.event ||
    row.sessionID !== expected.sessionID ||
    !Number.isFinite(timestamp(row)) ||
    "error" in row
  )
    return false;
  const fields = Object.entries(expected.fields) as [V2FailureField, string | number][];
  return fields.length > 0 && fields.every(([key, value]) => sameField(row, key, value));
};

interface ParsedHost {
  readonly entry: Record<string, unknown>;
  readonly malformed: boolean;
}

const parsedHost = (line: string): ParsedHost => {
  try {
    const value: unknown = JSON.parse(line);
    if (isRecord(value)) return { entry: value, malformed: false };
  } catch {
    // Host logs are also accepted in their structured key=value form.
  }
  const result: Record<string, unknown> = {};
  const keys = new Set<string>();
  let malformed = false;
  let offset = 0;
  while (offset < line.length) {
    while (/\s/.test(line[offset] ?? "")) offset++;
    if (offset === line.length) break;
    const key = line.slice(offset).match(/^[A-Za-z][\w.-]*/)?.[0];
    if (!key) {
      malformed = true;
      break;
    }
    offset += key.length;
    if (line[offset] !== "=") {
      malformed = true;
      break;
    }
    offset++;
    if (offset === line.length) {
      malformed = true;
      break;
    }
    const quote = line[offset];
    let raw: string;
    if (quote === '"') {
      const start = offset;
      offset++;
      let escaped = false;
      let closed = false;
      while (offset < line.length) {
        const character = line[offset]!;
        offset++;
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          closed = true;
          break;
        }
      }
      if (!closed || escaped) {
        malformed = true;
        break;
      }
      const encoded = line.slice(start, offset);
      try {
        const decoded: unknown = JSON.parse(encoded);
        if (typeof decoded !== "string") throw new Error("quoted value is not a string");
        raw = decoded;
      } catch {
        malformed = true;
        break;
      }
    } else if (quote === "'") {
      offset++;
      const characters: string[] = [];
      let closed = false;
      while (offset < line.length) {
        const character = line[offset]!;
        offset++;
        if (character === "'") {
          closed = true;
          break;
        }
        if (character === "\\" && offset < line.length) {
          const escaped = line[offset]!;
          if (escaped === "'" || escaped === "\\") {
            characters.push(escaped);
            offset++;
            continue;
          }
        }
        characters.push(character);
      }
      if (!closed) {
        malformed = true;
        break;
      }
      raw = characters.join("");
    } else {
      const start = offset;
      while (offset < line.length && !/\s/.test(line[offset]!)) offset++;
      raw = line.slice(start, offset);
    }
    if (keys.has(key)) {
      malformed = true;
      continue;
    }
    keys.add(key);
    result[key] = /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  if (!result.level) {
    const level = line.match(/^\s*(INFO|WARN|WARNING|ERROR)\b/i)?.[1];
    if (level) result.level = level;
  }
  return { entry: result, malformed };
};

const isExactPluginWarning = (entry: Record<string, unknown>, target: string): boolean => {
  return (
    target.includes("@file") &&
    String(entry.level).toUpperCase() === "WARN" &&
    entry.message === "failed to check plugin update" &&
    entry.target === target &&
    entry.cause ===
      "Cause([Fail(NpmInstallFailedError (cause: Error: Package checks only support registry and Git package specs))])" &&
    entry.role === "server" &&
    !("error" in entry) &&
    !("exception" in entry)
  );
};

const isExactShutdownInterrupt = (entry: Record<string, unknown>, cleanupStartedAt: number): boolean => {
  const method = entry["http.method"] ?? entry.method;
  const url = entry["http.url"] ?? entry.path;
  const status = entry["http.status"] ?? entry.status;
  return (
    Number.isFinite(cleanupStartedAt) &&
    entry.level === "INFO" &&
    typeof entry.cause === "string" &&
    entry.cause.startsWith("InterruptError: All fibers interrupted without error") &&
    entry.role === "server" &&
    method === "GET" &&
    url === "/api/event" &&
    Number(status) === 200 &&
    !("error" in entry) &&
    !("exception" in entry) &&
    Number.isFinite(timestamp(entry)) &&
    timestamp(entry) >= cleanupStartedAt
  );
};

const isExactPostCleanupStreamDisconnect = (entry: Record<string, unknown>, cleanupStartedAt: number): boolean =>
  entry.level === "INFO" &&
  entry.message === "event stream disconnected" &&
  entry.component === "client" &&
  (entry.error === "Transport" ||
    entry.error ===
      "Transport: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()") &&
  entry.role === "cli" &&
  !("cause" in entry) &&
  !("exception" in entry) &&
  Number.isFinite(timestamp(entry)) &&
  Number.isFinite(cleanupStartedAt) &&
  timestamp(entry) >= cleanupStartedAt;

export function classifyV2Diagnostics(context: V2DiagnosticContext): V2DiagnosticClassification {
  const parsed = parseDiagnosticLog(context.stmLog);
  const parsedIssues = [...parsed.issues];
  const failures = parsed.rows.filter(isFailureRow);
  for (const row of failures) {
    const fieldIssue = validKnownFields(row);
    if (fieldIssue) parsedIssues.push({ line: 0, reason: fieldIssue, byteLength: 0 });
    if (!Number.isFinite(timestamp(row)))
      parsedIssues.push({ line: 0, reason: "failure row requires a finite timestamp", byteLength: 0 });
  }

  const expectedMatched: ExpectedV2Failure[] = [];
  const duplicate: DiagnosticRow[] = [];
  const used = new Set<DiagnosticRow>();
  for (const expected of context.expectedFailures) {
    const candidates = failures.filter((row) => matches(row, expected));
    if (candidates.length === 1) {
      expectedMatched.push(expected);
      used.add(candidates[0]!);
    } else if (candidates.length > 1) {
      expectedMatched.push(expected);
      candidates.forEach((row, index) => index > 0 && duplicate.push(row));
      used.add(candidates[0]!);
    }
  }
  const missing = context.expectedFailures.filter((expected) => !expectedMatched.includes(expected));
  const unexpectedStm = failures.filter((row) => !used.has(row));
  const expectedHost: V2IndexedHostLine[] = [];
  const unexpectedHost: V2IndexedHostLine[] = [];
  for (const log of context.hostLogs) {
    log.lines.forEach((line, index) => {
      const parsed = parsedHost(line);
      const entry = parsed.entry;
      const level = String(entry.level ?? "").toUpperCase();
      const warning = level === "WARN" || level === "WARNING" || level === "ERROR";
      const allowedReason =
        !parsed.malformed && isExactPluginWarning(entry, context.candidateTarget)
          ? "exact candidate file plugin warning"
          : !parsed.malformed && isExactShutdownInterrupt(entry, context.cleanupStartedAt)
            ? "exact post-cleanup shutdown interrupt"
            : !parsed.malformed && isExactPostCleanupStreamDisconnect(entry, context.cleanupStartedAt)
              ? "exact post-cleanup client transport disconnect"
              : undefined;
      const infoError =
        level === "INFO" &&
        ("error" in entry || "cause" in entry || "exception" in entry || /\b[A-Z][A-Za-z0-9]+Error\b/.test(line));
      if ((warning || infoError) && allowedReason !== undefined) {
        expectedHost.push({
          file: log.file,
          index,
          line,
          reason: allowedReason,
        });
      } else if (warning || infoError) {
        unexpectedHost.push({
          file: log.file,
          index,
          line,
          reason: warning ? "unexpected WARN/ERROR" : "unexpected INFO error",
        });
      }
    });
  }
  return {
    parsedRows: parsed.rows,
    parsedIssues,
    tail: parsed.incompleteTail,
    unexpectedStm,
    expectedMatched,
    missing,
    duplicate,
    expectedHost,
    unexpectedHost,
  };
}
