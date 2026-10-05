import { expect, test } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { diagnosticsToolDispatch } from "./index.js";
import {
  DIAGNOSTICS_CALLS,
  DIAGNOSTICS_PROMPT,
  evaluateDiagnosticsEvidence,
  expectedDiagnosticsSettings,
} from "./diagnostics-evidence.js";

type Input = Parameters<typeof evaluateDiagnosticsEvidence>[0];
function valid(): Input {
  const sessionID = "ses_diagnostics";
  const expectedSettings = expectedDiagnosticsSettings("/tmp/fixture-memory");
  const records: Input["records"][number][] = [
    {
      seq: 1,
      event: "event.observed",
      observedEvent: "tool.execute.after",
      details: { eventData: { tool: "stm_memory_update" } },
    },
  ];
  // Pure evaluator data only. The host harness never writes a synthetic log.
  const rawLog =
    Array.from({ length: 125 }, (_, i) =>
      JSON.stringify({ event: i === 124 ? "v2_memory_update_committed" : "earlier", sessionID, index: i }),
    ).join("\n\n") + "\n";
  const files = {
    memory: Buffer.from("## Session Memory").toString("base64"),
    checkpoint: Buffer.from("msg_second\n").toString("base64"),
    boundary: null,
    log: Buffer.from(rawLog).toString("base64"),
    projectConfig: Buffer.from(
      JSON.stringify({
        enabled: true,
        memoryDir: expectedSettings.resolvedConfig.memoryDir,
        summarizerMode: "clean",
        memoryModel: "stm-probe/deterministic",
      }),
    ).toString("base64"),
  };
  for (const [index, call] of DIAGNOSTICS_CALLS.entries()) {
    const seq = 10 + index * 10;
    records.push({
      seq,
      event: "model.invocation",
      provider: "stm-probe",
      model: "deterministic",
      details: { primaryPrompt: DIAGNOSTICS_PROMPT, toolCall: { toolCallId: call.id, toolName: call.tool, input: {} } },
    });
    for (const phase of ["before", "after"] as const) {
      records.push({
        seq: seq + (phase === "before" ? 2 : 4),
        event: "event.observed",
        observedEvent: `tool.execute.${phase}`,
        details: {
          diagnosticsFiles: structuredClone(files),
          productionAccess: { context: 2, get: 2, sessionGenerate: 0, standaloneGenerate: 2 },
          eventData: {
            id: call.id,
            tool: call.tool,
            sessionID,
            messageID: `msg_diagnostic_${index}`,
            input: {},
            snapshotPhase: phase,
            ...(phase === "after"
              ? {
                  status: "completed",
                  result: {
                    content: [
                      {
                        type: "text",
                        text:
                          index === 0
                            ? rawLog.split(/\r?\n/).filter(Boolean).slice(-120).join("\n")
                            : JSON.stringify(expectedSettings),
                      },
                    ],
                  },
                }
              : {}),
          },
        },
      });
    }
  }
  return { records, sessionID, expectedSettings };
}

test("diagnostics accept ordered real emissions, exact 120-line tail, independent settings and byte/absence snapshots", () => {
  expect(evaluateDiagnosticsEvidence(valid())).toEqual({ passed: true, failures: [] });
});

const mutations: Record<string, (input: Input) => Input | void> = {
  missing: (i) => ({ ...i, records: i.records.filter((r) => r.seq !== 12) }),
  duplicate: (i) => ({
    ...i,
    records: [...i.records.slice(0, 3), { ...i.records[2]!, seq: 13 }, ...i.records.slice(3)],
  }),
  ordering: (i) => {
    (i.records[2] as { seq: number }).seq = 15;
  },
  "wrong session": (i) => {
    (i.records[2]!.details!.eventData as Record<string, unknown>).sessionID = "ses_wrong";
  },
  "wrong call message": (i) => {
    (i.records[3]!.details!.eventData as Record<string, unknown>).messageID = "msg_wrong";
  },
  "missing emission": (i) => ({ ...i, records: i.records.filter((r) => r.seq !== 10) }),
  "duplicate emission": (i) => ({
    ...i,
    records: [i.records[0]!, { ...i.records[1]!, seq: 9 }, ...i.records.slice(1)],
  }),
  "late emission": (i) => {
    (i.records[1] as { seq: number }).seq = 13;
  },
  "auxiliary emission": (i) => {
    i.records[1]!.details!.primaryPrompt = "auxiliary";
  },
  "wrong provider": (i) => {
    (i.records[1] as { provider: string }).provider = "other";
  },
  "wrong tail": (i) => {
    const d = i.records[3]!.details!.eventData as { result: { content: { text: string }[] } };
    d.result.content[0]!.text += "\nextra";
  },
  "empty log and response": (i) => {
    for (const r of i.records.filter((r) => r.details?.diagnosticsFiles))
      (r.details!.diagnosticsFiles as Record<string, unknown>).log = "";
    (i.records[3]!.details!.eventData as { result: { content: { text: string }[] } }).result.content[0]!.text = "";
  },
  "no actual update event": (i) => {
    for (const r of i.records.filter((r) => r.details?.diagnosticsFiles)) {
      const f = r.details!.diagnosticsFiles as Record<string, string>;
      f.log = Buffer.from(
        Buffer.from(f.log!, "base64").toString().replaceAll("v2_memory_update_committed", "other"),
      ).toString("base64");
    }
    const d = i.records[3]!.details!.eventData as { result: { content: { text: string }[] } };
    d.result.content[0]!.text = d.result.content[0]!.text.replaceAll("v2_memory_update_committed", "other");
  },
  "settings model": (i) => {
    const d = i.records[6]!.details!.eventData as { result: { content: { text: string }[] } };
    const s = JSON.parse(d.result.content[0]!.text);
    s.effective.memoryModel = "configured-model";
    d.result.content[0]!.text = JSON.stringify(s);
  },
  noncompleted: (i) => {
    (i.records[3]!.details!.eventData as Record<string, unknown>).status = "error";
  },
  "summarizer during pair": (i) => ({
    ...i,
    records: [
      ...i.records.slice(0, 3),
      { seq: 13, event: "model.invocation", sentinel: "## Session Memory" },
      ...i.records.slice(3),
    ],
  }),
  "production host call": (i) => {
    (i.records[3]!.details!.productionAccess as Record<string, number>).context!++;
  },
  "production generation": (i) => {
    (i.records[6]!.details!.productionAccess as Record<string, number>).standaloneGenerate!++;
  },
  "missing access evidence": (i) => {
    delete i.records[2]!.details!.productionAccess;
  },
};
for (const key of ["memory", "checkpoint", "boundary", "log", "projectConfig"]) {
  mutations[`mutated ${key}`] = (i) => {
    (i.records[3]!.details!.diagnosticsFiles as Record<string, unknown>)[key] =
      Buffer.from("mutation").toString("base64");
  };
  mutations[`missing ${key}`] = (i) => {
    delete (i.records[2]!.details!.diagnosticsFiles as Record<string, unknown>)[key];
  };
}
for (const [section, key, value] of [
  ["resolvedConfig", "memoryDir", "/wrong"],
  ["resolvedConfig", "memoryModel", "wrong/override"],
  ["effective", "maxMemoryLength", 1],
  ["effective", "maxUpdateInputLength", 1],
  ["effective", "maxDeltaMessages", 1],
  ["effective", "summarizerMode", "active"],
] as const) {
  mutations[`settings ${section}.${key}`] = (i) => {
    const d = i.records[6]!.details!.eventData as { result: { content: { text: string }[] } };
    const settings = JSON.parse(d.result.content[0]!.text);
    settings[section][key] = value;
    d.result.content[0]!.text = JSON.stringify(settings);
  };
}
mutations["inactive settings missing"] = (i) => {
  const d = i.records[6]!.details!.eventData as { result: { content: { text: string }[] } };
  const settings = JSON.parse(d.result.content[0]!.text);
  settings.inactiveSettings.pop();
  d.result.content[0]!.text = JSON.stringify(settings);
};
for (const [name, mutate] of Object.entries(mutations))
  test(`diagnostics reject ${name}`, () => {
    const input = structuredClone(valid());
    expect(evaluateDiagnosticsEvidence(mutate(input) ?? input).passed).toBe(false);
  });

test("diagnostic dispatch requires exact primary prompt, available tools and ordered paired SDK results", () => {
  const options = (extra: unknown[] = [], prompt = DIAGNOSTICS_PROMPT, tools = true) =>
    ({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }, ...extra],
      ...(tools ? { tools: DIAGNOSTICS_CALLS.map((c) => ({ type: "function", name: c.tool, inputSchema: {} })) } : {}),
    }) as LanguageModelV3CallOptions;
  const pair = (index: number, output: unknown = { type: "text", value: "real result" }) => {
    const c = DIAGNOSTICS_CALLS[index]!;
    return [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: c.id, toolName: c.tool, input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: c.id, toolName: c.tool, output }] },
    ];
  };
  expect(diagnosticsToolDispatch(options())).toEqual(DIAGNOSTICS_CALLS[0]);
  for (const output of [
    { type: "text", value: "real logs" },
    { type: "content", value: [{ type: "text", text: "real logs" }] },
  ])
    expect(diagnosticsToolDispatch(options(pair(0, output)))).toEqual(DIAGNOSTICS_CALLS[1]);
  expect(diagnosticsToolDispatch(options([...pair(0), ...pair(1)]))).toBeUndefined();
  expect(diagnosticsToolDispatch(options(pair(0).slice(1)))).toEqual(DIAGNOSTICS_CALLS[0]);
  expect(diagnosticsToolDispatch(options(pair(0).slice(0, 1)))).toEqual(DIAGNOSTICS_CALLS[0]);
  expect(diagnosticsToolDispatch(options(pair(1)))).toEqual(DIAGNOSTICS_CALLS[0]);
  expect(diagnosticsToolDispatch(options([], DIAGNOSTICS_PROMPT, false))).toBeUndefined();
  expect(diagnosticsToolDispatch(options([], `quoted ${DIAGNOSTICS_PROMPT}`))).toBeUndefined();
  expect(
    diagnosticsToolDispatch(options([{ role: "user", content: [{ type: "text", text: "ordinary followup" }] }])),
  ).toBeUndefined();
});
