import { expect, test } from "bun:test";

import { evaluateResetEvidence, RESET_MEMORY_TEMPLATE, type ResetEvidenceRecord } from "./reset-evidence.js";

const anchor = "msg-anchor";
const options = {
  resetBoundaryAnchor: anchor,
  firstPrompt: "First ordinary production update probe turn.",
  secondPrompt: "Second ordinary production update probe turn.",
  resetPrompt: "Use stm_memory_reset to reset this session. Confirm only after the first refusal.",
  postResetPrompt: "Continue after the confirmed reset with a fresh post-reset message.",
  postResetFollowupPrompt: "Acknowledge the post-reset continuation with one final ordinary response.",
};

function prompt(update: string): string {
  return JSON.stringify([{ role: "user", content: `<conversation_update>\n${update}\n</conversation_update>` }]);
}

function execution(
  seq: number,
  phase: "before" | "after",
  confirm: boolean,
  snapshots: { readonly memory: string; readonly checkpoint: string | null; readonly boundary: string | null },
  extra: Record<string, unknown> = {},
): ResetEvidenceRecord {
  return {
    event: "event.observed",
    observedEvent: `tool.execute.${phase}`,
    seq,
    details: {
      eventData: {
        tool: "stm_memory_reset",
        sessionID: "session",
        messageID: confirm ? anchor : "msg-refusal",
        id: confirm ? "call-confirmed" : "call-refusal",
        input: { confirm },
        ...(phase === "after"
          ? {
              status: "completed",
              result: {
                content: [
                  {
                    type: "text",
                    text: confirm
                      ? `resetBoundaryAnchor: ${anchor}`
                      : "Refused to reset V2 short-term memory: set confirm to literal true.",
                  },
                ],
              },
            }
          : {}),
        ...extra,
      },
      ...snapshots,
    },
  };
}

function validRecords(): ResetEvidenceRecord[] {
  const oldMemory = "old memory";
  return [
    execution(1, "before", false, { memory: oldMemory, checkpoint: "old-checkpoint", boundary: null }),
    execution(2, "after", false, { memory: oldMemory, checkpoint: "old-checkpoint", boundary: null }),
    execution(3, "before", true, { memory: oldMemory, checkpoint: "old-checkpoint", boundary: null }),
    execution(4, "after", true, {
      memory: RESET_MEMORY_TEMPLATE,
      checkpoint: "",
      boundary: `{"version":1,"anchorID":"${anchor}"}`,
    }),
    {
      event: "model.invocation",
      seq: 5,
      sentinel: "## Session Memory\n",
      details: {
        prompt: prompt(
          "ASSISTANT\nContinue after the confirmed reset with a fresh post-reset message.\nAcknowledge the post-reset continuation with one final ordinary response.",
        ),
      },
    },
    { event: "message.snapshot", seq: 6, id: anchor },
  ];
}

test("accepts realistic nested refusal and confirmed reset evidence", () => {
  expect(evaluateResetEvidence({ ...options, records: validRecords() })).toEqual({
    failures: [],
    confirmedAfterSeq: 4,
  });
});

test.each([
  [
    "wrong anchor",
    { resetBoundaryAnchor: "other" },
    "confirmed tool context messageID does not equal reset boundary anchor",
  ],
  ["wrong status", {}, "confirmed reset completion evidence is invalid"],
  ["no confirmed call", {}, "confirmed reset snapshots are incomplete"],
  ["altered refusal", {}, "refusal changed persisted reset state"],
  ["pre-reset summarizer only", {}, "post-reset memory summarizer invocation was not observed"],
  ["missing anchor snapshot", {}, "reset boundary anchor is absent from subsequent raw message snapshots"],
] as const)("rejects %s", (name, mutation, expected) => {
  const records = validRecords();
  if (name === "wrong status") {
    const confirmedAfter = records[3]!;
    (confirmedAfter.details!.eventData as Record<string, unknown>).status = "failed";
  } else if (name === "no confirmed call") {
    records.splice(2, 2);
  } else if (name === "altered refusal") {
    records[1] = { ...records[1]!, details: { ...records[1]!.details, checkpoint: "changed" } };
  } else if (name === "pre-reset summarizer only") {
    records[4] = { ...records[4]!, seq: 2 };
  } else if (name === "missing anchor snapshot") {
    records.pop();
  }
  const result = evaluateResetEvidence({ ...options, ...mutation, records });
  expect(result.failures).toContain(expected);
});

test("rejects prompt prefix contamination and an altered boundary", () => {
  const records = validRecords();
  records[4] = {
    ...records[4]!,
    details: {
      prompt: prompt(
        "First ordinary production update probe turn.\nContinue after the confirmed reset with a fresh post-reset message.",
      ),
    },
  };
  records[3] = {
    ...records[3]!,
    details: { ...records[3]!.details, boundary: `{"version":2,"anchorID":"${anchor}"}` },
  };
  const result = evaluateResetEvidence({ ...options, records });
  expect(result.failures).toContain("confirmed reset boundary is invalid");
  expect(result.failures).toContain("post-reset summarizer input contains non-post-reset conversation");
});

test("rejects a post-reset summarizer that omits the new prompt", () => {
  const records = validRecords();
  records[4] = {
    ...records[4]!,
    details: { prompt: prompt("Acknowledge the post-reset continuation with one final ordinary response.") },
  };
  expect(evaluateResetEvidence({ ...options, records }).failures).toContain(
    "post-reset conversation prompt was not observed",
  );
});

test("does not pair reset events when session identity differs", () => {
  const records = validRecords();
  records[3] = {
    ...records[3]!,
    details: {
      ...records[3]!.details,
      eventData: { ...(records[3]!.details!.eventData as Record<string, unknown>), sessionID: "other-session" },
    },
  };
  expect(evaluateResetEvidence({ ...options, records }).failures).toContain("confirmed reset snapshots are incomplete");
});

test("rejects duplicate reset evidence and non-post-reset contamination in multiple updates", () => {
  const records = validRecords();
  records.splice(1, 0, { ...records[1]! });
  records[5] = {
    ...records[5]!,
    details: {
      prompt: JSON.stringify([
        {
          role: "user",
          content: `<conversation_update>\n${options.postResetPrompt}\n${options.postResetFollowupPrompt}\n</conversation_update>`,
        },
        { role: "user", content: `<conversation_update>\n${options.firstPrompt}\n</conversation_update>` },
      ]),
    },
  };
  const failures = evaluateResetEvidence({ ...options, records }).failures;
  expect(failures).toContain("reset evidence must contain exactly one refusal and one confirmed pair");
  expect(failures).toContain("post-reset summarizer input contains non-post-reset conversation");
});

test("rejects reordered phases and raw snapshot whitespace mutation", () => {
  const records = validRecords();
  records[1] = { ...records[1]!, seq: 5 };
  records[3] = { ...records[3]!, details: { ...records[3]!.details, memory: `${RESET_MEMORY_TEMPLATE} ` } };
  const failures = evaluateResetEvidence({ ...options, records }).failures;
  expect(failures).toContain("reset evidence phases are not strictly ordered");
  expect(failures).toContain("confirmed reset memory snapshot is not the standard template");
});

test("rejects a post-reset summarizer that omits the required follow-up", () => {
  const records = validRecords();
  records[4] = { ...records[4]!, details: { prompt: prompt(options.postResetPrompt) } };
  expect(evaluateResetEvidence({ ...options, records }).failures).toContain(
    "post-reset followup conversation prompt was not observed",
  );
});
