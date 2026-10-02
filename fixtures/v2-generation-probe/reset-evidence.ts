export const RESET_MEMORY_TEMPLATE = `<!-- stm:v1 -->
## Session Memory

### User Instructions
- None captured yet.

### Long Horizon Context
- None captured yet.

### Decisions
- None captured yet.

### Conclusions
- None captured yet.

### Active References
- None captured yet.
`;

export interface ResetEvidenceRecord {
  readonly event: string;
  readonly seq: number;
  readonly observedEvent?: string;
  readonly details?: Record<string, unknown>;
  readonly sentinel?: string;
  readonly id?: string;
}

export interface ResetEvidenceInput {
  readonly records: readonly ResetEvidenceRecord[];
  readonly resetBoundaryAnchor: string | undefined;
  readonly firstPrompt: string;
  readonly secondPrompt: string;
  readonly resetPrompt: string;
  readonly postResetPrompt: string;
  readonly postResetFollowupPrompt: string;
}

export interface ResetEvidenceResult {
  readonly failures: readonly string[];
  readonly confirmedAfterSeq?: number;
}

interface ExecutionEvidence {
  readonly seq: number;
  readonly phase: "before" | "after";
  readonly eventData: Record<string, unknown>;
  readonly memory: unknown;
  readonly checkpoint: unknown;
  readonly boundary: unknown;
}

function textSnapshot(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return left === right;
}

function executionEvidence(record: ResetEvidenceRecord): ExecutionEvidence | undefined {
  if (record.event !== "event.observed" || record.details === undefined) return undefined;
  if (record.observedEvent !== "tool.execute.before" && record.observedEvent !== "tool.execute.after") return undefined;
  const eventData = record.details.eventData;
  if (typeof eventData !== "object" || eventData === null || Array.isArray(eventData)) return undefined;
  return {
    seq: record.seq,
    phase: record.observedEvent.endsWith("before") ? "before" : "after",
    eventData: eventData as Record<string, unknown>,
    memory: record.details.memory,
    checkpoint: record.details.checkpoint,
    boundary: record.details.boundary,
  };
}

function isResetCall(evidence: ExecutionEvidence): boolean {
  return evidence.eventData.tool === "stm_memory_reset";
}

function confirmed(evidence: ExecutionEvidence, value: boolean): boolean {
  const input = evidence.eventData.input;
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    (input as { confirm?: unknown }).confirm === value
  );
}

function identity(evidence: ExecutionEvidence): string | undefined {
  const { sessionID, messageID, id, tool } = evidence.eventData;
  if ([sessionID, messageID, id, tool].some((value) => typeof value !== "string" || value.length === 0))
    return undefined;
  return `${sessionID}\u0000${messageID}\u0000${id}\u0000${tool}`;
}

function completed(evidence: ExecutionEvidence): boolean {
  return evidence.eventData.status === "completed";
}

function resultText(evidence: ExecutionEvidence): string {
  const result = evidence.eventData.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (typeof part === "object" && part !== null ? [(part as { text?: unknown }).text] : []))
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function conversationUpdate(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    return undefined;
  }
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const object = value as Record<string, unknown>;
    if (object.role === "user") {
      if (typeof object.content === "string") texts.push(object.content);
      else if (Array.isArray(object.content)) {
        const content = object.content
          .map((part) => (typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined))
          .filter((text): text is string => typeof text === "string")
          .join("");
        if (content !== "") texts.push(content);
      }
    }
  };
  visit(parsed);
  const updates = texts.flatMap((text) =>
    [...text.matchAll(/<conversation_update>\n([\s\S]*?)\n<\/conversation_update>/g)].map((match) => match[1]!),
  );
  return updates.length === 0 ? undefined : updates.join("\n");
}

function boundaryIsExact(value: unknown, anchor: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value) as { version?: unknown; anchorID?: unknown };
    return parsed.version === 1 && parsed.anchorID === anchor && Object.keys(parsed).length === 2;
  } catch {
    return false;
  }
}

export function evaluateResetEvidence(input: ResetEvidenceInput): ResetEvidenceResult {
  const failures: string[] = [];
  const sequenceNumbers = input.records.map((record) => record.seq);
  if (sequenceNumbers.some((seq) => !Number.isFinite(seq)))
    failures.push("evidence sequence contains a nonfinite value");
  if (new Set(sequenceNumbers).size !== sequenceNumbers.length) failures.push("evidence sequence contains duplicates");
  const executions = input.records
    .map(executionEvidence)
    .filter((value): value is ExecutionEvidence => value !== undefined);
  const resetExecutions = executions.filter(isResetCall);
  if (resetExecutions.length !== 4)
    failures.push("reset evidence must contain exactly one refusal and one confirmed pair");
  const byIdentity = new Map<string, { before?: ExecutionEvidence; after?: ExecutionEvidence }>();
  for (const execution of resetExecutions) {
    const key = identity(execution);
    if (key === undefined) continue;
    const pair = byIdentity.get(key) ?? {};
    pair[execution.phase] = execution;
    byIdentity.set(key, pair);
  }
  const pairs = [...byIdentity.values()];
  if (pairs.length !== 2 || pairs.some((pair) => pair.before === undefined || pair.after === undefined))
    failures.push("reset evidence contains an incomplete or duplicate call identity");
  const refusal = pairs.find(
    (pair) => pair.before !== undefined && pair.after !== undefined && confirmed(pair.before, false),
  );
  const confirmation = pairs.find(
    (pair) => pair.before !== undefined && pair.after !== undefined && confirmed(pair.before, true),
  );
  if (refusal?.before === undefined || refusal.after === undefined) failures.push("refusal snapshots are incomplete");
  else {
    if (!completed(refusal.after) || !confirmed(refusal.after, false))
      failures.push("refusal completion evidence is invalid");
    if (textSnapshot(refusal.before.memory) === undefined || textSnapshot(refusal.after.memory) === undefined) {
      failures.push("refusal memory snapshot was not observed");
    }
    if (textSnapshot(refusal.before.checkpoint) === undefined || textSnapshot(refusal.after.checkpoint) === undefined) {
      failures.push("refusal checkpoint snapshot was not observed");
    }
    if (
      !sameSnapshot(refusal.before.memory, refusal.after.memory) ||
      !sameSnapshot(refusal.before.checkpoint, refusal.after.checkpoint) ||
      !sameSnapshot(refusal.before.boundary, refusal.after.boundary)
    ) {
      failures.push("refusal changed persisted reset state");
    }
    if (!resultText(refusal.after).startsWith("Refused to reset V2 short-term memory:"))
      failures.push("refusal result text is invalid");
  }
  if (confirmation?.before === undefined || confirmation.after === undefined)
    failures.push("confirmed reset snapshots are incomplete");
  else {
    const { before, after } = confirmation;
    if (!completed(after) || !confirmed(after, true)) failures.push("confirmed reset completion evidence is invalid");
    if (input.resetBoundaryAnchor === undefined || before.eventData.messageID !== input.resetBoundaryAnchor) {
      failures.push("confirmed tool context messageID does not equal reset boundary anchor");
    }
    if (textSnapshot(after.memory) !== RESET_MEMORY_TEMPLATE)
      failures.push("confirmed reset memory snapshot is not the standard template");
    if (textSnapshot(after.checkpoint) !== "") failures.push("confirmed reset did not clear checkpoint");
    if (input.resetBoundaryAnchor === undefined || !boundaryIsExact(after.boundary, input.resetBoundaryAnchor)) {
      failures.push("confirmed reset boundary is invalid");
    }
    if (!resultText(after).includes(`resetBoundaryAnchor: ${input.resetBoundaryAnchor ?? ""}`))
      failures.push("confirmed reset result anchor is invalid");
  }
  const confirmedAfterSeq = confirmation?.after?.seq;
  if (
    refusal?.before !== undefined &&
    refusal.after !== undefined &&
    confirmation?.before !== undefined &&
    confirmation.after !== undefined &&
    !(
      refusal.before.seq < refusal.after.seq &&
      refusal.after.seq < confirmation.before.seq &&
      confirmation.before.seq < confirmation.after.seq
    )
  ) {
    failures.push("reset evidence phases are not strictly ordered");
  }
  const summarizers = input.records.filter(
    (record) =>
      record.event === "model.invocation" &&
      typeof record.sentinel === "string" &&
      record.sentinel.startsWith("## Session Memory"),
  );
  const postResetSummarizers = summarizers.filter(
    (record) => confirmedAfterSeq !== undefined && record.seq > confirmedAfterSeq,
  );
  if (postResetSummarizers.length === 0) failures.push("post-reset memory summarizer invocation was not observed");
  let postResetPromptObserved = false;
  let postResetFollowupObserved = false;
  for (const record of postResetSummarizers) {
    const update = conversationUpdate(record.details?.prompt);
    if (update?.includes(input.postResetPrompt)) postResetPromptObserved = true;
    if (update?.includes(input.postResetFollowupPrompt)) postResetFollowupObserved = true;
    if (
      update === undefined ||
      update.includes(input.firstPrompt) ||
      update.includes(input.secondPrompt) ||
      update.includes(input.resetPrompt)
    ) {
      failures.push("post-reset summarizer input contains non-post-reset conversation");
    }
  }
  if (postResetSummarizers.length > 0 && !postResetPromptObserved)
    failures.push("post-reset conversation prompt was not observed");
  if (postResetSummarizers.length > 0 && !postResetFollowupObserved)
    failures.push("post-reset followup conversation prompt was not observed");
  if (
    confirmedAfterSeq !== undefined &&
    !input.records.some(
      (record) =>
        record.event === "message.snapshot" &&
        record.seq > confirmedAfterSeq &&
        record.id === input.resetBoundaryAnchor,
    )
  ) {
    failures.push("reset boundary anchor is absent from subsequent raw message snapshots");
  }
  return { failures, ...(confirmedAfterSeq === undefined ? {} : { confirmedAfterSeq }) };
}
