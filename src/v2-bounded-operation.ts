/** Bound a host operation even when its implementation ignores AbortSignal. */
export async function boundedV2Operation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const relay = () => controller.abort(signal.reason ?? new Error("v2_operation_aborted"));
  if (signal.aborted) relay();
  else signal.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("v2_operation_timeout")), timeoutMs);
  let rejectAbort: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const pending = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return operation(controller.signal);
  });
  pending.catch(() => undefined);
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", relay);
    controller.signal.removeEventListener("abort", rejectAbort!);
  }
}
