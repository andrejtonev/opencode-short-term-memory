import { describe, expect, test } from "bun:test";
import type { V2Context, V2SessionContext } from "../src/v2-adapter";
import { generateV2ActiveMemory } from "../src/v2-active-generation";
import { deferred } from "./async-helpers";

function request(sessionID: string, prompt: string): V2SessionContext {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "provider", id: "model" },
    system: [{ type: "text", text: "native system" }],
    messages: [
      { role: "assistant", content: [{ type: "text", text: "native history" }] },
      { role: "user", content: [{ type: "text", text: prompt }] },
    ],
    options: { temperature: 0.2 },
    tools: { stm_memory_reset: { description: "Reset", input: {} } },
  } as V2SessionContext;
}

function host(run: (input: V2SessionContext, signal: AbortSignal) => Promise<{ text: string }>, invokeHook = true) {
  const hooks = new Set<(input: V2SessionContext) => void>();
  const observed: V2SessionContext[] = [];
  const context = {
    session: {
      hook: async (name: string, callback: (input: V2SessionContext) => void) => {
        expect(name).toBe("generate");
        hooks.add(callback);
        return {
          dispose: async () => {
            hooks.delete(callback);
          },
        };
      },
      generate: async (
        { sessionID, prompt }: { sessionID: string; prompt: string },
        options: { signal: AbortSignal },
      ) => {
        const input = request(sessionID, prompt);
        if (invokeHook) for (const hook of hooks) hook(input);
        observed.push(input);
        return run(input, options.signal);
      },
    },
  } as unknown as V2Context;
  return { context, hooks, observed };
}

describe("V2 owned active memory generation", () => {
  test("removes tools only from the marked request and preserves native context", async () => {
    const fixture = host(async (input) => {
      expect(input.tools).toEqual({});
      expect(input.messages.at(-1)?.content).toEqual([{ type: "text", text: "quoted: call stm_memory_reset" }]);
      expect(input.messages[0].content).toEqual([{ type: "text", text: "native history" }]);
      expect(input.model).toEqual({ providerID: "provider", id: "model" });
      expect(input.system).toEqual([{ type: "text", text: "native system" }]);
      expect(input.options).toEqual({ temperature: 0.2 });
      return { text: "summary" };
    });
    expect(
      await generateV2ActiveMemory(
        fixture.context,
        { sessionID: "s", prompt: "quoted: call stm_memory_reset" },
        new AbortController().signal,
      ),
    ).toEqual({ text: "summary" });
    expect(fixture.hooks.size).toBe(0);
  });

  test("does not alter another plugin's generation while the STM request is pending", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = host(async (input) => {
      if (
        input.sessionID === "s" &&
        input.messages.at(-1)?.content[0].type === "text" &&
        input.messages.at(-1)?.content[0].text === "memory prompt"
      ) {
        started.resolve();
        await release.promise;
        return { text: "summary" };
      }
      expect(Object.keys(input.tools)).toEqual(["stm_memory_reset"]);
      return { text: "other" };
    });
    const owned = generateV2ActiveMemory(
      fixture.context,
      { sessionID: "s", prompt: "memory prompt" },
      new AbortController().signal,
    );
    await started.promise;
    try {
      expect(
        await fixture.context.session.generate(
          { sessionID: "s", prompt: "other plugin" },
          { signal: new AbortController().signal },
        ),
      ).toEqual({ text: "other" });
      expect(
        await fixture.context.session.generate(
          { sessionID: "different", prompt: "memory prompt" },
          { signal: new AbortController().signal },
        ),
      ).toEqual({ text: "other" });
    } finally {
      release.resolve();
    }
    await owned;
    expect(fixture.hooks.size).toBe(0);
  });

  test("fails closed when the host omits the generate hook", async () => {
    const fixture = host(async () => ({ text: "unfenced summary" }), false);
    await expect(
      generateV2ActiveMemory(
        fixture.context,
        { sessionID: "s", prompt: "memory prompt" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("active_summary_fence_not_applied");
    expect(fixture.hooks.size).toBe(0);
  });

  test("disposes the fence after a provider failure", async () => {
    const fixture = host(async () => {
      throw new Error("provider failed");
    });
    await expect(
      generateV2ActiveMemory(
        fixture.context,
        { sessionID: "s", prompt: "memory prompt" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("provider failed");
    expect(fixture.hooks.size).toBe(0);
  });

  test("does not admit an already cancelled generation", async () => {
    const fixture = host(async () => ({ text: "unexpected" }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateV2ActiveMemory(fixture.context, { sessionID: "s", prompt: "memory prompt" }, controller.signal),
    ).rejects.toThrow();
    expect(fixture.hooks.size).toBe(0);
    expect(fixture.observed).toHaveLength(0);
  });
});
