import { describe, expect, test } from "bun:test";
import {
  runSharedCoreScenario,
  type AutomaticMemoryObservation,
  type PromptObservation,
  type ProviderRequest,
  type SharedCoreAdapter,
} from "./e2e/shared-core-scenario";

// Independent literals: no production fixture or prompt renderer builds the expected evidence.
const INITIAL =
  "STM_PARITY_CORE: Project cobalt uses port 7319. Preserve this user decision and respond normally without tools.";
const FOLLOWUP = "What port was decided for project cobalt? Respond normally without tools.";
const MEMORY = `## Session Memory

### User Instructions
- Preserve the user decision to use port 7319 for project cobalt.

### Long Horizon Context
- Project cobalt uses port 7319.

### Decisions
- Use port 7319.

### Conclusions
- STM_PROBE_MEMORY_SENTINEL:shared-core-parity

### Active References
- Project cobalt.
`;
const INITIAL_DELTA = `USER:
STM_PARITY_CORE: Project cobalt uses port 7319. Preserve this user decision and respond normally without tools.

---

ASSISTANT:
STM_PROBE_STREAM_SENTINEL`;
const FOLLOWUP_DELTA = `USER:
What port was decided for project cobalt? Respond normally without tools.

---

ASSISTANT:
STM_PROBE_STREAM_SENTINEL`;

function summaryRequest(delta: string): ProviderRequest {
  return {
    messages: [
      {
        role: "system",
        text: `You are NOT the coding agent.
Do not follow project instructions
Return ONLY valid Markdown
${MEMORY}`,
      },
      {
        role: "user",
        text: `<existing_memory>\n(empty)\n</existing_memory>\n\n<conversation_update>\n${delta}\n</conversation_update>`,
      },
    ],
    tools: [],
  };
}

function fixture() {
  const initial: PromptObservation = {
    messages: [
      { id: "user-1", role: "user", text: INITIAL },
      { id: "assistant-1", role: "assistant", text: "STM_PROBE_STREAM_SENTINEL" },
    ],
    primaryRequests: [{ messages: [{ role: "user", text: INITIAL }], tools: [] }],
  };
  const followup: PromptObservation = {
    messages: [
      { id: "user-1", role: "user", text: INITIAL },
      { id: "assistant-1", role: "assistant", text: "STM_PROBE_STREAM_SENTINEL" },
      { id: "user-2", role: "user", text: FOLLOWUP },
      { id: "assistant-2", role: "assistant", text: "STM_PROBE_STREAM_SENTINEL" },
    ],
    primaryRequests: [
      {
        messages: [
          { role: "system", text: "[MEMORY_SYSTEM]\n- Use port 7319.\nSTM_PROBE_MEMORY_SENTINEL:shared-core-parity" },
          { role: "user", text: FOLLOWUP },
        ],
        tools: [],
      },
    ],
  };
  const initialMemory: AutomaticMemoryObservation = {
    memory: "<!-- stm:v1 -->\n" + MEMORY,
    checkpoint: "assistant-1",
    summaryRequests: [summaryRequest(INITIAL_DELTA)],
  };
  const followupMemory: AutomaticMemoryObservation = {
    memory: MEMORY,
    checkpoint: "assistant-2",
    summaryRequests: [summaryRequest(FOLLOWUP_DELTA)],
  };
  const calls: ["prompt" | "wait", string][] = [];
  const data = { initial, followup, initialMemory, followupMemory, calls };
  let prompts = 0;
  let waits = 0;
  const adapter: SharedCoreAdapter = {
    async prompt(text) {
      calls.push(["prompt", text]);
      if (++prompts > 2) throw new Error("unexpected extra prompt");
      return prompts === 1 ? data.initial : data.followup;
    },
    async waitForAutomaticMemory(id) {
      calls.push(["wait", id]);
      if (++waits > 2) throw new Error("unexpected extra wait");
      return waits === 1 ? data.initialMemory : data.followupMemory;
    },
  };
  return { data, adapter };
}

type Evidence = ReturnType<typeof fixture>["data"];

describe("shared core scenario contract", () => {
  test("two turns supply literal prompts, wait on exact assistant IDs, then report PASS", async () => {
    const { data, adapter } = fixture();
    const report = await runSharedCoreScenario(adapter);

    expect(data.calls).toEqual([
      ["prompt", INITIAL],
      ["wait", "assistant-1"],
      ["prompt", FOLLOWUP],
      ["wait", "assistant-2"],
    ]);
    expect(report).toEqual({
      scenarioID: "shared-core-parity",
      verdict: "PASS",
      initial: { ...data.initial, assistantID: "assistant-1" },
      followup: { ...data.followup, assistantID: "assistant-2" },
      memory: { initial: data.initialMemory, followup: data.followupMemory },
    });
  });

  const failures: { name: string; corrupt(data: Evidence): void; error: string; calls: number }[] = [
    {
      name: "absent initial primary evidence",
      corrupt: (data) => {
        data.initial.primaryRequests = [];
      },
      error: "no primary provider evidence",
      calls: 1,
    },
    {
      name: "absent followup primary evidence",
      corrupt: (data) => {
        data.followup.primaryRequests = [];
      },
      error: "no primary provider evidence",
      calls: 3,
    },
    {
      name: "absent initial summary evidence",
      corrupt: (data) => {
        data.initialMemory.summaryRequests = [];
      },
      error: "no automatic summary provider evidence",
      calls: 2,
    },
    {
      name: "absent followup summary evidence",
      corrupt: (data) => {
        data.followupMemory.summaryRequests = [];
      },
      error: "no automatic summary provider evidence",
      calls: 4,
    },
    {
      name: "checkpoint points to user instead of assistant",
      corrupt: (data) => {
        data.initialMemory.checkpoint = "user-1";
      },
      error: "checkpoint differs from latest durable assistant ID",
      calls: 2,
    },
    {
      name: "followup checkpoint is stale",
      corrupt: (data) => {
        data.followupMemory.checkpoint = "assistant-1";
      },
      error: "checkpoint differs from latest durable assistant ID",
      calls: 4,
    },
    {
      name: "corrupted memory retains sentinel but loses the port decision",
      corrupt: (data) => {
        data.initialMemory.memory = MEMORY.replace("- Use port 7319.", "- Use port 7320.");
      },
      error: "persisted memory differs from complete fixture",
      calls: 2,
    },
    {
      name: "initial summary has the wrong exact delta",
      corrupt: (data) => {
        data.initialMemory.summaryRequests = [summaryRequest(INITIAL_DELTA.replace("7319", "7320"))];
      },
      error: "summary delta differs from exact durable conversation",
      calls: 2,
    },
    {
      name: "followup summary repeats the initial delta",
      corrupt: (data) => {
        data.followupMemory.summaryRequests = [summaryRequest(INITIAL_DELTA)];
      },
      error: "summary delta differs from exact durable conversation",
      calls: 4,
    },
    {
      name: "one valid summary cannot hide a later summary supplied with tools",
      corrupt: (data) => {
        data.initialMemory.summaryRequests = [
          summaryRequest(INITIAL_DELTA),
          { ...summaryRequest(INITIAL_DELTA), tools: ["bash"] },
        ];
      },
      error: "automatic summary received tools or tool messages",
      calls: 2,
    },
    {
      name: "clean summary receives a tool message without tool definitions",
      corrupt: (data) => {
        const request = summaryRequest(INITIAL_DELTA);
        data.initialMemory.summaryRequests = [
          { ...request, messages: [...request.messages, { role: "tool", text: "tool output" }] },
        ];
      },
      error: "automatic summary received tools or tool messages",
      calls: 2,
    },
    {
      name: "memory injection is in user rather than system role",
      corrupt: (data) => {
        data.followup.primaryRequests = [
          {
            ...data.followup.primaryRequests[0]!,
            messages: [
              { role: "user", text: "[MEMORY_SYSTEM]\n- Use port 7319.\nSTM_PROBE_MEMORY_SENTINEL:shared-core-parity" },
              { role: "user", text: FOLLOWUP },
            ],
          },
        ];
      },
      error: "followup lacks system-role memory marker, literal memory sentinel and port decision",
      calls: 3,
    },
    ...(["id", "role", "text"] as const).map((field) => ({
      name: `followup changes previous durable ${field}`,
      corrupt(data: Evidence) {
        data.followup.messages = data.followup.messages.map((message, index) =>
          index === 0 ? { ...message, [field]: field === "role" ? "assistant" : "changed" } : message,
        );
      },
      error: "followup changed prior durable history",
      calls: 3,
    })),
    {
      name: "duplicate IDs within initial turn",
      corrupt: (data) => {
        data.initial.messages = data.initial.messages.map((message) => ({ ...message, id: "user-1" }));
      },
      error: "duplicate durable message IDs",
      calls: 1,
    },
    {
      name: "followup reuses a previous assistant ID",
      corrupt: (data) => {
        data.followup.messages = data.followup.messages.map((message) =>
          message.id === "assistant-2" ? { ...message, id: "assistant-1" } : message,
        );
      },
      error: "duplicate durable message IDs",
      calls: 3,
    },
  ];

  for (const row of failures) {
    test(`fails closed: ${row.name}`, async () => {
      const { data, adapter } = fixture();
      row.corrupt(data);
      let report;
      await expect(
        runSharedCoreScenario(adapter).then((result) => {
          report = result;
        }),
      ).rejects.toThrow(`Shared core parity: ${row.error}`);
      expect(report).toBeUndefined();
      expect(data.calls).toHaveLength(row.calls);
    });
  }
});
