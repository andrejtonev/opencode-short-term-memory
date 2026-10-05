import { expect, test } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSetupSnapshot, setupToolDispatch, memoryUpdateResponse } from "./index.js";
import { captureInitializedSetupSnapshot, SETUP_BOOTSTRAP_PROMPT } from "./host-api.js";
import {
  evaluateSetupEvidence,
  expectedSetupResult,
  SETUP_CALLS,
  SETUP_EXPECTED_FIELDS,
  SETUP_TOOL,
  type SetupSnapshot,
} from "./setup-evidence.js";

type Input = Parameters<typeof evaluateSetupEvidence>[0];
const names = [
  "stm_memory_read",
  "stm_memory_status",
  "stm_memory_reset",
  "stm_memory_update",
  "stm_memory_logs",
  "stm_memory_settings",
  SETUP_TOOL,
];
const bytes = (text: string) => Buffer.from(text).toString("base64");
function valid(): Input {
  const configPath = "/tmp/fixture/project/.opencode/stm.jsonc";
  const initial: SetupSnapshot = {
    configs: { jsonc: bytes('{"enabled":true,"memoryDir":"/tmp/fixture/absolute-memory"}\n'), json: null },
    memoryFiles: {
      "/tmp/fixture/absolute-memory/": bytes("directory"),
      "/tmp/fixture/project/.opencode/memory/": null,
    },
    readOnlyRefs: { "/tmp/fixture/project/opencode.json": bytes("{}"), "/tmp/fixture/project/AGENTS.md": null },
    productionAccess: { context: 0, get: 0, sessionGenerate: 0, standaloneGenerate: 0 },
  };
  const removed = { ...structuredClone(initial), configs: { jsonc: null, json: null } };
  const created = {
    ...structuredClone(initial),
    configs: {
      jsonc: bytes(`{ // Shared example\n${JSON.stringify(SETUP_EXPECTED_FIELDS).slice(1, -1)},\n}`),
      json: null,
    },
  };
  const records: Input["records"][number][] = [
    {
      seq: 1,
      event: "event.observed",
      observedEvent: "setup.automatic-context-suppression",
      details: { scope: "production.session.context", strategy: "registered-no-op" },
    },
  ];
  for (const [index, call] of SETUP_CALLS.entries()) {
    const seq = 10 + index * 10;
    records.push({ seq: seq - 1, event: "model.request", requestKind: "primary" });
    records.push({
      seq,
      event: "model.invocation",
      provider: "stm-probe",
      model: "deterministic",
      details: {
        primaryPrompt: call.prompt,
        toolNames: names,
        toolCall: { toolCallId: call.id, toolName: SETUP_TOOL, input: call.input },
      },
    });
    for (const phase of ["before", "after"] as const)
      records.push({
        seq: seq + (phase === "before" ? 2 : 4),
        event: "event.observed",
        observedEvent: `tool.execute.${phase}`,
        details: {
          setupSnapshot: structuredClone(index < 2 ? initial : index === 2 && phase === "before" ? removed : created),
          eventData: {
            id: call.id,
            tool: SETUP_TOOL,
            sessionID: "ses_setup",
            messageID: `msg_setup_${index}`,
            input: call.input,
            snapshotPhase: phase,
            ...(phase === "after"
              ? {
                  status: "completed",
                  result: { content: [{ type: "text", text: expectedSetupResult(index, configPath) }] },
                }
              : {}),
          },
        },
      });
  }
  return {
    records,
    sessionID: "ses_setup",
    configPath,
    initial,
    final: structuredClone(created),
    suppressionObserved: true,
    removal: {
      path: configPath,
      afterSeq: 25,
      completedPrompts: SETUP_CALLS.slice(0, 2).map((c) => c.prompt),
      before: structuredClone(initial),
      after: structuredClone(removed),
    },
  };
}
function event(input: Input, seq: number) {
  return input.records.find((r) => r.seq === seq)!.details!;
}
test("setup accepts ordered host lifecycle, independent JSONC defaults, exact results and read-only snapshots", () => {
  expect(evaluateSetupEvidence(valid())).toEqual({ passed: true, failures: [] });
});
const mutations: Record<string, (i: Input) => Input | void> = {
  missing: (i) => ({ ...i, records: i.records.filter((r) => r.seq !== 12) }),
  duplicate: (i) => ({
    ...i,
    records: [...i.records.slice(0, 4), { ...i.records[3]!, seq: 13 }, ...i.records.slice(4)],
  }),
  order: (i) => {
    (i.records.find((r) => r.seq === 12) as { seq: number }).seq = 15;
  },
  "wrong session": (i) => {
    (event(i, 12).eventData as Record<string, unknown>).sessionID = "ses_wrong";
  },
  "no-confirm mutation": (i) => {
    (event(i, 14).setupSnapshot as SetupSnapshot).configs.jsonc = bytes("mutated");
  },
  "existing refusal changed": (i) => {
    (event(i, 24).setupSnapshot as SetupSnapshot).configs.jsonc = null;
  },
  "creation missing": (i) => {
    (event(i, 34).setupSnapshot as SetupSnapshot).configs.jsonc = null;
  },
  "wrong defaults": (i) => {
    (event(i, 34).setupSnapshot as SetupSnapshot).configs.jsonc = bytes(
      JSON.stringify({ ...SETUP_EXPECTED_FIELDS, memoryModel: "wrong/override" }),
    );
  },
  "wrong result": (i) => {
    (event(i, 34).eventData as { result: { content: { text: string }[] } }).result.content[0]!.text =
      "Created elsewhere";
  },
  "overwrite mutation": (i) => {
    (event(i, 44).setupSnapshot as SetupSnapshot).configs.jsonc = bytes("overwrite");
  },
  "host access": (i) => {
    (event(i, 34).setupSnapshot as SetupSnapshot).productionAccess.context++;
  },
  "generation in pair": (i) => ({
    ...i,
    records: [
      ...i.records.filter((r) => r.seq < 33),
      { seq: 33, event: "model.request" },
      ...i.records.filter((r) => r.seq > 33),
    ],
  }),
  "missing removal": (i) => ({ ...i, removal: null }),
  "wrong removal path": (i) => {
    i.removal!.path = "/tmp/user-config";
  },
  "concurrent removal": (i) => {
    i.removal!.afterSeq = 33;
  },
  "missing suppression": (i) => ({ ...i, suppressionObserved: false }),
  "auxiliary emission": (i) => {
    event(i, 30).primaryPrompt = "auxiliary";
  },
  "auxiliary request": (i) => {
    (i.records.find((r) => r.seq === 29) as { requestKind: string }).requestKind = "title";
  },
  "wrong inventory": (i) => {
    event(i, 30).toolNames = names.slice(0, -1);
  },
  "extra memory tool": (i) => {
    event(i, 30).toolNames = [...names, "stm_memory_other"];
  },
  noncompleted: (i) => {
    (event(i, 34).eventData as Record<string, unknown>).status = "error";
  },
};
for (const key of ["json", "jsonc"] as const)
  mutations[`missing config snapshot ${key}`] = (i) => {
    delete (event(i, 12).setupSnapshot as { configs: Record<string, unknown> }).configs[key];
  };
for (const key of ["memoryFiles", "readOnlyRefs"] as const)
  mutations[`outside config ${key}`] = (i) => {
    (event(i, 34).setupSnapshot as SetupSnapshot)[key]["/unexpected"] = bytes("mutation");
  };
for (const [name, mutate] of Object.entries(mutations))
  test(`setup rejects ${name}`, () => {
    const input = structuredClone(valid());
    expect(evaluateSetupEvidence(mutate(input) ?? input).passed).toBe(false);
  });

test("setup dispatch uses exact latest primary marker, actual available tool, paired ID and exact successful result", () => {
  const old = Bun.env.PROBE_PROJECT_CONFIG_PATH;
  Bun.env.PROBE_PROJECT_CONFIG_PATH = "/tmp/fixture/project/.opencode/stm.jsonc";
  try {
    for (const [index, call] of SETUP_CALLS.entries()) {
      const options = (extra: unknown[] = [], marker: string = call.prompt, tools = true) =>
        ({
          prompt: [{ role: "user", content: [{ type: "text", text: marker }] }, ...extra],
          ...(tools ? { tools: [{ type: "function", name: SETUP_TOOL, inputSchema: {} }] } : {}),
        }) as LanguageModelV3CallOptions;
      const pair = [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: call.id, toolName: SETUP_TOOL, input: call.input }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.id,
              toolName: SETUP_TOOL,
              output: { type: "text", value: expectedSetupResult(index, Bun.env.PROBE_PROJECT_CONFIG_PATH!) },
            },
          ],
        },
      ];
      expect(setupToolDispatch(options())?.completed).toBe(false);
      expect(setupToolDispatch(options(pair))?.completed).toBe(true);
      expect(setupToolDispatch(options(pair.slice(1)))?.completed).toBe(false);
      expect(setupToolDispatch(options(pair.slice(0, 1)))?.completed).toBe(false);
      expect(setupToolDispatch(options([], `quoted ${call.prompt}`))).toBeUndefined();
      expect(setupToolDispatch(options([], call.prompt, false))).toBeUndefined();
      expect(
        setupToolDispatch(options([{ role: "user", content: [{ type: "text", text: "followup" }] }])),
      ).toBeUndefined();
      expect(setupToolDispatch(options([], memoryUpdateResponse("test")))).toBeUndefined();
      (pair[1]!.content[0] as { output: { value: string } }).output.value = "fabricated result";
      expect(setupToolDispatch(options(pair))?.completed).toBe(false);
    }
  } finally {
    if (old === undefined) delete Bun.env.PROBE_PROJECT_CONFIG_PATH;
    else Bun.env.PROBE_PROJECT_CONFIG_PATH = old;
  }
});

test("setup snapshot reads actual config candidates, both memory roots and references without writing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "stm-setup-snapshot-"));
  try {
    const configPath = join(root, "project", ".opencode", "stm.jsonc");
    const memoryDir = join(root, "absolute-memory");
    const accessPath = join(root, "markers", "production-access.json");
    for (const path of [
      join(root, "project", ".opencode", "memory", "checkpoints"),
      memoryDir,
      join(root, "markers"),
      join(root, "xdg-config", "opencode"),
    ])
      await mkdir(path, { recursive: true });
    await writeFile(configPath, "initial\n");
    await writeFile(accessPath, JSON.stringify({ context: 0, get: 0, sessionGenerate: 0, standaloneGenerate: 0 }));
    const checkpoint = join(root, "project", ".opencode", "memory", "checkpoints", "session.txt");
    await writeFile(checkpoint, "checkpoint\n");
    const reference = join(root, "xdg-config", "opencode", "stm.json");
    await writeFile(reference, "global\n");
    const first = await captureSetupSnapshot(configPath, memoryDir, accessPath);
    expect(first.configs).toEqual({ jsonc: bytes("initial\n"), json: null });
    expect(first.memoryFiles[checkpoint]).toBe(bytes("checkpoint\n"));
    expect(first.readOnlyRefs[reference]).toBe(bytes("global\n"));
    expect(await captureSetupSnapshot(configPath, memoryDir, accessPath)).toEqual(first);
    await writeFile(join(root, "project", ".opencode", "stm.json"), "alternate\n");
    expect((await captureSetupSnapshot(configPath, memoryDir, accessPath)).configs.json).toBe(bytes("alternate\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup baseline triggers lazy plugins and waits for bootstrap completion before reading access evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "stm-setup-lazy-"));
  try {
    const configPath = join(root, "project", ".opencode", "stm.jsonc");
    const memoryDir = join(root, "absolute-memory");
    const accessPath = join(root, "markers", "production-access.json");
    for (const path of [join(root, "project", ".opencode"), memoryDir, join(root, "markers")])
      await mkdir(path, { recursive: true });
    await writeFile(configPath, "fixture-owned\n");
    const calls: string[] = [];
    const snapshot = () => {
      calls.push("snapshot");
      return captureSetupSnapshot(configPath, memoryDir, accessPath);
    };
    // Reproduces the old harness ordering: no marker exists after lazy session creation.
    await expect(snapshot()).rejects.toMatchObject({ code: "ENOENT" });
    calls.length = 0;
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting!: () => void;
    const waitEntered = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const client = {
      session: {
        prompt: async (input: { sessionID: string; text: string }) => {
          expect(input).toEqual({ sessionID: "ses_lazy", text: SETUP_BOOTSTRAP_PROMPT });
          calls.push("prompt");
        },
        wait: async (input: { sessionID: string }) => {
          expect(input).toEqual({ sessionID: "ses_lazy" });
          calls.push("wait");
          waiting();
          await settled;
          // Fake host setup only; never touches the retained live sandbox/evidence.
          await writeFile(
            accessPath,
            JSON.stringify({ context: 0, get: 0, sessionGenerate: 0, standaloneGenerate: 0 }),
          );
          calls.push("setup-settled");
        },
      },
    } as unknown as Parameters<typeof captureInitializedSetupSnapshot>[0];
    const baseline = captureInitializedSetupSnapshot(client, "ses_lazy", snapshot);
    await waitEntered;
    expect(calls).toEqual(["prompt", "wait"]);
    release();
    const initial = await baseline;
    expect(calls).toEqual(["prompt", "wait", "setup-settled", "snapshot"]);
    expect(initial.configs).toEqual({ jsonc: bytes("fixture-owned\n"), json: null });
    expect(initial.productionAccess).toEqual({ context: 0, get: 0, sessionGenerate: 0, standaloneGenerate: 0 });
    expect(
      setupToolDispatch({
        prompt: [{ role: "user", content: [{ type: "text", text: SETUP_BOOTSTRAP_PROMPT }] }],
        tools: [{ type: "function", name: SETUP_TOOL, inputSchema: {} }],
      } as LanguageModelV3CallOptions),
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup baseline never snapshots when bootstrap prompt or wait fails", async () => {
  for (const phase of ["prompt", "wait"] as const) {
    let snapshots = 0;
    const error = new Error(`bootstrap ${phase} failed`);
    const client = {
      session: {
        prompt: async () => {
          if (phase === "prompt") throw error;
        },
        wait: async () => {
          throw error;
        },
      },
    } as unknown as Parameters<typeof captureInitializedSetupSnapshot>[0];
    await expect(
      captureInitializedSetupSnapshot(client, "ses_lazy", async () => {
        snapshots++;
      }),
    ).rejects.toBe(error);
    expect(snapshots).toBe(0);
  }
});
