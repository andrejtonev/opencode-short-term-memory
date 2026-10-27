import { describe, expect, test } from "bun:test";
import type { V2Context, V2SessionContext } from "../src/v2-adapter";
import {
  disposeV2NativeGeneration,
  generateV2ActiveOverrideMemory,
  generateV2CleanMemory,
  isV2OwnedSummarySession,
} from "../src/v2-native-generation";
import { installV2NativeGenerationHarness } from "./v2-native-generation-harness";

function context(): V2Context {
  const subscribe = ({ signal }: { signal: AbortSignal }) =>
    (async function* () {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })();
  return {
    location: { directory: "C:\\project" },
    event: { subscribe },
    session: {},
  } as unknown as V2Context;
}

describe("V2 native summary generation", () => {
  test("uses a clean unparented session and omits the model for host-default inheritance", async () => {
    let request: V2SessionContext | undefined;
    const fixture = context();
    const harness = installV2NativeGenerationHarness(fixture, {
      defaultModel: { providerID: "offline", id: "default" },
      clean: async (_input, _signal, generation) => {
        request = generation;
        return { text: "updated memory" };
      },
    });
    try {
      expect(
        await generateV2CleanMemory(fixture, { prompt: "summarize this delta" }, new AbortController().signal),
      ).toEqual({
        text: "updated memory",
      });
      expect(harness.calls.create).toHaveLength(1);
      expect(harness.calls.create[0]?.input.model).toBeUndefined();
      expect(harness.calls.create[0]?.session.parentID).toBeNull();
      expect(harness.calls.create[0]?.session.metadata).toMatchObject({
        stmInternalSummary: "v1",
        stmSummaryMode: "clean",
      });
      expect(request?.model).toEqual({ providerID: "offline", id: "default" });
      expect(request?.system).toEqual([
        {
          type: "text",
          text: "You are a clean short-term memory summarizer. Return only the updated Session Memory markdown.",
        },
      ]);
      expect(request?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "summarize this delta" }] }]);
      expect(Object.keys(request?.tools ?? {}).length).toBeGreaterThan(0);
      expect(harness.calls.remove).toHaveLength(1);
      expect(isV2OwnedSummarySession(fixture, harness.calls.create[0]!.session.id)).toBe(false);
    } finally {
      await harness.dispose();
      disposeV2NativeGeneration(fixture);
    }
  });

  test("copies active native context to an explicit-model session while denying tools", async () => {
    const fixture = context();
    let activeRequest: V2SessionContext | undefined;
    const requestedModel = { providerID: "deepseek", id: "deepseek-v4.1-flash-free" };
    const harness = installV2NativeGenerationHarness(fixture, {
      activeRequest: ({ sessionID, prompt }) =>
        ({
          sessionID,
          agent: "build",
          model: { providerID: "source", id: "active" },
          system: [{ type: "text", text: "native active system" }],
          messages: [
            { role: "assistant", content: [{ type: "text", text: "native active history" }] },
            { role: "user", content: [{ type: "text", text: prompt }] },
          ],
          options: { temperature: 0.25, reasoning_effort: "high" },
          tools: { shell: { description: "native tool", input: {} } },
        }) as unknown as V2SessionContext,
      active: async (_input, _signal, generation) => {
        activeRequest = generation;
        return { text: "active model summary" };
      },
    });
    try {
      expect(
        await generateV2ActiveOverrideMemory(
          fixture,
          { sessionID: "parent-session", prompt: "summarize active history", model: requestedModel },
          new AbortController().signal,
        ),
      ).toEqual({ text: "active model summary" });
      expect(harness.calls.generate).toHaveLength(2);
      expect(harness.calls.create[0]?.input.model).toEqual(requestedModel);
      expect(harness.calls.create[0]?.session.parentID).toBeNull();
      expect(harness.calls.active[0]?.input.sessionID).toBe("parent-session");
      expect(activeRequest?.model).toEqual(requestedModel);
      expect(activeRequest?.system).toEqual([{ type: "text", text: "native active system" }]);
      expect(activeRequest?.messages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "native active history" }] },
        { role: "user", content: [{ type: "text", text: "summarize active history" }] },
      ]);
      expect(activeRequest?.options).toEqual({ temperature: 0.25 });
      expect(activeRequest?.tools).toEqual({});
      expect(isV2OwnedSummarySession(fixture, harness.calls.create[0]!.session.id)).toBe(false);
    } finally {
      await harness.dispose();
      disposeV2NativeGeneration(fixture);
    }
  });

  test("keeps an orphaned owned ID fenced when native removal fails", async () => {
    const fixture = context();
    const harness = installV2NativeGenerationHarness(fixture, {
      clean: async () => ({ text: "updated memory" }),
      remove: async () => {
        throw new Error("session.remove unavailable");
      },
    });
    try {
      await generateV2CleanMemory(fixture, { prompt: "summarize" }, new AbortController().signal);
      const ownedID = harness.calls.create[0]!.session.id;
      expect(isV2OwnedSummarySession(fixture, ownedID)).toBe(true);
      disposeV2NativeGeneration(fixture);
      expect(isV2OwnedSummarySession(fixture, ownedID)).toBe(true);
    } finally {
      await harness.dispose();
      disposeV2NativeGeneration(fixture);
    }
  });

  test("fails closed and removes both IDs if create returns a different session", async () => {
    const fixture = context();
    const harness = installV2NativeGenerationHarness(fixture, {
      createdSessionID: "ses_returned_different_id",
      clean: async () => ({ text: "must not be generated" }),
    });
    try {
      await expect(
        generateV2CleanMemory(fixture, { prompt: "summarize" }, new AbortController().signal),
      ).rejects.toThrow("native_summary_session_id_mismatch");
      expect(harness.calls.generate).toHaveLength(0);
      expect(harness.calls.remove.map(({ sessionID }) => sessionID)).toContain("ses_returned_different_id");
      expect(harness.calls.create[0]?.session.metadata.stmInternalSummary).toBe("v1");
      expect(isV2OwnedSummarySession(fixture, "ses_returned_different_id")).toBe(false);
    } finally {
      await harness.dispose();
      disposeV2NativeGeneration(fixture);
    }
  });
});
