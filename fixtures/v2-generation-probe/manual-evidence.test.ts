import { expect, test } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { manualToolDispatch } from "./index.js";
import { RESET_MEMORY_TEMPLATE } from "./reset-evidence.js";
import {
  evaluateManualEvidence,
  MANUAL_CALL_IDS,
  MANUAL_FIRST_PROMPT,
  MANUAL_SECOND_PROMPT,
  MANUAL_SEED_PROMPT,
  MANUAL_POST_RESET_PROMPT,
  MANUAL_RESET_PROMPT,
  type ManualEvidenceInput,
} from "./manual-evidence.js";

const sessionID = "ses_manual";
const model = { providerID: "stm-probe", id: "deterministic" };
const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 1 } });
const assistant = (id: string, pending = false) => ({
  id,
  type: "assistant",
  agent: "build",
  model,
  time: pending ? { created: 1 } : { created: 1, completed: 2 },
  content: [{ type: "text", text: pending ? "PENDING MUST NOT ENTER MEMORY" : "STM_PROBE_STREAM_SENTINEL" }],
});

function valid(): ManualEvidenceInput {
  const records: ManualEvidenceInput["records"][number][] = [];
  const emit = (record: Omit<ManualEvidenceInput["records"][number], "seq">) =>
    records.push({ ...record, seq: records.length + 1 });
  const memory = "## Session Memory\nSTM_PROBE_MEMORY_SENTINEL:run-manual";
  const boundary = JSON.stringify({ version: 1, anchorID: "msg_reset_confirm" });
  emit({
    event: "event.observed",
    observedEvent: "manual.automatic-context-suppression",
    details: { scope: "production.session.context", strategy: "registered-no-op" },
  });
  const seed = [user("msg_seed", MANUAL_SEED_PROMPT), assistant("msg_seed_assistant")];
  const firstHistory = [...seed, user("msg_first_user", MANUAL_FIRST_PROMPT), assistant("msg_first_pending", true)];
  const resetHistory = [
    ...seed,
    user("msg_first_user", MANUAL_FIRST_PROMPT),
    assistant("msg_first_pending"),
    user("msg_reset_user", MANUAL_RESET_PROMPT),
    assistant("msg_reset_refusal"),
    assistant("msg_reset_confirm", true),
  ];
  const secondHistory = [
    ...resetHistory.slice(0, -1),
    assistant("msg_reset_confirm"),
    assistant("msg_reset_response"),
    user("msg_post", MANUAL_POST_RESET_PROMPT),
    assistant("msg_post_assistant"),
    user("msg_second_user", MANUAL_SECOND_PROMPT),
    assistant("msg_second_pending", true),
    user("msg_future", "FUTURE MUST NOT ENTER MEMORY"),
  ];
  const snapshot = (
    history: unknown[],
    memoryValue: string | null,
    checkpoint: string | null,
    boundaryValue: string | null,
  ) => ({
    hostHistory: history,
    hostSession: { id: sessionID, model },
    memory: memoryValue,
    checkpoint,
    boundary: boundaryValue,
  });
  const execution = (
    phase: "before" | "after",
    id: string,
    messageID: string,
    tool: string,
    input: Record<string, unknown>,
    state: Record<string, unknown>,
    text = "",
  ) =>
    emit({
      event: "event.observed",
      observedEvent: `tool.execute.${phase}`,
      details: {
        ...state,
        eventData: {
          id,
          messageID,
          sessionID,
          tool,
          input,
          snapshotPhase: phase,
          ...(phase === "after" ? { status: "completed", result: { content: [{ type: "text", text }] } } : {}),
        },
      },
    });
  const response = (caller: string, count = 3) =>
    [
      "generation: v2",
      `sessionID: ${sessionID}`,
      "update: committed",
      "reason: delta_exhausted",
      "source: durable-visible-text",
      `stoppedBeforeMessageID: ${caller}`,
      `progress: cumulative-invocation {"checkpointedChunks":1,"checkpointedMessages":${count},"persistedPartialFragments":0}`,
      "rollback: not-applicable",
      "detail: none",
    ].join("\n");
  const summarizer = (seedText: string, prompt: string, afterReset = false) =>
    emit({
      event: "model.invocation",
      provider: "stm-probe",
      model: "deterministic",
      sentinel: memory,
      details: {
        toolNames: [],
        prompt: JSON.stringify([
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<conversation_update>\n${afterReset ? "ASSISTANT:\nSTM_PROBE_STREAM_SENTINEL\n\n---\n\n" : ""}USER:\n${seedText}\n\n---\n\nASSISTANT:\nSTM_PROBE_STREAM_SENTINEL\n\n---\n\nUSER:\n${prompt}\n</conversation_update>`,
              },
            ],
          },
        ]),
      },
    });
  execution(
    "before",
    MANUAL_CALL_IDS[0],
    "msg_first_pending",
    "stm_memory_update",
    {},
    snapshot(firstHistory, null, null, null),
  );
  summarizer(MANUAL_SEED_PROMPT, MANUAL_FIRST_PROMPT);
  execution(
    "after",
    MANUAL_CALL_IDS[0],
    "msg_first_pending",
    "stm_memory_update",
    {},
    snapshot(firstHistory, memory, "msg_first_user\n", null),
    response("msg_first_pending"),
  );
  execution(
    "before",
    "stm-probe-reset-refusal",
    "msg_reset_refusal",
    "stm_memory_reset",
    { confirm: false },
    snapshot(resetHistory, memory, "msg_first_user\n", null),
  );
  execution(
    "after",
    "stm-probe-reset-refusal",
    "msg_reset_refusal",
    "stm_memory_reset",
    { confirm: false },
    snapshot(resetHistory, memory, "msg_first_user\n", null),
    "Refused to reset V2 short-term memory: set confirm to literal true.",
  );
  execution(
    "before",
    "stm-probe-reset-confirmed",
    "msg_reset_confirm",
    "stm_memory_reset",
    { confirm: true },
    snapshot(resetHistory, memory, "msg_first_user\n", null),
  );
  execution(
    "after",
    "stm-probe-reset-confirmed",
    "msg_reset_confirm",
    "stm_memory_reset",
    { confirm: true },
    snapshot(resetHistory, RESET_MEMORY_TEMPLATE, "", boundary),
    `generation: v2\nreset: completed\nauthoritative sessionID: ${sessionID}\nresetBoundaryAnchor: msg_reset_confirm`,
  );
  execution(
    "before",
    MANUAL_CALL_IDS[1],
    "msg_second_pending",
    "stm_memory_update",
    {},
    snapshot(secondHistory, RESET_MEMORY_TEMPLATE, "", boundary),
  );
  summarizer(MANUAL_POST_RESET_PROMPT, MANUAL_SECOND_PROMPT, true);
  execution(
    "after",
    MANUAL_CALL_IDS[1],
    "msg_second_pending",
    "stm_memory_update",
    {},
    snapshot(secondHistory, memory, "msg_second_user\n", boundary),
    response("msg_second_pending", 4),
  );
  // Add provider calls while keeping mutation tests' base sequence references stable.
  for (const [seq, id] of [
    [2, MANUAL_CALL_IDS[0]],
    [9, MANUAL_CALL_IDS[1]],
  ] as const) {
    records.push({
      event: "model.invocation",
      seq: seq - 0.2,
      details: { toolCall: { toolCallId: id, toolName: "stm_memory_update", input: {} } },
    });
  }
  records.sort((a, b) => a.seq - b.seq);
  // Leave room for inserted records without weakening the integer sequence contract.
  for (const record of records) (record as { seq: number }).seq *= 5;
  return {
    records,
    sessionID,
    runId: "run-manual",
    suppressionObserved: true,
    finalCheckpoint: "msg_second_user",
    finalBoundary: boundary,
  };
}

test("manual evidence accepts causal commits with exact history and reset boundary", () => {
  expect(evaluateManualEvidence(valid()).failures).toEqual([]);
});

test("manual evaluator requires the settled post-anchor reset response even with consistent snapshots and progress", () => {
  const input = structuredClone(valid());
  for (const record of input.records) {
    if (Array.isArray(record.details?.hostHistory)) {
      record.details.hostHistory = record.details.hostHistory.filter(
        (message: { id: string }) => message.id !== "msg_reset_response",
      );
    }
    if (record.seq === 50) {
      record.details!.prompt = String(record.details!.prompt).replace(
        "ASSISTANT:\\nSTM_PROBE_STREAM_SENTINEL\\n\\n---\\n\\n",
        "",
      );
    }
    if (record.seq === 55) {
      const data = record.details!.eventData as { result: { content: { text: string }[] } };
      data.result.content[0]!.text = data.result.content[0]!.text.replace(
        '"checkpointedMessages":4',
        '"checkpointedMessages":3',
      );
    }
  }
  expect(evaluateManualEvidence(input).failures).toEqual([
    "manual settled prefix contains old, missing, pending or future text",
  ]);
});

for (const replacement of [
  MANUAL_SEED_PROMPT,
  MANUAL_FIRST_PROMPT,
  MANUAL_RESET_PROMPT,
  "PENDING MUST NOT ENTER MEMORY",
  "FUTURE MUST NOT ENTER MEMORY",
]) {
  test(`manual evaluator rejects contaminated post-anchor reset response: ${replacement}`, () => {
    const input = structuredClone(valid());
    for (const record of input.records) {
      const history = record.details?.hostHistory as { id: string; content?: { text: string }[] }[] | undefined;
      const response = history?.find((message) => message.id === "msg_reset_response");
      if (response?.content) response.content[0]!.text = replacement;
      if (record.seq === 50) {
        record.details!.prompt = String(record.details!.prompt).replace("STM_PROBE_STREAM_SENTINEL", replacement);
      }
    }
    expect(evaluateManualEvidence(input).failures).toContain(
      "manual settled prefix contains old, missing, pending or future text",
    );
  });
}

const mutations: Record<string, (input: ManualEvidenceInput) => ManualEvidenceInput> = {
  "missing pair": (input) => ({ ...input, records: input.records.filter((record) => record.seq !== 10) }),
  "duplicate pair": (input) => ({
    ...input,
    records: [...input.records, { ...input.records.find((record) => record.seq === 10)!, seq: 60 }],
  }),
  "out of order pair": (input) => ({
    ...input,
    records: input.records.map((record) => ({
      ...record,
      seq: record.seq === 10 ? 20 : record.seq === 20 ? 10 : record.seq,
    })),
  }),
  "wrong session": (input) => ({ ...input, sessionID: "ses_wrong" }),
  "missing disk suppression": (input) => ({ ...input, suppressionObserved: false }),
  "missing telemetry suppression": (input) => ({ ...input, records: input.records.slice(1) }),
  "wrong final checkpoint": (input) => ({ ...input, finalCheckpoint: "msg_future" }),
  "unbracketed summarizer": (input) => {
    const summarizer = input.records.find((record) => record.seq === 15)!;
    const records = input.records.filter((record) => record !== summarizer);
    records.splice(
      records.findIndex((record) => record.seq === 25),
      0,
      { ...summarizer, seq: 21 },
    );
    return { ...input, records };
  },
  "wrong summarizer model": (input) => ({
    ...input,
    records: input.records.map((record) => (record.seq === 15 ? { ...record, model: "wrong-model" } : record)),
  }),
  "missing provider call": (input) => ({ ...input, records: input.records.filter((record) => record.seq !== 9) }),
};
const expectedFailures: Record<string, string[]> = {
  "unbracketed summarizer": [
    "manual summarizer not uniquely bracketed by execution",
    "manual summarizer provider/model/tools mismatch",
    "manual summarizer input differs from exact settled prefix",
  ],
  "wrong summarizer model": ["manual summarizer provider/model/tools mismatch"],
  "missing provider call": ["manual real provider call missing or duplicate"],
  "noncommitted response": ["manual response not truthful committed settled-prefix result"],
  "summarizer exposes tools": ["manual summarizer provider/model/tools mismatch"],
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`manual evaluator rejects ${name}`, () => {
    const { failures } = evaluateManualEvidence(mutate(valid()));
    if (expectedFailures[name]) expect(failures).toEqual(expectedFailures[name]);
    else expect(failures.length).toBeGreaterThan(0);
  });
}

const detailMutations: Record<string, { seq: number; change: (details: Record<string, unknown>) => void }> = {
  "noncommitted response": {
    seq: 4,
    change: (d) => {
      const data = d.eventData as { result: { content: { text: string }[] } };
      data.result.content[0]!.text = data.result.content[0]!.text.replace("update: committed", "update: skipped");
    },
  },
  "wrong checkpoint": {
    seq: 4,
    change: (d) => {
      d.checkpoint = "msg_first_pending";
    },
  },
  "bad snapshot": {
    seq: 2,
    change: (d) => {
      delete d.memory;
    },
  },
  "bad host history": {
    seq: 2,
    change: (d) => {
      d.hostHistory = [{ id: "msg_broken", time: {} }];
    },
  },
  "old text replay": {
    seq: 10,
    change: (d) => {
      d.prompt = String(d.prompt).replace(MANUAL_POST_RESET_PROMPT, MANUAL_SEED_PROMPT);
    },
  },
  "summarizer exposes tools": {
    seq: 10,
    change: (d) => {
      d.toolNames = ["stm_memory_update"];
    },
  },
  "noncompleted host": {
    seq: 4,
    change: (d) => {
      (d.eventData as Record<string, unknown>).status = "error";
    },
  },
  "changed call message": {
    seq: 4,
    change: (d) => {
      (d.eventData as Record<string, unknown>).messageID = "msg_different";
    },
  },
  "wrong stop marker": {
    seq: 4,
    change: (d) => {
      const data = d.eventData as { result: { content: { text: string }[] } };
      data.result.content[0]!.text = data.result.content[0]!.text.replace(
        "stoppedBeforeMessageID: msg_first_pending",
        "stoppedBeforeMessageID: msg_future",
      );
    },
  },
  "checkpoint already set": {
    seq: 2,
    change: (d) => {
      d.checkpoint = "msg_seed";
    },
  },
  "reset boundary wrong anchor": {
    seq: 8,
    change: (d) => {
      d.boundary = JSON.stringify({ version: 1, anchorID: "msg_wrong" });
    },
  },
  "reset template changed": {
    seq: 8,
    change: (d) => {
      d.memory = "not the reset template";
    },
  },
  "reset checkpoint uncleared": {
    seq: 8,
    change: (d) => {
      d.checkpoint = "msg_first_user";
    },
  },
  "manual changed boundary": {
    seq: 11,
    change: (d) => {
      d.boundary = null;
    },
  },
  "wrong progress": {
    seq: 11,
    change: (d) => {
      const data = d.eventData as { result: { content: { text: string }[] } };
      data.result.content[0]!.text = data.result.content[0]!.text.replace(
        '"checkpointedMessages":4',
        '"checkpointedMessages":0',
      );
    },
  },
  "missing sentinel": {
    seq: 11,
    change: (d) => {
      d.memory = "## Session Memory";
    },
  },
  "pending assistant settled": {
    seq: 2,
    change: (d) => {
      (d.hostHistory as { time: { completed?: number } }[])[3]!.time.completed = 2;
    },
  },
};
for (const [name, { seq, change }] of Object.entries(detailMutations)) {
  test(`manual evaluator rejects ${name}`, () => {
    const input = structuredClone(valid());
    change(input.records.find((record) => record.seq === seq * 5)!.details!);
    const { failures } = evaluateManualEvidence(input);
    if (expectedFailures[name]) expect(failures).toEqual(expectedFailures[name]);
    else expect(failures.length).toBeGreaterThan(0);
  });
}

test("manual dispatch uses exact last primary marker and paired SDK outputs, not call/result counts", () => {
  const options = (marker: string, extra: unknown[] = [], tools = true) =>
    ({
      prompt: [{ role: "user", content: [{ type: "text", text: marker }] }, ...extra],
      ...(tools ? { tools: [{ type: "function", name: "stm_memory_update", inputSchema: {} }] } : {}),
    }) as LanguageModelV3CallOptions;
  const call = (id: string) => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "stm_memory_update", input: {} }],
  });
  const result = (id: string, output: unknown) => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "stm_memory_update", output }],
  });
  expect(manualToolDispatch(options(MANUAL_FIRST_PROMPT))).toEqual({ callID: MANUAL_CALL_IDS[0], completed: false });
  expect(
    manualToolDispatch(
      options(MANUAL_FIRST_PROMPT, [
        call(MANUAL_CALL_IDS[0]),
        result(MANUAL_CALL_IDS[0], { type: "text", value: "generation: v2\nupdate: committed" }),
      ]),
    ),
  ).toEqual({ callID: MANUAL_CALL_IDS[0], completed: true });
  expect(
    manualToolDispatch(options(MANUAL_FIRST_PROMPT, [call(MANUAL_CALL_IDS[0]), call(MANUAL_CALL_IDS[0])]))?.completed,
  ).toBe(false);
  expect(
    manualToolDispatch(
      options(MANUAL_FIRST_PROMPT, [result(MANUAL_CALL_IDS[0], { type: "text", value: "update: committed" })]),
    )?.completed,
  ).toBe(false);
  expect(
    manualToolDispatch(
      options(MANUAL_SECOND_PROMPT, [
        call(MANUAL_CALL_IDS[0]),
        result(MANUAL_CALL_IDS[0], { type: "text", value: "update: committed" }),
      ]),
    ),
  ).toEqual({ callID: MANUAL_CALL_IDS[1], completed: false });
  for (const output of [
    { type: "content", value: [{ type: "text", text: "update: committed" }] },
    { type: "text", value: "update: committed" },
  ]) {
    expect(
      manualToolDispatch(options(MANUAL_SECOND_PROMPT, [call(MANUAL_CALL_IDS[1]), result(MANUAL_CALL_IDS[1], output)]))
        ?.completed,
    ).toBe(true);
  }
  expect(manualToolDispatch(options(MANUAL_FIRST_PROMPT, [], false))).toBeUndefined();
  expect(manualToolDispatch(options(`quoted ${MANUAL_FIRST_PROMPT}`))).toBeUndefined();
  expect(
    manualToolDispatch(
      options(MANUAL_FIRST_PROMPT, [{ role: "user", content: [{ type: "text", text: "ordinary followup" }] }]),
    ),
  ).toBeUndefined();
  expect(
    manualToolDispatch(
      options(MANUAL_FIRST_PROMPT, [
        call(MANUAL_CALL_IDS[0]),
        result(MANUAL_CALL_IDS[0], { type: "text", value: "update: busy" }),
      ]),
    )?.completed,
  ).toBe(false);
  const summarizer = options(
    `You are a short‑term session memory processor for an OpenCode plugin.\n<conversation_update>\n${MANUAL_FIRST_PROMPT}\n### User Instructions\n### Long Horizon Context\n### Decisions\n### Conclusions\n### Active References`,
  );
  expect(manualToolDispatch(summarizer)).toBeUndefined();
  const compaction = options(
    `## Objective\n## Requirements\n## Decisions\n## Work State\n### Completed\n### Active\n### Blocked\n## Next Move\n## Relevant Files\n## Important Context\n${MANUAL_FIRST_PROMPT}`,
  );
  expect(manualToolDispatch(compaction)).toBeUndefined();
});
