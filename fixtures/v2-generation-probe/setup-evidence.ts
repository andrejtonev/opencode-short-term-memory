import { parse, type ParseError } from "jsonc-parser";
import { dirname } from "node:path";
import type { ManualEvidenceInput } from "./manual-evidence.js";
import { evaluatePrimaryMemoryToolInventory } from "./evaluator.js";

export const SETUP_TOOL = "stm_memory_setup";
export const SETUP_CALLS = [
  {
    id: "stm-probe-setup-unconfirmed",
    prompt: "STM_SETUP_UNCONFIRMED: call stm_memory_setup with empty input.",
    input: {},
  },
  {
    id: "stm-probe-setup-existing",
    prompt: "STM_SETUP_EXISTING: call stm_memory_setup with confirm true.",
    input: { confirm: true },
  },
  {
    id: "stm-probe-setup-create",
    prompt: "STM_SETUP_CREATE: call stm_memory_setup with confirm true.",
    input: { confirm: true },
  },
  {
    id: "stm-probe-setup-repeat",
    prompt: "STM_SETUP_REPEAT: call stm_memory_setup with confirm true.",
    input: { confirm: true },
  },
] as const;
export const SETUP_EXPECTED_FIELDS = {
  enabled: true,
  memoryModel: "",
  summarizerMode: "clean",
  remindEveryN: 4,
  enableLegacyPeriodicSystemTransform: false,
  maxMemoryLength: 10000,
  debug: false,
};
export const SETUP_CAVEAT =
  "Shared example: see stm_memory_settings for effective V2 settings; configured memoryModel overrides are not applied in V2.";
export function expectedSetupResult(index: number, configPath: string): string {
  if (index === 0) return "Refused to create a project example config: set confirm to literal true to confirm setup.";
  const first =
    index === 2
      ? `Created project example config at ${configPath}.`
      : `No example config created: stm.jsonc already exists in ${dirname(configPath)}.`;
  return `${first}\nconfigPath: ${configPath}\n${SETUP_CAVEAT}`;
}

export interface SetupSnapshot {
  configs: { jsonc: string | null; json: string | null };
  memoryFiles: Record<string, string | null>;
  readOnlyRefs: Record<string, string | null>;
  productionAccess: { context: number; get: number; sessionGenerate: number; standaloneGenerate: number };
}
type Obj = Record<string, unknown>;
function object(value: unknown): Obj | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined;
}
function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  const left = object(a),
    right = object(b);
  return left && right
    ? Object.keys(left).length === Object.keys(right).length &&
        Object.keys(left).every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
    : a === b;
}
export function evaluateSetupEvidence(input: {
  records: readonly (ManualEvidenceInput["records"][number] & { readonly requestKind?: string })[];
  sessionID: string;
  configPath: string;
  initial: SetupSnapshot;
  final: SetupSnapshot;
  suppressionObserved: boolean;
  removal: {
    path: string;
    afterSeq: number;
    completedPrompts: readonly string[];
    before: SetupSnapshot;
    after: SetupSnapshot;
  } | null;
}): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const require = (condition: unknown, message: string) => {
    if (!condition) failures.push(message);
  };
  const validSnapshot = (s: unknown): s is SetupSnapshot => {
    const v = object(s),
      c = object(v?.configs),
      counters = object(v?.productionAccess);
    const bytes = (value: unknown) =>
      value === null || (typeof value === "string" && Buffer.from(value, "base64").toString("base64") === value);
    return !!(
      c &&
      Object.keys(c).length === 2 &&
      [c.jsonc, c.json].every(bytes) &&
      [v?.memoryFiles, v?.readOnlyRefs].every(
        (m) => object(m) && Object.keys(m as Obj).length > 0 && Object.values(m as Obj).every(bytes),
      ) &&
      counters &&
      Object.keys(counters).length === 4 &&
      ["context", "get", "sessionGenerate", "standaloneGenerate"].every((k) => counters[k] === 0)
    );
  };
  require(input.suppressionObserved &&
    input.records.some(
      (r) =>
        r.observedEvent === "setup.automatic-context-suppression" &&
        equal(r.details, { scope: "production.session.context", strategy: "registered-no-op" }),
    ), "setup: explicit automatic context suppression missing");
  require(input.records.every(
    (r, i) => Number.isInteger(r.seq) && r.seq > 0 && (i === 0 || r.seq > input.records[i - 1]!.seq),
  ), "setup: sequence not unique and ordered");
  require(validSnapshot(input.initial) &&
    validSnapshot(input.final) &&
    typeof input.initial.configs.jsonc === "string" &&
    input.initial.configs.json === null, "setup: lifecycle snapshots invalid");
  const executions = input.records.filter((r) => /^tool.execute\.(before|after)$/.test(r.observedEvent ?? ""));
  require(executions.length === 8, "setup: expected exactly four execution pairs and no auxiliary tools");
  require(input.records.filter((r) => r.event === "model.invocation" && r.details?.toolCall !== undefined).length ===
    4, "setup: unexpected or duplicate provider tool dispatch");
  let previousAfter = 0;
  let previousSnapshot: unknown = input.initial;
  const callers = new Set<string>();
  for (const [index, call] of SETUP_CALLS.entries()) {
    const before = executions.filter(
      (r) => r.observedEvent === "tool.execute.before" && object(r.details?.eventData)?.id === call.id,
    );
    const after = executions.filter(
      (r) => r.observedEvent === "tool.execute.after" && object(r.details?.eventData)?.id === call.id,
    );
    require(before.length === 1 && after.length === 1, `${call.id}: missing or duplicate pair`);
    if (before.length !== 1 || after.length !== 1) continue;
    const b = before[0]!,
      a = after[0]!,
      bd = object(b.details?.eventData)!,
      ad = object(a.details?.eventData)!;
    require(previousAfter < b.seq && b.seq < a.seq, `${call.id}: execution order invalid`);
    require([bd, ad].every(
      (d) =>
        d.tool === SETUP_TOOL &&
        d.sessionID === input.sessionID &&
        typeof d.messageID === "string" &&
        d.messageID.startsWith("msg_") &&
        equal(d.input, call.input),
    ) &&
      bd.messageID === ad.messageID &&
      bd.snapshotPhase === "before" &&
      ad.snapshotPhase === "after" &&
      ad.status === "completed", `${call.id}: identity/input/completion invalid`);
    callers.add(String(bd.messageID));
    const emissions = input.records.filter(
      (r) => r.event === "model.invocation" && object(r.details?.toolCall)?.toolCallId === call.id,
    );
    const e = emissions[0];
    const request = input.records.filter((r) => r.event === "model.request" && e && r.seq < e.seq).at(-1);
    require(emissions.length === 1 &&
      e &&
      e.seq > previousAfter &&
      e.seq < b.seq &&
      e.provider === "stm-probe" &&
      e.model === "deterministic" &&
      request?.requestKind === "primary" &&
      request.seq > previousAfter &&
      e.details?.primaryPrompt === call.prompt &&
      equal(e.details?.toolCall, {
        toolCallId: call.id,
        toolName: SETUP_TOOL,
        input: call.input,
      }), `${call.id}: primary emission invalid`);
    failures.push(
      ...evaluatePrimaryMemoryToolInventory(
        Array.isArray(e?.details?.toolNames) ? (e!.details!.toolNames as string[]) : [],
      ),
    );
    const memoryTools = Array.isArray(e?.details?.toolNames)
      ? e.details.toolNames.filter((name: unknown) => typeof name === "string" && name.startsWith("stm_memory_"))
      : [];
    require(memoryTools.length === 7 &&
      new Set(memoryTools).size === 7, `${call.id}: memory inventory is not exactly seven distinct tools`);
    const bs = b.details?.setupSnapshot,
      as = a.details?.setupSnapshot;
    require(validSnapshot(bs) && validSnapshot(as), `${call.id}: snapshot/access invalid`);
    if (index === 2) {
      const removal = input.removal;
      require(removal &&
        removal.path === input.configPath &&
        removal.afterSeq >= previousAfter &&
        e &&
        removal.afterSeq < e.seq &&
        equal(
          removal.completedPrompts,
          SETUP_CALLS.slice(0, 2).map((c) => c.prompt),
        ) &&
        validSnapshot(removal.before) &&
        validSnapshot(removal.after) &&
        equal(removal.before, previousSnapshot) &&
        equal(removal.after, bs) &&
        equal(removal.after, {
          ...removal.before,
          configs: { jsonc: null, json: null },
        }), "setup: explicit between-prompts fixture removal invalid");
    } else require(equal(previousSnapshot, bs), `${call.id}: lifecycle continuity invalid`);
    if (validSnapshot(bs) && validSnapshot(as)) {
      require(equal(bs.memoryFiles, as.memoryFiles) &&
        equal(bs.readOnlyRefs, as.readOnlyRefs) &&
        equal(bs.productionAccess, as.productionAccess), `${call.id}: non-config writes or host access`);
      if (index === 2) {
        require(bs.configs.jsonc === null &&
          bs.configs.json === null &&
          as.configs.json === null &&
          typeof as.configs.jsonc === "string", "setup: creation config missing or preexisting");
        const errors: ParseError[] = [];
        const parsed =
          typeof as.configs.jsonc === "string"
            ? parse(Buffer.from(as.configs.jsonc, "base64").toString("utf8"), errors, { allowTrailingComma: true })
            : undefined;
        require(errors.length === 0 && equal(parsed, SETUP_EXPECTED_FIELDS), "setup: created JSONC defaults invalid");
      } else require(equal(bs.configs, as.configs), `${call.id}: refusal/overwrite mutated config`);
    }
    const content = object(ad.result)?.content;
    require(Array.isArray(content) &&
      content.length === 1 &&
      object(content[0])?.type === "text" &&
      object(content[0])?.text ===
        expectedSetupResult(index, input.configPath), `${call.id}: exact result/path/V2 caveat invalid`);
    require(!input.records.some(
      (r) =>
        r.seq > b.seq &&
        r.seq < a.seq &&
        ["model.invocation", "model.request", "operation.start", "callback.enter"].includes(r.event),
    ), `${call.id}: session/generation during tool pair`);
    previousAfter = a.seq;
    previousSnapshot = as;
  }
  require(callers.size === 4 &&
    equal(previousSnapshot, input.final), "setup: distinct callers or final continuity invalid");
  require(equal(input.initial.memoryFiles, input.final.memoryFiles) &&
    equal(input.initial.readOnlyRefs, input.final.readOnlyRefs), "setup: writes outside config lifecycle");
  return { passed: failures.length === 0, failures };
}
