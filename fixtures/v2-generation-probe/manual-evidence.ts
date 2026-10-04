import { RESET_MEMORY_TEMPLATE, type ResetEvidenceRecord } from "./reset-evidence.js";

export const MANUAL_SEED_PROMPT = "Manual acceptance pre-reset settled seed.";
export const MANUAL_FIRST_PROMPT = "STM_MANUAL_FIRST: call stm_memory_update with empty input now.";
export const MANUAL_POST_RESET_PROMPT = "Manual acceptance post-reset settled content.";
export const MANUAL_SECOND_PROMPT = "STM_MANUAL_SECOND: call stm_memory_update with empty input now.";
export const MANUAL_RESET_PROMPT = "Use stm_memory_reset to reset this session. Confirm only after the first refusal.";
export const MANUAL_CALL_IDS = ["stm-probe-manual-first", "stm-probe-manual-second"] as const;

type ObjectRecord = Record<string, unknown>;
function object(value: unknown): ObjectRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ObjectRecord) : undefined;
}

export interface ManualEvidenceInput {
  readonly records: readonly (ResetEvidenceRecord & { readonly provider?: string; readonly model?: string })[];
  readonly sessionID: string;
  readonly runId: string;
  readonly suppressionObserved: boolean;
  readonly finalCheckpoint: string;
  readonly finalBoundary: string | undefined;
}

interface Execution {
  seq: number;
  phase: "before" | "after";
  data: ObjectRecord;
  snapshot: ObjectRecord;
}

function resultText(data: ObjectRecord): string {
  const content = object(data.result)?.content;
  return Array.isArray(content)
    ? content
        .map((part) => object(part)?.text)
        .filter((text): text is string => typeof text === "string")
        .join("\n")
    : "";
}

// Independent fixture projection: preserve host ordering and stop at the pending caller.
function settled(
  snapshot: ObjectRecord,
  callerID: unknown,
): { checkpoint: string; update: string; count: number } | undefined {
  if (!Array.isArray(snapshot.hostHistory)) return undefined;
  const ids = new Set<string>();
  const entries: { id: string; text: string }[] = [];
  let stopped = false;
  let boundaryAnchor: string | undefined;
  if (typeof snapshot.boundary === "string") {
    try {
      boundaryAnchor = object(JSON.parse(snapshot.boundary))?.anchorID as string | undefined;
    } catch {
      return undefined;
    }
    if (typeof boundaryAnchor !== "string") return undefined;
  } else if (snapshot.boundary !== null) return undefined;
  let boundarySeen = boundaryAnchor === undefined;
  for (const raw of snapshot.hostHistory) {
    const record = object(raw);
    const time = object(record?.time);
    if (
      record === undefined ||
      typeof record.id !== "string" ||
      !record.id.startsWith("msg_") ||
      ids.has(record.id) ||
      typeof time?.created !== "number" ||
      !Number.isFinite(time.created)
    )
      return undefined;
    ids.add(record.id);
    if (record.type === "assistant" && time.completed === undefined) {
      if (record.id !== callerID) return undefined;
      stopped = true;
      break;
    }
    if (!boundarySeen) {
      if (record.id === boundaryAnchor) boundarySeen = true;
      continue;
    }
    if (record.type === "user") {
      if (typeof record.text !== "string") return undefined;
      if (record.text !== "") entries.push({ id: record.id, text: `USER:\n${record.text}` });
    } else if (record.type === "assistant") {
      if (typeof time.completed !== "number" || !Number.isFinite(time.completed) || !Array.isArray(record.content))
        return undefined;
      const texts: string[] = [];
      for (const rawPart of record.content) {
        const part = object(rawPart);
        if (part === undefined) return undefined;
        if (part.type === "text") {
          if (typeof part.text !== "string") return undefined;
          texts.push(part.text);
        } else if (part.type !== "tool" && part.type !== "reasoning") return undefined;
      }
      if (texts.join("") !== "") entries.push({ id: record.id, text: `ASSISTANT:\n${texts.join("")}` });
    } else if (
      ![
        "idle",
        "synthetic",
        "system",
        "skill",
        "agent-switched",
        "model-switched",
        "location-switched",
        "shell",
        "compaction",
      ].includes(String(record.type))
    )
      return undefined;
  }
  if (!stopped || !boundarySeen || entries.length === 0) return undefined;
  return {
    checkpoint: entries.at(-1)!.id,
    update: entries.map((entry) => entry.text).join("\n\n---\n\n"),
    count: entries.length,
  };
}

function conversationUpdate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const prompt: unknown = JSON.parse(value);
    if (!Array.isArray(prompt)) return undefined;
    const updates: string[] = [];
    for (const raw of prompt) {
      const message = object(raw);
      if (message?.role !== "user") continue;
      const content = message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => object(part)?.text ?? "").join("")
            : "";
      for (const match of text.matchAll(/<conversation_update>\n([\s\S]*?)\n<\/conversation_update>/g))
        updates.push(match[1]!);
    }
    return updates.length === 1 ? updates[0] : undefined;
  } catch {
    return undefined;
  }
}

export function evaluateManualEvidence(input: ManualEvidenceInput): { failures: string[] } {
  const failures: string[] = [];
  const require = (condition: unknown, message: string) => {
    if (!condition) failures.push(message);
  };
  require(input.suppressionObserved, "manual production context suppression marker missing");
  const suppression = input.records.filter((record) => record.observedEvent === "manual.automatic-context-suppression");
  require(suppression.length === 1 &&
    suppression[0]?.details?.scope === "production.session.context" &&
    suppression[0]?.details?.strategy === "registered-no-op", "manual telemetry suppression marker missing or invalid");
  require(input.records.every(
    (record, index) =>
      Number.isInteger(record.seq) && record.seq > 0 && (index === 0 || record.seq > input.records[index - 1]!.seq),
  ), "manual evidence sequence is not unique and strictly ordered");
  const executions: Execution[] = [];
  for (const record of input.records) {
    if (record.event !== "event.observed" || !/^tool.execute\.(before|after)$/.test(record.observedEvent ?? ""))
      continue;
    const data = object(record.details?.eventData);
    if (data?.tool !== "stm_memory_update" && data?.tool !== "stm_memory_reset") continue;
    require(["memory", "checkpoint", "boundary"].every(
      (key) => record.details?.[key] === null || typeof record.details?.[key] === "string",
    ), "manual persistence snapshot missing or malformed");
    executions.push({
      seq: record.seq,
      phase: record.observedEvent === "tool.execute.before" ? "before" : "after",
      data,
      snapshot: record.details!,
    });
  }
  const calls = [MANUAL_CALL_IDS[0], "stm-probe-reset-refusal", "stm-probe-reset-confirmed", MANUAL_CALL_IDS[1]];
  require(executions.length === 8, "manual scenario requires exactly four execution pairs");
  const pairs = calls.map((id, index) => {
    const matching = executions.filter((entry) => entry.data.id === id);
    const before = matching.filter((entry) => entry.phase === "before");
    const after = matching.filter((entry) => entry.phase === "after");
    require(before.length === 1 && after.length === 1, `manual call ${id} has missing or duplicate pair`);
    if (before.length !== 1 || after.length !== 1) return undefined;
    const b = before[0]!,
      a = after[0]!;
    const tool = index === 0 || index === 3 ? "stm_memory_update" : "stm_memory_reset";
    require(b.seq < a.seq, `manual call ${id} pair out of order`);
    require([b, a].every(
      (entry) =>
        entry.data.sessionID === input.sessionID &&
        entry.data.tool === tool &&
        typeof entry.data.messageID === "string" &&
        entry.data.messageID.startsWith("msg_") &&
        object(entry.snapshot.hostSession)?.id === input.sessionID &&
        object(object(entry.snapshot.hostSession)?.model)?.id === "deterministic" &&
        object(object(entry.snapshot.hostSession)?.model)?.providerID === "stm-probe" &&
        Array.isArray(entry.snapshot.hostHistory),
    ), `manual call ${id} host identity/history/model mismatch`);
    require(b.data.messageID === a.data.messageID &&
      a.data.status === "completed", `manual call ${id} completion identity/status mismatch`);
    require(b.data.snapshotPhase === "before" &&
      a.data.snapshotPhase === "after", `manual call ${id} snapshot phase mismatch`);
    require(JSON.stringify(b.data.input) === JSON.stringify(a.data.input), `manual call ${id} input changed`);
    return { before: b, after: a };
  });
  for (let index = 1; index < pairs.length; index++) {
    const previous = pairs[index - 1],
      current = pairs[index];
    if (previous && current) {
      require(previous.after.seq < current.before.seq, "manual scenario pairs out of order");
      require(["memory", "checkpoint", "boundary"].every(
        (key) => previous.after.snapshot[key] === current.before.snapshot[key],
      ), "persisted state changed outside tool execution");
    }
  }
  const first = pairs[0],
    refusal = pairs[1],
    reset = pairs[2],
    second = pairs[3];
  require(new Set(pairs.filter((pair) => pair !== undefined).map((pair) => pair.before.data.messageID)).size ===
    4, "manual scenario must use distinct host caller message IDs");
  if (first)
    require(suppression.length === 1 &&
      suppression[0]!.seq < first.before.seq, "manual suppression not recorded before first execution");
  if (first)
    require(first.before.snapshot.checkpoint === null &&
      first.before.snapshot.boundary === null, "first manual checkpoint/boundary must be absent before execution");
  if (refusal) {
    require(object(refusal.before.data.input)?.confirm === false &&
      object(refusal.after.data.input)?.confirm === false, "reset refusal input invalid");
    require(resultText(refusal.after.data).startsWith(
      "Refused to reset V2 short-term memory:",
    ), "reset refusal response invalid");
    require(["memory", "checkpoint", "boundary"].every(
      (key) => refusal.before.snapshot[key] === refusal.after.snapshot[key],
    ), "reset refusal mutated persistence");
  }
  let boundary: string | undefined;
  if (reset) {
    boundary = typeof reset.after.snapshot.boundary === "string" ? reset.after.snapshot.boundary : undefined;
    let parsed: ObjectRecord | undefined;
    try {
      parsed = object(JSON.parse(boundary ?? ""));
    } catch {
      /* Report malformed boundary below. */
    }
    require(object(reset.before.data.input)?.confirm === true &&
      object(reset.after.data.input)?.confirm === true, "confirmed reset input invalid");
    require(reset.after.snapshot.memory === RESET_MEMORY_TEMPLATE &&
      reset.after.snapshot.checkpoint === "", "confirmed reset did not restore exact template and clear checkpoint");
    require(parsed?.version === 1 &&
      parsed.anchorID === reset.before.data.messageID &&
      Object.keys(parsed).length === 2, "confirmed reset boundary does not equal exact caller anchor");
    const lines = resultText(reset.after.data).split("\n");
    require([
      "generation: v2",
      "reset: completed",
      `authoritative sessionID: ${input.sessionID}`,
      `resetBoundaryAnchor: ${reset.before.data.messageID}`,
    ].every((line) => lines.includes(line)), "confirmed reset response invalid");
  }
  const summarizers = input.records.filter(
    (record) => record.event === "model.invocation" && record.sentinel?.startsWith("## Session Memory"),
  );
  require(summarizers.length === 2, "manual scenario requires exactly two summarizer invocations");
  for (const [index, pair] of [first, second].entries()) {
    if (!pair) continue;
    const { before, after } = pair;
    const emitted = input.records.filter(
      (record) =>
        record.event === "model.invocation" && object(record.details?.toolCall)?.toolCallId === before.data.id,
    );
    require(emitted.length === 1 &&
      emitted[0]!.seq < before.seq &&
      object(emitted[0]!.details?.toolCall)?.toolName === "stm_memory_update" &&
      JSON.stringify(object(emitted[0]!.details?.toolCall)?.input) ===
        "{}", "manual real provider call missing or duplicate");
    require(object(before.data.input) !== undefined &&
      Object.keys(object(before.data.input)!).length === 0, "manual input must be empty");
    const prefix = settled(before.snapshot, before.data.messageID);
    require(prefix !== undefined, "manual raw history is not a valid settled prefix with pending caller");
    const afterPrefix = settled(after.snapshot, after.data.messageID);
    require(prefix !== undefined &&
      afterPrefix !== undefined &&
      JSON.stringify(prefix) ===
        JSON.stringify(
          afterPrefix,
        ), "manual settled host history changed during execution or after snapshot is invalid");
    require(before.snapshot.boundary === after.snapshot.boundary, "manual update changed reset boundary");
    require(typeof after.snapshot.memory === "string" &&
      after.snapshot.memory.includes(`STM_PROBE_MEMORY_SENTINEL:${input.runId}`), "manual memory sentinel missing");
    const lines = resultText(after.data).split(/\r?\n/);
    require([
      "generation: v2",
      "update: committed",
      "reason: delta_exhausted",
      "source: durable-visible-text",
      `sessionID: ${input.sessionID}`,
      `stoppedBeforeMessageID: ${before.data.messageID}`,
      "rollback: not-applicable",
      "detail: none",
    ].every(
      (line) => lines.filter((value) => value === line).length === 1,
    ), "manual response not truthful committed settled-prefix result");
    if (prefix) {
      require(after.snapshot.checkpoint === `${prefix.checkpoint}\n` &&
        prefix.checkpoint !== before.data.messageID, "manual checkpoint does not equal settled prefix");
      require(lines.includes(
        `progress: cumulative-invocation ${JSON.stringify({ checkpointedChunks: 1, checkpointedMessages: prefix.count, persistedPartialFragments: 0 })}`,
      ), "manual committed progress mismatch");
      const bracketed = summarizers.filter((record) => record.seq > before.seq && record.seq < after.seq);
      require(bracketed.length === 1, "manual summarizer not uniquely bracketed by execution");
      const summarizer = bracketed[0];
      require(summarizer?.provider === "stm-probe" &&
        summarizer.model === "deterministic" &&
        Array.isArray(summarizer.details?.toolNames) &&
        summarizer.details.toolNames.length === 0, "manual summarizer provider/model/tools mismatch");
      require(conversationUpdate(summarizer?.details?.prompt) ===
        prefix.update, "manual summarizer input differs from exact settled prefix");
      // The reset turn emits a settled text response after its confirmed tool-call anchor.
      const expected = `${index === 1 ? "ASSISTANT:\nSTM_PROBE_STREAM_SENTINEL\n\n---\n\n" : ""}USER:\n${index === 0 ? MANUAL_SEED_PROMPT : MANUAL_POST_RESET_PROMPT}\n\n---\n\nASSISTANT:\nSTM_PROBE_STREAM_SENTINEL\n\n---\n\nUSER:\n${index === 0 ? MANUAL_FIRST_PROMPT : MANUAL_SECOND_PROMPT}`;
      require(prefix.update === expected, "manual settled prefix contains old, missing, pending or future text");
    }
    if (index === 1)
      require(before.snapshot.checkpoint === "" &&
        before.snapshot.boundary === boundary &&
        boundary !== undefined, "post-reset manual did not start at cleared checkpoint and retained boundary");
  }
  if (second)
    require(second.after.snapshot.checkpoint === `${input.finalCheckpoint}\n` &&
      second.after.snapshot.boundary === input.finalBoundary &&
      input.finalBoundary === boundary, "manual final persistence differs from second committed snapshot");
  return { failures };
}
