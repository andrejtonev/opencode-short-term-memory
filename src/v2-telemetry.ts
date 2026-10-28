import { createRuntimeState, type RuntimeState } from "./memory-utils";
import { redactDiagnostic } from "./diagnostics";
import type { V2Context } from "./v2-adapter";

const states = new WeakMap<V2Context, RuntimeState>();
const disposed = new WeakSet<V2Context>();

function timestamp(): string | undefined {
  try {
    return new Date().toISOString();
  } catch {
    return undefined;
  }
}

export function initializeV2Telemetry(context: V2Context, signal: AbortSignal): void {
  disposed.delete(context);
  states.set(context, createRuntimeState());
  const dispose = () => {
    disposed.add(context);
    states.delete(context);
  };
  if (signal.aborted) dispose();
  else signal.addEventListener("abort", dispose, { once: true });
}

export function readV2Telemetry(context?: V2Context): RuntimeState {
  return { ...((context ? states.get(context) : undefined) ?? createRuntimeState()) };
}

export function recordV2Telemetry(
  context: V2Context,
  event: "update" | "inject" | "compact" | "error",
  detail?: string | number,
): void {
  if (disposed.has(context)) return;
  let state = states.get(context);
  if (!state) {
    state = createRuntimeState();
    states.set(context, state);
  }
  if (event === "update") {
    state.updateCount++;
    state.lastUpdateAt = timestamp();
    state.lastError = undefined;
  } else if (event === "inject") {
    state.injectCount++;
    state.injectCharCount += typeof detail === "number" ? detail : 0;
    state.lastInjectAt = timestamp();
  } else if (event === "compact") state.compactCount++;
  else state.lastError = redactDiagnostic(String(detail ?? "unknown"));
}
