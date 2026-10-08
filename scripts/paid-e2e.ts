import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

// Published Standard-rate envelope, NOT deployment pricing or an invoice guarantee.
// Maximum published EU long-context USD/M: input 0.24, output 0.90, with no cache writes.
// https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/
// Pricing page's current rate table: https://aka.ms/AOAIpricingbanner
export const LIMIT_UNITS = 500_000_000;
export const RESERVATION_UNITS = 22_865_280;
export const MAX_BYTES = 1_048_576;
const MODEL = "gpt-6-luna";
const MODEL_ID = "paid-e2e/gpt-6-luna";
const PARENT = "/tmp/opencode";
const REPO = resolve(import.meta.dir, "..");

type Json = Record<string, any>;
type Attempt = { state: "pending" | "settled" | "uncertain"; units: number };
type Prior = {
  knownUnits: number;
  uncertainUnits: number;
  attempts: number;
  provenance: Json[];
};
export interface Ledger {
  attempts: number;
  entries: Map<number, Attempt>;
  prior: Prior;
  // Total exposure: settled charges plus pending/uncertain worst-case reserves.
  reservedUnits: number;
  estimatedUnits: number;
  maxObservedUnits: number;
  closed: boolean;
}
export function createLedger(prior: Prior = { knownUnits: 0, uncertainUnits: 0, attempts: 0, provenance: [] }): Ledger {
  requireThat(
    [prior.knownUnits, prior.uncertainUnits, prior.attempts].every((n) => Number.isSafeInteger(n) && n >= 0) &&
      prior.knownUnits + prior.uncertainUnits <= LIMIT_UNITS,
    "invalid prior exposure",
  );
  const exposure = prior.knownUnits + prior.uncertainUnits;
  return {
    attempts: 0,
    entries: new Map(),
    prior,
    reservedUnits: exposure,
    estimatedUnits: 0,
    maxObservedUnits: exposure,
    closed: false,
  };
}
export function parseRunArgs(args: string[]): { priorPaths: string[]; cliPath?: string } {
  requireThat(
    args[0] === "--run" && args.length >= 3 && args.length % 2 === 1,
    "--run requires --prior-evidence /absolute/directory or --prior-report /absolute/report.json (repeatable)",
  );
  const paths: string[] = [];
  let cliPath: string | undefined;
  for (let i = 1; i < args.length; i += 2) {
    requireThat(
      ["--prior-evidence", "--prior-report", "--cli-path"].includes(args[i]) && isAbsolute(args[i + 1]),
      "invalid prior evidence argument",
    );
    if (args[i] === "--cli-path") {
      requireThat(cliPath === undefined, "duplicate --cli-path");
      cliPath = args[i + 1];
      continue;
    }
    paths.push(args[i] === "--prior-evidence" ? join(args[i + 1], "report.json") : args[i + 1]);
  }
  requireThat(paths.length > 0, "prior evidence required even with --cli-path");
  return { priorPaths: paths, ...(cliPath === undefined ? {} : { cliPath }) };
}
function validateCliPath(path: string): { path: string; realPath: string; sha256: string } {
  requireThat(isAbsolute(path), "CLI path must be absolute");
  const realPath = realpathSync(path);
  const stat = statSync(realPath);
  requireThat(stat.isFile(), "CLI path must be a regular file");
  accessSync(realPath, constants.X_OK);
  return { path, realPath, sha256: createHash("sha256").update(readFileSync(realPath)).digest("hex") };
}
export function reserve(ledger: Ledger): number {
  if (ledger.closed || ledger.reservedUnits + RESERVATION_UNITS > LIMIT_UNITS) {
    ledger.closed = true;
    throw new Error("admission closed: USD 5 reservation ceiling");
  }
  // Synchronous, before any await/fetch: concurrent requests cannot oversubscribe.
  ledger.reservedUnits += RESERVATION_UNITS;
  ledger.maxObservedUnits = Math.max(ledger.maxObservedUnits, ledger.reservedUnits);
  const id = ++ledger.attempts;
  ledger.entries.set(id, { state: "pending", units: RESERVATION_UNITS });
  return id;
}
export function settle(ledger: Ledger, id: number, units: number): void {
  const entry = ledger.entries.get(id);
  requireThat(entry?.state === "pending", "attempt is not pending: duplicate or unknown settlement");
  requireThat(Number.isSafeInteger(units) && units >= 0 && units <= entry.units, "settlement exceeds reservation");
  ledger.reservedUnits -= entry.units - units;
  ledger.estimatedUnits += units;
  entry.state = "settled";
  entry.units = units;
}
function retainUncertain(ledger: Ledger, id: number): void {
  const entry = ledger.entries.get(id);
  if (entry?.state === "pending") entry.state = "uncertain";
  // A delivery failure after settlement remains a known charge, not a second reserve.
  ledger.closed = true;
}
function record(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function functionCall(value: unknown, index?: number): Json {
  requireThat(record(value) && value.type === "function" && typeof value.id === "string", "invalid tool call");
  requireThat(
    record(value.function) && typeof value.function.name === "string" && typeof value.function.arguments === "string",
    "invalid function call",
  );
  requireThat(/^[a-zA-Z0-9_-]{1,64}$/.test(value.function.name), "invalid function name");
  return {
    ...(index === undefined ? {} : { index }),
    id: value.id,
    type: "function",
    function: { name: value.function.name, arguments: value.function.arguments },
  };
}
export function allowlistedBody(value: unknown): Json {
  requireThat(record(value) && value.model === MODEL, "only gpt-6-luna is admitted");
  requireThat(value.n === undefined || value.n === 1, "only n=1 is admitted");
  requireThat(value.stream === undefined || typeof value.stream === "boolean", "invalid stream");
  requireThat(Array.isArray(value.messages) && value.messages.length > 0, "messages required");
  const messages = value.messages.map((message: unknown) => {
    requireThat(
      record(message) && ["system", "developer", "user", "assistant", "tool"].includes(message.role),
      "invalid message role",
    );
    let content = message.content;
    if (Array.isArray(content)) {
      requireThat(
        content.every((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string"),
        "only text message parts admitted",
      );
      content = content.map((part: Json) => part.text).join("\n");
    }
    requireThat(
      typeof content === "string" ||
        (message.role === "assistant" && content == null && Array.isArray(message.tool_calls)),
      "only text/tool messages admitted",
    );
    const out: Json = { role: message.role, content: content ?? null };
    if (message.name !== undefined) {
      requireThat(
        typeof message.name === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(message.name),
        "invalid message name",
      );
      out.name = message.name;
    }
    if (message.role === "tool") {
      requireThat(typeof message.tool_call_id === "string" && message.tool_call_id.length > 0, "tool_call_id required");
      out.tool_call_id = message.tool_call_id;
    }
    if (message.tool_calls !== undefined) {
      requireThat(
        message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
        "invalid tool_calls",
      );
      out.tool_calls = message.tool_calls.map((call: unknown) => functionCall(call));
    }
    return out;
  });
  const body: Json = {
    model: MODEL,
    messages,
    n: 1,
    stream: false,
    max_completion_tokens: 8192,
    reasoning_effort: "none",
    service_tier: "default",
    // Explicit mode without breakpoints disables both cache reads and writes.
    // Rebuilt messages/tools discard caller cache policy, breakpoints and metadata.
    // https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching
    prompt_cache_options: { mode: "explicit" },
  };
  if (value.tools !== undefined) {
    requireThat(Array.isArray(value.tools), "invalid tools");
    body.tools = value.tools.map((tool: unknown) => {
      requireThat(record(tool) && tool.type === "function" && record(tool.function), "only function tools admitted");
      const fn = tool.function;
      requireThat(typeof fn.name === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(fn.name), "invalid tool name");
      requireThat(record(fn.parameters) && fn.parameters.type === "object", "object function schema required");
      // Do not admit external schema references (even though Azure normally ignores them).
      requireThat(!/"\$(?:ref|id)"\s*:/.test(JSON.stringify(fn.parameters)), "schema references not admitted");
      requireThat(fn.description === undefined || typeof fn.description === "string", "invalid description");
      requireThat(fn.strict === undefined || typeof fn.strict === "boolean", "invalid strict");
      return {
        type: "function",
        function: {
          name: fn.name,
          parameters: fn.parameters,
          ...(fn.description === undefined ? {} : { description: fn.description }),
          ...(fn.strict === undefined ? {} : { strict: fn.strict }),
        },
      };
    });
  }
  if (value.tool_choice !== undefined) {
    if (["auto", "none", "required"].includes(value.tool_choice)) body.tool_choice = value.tool_choice;
    else {
      requireThat(
        record(value.tool_choice) &&
          value.tool_choice.type === "function" &&
          record(value.tool_choice.function) &&
          body.tools?.some((tool: Json) => tool.function.name === value.tool_choice.function.name),
        "invalid tool_choice",
      );
      body.tool_choice = { type: "function", function: { name: value.tool_choice.function.name } };
    }
  }
  requireThat(Buffer.byteLength(JSON.stringify(body)) <= MAX_BYTES, "upstream request too large");
  return body;
}

function validateUsage(usage: unknown): number {
  requireThat(record(usage), "missing usage: admission closed");
  const { prompt_tokens: input, completion_tokens: output, total_tokens: total } = usage;
  requireThat(
    Number.isSafeInteger(input) &&
      input >= 0 &&
      input <= 922_000 &&
      Number.isSafeInteger(output) &&
      output >= 0 &&
      output <= 8192 &&
      total === input + output,
    "usage violates reservation envelope",
  );
  const details = usage.prompt_tokens_details;
  requireThat(details === undefined || record(details), "invalid prompt token details");
  requireThat(
    (details?.cache_write_tokens === undefined || details.cache_write_tokens === 0) &&
      (usage.cache_write_tokens === undefined || usage.cache_write_tokens === 0),
    "unexpected cache writes violate no-write envelope",
  );
  for (const cached of [details?.cached_tokens, usage.cached_tokens])
    requireThat(
      cached === undefined || (Number.isSafeInteger(cached) && cached >= 0 && cached <= input),
      "invalid cached input accounting",
    );
  const completion = usage.completion_tokens_details;
  requireThat(completion === undefined || record(completion), "invalid completion token details");
  requireThat(
    completion?.reasoning_tokens === undefined ||
      (Number.isSafeInteger(completion.reasoning_tokens) &&
        completion.reasoning_tokens >= 0 &&
        completion.reasoning_tokens <= output),
    "invalid reasoning accounting",
  );
  // Cache reads are input subsets; completion already includes reasoning. No writes admitted.
  const units = input * 24 + output * 90;
  requireThat(units <= RESERVATION_UNITS, "estimated charge exceeds reservation");
  return units;
}
function validateModel(value: Json): void {
  // Verified dated release, not an arbitrary Luna/GPT-6 prefix match.
  // https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure#gpt-6
  requireThat(
    value.model === MODEL || value.model === "gpt-6-luna-2026-09-22",
    "returned model violates Luna envelope",
  );
  requireThat(
    value.service_tier === undefined || value.service_tier === "default",
    "returned service tier violates standard-rate envelope",
  );
}
export function validateResponse(value: unknown): { response: Json; estimatedUnits: number } {
  requireThat(record(value), "invalid Azure response");
  validateModel(value);
  const estimatedUnits = validateUsage(value.usage);
  requireThat(typeof value.id === "string" && Number.isSafeInteger(value.created), "invalid completion metadata");
  requireThat(
    Array.isArray(value.choices) && value.choices.length === 1 && value.choices[0].index === 0,
    "invalid choices",
  );
  const choice = value.choices[0];
  requireThat(record(choice.message) && choice.message.role === "assistant", "invalid assistant response");
  requireThat(
    choice.message.content === null || typeof choice.message.content === "string",
    "invalid response content",
  );
  requireThat(
    ["stop", "length", "tool_calls", "content_filter"].includes(choice.finish_reason),
    "invalid finish reason",
  );
  if (choice.message.tool_calls !== undefined) {
    requireThat(Array.isArray(choice.message.tool_calls), "invalid response tools");
    choice.message.tool_calls.forEach((call: unknown) => functionCall(call));
  }
  return { response: value, estimatedUnits };
}

const LEGACY_EVIDENCE: Record<string, [string, string]> = {
  "stm-paid-e2e-os0JV2": [
    "2783e7ddbf97a44f6a0aa6e6b6fd0df4ba225905be87b4c0f50df7d59c363d51",
    "a9af9538bb777688f493ee65e0aa3665724e453e66252785d0d0dbbbd2a91da6",
  ],
  "stm-paid-e2e-f5faOd": [
    "b311497870218049a19d9bd95207432e113063a5ec02d1cb89ff70422ae7617f",
    "10813d969fde69d53b459efa5e4eca7f733b88fa2d14135b762eee3fe26a8e83",
  ],
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export function importPrior(paths: string[]): Prior {
  const prior: Prior = { knownUnits: 0, uncertainUnits: 0, attempts: 0, provenance: [] };
  const runs = new Map<string, { report: Json; provenance: Json; count: number; known: number; uncertain: number }>();
  for (const path of paths) {
    requireThat(isAbsolute(path), "prior report path must be absolute");
    const readBounded = (file: string) => {
      requireThat(statSync(file).isFile() && statSync(file).size <= 10 * MAX_BYTES, "invalid evidence file");
      return readFileSync(file, "utf8");
    };
    const reportText = readBounded(path);
    const report = JSON.parse(reportText);
    requireThat(
      record(report) && typeof report.runID === "string" && /^stm-paid-e2e-[a-zA-Z0-9]+$/.test(report.runID),
      "invalid prior report",
    );
    const logText = readBounded(join(dirname(path), "requests.jsonl"));
    const provenance = { runID: report.runID, reportSHA256: sha256(reportText), requestsSHA256: sha256(logText) };
    const existing = runs.get(report.runID);
    if (existing) {
      requireThat(
        JSON.stringify(existing.provenance) === JSON.stringify(provenance),
        "conflicting duplicate run evidence",
      );
      continue;
    }
    const legacy = LEGACY_EVIDENCE[report.runID];
    const trustedLegacy = legacy?.[0] === provenance.reportSHA256 && legacy?.[1] === provenance.requestsSHA256;
    if (legacy) requireThat(trustedLegacy, "legacy evidence hash mismatch");
    const entries = new Map<number, { reserve: Json; terminals: Json[] }>();
    requireThat(logText.endsWith("\n"), "incomplete request log");
    for (const line of logText.trimEnd().split("\n")) {
      const event = JSON.parse(line);
      requireThat(
        record(event) &&
          typeof event.time === "string" &&
          Number.isFinite(Date.parse(event.time)) &&
          Number.isSafeInteger(event.elapsedMs) &&
          event.elapsedMs >= 0,
        "malformed request event",
      );
      if (event.attempt === null) {
        requireThat(
          ["closed", "rejected"].includes(event.admission) && event.reservationRetained === false && !event.usage,
          "invalid unreserved event",
        );
        continue;
      }
      requireThat(Number.isSafeInteger(event.attempt) && event.attempt > 0, "invalid attempt ID");
      if (event.admission === "reserved") {
        requireThat(
          !entries.has(event.attempt) && event.reservedUnits === RESERVATION_UNITS,
          "duplicate or invalid reservation",
        );
        entries.set(event.attempt, { reserve: event, terminals: [] });
      } else {
        const entry = entries.get(event.attempt);
        requireThat(entry && Date.parse(event.time) >= Date.parse(entry.reserve.time), "terminal without reservation");
        entry.terminals.push(event);
      }
    }
    let known = 0;
    let uncertain = 0;
    for (const { terminals } of entries.values()) {
      requireThat(terminals.length >= 1 && terminals.length <= 2, "missing or duplicate terminal");
      const terminal = terminals[0];
      if (terminal.usage !== undefined) {
        const units = validateUsage(terminal.usage);
        requireThat(
          terminal.status === 200 && terminal.estimatedUpperBoundUnits === units && !terminal.error,
          "conflicting usage terminal",
        );
        let validated = trustedLegacy;
        if (!trustedLegacy && terminal.responseValidated === true && record(terminal.responseMetadata)) {
          requireThat(
            terminal.accountingState === "settled" && terminal.reservationRetained === false,
            "conflicting settlement state",
          );
          validateModel(terminal.responseMetadata);
          validated = true;
        }
        if (validated) known += units;
        else uncertain += RESERVATION_UNITS;
        if (terminals.length === 2)
          requireThat(
            terminal.responseValidated === true &&
              terminals[1].accountingState === "settled" &&
              terminals[1].admission === "closed" &&
              terminals[1].reservationRetained === false &&
              typeof terminals[1].error === "string" &&
              !terminals[1].usage,
            "conflicting delivery terminal",
          );
      } else {
        requireThat(
          terminals.length === 1 &&
            terminal.admission === "closed" &&
            terminal.reservationRetained === true &&
            typeof terminal.error === "string",
          "invalid uncertain terminal",
        );
        uncertain += RESERVATION_UNITS;
      }
    }
    requireThat(entries.size === report.attemptsIncludingPreflight, "report attempt count mismatch");
    if (trustedLegacy)
      requireThat(Math.abs(known / 1e8 - report.estimatedUpperBoundUSD) < 1e-12, "report usage mismatch");
    else {
      const loggedSettled = [...entries.values()].reduce(
        (sum, entry) => sum + (entry.terminals[0].usage === undefined ? 0 : validateUsage(entry.terminals[0].usage)),
        0,
      );
      const loggedUncertain =
        [...entries.values()].filter((entry) => entry.terminals[0].usage === undefined).length * RESERVATION_UNITS;
      requireThat(report.currentSettledUSD === loggedSettled / 1e8, "report settlement mismatch");
      requireThat(
        report.currentUncertainUSD === loggedUncertain / 1e8 &&
          report.currentOutstandingUSD === 0 &&
          Number.isSafeInteger(report.totalExposureUnits) &&
          report.totalExposureUnits >= 0 &&
          report.totalExposureUnits <= LIMIT_UNITS &&
          report.totalExposureUSD === report.totalExposureUnits / 1e8,
        "report exposure mismatch",
      );
    }
    runs.set(report.runID, { report, provenance, count: entries.size, known, uncertain });
    prior.knownUnits += known;
    prior.uncertainUnits += uncertain;
    prior.attempts += entries.size;
    prior.provenance.push({
      ...provenance,
      validation: trustedLegacy
        ? "hash-bound original validator; response model not recaptured"
        : "captured validation metadata where present; unknown metadata retains reserve",
    });
  }
  for (const [runID, { report }] of runs) {
    if (report.priorProvenance) {
      requireThat(Array.isArray(report.priorProvenance), "invalid prior provenance");
      const dependencies = new Set<string>();
      let dependencyCount = 0;
      let dependencyKnown = 0;
      let dependencyUncertain = 0;
      for (const dependency of report.priorProvenance) {
        requireThat(
          record(dependency) && dependency.runID !== runID && !dependencies.has(dependency.runID),
          "invalid prior dependency",
        );
        dependencies.add(dependency.runID);
        const imported = runs.get(dependency.runID)?.provenance;
        requireThat(
          imported &&
            imported.reportSHA256 === dependency.reportSHA256 &&
            imported.requestsSHA256 === dependency.requestsSHA256,
          "missing or conflicting prior dependency",
        );
        dependencyCount += runs.get(dependency.runID)!.count;
        dependencyKnown += runs.get(dependency.runID)!.known;
        dependencyUncertain += runs.get(dependency.runID)!.uncertain;
      }
      requireThat(dependencyCount === report.priorAttempts, "prior attempt count mismatch");
      requireThat(
        report.priorKnownUSD === dependencyKnown / 1e8 &&
          report.priorUncertainUSD === dependencyUncertain / 1e8 &&
          report.totalExposureUnits ===
            dependencyKnown +
              dependencyUncertain +
              Math.round(report.currentSettledUSD * 1e8) +
              Math.round(report.currentUncertainUSD * 1e8),
        "prior exposure mismatch",
      );
    } else if (report.priorAttempts) {
      // Only inspected legacy reports can establish historical anonymous carryover.
      requireThat(
        runID === "stm-paid-e2e-f5faOd" && report.priorAttempts === 1 && runs.has("stm-paid-e2e-os0JV2"),
        "unresolved anonymous prior attempts",
      );
    } else requireThat(LEGACY_EVIDENCE[runID], "missing prior provenance");
  }
  createLedger(prior);
  return prior;
}
export function completionSSE(response: Json): string {
  const choice = response.choices[0];
  const base = { id: response.id, object: "chat.completion.chunk", created: response.created, model: response.model };
  const chunk = (delta: Json, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  let text = chunk({ role: "assistant", content: "" });
  if (choice.message.content) text += chunk({ content: choice.message.content });
  if (choice.message.tool_calls?.length)
    text += chunk({
      tool_calls: choice.message.tool_calls.map((call: unknown, index: number) => functionCall(call, index)),
    });
  text += chunk({}, choice.finish_reason);
  text += `data: ${JSON.stringify({ ...base, choices: [], usage: response.usage })}\n\ndata: [DONE]\n\n`;
  return text;
}
async function cappedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  requireThat(body, "missing body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      requireThat(size <= MAX_BYTES, "body exceeds 1 MiB");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function redact(text: string, secrets: string[] = []): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/(Bearer\s+)[^\s"\\]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[-_]?key|authorization|access_token|token|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1[REDACTED]",
    );
}
export function createProxy(options: {
  endpoint: string;
  apiKey: string;
  token: string;
  ledger: Ledger;
  signal?: AbortSignal;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  telemetry?: (event: Json) => void;
  onClosed?: () => void;
}) {
  const { ledger, token, apiKey } = options;
  return async (request: Request): Promise<Response> => {
    const errorResponse = (status: number, message: string) =>
      Response.json({ error: { message, type: "paid_e2e_blocker" } }, { status });
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return errorResponse(401, "local authorization required");
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return errorResponse(404, "route not admitted");
    let id: number | undefined;
    let status: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const emit = (event: Json) =>
      options.telemetry?.({
        time: new Date().toISOString(),
        attempt: id ?? null,
        elapsedMs: Date.now() - started,
        ...event,
      });
    try {
      const incoming = JSON.parse(await cappedText(request.body));
      const body = allowlistedBody(incoming);
      const streaming = incoming.stream === true;
      id = reserve(ledger);
      emit({ admission: "reserved", reservedUnits: RESERVATION_UNITS, totalReservedUnits: ledger.reservedUnits });
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 90_000);
      const upstream = await (options.fetcher ?? fetch)(options.endpoint, {
        method: "POST",
        headers: { "api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
        redirect: "error",
      });
      status = upstream.status;
      const text = await cappedText(upstream.body);
      if (!upstream.ok) {
        // Preserve the provider's HTTP status and error, but never echo a raw completion.
        retainUncertain(ledger, id);
        let error: unknown;
        try {
          error = JSON.parse(text).error;
        } catch {
          /* Non-JSON errors are still actionable. */
        }
        const safe = redact(error === undefined ? text : JSON.stringify(error), [apiKey, token]);
        emit({ status, error: safe.slice(0, 4096), admission: "closed", reservationRetained: true });
        return new Response(error === undefined ? safe.slice(0, 4096) : `{"error":${safe}}`, {
          status,
          headers: { "content-type": error === undefined ? "text/plain" : "application/json" },
        });
      }
      requireThat(status === 200, "unexpected successful provider status");
      const { response, estimatedUnits } = validateResponse(JSON.parse(text));
      settle(ledger, id, estimatedUnits);
      emit({
        status,
        usage: {
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
          ...(response.usage.prompt_tokens_details === undefined
            ? {}
            : { prompt_tokens_details: response.usage.prompt_tokens_details }),
          ...(response.usage.completion_tokens_details === undefined
            ? {}
            : { completion_tokens_details: response.usage.completion_tokens_details }),
          ...(response.usage.cache_write_tokens === undefined
            ? {}
            : { cache_write_tokens: response.usage.cache_write_tokens }),
          ...(response.usage.cached_tokens === undefined ? {} : { cached_tokens: response.usage.cached_tokens }),
        },
        estimatedUpperBoundUnits: estimatedUnits,
        reservationRetained: false,
        accountingState: "settled",
        responseValidated: true,
        responseMetadata: { model: response.model, service_tier: response.service_tier },
        totalExposureUnits: ledger.reservedUnits,
      });
      // The upstream is always nonstreaming; only the local client's wire format varies.
      const result = streaming ? completionSSE(response) : JSON.stringify(response);
      requireThat(Buffer.byteLength(result) <= MAX_BYTES, "local response exceeds 1 MiB");
      return new Response(result, {
        headers: { "content-type": streaming ? "text/event-stream" : "application/json", "cache-control": "no-store" },
      });
    } catch (error) {
      if (id !== undefined) retainUncertain(ledger, id);
      const message = redact(error instanceof Error ? error.message : "proxy failure", [apiKey, token]).slice(0, 4096);
      emit({
        status: status ?? null,
        error: message,
        admission: ledger.closed ? "closed" : "rejected",
        reservationRetained: id !== undefined && ledger.entries.get(id)?.state !== "settled",
        accountingState: id === undefined ? undefined : ledger.entries.get(id)?.state,
      });
      return errorResponse(id === undefined ? (ledger.closed ? 429 : 400) : 502, message);
    } finally {
      if (timer) clearTimeout(timer);
      if (ledger.closed) options.onClosed?.();
    }
  };
}

function sandboxEnvironment(root: string, baseURL: string, token: string): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const config = {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["paid-e2e"],
    model: MODEL_ID,
    small_model: MODEL_ID,
    provider: {
      "paid-e2e": {
        npm: "@ai-sdk/openai-compatible",
        name: "Bounded Azure Luna",
        options: { baseURL, apiKey: token },
        models: {
          [MODEL]: {
            name: MODEL,
            tool_call: true,
            reasoning: true,
            limit: { context: 1050000, input: 922000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    permission: { "*": "deny", "stm_memory_*": "allow", short_term_memory: "allow" },
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    lsp: false,
    formatter: false,
    server: { hostname: "127.0.0.1" },
  };
  return {
    PATH: `${root}/bin:/home/dev/.opencode/bin:/home/dev/.bun/bin:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    OPENCODE_DB: join(root, "db", "opencode.db"),
    BUN_INSTALL_CACHE_DIR: join(root, "cache", "bun"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_E2E: "1",
    STM_E2E_MODEL: MODEL_ID,
    STM_E2E_FALLBACK_MODEL: MODEL_ID,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    OPENCODE_DISABLE_TERMINAL_TITLE: "1",
  };
}
function setupSandbox(): string {
  requireThat(statSync(PARENT).isDirectory(), "sandbox parent missing");
  const root = mkdtempSync(join(PARENT, "stm-paid-e2e-"));
  for (const dir of [
    "home/.config",
    "home/.local/share/opencode",
    "cache",
    "state",
    "runtime",
    "tmp",
    "db",
    "bin",
    "evidence",
  ])
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "home/.local/share/opencode/auth.json"), "{}\n", { mode: 0o600 });
  symlinkSync(realpathSync(process.execPath), join(root, "bin", "node"));
  return root;
}
function smokeHelper(root: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(
    "node",
    [join(REPO, "scripts/e2e-symlink-plugin.mjs"), join(root, "smoke-config"), join(REPO, "src/index.ts")],
    { env, timeout: 10_000 },
  );
  requireThat(
    result.status === 0 && existsSync(join(root, "smoke-config/opencode/plugins/opencode-short-term-memory.ts")),
    "Bun-backed node helper smoke failed",
  );
  const cli = spawnSync("opencode", ["--version"], { env, timeout: 10_000 });
  requireThat(cli.status === 0, "opencode unavailable: suite would skip");
  return cli.stdout.toString().trim();
}
function killGroup(group: number | undefined): void {
  if (group === undefined) return;
  try {
    process.kill(-group, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function run(prior: Prior, selectedCli?: ReturnType<typeof validateCliPath>): Promise<void> {
  const ledger = createLedger(prior);
  const root = setupSandbox();
  const token = randomBytes(32).toString("hex");
  const upstreamShutdown = new AbortController();
  let apiKey = "";
  let server: ReturnType<typeof Bun.serve> | undefined;
  const inFlight = new Set<Promise<Response>>();
  let group: number | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let suiteExit: number | null = null;
  let suiteInvocations = 0;
  let blocker: string | undefined;
  let cleanup = "not started";
  let cliVersion: string | undefined;
  const command = [
    process.execPath,
    "test",
    "--isolate",
    "--max-concurrency=1",
    "--no-orphans",
    "--timeout",
    "300000",
    "--reporter=junit",
    "--reporter-outfile",
    join(root, "evidence/tests.xml"),
    "test/e2e/",
  ];
  const stopGroup = () => {
    ledger.closed = true;
    upstreamShutdown.abort();
    killGroup(group);
  };
  const onSignal = () => {
    blocker = "launcher interrupted";
    stopGroup();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    // The suite invokes opencode by name; its sandbox PATH must select this CLI too.
    if (selectedCli) symlinkSync(selectedCli.realPath, join(root, "bin", "opencode"));
    const resource = process.env.AZURE_RESOURCE_NAME;
    requireThat(
      resource && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(resource),
      "AZURE_RESOURCE_NAME required (not forwarded to child)",
    );
    const authPath = "/home/dev/.local/share/opencode/auth.json";
    const authStat = statSync(authPath);
    requireThat(
      authStat.isFile() && (authStat.mode & 0o077) === 0 && authStat.size <= MAX_BYTES,
      "auth file must be private and bounded",
    );
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    requireThat(
      record(auth.azure) &&
        auth.azure.type === "api" &&
        typeof auth.azure.key === "string" &&
        auth.azure.key.length > 0,
      "azure API auth missing",
    );
    apiKey = auth.azure.key;
    const endpoint = `https://${resource}.openai.azure.com/openai/v1/chat/completions?api-version=v1`;
    const proxy = createProxy({
      endpoint,
      apiKey,
      token,
      ledger,
      signal: upstreamShutdown.signal,
      onClosed: () => {
        blocker ??= "proxy admission closed; suite process group terminated";
        stopGroup();
      },
      telemetry: (event) =>
        appendFileSync(join(root, "evidence/requests.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 }),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: MAX_BYTES,
      idleTimeout: 120,
      fetch: (request) => {
        const pending = proxy(request);
        inFlight.add(pending);
        void pending.finally(() => inFlight.delete(pending)).catch(() => {});
        return pending;
      },
    });
    const env = sandboxEnvironment(root, `http://127.0.0.1:${server.port}/v1`, token);
    cliVersion = smokeHelper(root, env);
    deadline = setTimeout(() => {
      timedOut = true;
      blocker = "600-second outer deadline";
      stopGroup();
      server?.stop(true);
    }, 600_000);
    // Exactly one preflight, through the same ledger; never a mock or fallback.
    const preflight = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(95_000),
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "Call paid_e2e_probe with ok=true." }],
        tools: [
          {
            type: "function",
            function: {
              name: "paid_e2e_probe",
              parameters: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
              },
              strict: true,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "paid_e2e_probe" } },
        stream: false,
      }),
    });
    const preflightText = await cappedText(preflight.body);
    requireThat(
      preflight.ok,
      `Luna preflight HTTP ${preflight.status}: ${redact(preflightText, [apiKey, token]).slice(0, 4096)}`,
    );
    const probe = validateResponse(JSON.parse(preflightText)).response;
    const calls = probe.choices[0].message.tool_calls;
    requireThat(
      probe.choices[0].finish_reason === "tool_calls" &&
        calls?.length === 1 &&
        calls[0].function.name === "paid_e2e_probe" &&
        JSON.parse(calls[0].function.arguments).ok === true,
      "preflight did not satisfy required tool call",
    );
    requireThat(!ledger.closed, "admission closed before suite");
    suiteInvocations = 1;
    const child = spawn(command[0], command.slice(1), {
      cwd: REPO,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    group = child.pid;
    let logBytes = 0;
    const log = (data: Buffer) => {
      logBytes += data.length;
      if (logBytes > 10 * MAX_BYTES) {
        blocker = "suite log exceeded 10 MiB";
        stopGroup();
        return;
      }
      appendFileSync(join(root, "evidence/tests.log"), redact(data.toString(), [apiKey, token]), { mode: 0o600 });
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    suiteExit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (suiteExit !== 0) blocker ??= `suite exited ${suiteExit}`;
    if (ledger.closed) blocker ??= "proxy admission closed during suite; inspect requests.jsonl";
  } catch (error) {
    blocker = redact(error instanceof Error ? error.message : "launcher failed", [apiKey, token]);
  } finally {
    if (deadline) clearTimeout(deadline);
    stopGroup();
    if (server) await server.stop(true);
    await Promise.allSettled([...inFlight]);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    // Keep only private evidence; remove the sandbox's token-bearing config/state/logs.
    for (const entry of ["home", "cache", "state", "runtime", "tmp", "db", "bin", "smoke-config"])
      rmSync(join(root, entry), { recursive: true, force: true });
    cleanup = "process group killed; proxy stopped; sandbox state removed; private evidence retained";
    let tests: Json | null = null;
    const xmlPath = join(root, "evidence/tests.xml");
    if (existsSync(xmlPath)) {
      const xml = readFileSync(xmlPath, "utf8");
      // Test output can contain prompts/completions. Keep it private, out of the summary.
      const match = xml.match(/<testsuites\b([^>]*)>/) ?? xml.match(/<testsuite\b([^>]*)>/);
      if (match)
        tests = Object.fromEntries(
          [...match[1].matchAll(/(tests|failures|errors|skipped)="(\d+)"/g)].map((m) => [m[1], Number(m[2])]),
        );
      if (!tests?.tests) {
        tests = { tests: 0, failures: 0, errors: 0, skipped: 0 };
        for (const suite of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
          for (const attribute of suite[1].matchAll(/(tests|failures|errors|skipped)="(\d+)"/g))
            tests[attribute[1]] += Number(attribute[2]);
        }
      }
      writeFileSync(xmlPath, redact(xml, [apiKey, token]), { mode: 0o600 });
    }
    const logPath = join(root, "evidence/tests.log");
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const parsedCounts = {
      pass: (log.match(/^\(pass\) /gm) ?? []).length,
      fail: (log.match(/^\(fail\) /gm) ?? []).length,
      skip: (log.match(/^\(skip\) /gm) ?? []).length,
      source: "completed test lines; partial if interrupted",
    };
    for (const entry of ledger.entries.values()) if (entry.state === "pending") entry.state = "uncertain";
    const currentUncertain = [...ledger.entries.values()]
      .filter((entry) => entry.state === "uncertain")
      .reduce((sum, entry) => sum + entry.units, 0);
    const report = {
      runID: root.split("/").at(-1),
      artifact:
        "/home/dev/workspace/opencode-work/opencode-short-term-memory-v2-latest-parity/2026-10-07--paid-usage-settlement.html",
      command,
      cli: {
        selection: selectedCli ? "explicit --cli-path" : "default sandbox PATH",
        ...selectedCli,
        version: cliVersion,
      },
      suiteInvocations,
      suiteExit,
      tests,
      parsedCounts,
      executedTests: tests ? tests.tests - (tests.skipped ?? 0) : null,
      timedOut,
      priorAttempts: prior.attempts,
      priorProvenance: prior.provenance,
      priorKnownUSD: prior.knownUnits / 1e8,
      priorUncertainUSD: prior.uncertainUnits / 1e8,
      attemptsIncludingPreflight: ledger.attempts,
      totalAttempts: prior.attempts + ledger.attempts,
      currentSettledUSD: ledger.estimatedUnits / 1e8,
      currentUncertainUSD: currentUncertain / 1e8,
      currentOutstandingUSD: 0,
      totalExposureUnits: ledger.reservedUnits,
      totalExposureUSD: ledger.reservedUnits / 1e8,
      maxObservedExposureUnits: ledger.maxObservedUnits,
      maxObservedExposureUSD: ledger.maxObservedUnits / 1e8,
      pricing:
        "published Standard-rate upper envelope: USD 0.24/M input and 0.90/M output (EU long context); explicit cache mode without breakpoints; NOT invoice guarantee; unknown deployment SKU; validated usage settles once; uncertain/outstanding attempts retain full worst-case reservation",
      pricingSources: [
        "https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/",
        "https://aka.ms/AOAIpricingbanner",
        "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching",
      ],
      globalBudgetChanged: false,
      isolation:
        "trusted suite only; not an OS security sandbox; harness auto/skip-permissions may override tool denials; child has no Azure credentials",
      evidence: join(root, "evidence"),
      cleanup,
      blocker: blocker ?? null,
    };
    writeFileSync(join(root, "evidence/report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    if (blocker || suiteInvocations !== 1 || !tests || !tests.tests || tests.tests === tests.skipped)
      process.exitCode = 1;
  }
}

async function selfTest(): Promise<void> {
  const priorPaths = [
    "/tmp/opencode/stm-paid-e2e-os0JV2/evidence/report.json",
    "/tmp/opencode/stm-paid-e2e-f5faOd/evidence/report.json",
  ];
  assert.deepEqual(
    parseRunArgs(["--run", "--prior-evidence", dirname(priorPaths[0]), "--prior-report", priorPaths[1]]),
    { priorPaths },
  );
  assert.deepEqual(parseRunArgs(["--run", "--cli-path", "/tmp/corrected cli", "--prior-report", priorPaths[0]]), {
    priorPaths: [priorPaths[0]],
    cliPath: "/tmp/corrected cli",
  });
  for (const args of [
    ["--run"],
    ["--run", "--prior-evidence"],
    ["--run", "--prior-report", "relative"],
    ["--run", "--other", "/tmp/report.json"],
    ["--run", "--prior-attempts", "1"],
    ["--run", "--cli-path", "/tmp/corrected"],
    ["--run", "--prior-report", priorPaths[0], "--cli-path", "relative"],
    ["--run", "--prior-report", priorPaths[0], "--cli-path"],
    ["--run", "--prior-report", priorPaths[0], "--cli-path", "/tmp/a", "--cli-path", "/tmp/b"],
  ])
    assert.throws(() => parseRunArgs(args));
  for (const knownUnits of [-1, 1.5, NaN, Infinity, LIMIT_UNITS + 1])
    assert.throws(() => createLedger({ knownUnits, uncertainUnits: 0, attempts: 0, provenance: [] }));
  const carried = createLedger({ knownUnits: 0, uncertainUnits: RESERVATION_UNITS, attempts: 1, provenance: [] });
  assert.equal(reserve(carried), 1);
  assert.equal(carried.reservedUnits, 45_730_560);
  settle(carried, 1, 114);
  assert.equal(carried.reservedUnits, RESERVATION_UNITS + 114);
  assert.throws(() => settle(carried, 1, 114));
  assert.throws(() => settle(carried, 99, 114));
  const pendingID = reserve(carried);
  assert.throws(() => settle(carried, pendingID, RESERVATION_UNITS + 1));
  retainUncertain(carried, pendingID);
  assert.throws(() => settle(carried, pendingID, 1));
  const ledger = createLedger();
  await Promise.all(Array.from({ length: 21 }, async () => reserve(ledger)));
  assert.equal(ledger.reservedUnits, 480_170_880);
  assert.throws(() => reserve(ledger));
  assert.equal(ledger.attempts, 21);
  assert.equal(ledger.reservedUnits, 480_170_880);
  const request = {
    model: MODEL,
    stream: true,
    messages: [
      {
        role: "user",
        prompt_cache_breakpoint: { mode: "explicit" },
        cache_control: { type: "ephemeral" },
        content: [{ type: "text", text: "test", prompt_cache_breakpoint: { mode: "explicit" } }],
      },
    ],
    temperature: 99,
    max_completion_tokens: 999999,
    max_tokens: 999999,
    reasoning_effort: "max",
    service_tier: "priority",
    prompt_cache_options: { mode: "implicit", ttl: "30m" },
    prompt_cache_key: "caller-key",
    prompt_cache_retention: "24h",
    metadata: { prompt_cache_breakpoint: { mode: "explicit" } },
  };
  const body = allowlistedBody(request);
  assert.equal(body.stream, false);
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal(body.temperature, undefined);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.n, 1);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.service_tier, "default");
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.prompt_cache_retention, undefined);
  assert.equal(body.metadata, undefined);
  assert.deepEqual(body.messages, [{ role: "user", content: "test" }]);
  const toolBody = allowlistedBody({
    ...request,
    tools: [
      {
        type: "function",
        prompt_cache_breakpoint: { mode: "explicit" },
        cache_control: { type: "ephemeral" },
        function: {
          name: "probe",
          parameters: { type: "object", properties: {} },
          prompt_cache_breakpoint: { mode: "explicit" },
          metadata: { cache_control: { type: "ephemeral" } },
        },
      },
    ],
  });
  assert.deepEqual(toolBody.tools, [
    { type: "function", function: { name: "probe", parameters: { type: "object", properties: {} } } },
  ]);
  assert.equal(toolBody.reasoning_effort, "none");
  assert.throws(() => allowlistedBody({ ...request, model: "other" }));
  assert.throws(() => allowlistedBody({ ...request, n: 2 }));
  assert.throws(() => allowlistedBody({ ...request, messages: [{ role: "user", content: [{ type: "image_url" }] }] }));
  const response = {
    id: "mock",
    created: 1,
    model: "gpt-6-luna-2026-09-22",
    service_tier: "default",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [0, 1].map((i) => ({
            id: `call${i}`,
            type: "function",
            function: { name: `tool${i}`, arguments: "{}" },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 922000,
      completion_tokens: 8192,
      total_tokens: 930192,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  };
  assert.equal(validateResponse(response).estimatedUnits, RESERVATION_UNITS);
  assert.equal(
    validateResponse({ ...response, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      .estimatedUnits,
    114,
  );
  assert.equal(validateResponse({ ...response, model: MODEL }).estimatedUnits, RESERVATION_UNITS);
  assert.throws(() => validateResponse({ ...response, usage: undefined }));
  assert.throws(() => validateResponse({ ...response, model: "gpt-5" }));
  for (const model of ["gpt-6-sol", "gpt-6-luna-preview", "gpt-6-luna-2026-09-23", "gpt-6-luna-2026-09-22-extra"])
    assert.throws(() => validateResponse({ ...response, model }));
  assert.throws(() => validateResponse({ ...response, service_tier: "priority" }));
  assert.throws(() => validateResponse({ ...response, usage: { ...response.usage, completion_tokens: 8193 } }));
  assert.throws(() =>
    validateResponse({ ...response, usage: { ...response.usage, prompt_tokens: 922001, total_tokens: 930193 } }),
  );
  for (const cache_write_tokens of [1, -1, null, "0", 0.5])
    assert.throws(() =>
      validateResponse({
        ...response,
        usage: { ...response.usage, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens } },
      }),
    );
  assert.throws(() => validateResponse({ ...response, usage: { ...response.usage, cache_write_tokens: 1 } }));
  assert.throws(() => validateResponse({ ...response, usage: { ...response.usage, prompt_tokens_details: null } }));
  assert.equal(
    validateResponse({
      ...response,
      usage: { ...response.usage, prompt_tokens_details: { cached_tokens: 922000, cache_write_tokens: 0 } },
    }).estimatedUnits,
    RESERVATION_UNITS,
  );
  assert.equal(
    validateResponse({ ...response, usage: { ...response.usage, prompt_tokens_details: undefined } }).estimatedUnits,
    RESERVATION_UNITS,
  );
  const sse = completionSSE(response);
  assert.match(sse, /"index":1,"id":"call1"/);
  assert.match(sse, /"finish_reason":"tool_calls"/);
  assert.match(sse, /"choices":\[\],"usage"/);
  assert.ok(sse.endsWith("data: [DONE]\n\n"));
  const makeRequest = (payload: Json = request, authorized = true) =>
    new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: authorized ? "Bearer local-secret" : "wrong" },
      body: JSON.stringify(payload),
    });
  let fetches = 0;
  const mockLedger = createLedger();
  const events: Json[] = [];
  const proxy = createProxy({
    endpoint: "https://mock.invalid",
    apiKey: "azure-secret",
    token: "local-secret",
    ledger: mockLedger,
    telemetry: (e) => events.push(e),
    fetcher: async (_url, init) => {
      fetches++;
      assert.equal(mockLedger.attempts, fetches);
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("api-key"), "azure-secret");
      assert.deepEqual(JSON.parse(init.body as string), body);
      return Response.json(response);
    },
  });
  assert.equal((await proxy(makeRequest(request, false))).status, 401);
  assert.equal(fetches, 0);
  const good = await proxy(makeRequest());
  assert.equal(good.status, 200);
  assert.equal(mockLedger.reservedUnits, RESERVATION_UNITS);
  assert.equal(good.headers.get("content-type"), "text/event-stream");
  assert.match(await good.text(), /"index":1,"id":"call1"/);
  assert.equal(mockLedger.estimatedUnits, RESERVATION_UNITS);
  assert.ok(!JSON.stringify(events).includes("azure-secret"));
  const loopback = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_BYTES, fetch: proxy });
  try {
    const wire = await fetch(`http://127.0.0.1:${loopback.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(wire.headers.get("content-type"), "text/event-stream");
    assert.match(await wire.text(), /"index":1,"id":"call1"/);
  } finally {
    await loopback.stop(true);
  }
  const rejected = await proxy(
    makeRequest({ ...request, messages: [{ role: "user", content: "x".repeat(MAX_BYTES) }] }),
  );
  assert.equal(rejected.status, 400);
  assert.equal(fetches, 2);
  const concurrentLedger = createLedger({
    knownUnits: 0,
    uncertainUnits: RESERVATION_UNITS,
    attempts: 1,
    provenance: [],
  });
  let concurrentFetches = 0;
  const concurrentProxy = createProxy({
    endpoint: "https://mock.invalid",
    apiKey: "azure-secret",
    token: "local-secret",
    ledger: concurrentLedger,
    fetcher: async () => {
      concurrentFetches++;
      await Promise.resolve();
      return Response.json(response);
    },
  });
  const concurrentResults = await Promise.all(Array.from({ length: 22 }, () => concurrentProxy(makeRequest())));
  assert.equal(concurrentResults.filter((result) => result.status === 200).length, 20);
  assert.equal(concurrentResults.filter((result) => result.status === 429).length, 2);
  assert.equal(concurrentFetches, 20);
  assert.equal(concurrentLedger.attempts, 20);
  assert.equal(concurrentLedger.reservedUnits, 480_170_880);
  assert.equal(concurrentLedger.estimatedUnits, 457_305_600);
  assert.equal(concurrentLedger.closed, true);
  for (const failure of [
    "provider",
    "missing-usage",
    "network",
    "oversized",
    "local-oversized",
    "cache-write",
    "tier",
    "model",
    "malformed-tools",
    "reasoning",
    "timeout",
  ]) {
    const failed = createLedger();
    let calls = 0;
    const handler = createProxy({
      endpoint: "https://mock.invalid",
      apiKey: "azure-secret",
      token: "local-secret",
      ledger: failed,
      fetcher: async () => {
        calls++;
        if (failure === "network") throw new Error("azure-secret local-secret");
        if (failure === "timeout") throw new DOMException("mock timeout", "TimeoutError");
        if (failure === "oversized") return new Response("x".repeat(MAX_BYTES + 1));
        if (failure === "local-oversized") {
          const large = {
            ...response,
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
          };
          large.choices[0].message.content = "x".repeat(MAX_BYTES - Buffer.byteLength(JSON.stringify(large)));
          assert.equal(Buffer.byteLength(JSON.stringify(large)), MAX_BYTES);
          assert.ok(Buffer.byteLength(completionSSE(large)) > MAX_BYTES);
          return Response.json(large);
        }
        if (failure === "cache-write")
          return Response.json({
            ...response,
            usage: { ...response.usage, prompt_tokens_details: { cache_write_tokens: 1 } },
          });
        if (failure === "tier") return Response.json({ ...response, service_tier: "priority" });
        if (failure === "model") return Response.json({ ...response, model: "gpt-6-sol" });
        if (failure === "malformed-tools")
          return Response.json({
            ...response,
            choices: [{ ...response.choices[0], message: { ...response.choices[0].message, tool_calls: [{}] } }],
          });
        if (failure === "reasoning")
          return Response.json({
            ...response,
            usage: { ...response.usage, completion_tokens_details: { reasoning_tokens: 8193 } },
          });
        if (failure === "provider")
          return Response.json(
            { error: { code: "DeploymentNotFound", message: "azure-secret local-secret" } },
            { status: 404 },
          );
        return Response.json({ ...response, usage: undefined });
      },
    });
    const result = await handler(makeRequest());
    assert.equal(result.status, failure === "provider" ? 404 : 502);
    assert.ok(!(await result.text()).includes("azure-secret"));
    assert.equal(failed.reservedUnits, failure === "local-oversized" ? 114 : RESERVATION_UNITS);
    assert.equal(failed.estimatedUnits, failure === "local-oversized" ? 114 : 0);
    assert.equal(failed.entries.get(1)?.state, failure === "local-oversized" ? "settled" : "uncertain");
    assert.equal(failed.closed, true);
    assert.equal((await handler(makeRequest())).status, 429);
    assert.equal(calls, 1);
  }
  const smallResponse = {
    ...response,
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  };
  const sequential = createLedger();
  const sequentialProxy = createProxy({
    endpoint: "https://mock.invalid",
    apiKey: "mock",
    token: "local-secret",
    ledger: sequential,
    fetcher: async () => Response.json(smallResponse),
  });
  for (let i = 0; i < 50; i++) assert.equal((await sequentialProxy(makeRequest())).status, 200);
  assert.equal(sequential.attempts, 50);
  assert.equal(sequential.estimatedUnits, 50 * 114);
  assert.equal(sequential.reservedUnits, 50 * 114);
  assert.ok(sequential.maxObservedUnits <= LIMIT_UNITS);
  assert.equal(sequential.closed, false);

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const exited = new Promise<string | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (_code, signal) => resolve(signal));
  });
  const exhausted = createLedger({ knownUnits: LIMIT_UNITS, uncertainUnits: 0, attempts: 1, provenance: [] });
  let closedCalls = 0;
  let shutdownFetches = 0;
  const shutdownProxy = createProxy({
    endpoint: "https://mock.invalid",
    apiKey: "mock",
    token: "local-secret",
    ledger: exhausted,
    fetcher: async () => {
      shutdownFetches++;
      return Response.json(smallResponse);
    },
    onClosed: () => {
      closedCalls++;
      killGroup(child.pid);
    },
  });
  const safety = setTimeout(() => killGroup(child.pid), 3000);
  try {
    const start = Date.now();
    assert.equal((await shutdownProxy(makeRequest())).status, 429);
    assert.equal(await exited, "SIGKILL");
    assert.ok(Date.now() - start < 2500);
    assert.equal(closedCalls, 1);
    assert.equal(shutdownFetches, 0);
  } finally {
    clearTimeout(safety);
    killGroup(child.pid);
  }

  if (priorPaths.every(existsSync)) {
    const before = priorPaths
      .flatMap((path) => [path, join(dirname(path), "requests.jsonl")])
      .map((path) => sha256(readFileSync(path, "utf8")));
    const imported = importPrior(priorPaths);
    assert.equal(imported.knownUnits, 2_164_704);
    assert.equal(imported.uncertainUnits, RESERVATION_UNITS);
    assert.equal(imported.attempts, 21);
    assert.equal(createLedger(imported).reservedUnits, 25_029_984);
    assert.deepEqual(importPrior([...priorPaths, ...priorPaths]), imported);
    assert.throws(() => importPrior([priorPaths[1]]));
    assert.deepEqual(
      priorPaths
        .flatMap((path) => [path, join(dirname(path), "requests.jsonl")])
        .map((path) => sha256(readFileSync(path, "utf8"))),
      before,
    );
  }
  const fixtureRoot = mkdtempSync(join(PARENT, "stm-ledger-selftest-"));
  try {
    const reportPath = join(fixtureRoot, "report.json");
    const logPath = join(fixtureRoot, "requests.jsonl");
    const report = {
      runID: "stm-paid-e2e-mock",
      attemptsIncludingPreflight: 1,
      currentSettledUSD: 114 / 1e8,
      currentUncertainUSD: 0,
      currentOutstandingUSD: 0,
      totalExposureUnits: 114,
      totalExposureUSD: 114 / 1e8,
      priorAttempts: 0,
      priorKnownUSD: 0,
      priorUncertainUSD: 0,
      priorProvenance: [],
    };
    const reservation = {
      time: new Date(0).toISOString(),
      elapsedMs: 0,
      attempt: 1,
      admission: "reserved",
      reservedUnits: RESERVATION_UNITS,
    };
    const terminal = {
      time: new Date(1).toISOString(),
      elapsedMs: 1,
      attempt: 1,
      status: 200,
      usage: smallResponse.usage,
      estimatedUpperBoundUnits: 114,
      responseValidated: true,
      responseMetadata: { model: MODEL, service_tier: "default" },
      reservationRetained: false,
      accountingState: "settled",
    };
    const fixture = (rows: Json[], summary = report) => {
      writeFileSync(reportPath, JSON.stringify(summary));
      writeFileSync(logPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    };
    fixture([reservation, terminal]);
    assert.equal(importPrior([reportPath]).knownUnits, 114);
    fixture([reservation, { ...terminal, responseMetadata: undefined }]);
    assert.equal(importPrior([reportPath]).uncertainUnits, RESERVATION_UNITS);
    fixture([reservation]);
    assert.throws(() => importPrior([reportPath]));
    fixture([reservation, terminal, terminal]);
    assert.throws(() => importPrior([reportPath]));
    fixture([reservation, { ...terminal, usage: { ...smallResponse.usage, total_tokens: 3 } }]);
    assert.throws(() => importPrior([reportPath]));
    fixture([reservation, { ...terminal, responseMetadata: { model: "gpt-6-sol" } }]);
    assert.throws(() => importPrior([reportPath]));
    fixture([reservation, terminal], { ...report, attemptsIncludingPreflight: 2 });
    assert.throws(() => importPrior([reportPath]));
    fixture([reservation, terminal]);
    writeFileSync(logPath, "{incomplete");
    assert.throws(() => importPrior([reportPath]));
    fixture([reservation, terminal]);
    const duplicateDir = join(fixtureRoot, "duplicate");
    mkdirSync(duplicateDir);
    writeFileSync(join(duplicateDir, "report.json"), JSON.stringify({ ...report, currentSettledUSD: 0 }));
    writeFileSync(join(duplicateDir, "requests.jsonl"), readFileSync(logPath));
    assert.throws(() => importPrior([reportPath, join(duplicateDir, "report.json")]));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  const root = setupSandbox();
  try {
    const env = sandboxEnvironment(root, "http://127.0.0.1:1/v1", "local-secret");
    assert.equal(env.AZURE_RESOURCE_NAME, undefined);
    assert.equal(env.AZURE_API_KEY, undefined);
    assert.equal(env.STM_E2E_MODEL, "paid-e2e/gpt-6-luna");
    assert.equal(env.STM_E2E_FALLBACK_MODEL, "paid-e2e/gpt-6-luna");
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    assert.equal(config.model, "paid-e2e/gpt-6-luna");
    assert.equal(config.small_model, "paid-e2e/gpt-6-luna");
    assert.deepEqual(config.enabled_providers, ["paid-e2e"]);
    assert.deepEqual(config.provider["paid-e2e"].models[MODEL].limit, {
      context: 1050000,
      input: 922000,
      output: 8192,
    });
    assert.equal(readFileSync(join(root, "home/.local/share/opencode/auth.json"), "utf8"), "{}\n");
    smokeHelper(root, env);
    assert.throws(() => validateCliPath("relative"));
    assert.throws(() => validateCliPath(root));
    assert.throws(() => validateCliPath(join(root, "missing")));
    const nonExecutable = join(root, "not-executable");
    writeFileSync(nonExecutable, "not executable\n", { mode: 0o600 });
    assert.throws(() => validateCliPath(nonExecutable));
    const executable = join(root, "selected cli");
    const fixture = `#!${realpathSync(process.execPath)}\nconsole.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME}));\n`;
    writeFileSync(executable, fixture, { mode: 0o700 });
    const alias = join(root, "selected alias");
    symlinkSync(executable, alias);
    const selected = validateCliPath(alias);
    assert.deepEqual(selected, { path: alias, realPath: executable, sha256: sha256(fixture) });
    symlinkSync(selected.realPath, join(root, "bin", "opencode"));
    assert.equal(realpathSync(join(root, "bin", "opencode")), selected.realPath);
    assert.deepEqual(JSON.parse(smokeHelper(root, env)), { args: ["--version"], cwd: process.cwd(), home: env.HOME });
    // Reproduce the suite's by-name discovery and child launches with the overridden PATH.
    const routed = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const { execSync, spawnSync } = require("node:child_process");
      const version = JSON.parse(execSync("opencode --version").toString());
      const calls = [["serve", "--port", "1234"], ["run", "--attach", "http://127.0.0.1:1", "probe"]].map(args => {
        const result = spawnSync("opencode", args, { cwd: process.cwd(), env: { ...process.env } });
        if (result.status !== 0) throw new Error("routing failed");
        return JSON.parse(result.stdout.toString());
      });
      console.log(JSON.stringify({ version, calls }));
    `,
      ],
      { env, cwd: root, timeout: 10_000 },
    );
    assert.equal(routed.status, 0, routed.stderr.toString());
    assert.deepEqual(JSON.parse(routed.stdout.toString()), {
      version: { args: ["--version"], cwd: root, home: env.HOME },
      calls: [
        { args: ["serve", "--port", "1234"], cwd: root, home: env.HOME },
        { args: ["run", "--attach", "http://127.0.0.1:1", "probe"], cwd: root, home: env.HOME },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(
    "self-test PASS: CLI option validation, executable identity and sandbox discovery/serve/attached-run routing; settlement and exposure accounting; sequential >21 and concurrency; prior evidence reconciliation; malformed usage/tools, timeouts and provider errors fail closed; delivery failure remains settled; prompt/response envelope; shutdown; sandbox helper; no credentials read or paid inference",
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") await selfTest();
  else {
    let prior: Prior | undefined;
    let selectedCli: ReturnType<typeof validateCliPath> | undefined;
    try {
      const options = parseRunArgs(args);
      selectedCli = options.cliPath === undefined ? undefined : validateCliPath(options.cliPath);
      prior = importPrior(options.priorPaths);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "invalid arguments");
      console.error(
        "Usage: bun scripts/paid-e2e.ts --self-test | --run [--cli-path /absolute/executable] --prior-evidence /absolute/evidenceDirectory [--prior-report /absolute/report.json ...] (paid Luna, USD 5 total published-rate exposure including all prior evidence, NOT invoice guarantee)",
      );
      process.exitCode = 2;
    }
    if (prior !== undefined) await run(prior, selectedCli);
  }
}
