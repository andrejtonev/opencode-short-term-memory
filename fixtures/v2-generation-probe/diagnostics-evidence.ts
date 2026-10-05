import type { ManualEvidenceInput } from "./manual-evidence.js";

export const DIAGNOSTICS_PROMPT =
  "STM_DIAGNOSTICS: call stm_memory_logs with empty input, then stm_memory_settings with empty input.";
export const DIAGNOSTICS_CALLS = [
  { id: "stm-probe-diagnostics-logs", tool: "stm_memory_logs" },
  { id: "stm-probe-diagnostics-settings", tool: "stm_memory_settings" },
] as const;

// Fixture-owned oracle for the isolated initial configuration, not production resolution.
export function expectedDiagnosticsSettings(memoryDir: string) {
  const resolvedConfig = {
    enabled: true,
    memoryModel: "stm-probe/deterministic",
    summarizerMode: "clean",
    cleanFallbackToActiveSession: false,
    includeAgentsMdOnFirstUpdate: false,
    injectInSubagents: true,
    enableLegacyPeriodicSystemTransform: false,
    sideSessionRetries: 1,
    remindEveryN: 4,
    maxMemoryLength: 10000,
    maxUpdateInputLength: 20000,
    debounceMs: 1200,
    debug: false,
    logMaxLines: 300,
    maxDeltaMessages: 200,
    collapseAssistantBursts: false,
    memoryDir,
  };
  return {
    generation: "v2",
    resolvedConfig,
    effective: {
      enabled: true,
      memoryModel: "current-session",
      summarizerMode: "clean",
      maxMemoryLength: 10000,
      maxUpdateInputLength: 20000,
      maxDeltaMessages: 200,
      memoryDir,
      updateHook: "context",
      injectionHooks: ["context", "compaction"],
    },
    inactiveSettings: [
      "memoryModel",
      "cleanFallbackToActiveSession",
      "includeAgentsMdOnFirstUpdate",
      "injectInSubagents",
      "enableLegacyPeriodicSystemTransform",
      "sideSessionRetries",
      "remindEveryN",
      "debounceMs",
      "debug",
      "logMaxLines",
      "collapseAssistantBursts",
    ],
  };
}

type ObjectRecord = Record<string, unknown>;
function object(value: unknown): ObjectRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ObjectRecord) : undefined;
}
function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const left = object(a),
    right = object(b);
  if (left && right)
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
  return a === b;
}

export function evaluateDiagnosticsEvidence(input: {
  records: ManualEvidenceInput["records"];
  sessionID: string;
  expectedSettings: ReturnType<typeof expectedDiagnosticsSettings>;
}): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const require = (condition: unknown, message: string) => {
    if (!condition) failures.push(message);
  };
  require(input.records.every(
    (r, i) => Number.isInteger(r.seq) && r.seq > 0 && (i === 0 || r.seq > input.records[i - 1]!.seq),
  ), "diagnostic sequence is not unique and ordered");
  const executions = input.records.filter(
    (r) =>
      r.event === "event.observed" &&
      /^tool.execute\.(before|after)$/.test(r.observedEvent ?? "") &&
      DIAGNOSTICS_CALLS.some((c) => c.tool === object(r.details?.eventData)?.tool),
  );
  require(executions.length === 4, "diagnostics require exactly two execution pairs");
  let previousAfter = Math.max(
    0,
    ...input.records
      .filter(
        (r) =>
          r.observedEvent === "tool.execute.after" &&
          ["stm_memory_update", "stm_memory_reset"].includes(String(object(r.details?.eventData)?.tool)),
      )
      .map((r) => r.seq),
  );
  const callerIDs = new Set<string>();
  for (const call of DIAGNOSTICS_CALLS) {
    const matches = executions.filter((r) => object(r.details?.eventData)?.id === call.id);
    const before = matches.filter((r) => r.observedEvent === "tool.execute.before"),
      after = matches.filter((r) => r.observedEvent === "tool.execute.after");
    require(before.length === 1 && after.length === 1, `${call.tool}: missing or duplicate pair`);
    if (before.length !== 1 || after.length !== 1) continue;
    const b = before[0]!,
      a = after[0]!,
      bd = object(b.details?.eventData)!,
      ad = object(a.details?.eventData)!;
    require(previousAfter > 0 && previousAfter < b.seq && b.seq < a.seq, `${call.tool}: execution order invalid`);
    require([bd, ad].every(
      (d) =>
        d.sessionID === input.sessionID &&
        d.tool === call.tool &&
        typeof d.messageID === "string" &&
        d.messageID.startsWith("msg_") &&
        equal(d.input, {}),
    ) &&
      bd.messageID === ad.messageID &&
      bd.snapshotPhase === "before" &&
      ad.snapshotPhase === "after" &&
      ad.status === "completed", `${call.tool}: host identity/input/completion invalid`);
    if (typeof bd.messageID === "string") callerIDs.add(bd.messageID);
    const emissions = input.records.filter(
      (r) => r.event === "model.invocation" && object(r.details?.toolCall)?.toolCallId === call.id,
    );
    require(emissions.length === 1 &&
      emissions[0]!.seq < b.seq &&
      emissions[0]!.seq > previousAfter &&
      emissions[0]!.provider === "stm-probe" &&
      emissions[0]!.model === "deterministic" &&
      emissions[0]!.details?.primaryPrompt === DIAGNOSTICS_PROMPT &&
      equal(object(emissions[0]!.details?.toolCall), {
        toolCallId: call.id,
        toolName: call.tool,
        input: {},
      }), `${call.tool}: real provider emission invalid`);
    previousAfter = a.seq;
    const keys = ["memory", "checkpoint", "boundary", "log", "projectConfig"];
    const bs = object(b.details?.diagnosticsFiles),
      as = object(a.details?.diagnosticsFiles);
    require(bs &&
      as &&
      [bs, as].every((s) =>
        keys.every(
          (k) => s[k] === null || (typeof s[k] === "string" && Buffer.from(s[k], "base64").toString("base64") === s[k]),
        ),
      ) &&
      keys.every((k) => bs[k] === as[k]), `${call.tool}: file snapshot missing or mutated`);
    const counters = object(b.details?.productionAccess);
    require(counters &&
      Object.keys(counters).length === 4 &&
      ["context", "get", "sessionGenerate", "standaloneGenerate"].every(
        (k) => Number.isInteger(counters[k]) && Number(counters[k]) >= 0,
      ) &&
      equal(counters, a.details?.productionAccess), `${call.tool}: production host/generation access during pair`);
    require(!input.records.some(
      (r) =>
        r.seq > b.seq &&
        r.seq < a.seq &&
        (r.event === "model.invocation" ||
          r.event === "model.request" ||
          r.event === "operation.start" ||
          r.event === "callback.enter"),
    ), `${call.tool}: host/generation telemetry during pair`);
    const content = object(ad.result)?.content;
    const text =
      Array.isArray(content) && content.length === 1 && object(content[0])?.type === "text"
        ? object(content[0])?.text
        : undefined;
    if (call.tool === "stm_memory_logs") {
      const raw = typeof bs?.log === "string" ? Buffer.from(bs.log, "base64").toString("utf8") : "";
      const lines = raw.split(/\r?\n/).filter(Boolean).slice(-120);
      const committed = lines.some((line) => {
        try {
          const event = object(JSON.parse(line));
          return event?.event === "v2_memory_update_committed" && event.sessionID === input.sessionID;
        } catch {
          return false;
        }
      });
      require(lines.length > 0 &&
        committed &&
        text === lines.join("\n"), "logs: response is not exact nonempty committed-update tail");
    } else {
      let settings: unknown;
      try {
        settings = typeof text === "string" ? JSON.parse(text) : undefined;
      } catch {
        /* Fail below. */
      }
      require(equal(
        settings,
        input.expectedSettings,
      ), "settings: response differs from independent configured/effective oracle");
    }
  }
  require(callerIDs.size === 2, "diagnostics must use distinct host caller messages");
  return { passed: failures.length === 0, failures };
}
