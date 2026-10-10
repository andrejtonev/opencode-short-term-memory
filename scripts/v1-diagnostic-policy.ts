export interface DiagnosticRow {
  readonly [key: string]: unknown;
  readonly event: string;
  readonly ts?: string;
  readonly tsISO?: string;
  readonly error?: unknown;
  readonly level?: string;
  readonly sessionID?: string;
  readonly operationID?: string;
  readonly operationId?: string;
  readonly timestamp?: number | string;
  readonly time?: number | string;
}

export interface DiagnosticParseIssue {
  readonly line: number;
  readonly reason: string;
  readonly byteLength: number;
}

export interface DiagnosticParseResult {
  readonly rows: DiagnosticRow[];
  readonly issues: DiagnosticParseIssue[];
  readonly incompleteTail:
    | { readonly unterminated: true; readonly line: number; readonly byteLength: number }
    | undefined;
}

export interface DiagnosticClassification {
  readonly hostErrors: string[];
  readonly snapshotWarnings: string[];
  readonly expectedWarnings: string[];
  readonly stmErrors: DiagnosticRow[];
  readonly recoveredStmErrors: DiagnosticRow[];
}

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const invalidKnownField = (row: Record<string, unknown>): string | undefined => {
  if (typeof row.event !== "string" || row.event.trim().length === 0) return "event must be a nonempty string";
  for (const field of ["ts", "tsISO", "sessionID", "operationID", "operationId", "level"] as const) {
    if (field in row && typeof row[field] !== "string") return `${field} must be a string`;
  }
  for (const field of ["timestamp", "time"] as const) {
    if (field in row && typeof row[field] !== "number" && typeof row[field] !== "string")
      return `${field} must be a number or string`;
  }
  return undefined;
};

/** Parse newline-delimited STM diagnostics without dropping malformed evidence. */
export function parseDiagnosticLog(text: string): DiagnosticParseResult {
  const rows: DiagnosticRow[] = [];
  const issues: DiagnosticParseIssue[] = [];
  const lines = text.split("\n");
  const hasIncompleteTail = text.length > 0 && !text.endsWith("\n");
  const completeCount = hasIncompleteTail ? lines.length - 1 : lines.length;

  for (let index = 0; index < completeCount; index++) {
    const line = lines[index]!.replace(/\r$/, "");
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) {
        issues.push({ line: index + 1, reason: "row must be a complete JSON object", byteLength: byteLength(line) });
        continue;
      }
      const reason = invalidKnownField(value);
      if (reason) {
        issues.push({ line: index + 1, reason, byteLength: byteLength(line) });
        continue;
      }
      rows.push(value as DiagnosticRow);
    } catch {
      issues.push({ line: index + 1, reason: "invalid JSON row", byteLength: byteLength(line) });
    }
  }

  const incompleteTail = hasIncompleteTail
    ? {
        unterminated: true as const,
        line: lines.length,
        byteLength: byteLength(lines[lines.length - 1]!.replace(/\r$/, "")),
      }
    : undefined;
  return { rows, issues, incompleteTail };
}

const errorIsPresent = (error: unknown): boolean => {
  if (error === null || error === undefined || error === false || error === 0) return false;
  if (typeof error === "string") return error.trim().length > 0;
  return true;
};

const isErrorLevel = (level: unknown): boolean => typeof level === "string" && /^error$/i.test(level.trim());

const diagnosticTime = (row: DiagnosticRow): number => {
  const value = row.tsISO ?? row.ts ?? row.time ?? row.timestamp;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  return typeof value === "string" && value.trim().length > 0 ? Date.parse(value) : Number.NaN;
};

const operationID = (row: DiagnosticRow): string | undefined => row.operationID ?? row.operationId;

const approvedRecoveryEvents = new Set(["stm_retry_recovered", "memory_update_done", "side_session_summarize_done"]);

const normalizeSnapshotLine = (line: string): string =>
  line.replace(/\b(?:timestamp|time|pid|attempt|requestID)=[^\s]+/gi, "").trim();

/** Classify host text and STM rows conservatively; recovery requires identity and strict time order. */
export function classifyDiagnosticRows(rows: readonly DiagnosticRow[], hostLog: string): DiagnosticClassification {
  const lines = hostLog.split(/\r?\n/).filter(Boolean);
  const hostErrors = lines.filter((line) => /^\s*ERROR(?:\s|$)/.test(line) || /\blevel=ERROR\b/.test(line));
  const expectedWarnings = lines.filter((line) => /^\s*Warning:\s*OPENCODE_SERVER_PASSWORD\b/i.test(line));
  const snapshotWarnings: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/service=snapshot\b.*\bexitCode=(?!0\b)\d+/i.test(line)) {
      snapshotWarnings.push(normalizeSnapshotLine(line));
      if (/failed to add snapshot files/i.test(lines[index + 1] ?? "")) index++;
    } else if (/failed to add snapshot files/i.test(line)) {
      snapshotWarnings.push(normalizeSnapshotLine(line));
    }
  }

  const errorEntries = rows.flatMap((row, index) =>
    errorIsPresent(row.error) || isErrorLevel(row.level) ? [{ row, index }] : [],
  );
  const errors = errorEntries.map(({ row }) => row);
  const recoveredStmErrors = errorEntries
    .filter(({ row, index }) => {
      const operation = operationID(row);
      const timestamp = diagnosticTime(row);
      if (!row.sessionID || !operation || !Number.isFinite(timestamp)) return false;
      return rows.slice(index + 1).some((next) => {
        const nextTimestamp = diagnosticTime(next);
        return (
          next.sessionID === row.sessionID &&
          operationID(next) === operation &&
          Number.isFinite(nextTimestamp) &&
          nextTimestamp > timestamp &&
          approvedRecoveryEvents.has(next.event) &&
          !errorIsPresent(next.error) &&
          !isErrorLevel(next.level)
        );
      });
    })
    .map(({ row }) => row);
  const recovered = new Set(recoveredStmErrors);
  return {
    hostErrors,
    snapshotWarnings,
    expectedWarnings,
    stmErrors: errors.filter((row) => !recovered.has(row)),
    recoveredStmErrors,
  };
}
