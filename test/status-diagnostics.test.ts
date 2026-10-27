import { expect, test } from "bun:test";
import { statusText } from "../src/commands";
import { createRuntimeState, DEFAULT_CONFIG } from "../src/memory-utils";
import { initializeV2Telemetry, readV2Telemetry, recordV2Telemetry } from "../src/v2-telemetry";
import type { V2Context } from "../src/v2-adapter";

test.each(["active", "clean"] as const)("V1 status describes the effective %s transport", async (summarizerMode) => {
  const status = await statusText(undefined, {
    config: { ...DEFAULT_CONFIG, summarizerMode, enableLegacyPeriodicSystemTransform: true },
    sessionStates: new Map(),
    globalState: createRuntimeState(),
  });
  expect(status).toContain(
    `effectiveDeliveryMode: ${summarizerMode === "active" ? "promptNoReply" : "legacySystemTransform"}`,
  );
});

test("V2 runtime diagnostics are isolated and late events cannot recreate disposed state", () => {
  const first = {} as V2Context;
  const second = {} as V2Context;
  const lifetime = new AbortController();
  initializeV2Telemetry(first, lifetime.signal);
  recordV2Telemetry(first, "compact");
  recordV2Telemetry(first, "error", "provider rejected");
  expect(readV2Telemetry(first)).toMatchObject({ compactCount: 1, lastError: "provider rejected" });
  expect(readV2Telemetry(second)).toEqual(createRuntimeState());
  lifetime.abort();
  recordV2Telemetry(first, "inject", 200);
  expect(readV2Telemetry(first)).toEqual(createRuntimeState());
});
