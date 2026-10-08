import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Host } from "@opencode/plugin/host";
import type { CommandInvocation } from "@opencode/plugin/promise/command";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { createStatusCommand, createStatusDelivery, setupStatusCommand } from "../src/v2-status-command";
import { createV2MemoryActions, createV2MemoryTools, readV2MemoryStatus } from "../src/v2-memory-tools";
import type { V2MemoryCommandActions } from "../src/v2-memory-command";
import { createV2Adapter, type V2Context } from "../src/v2-adapter";
import { receiveStatus } from "../src/tui";
import Root from "../src";
import { memoryPathFor } from "../src/memory-utils";
import { STATUS_MAX_CHARS, statusTargets, type StatusOffer, type StatusOutput } from "../src/v2-status-output";

const invocation = (text = "status", sessionID = "session") =>
  ({ sessionID, prompt: { text }, delivery: "queue" }) as CommandInvocation;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const request = (run = async () => "status", mutating = false) => ({
  sessionID: "session",
  title: "STM status",
  run,
  mutating,
});

test("command and tool use one fresh reader and only authoritative identity", async () => {
  const directory = await mkdtemp("/tmp/opencode/stm-status-test-");
  try {
    await mkdir(`${directory}/.opencode`);
    const config = `${directory}/.opencode/stm.jsonc`;
    await writeFile(config, JSON.stringify({ memoryDir: `${directory}/memory`, enabled: false }));
    const context = { location: { directory } } as V2Context;
    const [, tool] = createV2MemoryTools(context);
    let text = "";
    const command = createStatusCommand(createV2MemoryActions(context), async (request) => {
      expect(request.sessionID).toBe("session");
      text = await request.run();
    });
    const input = invocation("");
    Object.defineProperty(input, "delivery", {
      get: () => {
        throw new Error("unused delivery read");
      },
    });
    await command.execute(input);
    const toolContext = new Proxy(
      { sessionID: "session" },
      {
        get(target, key) {
          if (key !== "sessionID") throw new Error(`fabricated context field ${String(key)}`);
          return target.sessionID;
        },
      },
    ) as ToolContext;
    const result = await tool.execute({}, toolContext);
    expect(result?.content).toEqual([{ type: "text", text }]);
    expect(text).toBe(await readV2MemoryStatus("session", directory));
    expect(text).toContain("enabled: false");
    await writeFile(config, JSON.stringify({ memoryDir: `${directory}/memory`, enabled: true }));
    await command.execute(invocation(" STATUS "));
    expect(text).toContain("enabled: true");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid command identities/arguments/attachments fail before status or delivery", async () => {
  let deliveries = 0;
  const command = createStatusCommand({} as V2MemoryCommandActions, async () => {
    deliveries++;
  });
  for (const id of ["", " ", "../escape", "a/b"])
    await expect(command.execute(invocation("status", id))).rejects.toThrow("sessionID");
  for (const text of ["status extra", "reset confirm true extra", "unknown"]) {
    await expect(command.execute(invocation(text))).rejects.toThrow("arguments");
  }
  for (const key of ["files", "agents", "skills"]) {
    const input = invocation();
    (input.prompt as unknown as Record<string, unknown>)[key] = [{}];
    await expect(command.execute(input)).rejects.toThrow("attachments");
  }
  await expect(command.execute({ sessionID: "session" } as CommandInvocation)).rejects.toThrow("prompt");
  expect(deliveries).toBe(0);
});

test("delivery requires matching receiver/session/request; late ACK cannot settle next delivery", async () => {
  const events: { name: string; data: any }[] = [];
  const delivery = createStatusDelivery(async (name, data) => {
    events.push({ name, data });
  }, 30);
  const absent = delivery.deliver(request());
  const first = events[0]!.data;
  const receiver = { requestID: first.requestID, sessionID: "session", receiverID: "receiver" };
  expect(await delivery.claim({ ...receiver, sessionID: "wrong" })).toEqual({ accepted: false });
  expect(delivery.acknowledge(receiver)).toEqual({ accepted: false });
  await expect(absent).rejects.toThrow("no connected TUI");
  expect(delivery.acknowledge(receiver)).toEqual({ accepted: false });
  const next = delivery.deliver(request(async () => "x".repeat(STATUS_MAX_CHARS + 20)));
  const offer = events.at(-1)!.data;
  const selected = { ...receiver, requestID: offer.requestID };
  expect(delivery.acknowledge(receiver)).toEqual({ accepted: false });
  expect(await delivery.claim(selected)).toEqual({ accepted: true });
  expect(await delivery.claim({ ...selected, receiverID: "other" })).toEqual({ accepted: false });
  await pause(0);
  const output = events.at(-1)!.data as StatusOutput;
  expect(output.message.length).toBe(STATUS_MAX_CHARS);
  expect(output.message).toContain("[STM status truncated");
  expect(delivery.acknowledge({ ...selected, receiverID: "other" })).toEqual({ accepted: false });
  expect(delivery.acknowledge(selected)).toEqual({ accepted: true });
  await next;
  const disposed = delivery.deliver(request());
  delivery.dispose();
  delivery.dispose();
  await expect(disposed).rejects.toThrow("disposed");
  await expect(delivery.deliver(request())).rejects.toThrow("disposed");
});

test("emission errors cancel immediately and do not poison later requests", async () => {
  let fail = true;
  const delivery = createStatusDelivery(async () => {
    if (fail) throw new Error("emit failed");
  }, 10);
  await expect(delivery.deliver(request())).rejects.toThrow("offer delivery failed");
  fail = false;
  await expect(delivery.deliver(request())).rejects.toThrow("no connected TUI");
  delivery.dispose();
});

test.each([1, 2])("synchronous offer throw on emission %i cleans admission and interval", async (throwOn) => {
  let emissions = 0;
  let calls = 0;
  let failedOffer!: StatusOffer;
  let recovered = false;
  const failure = new Error("synchronous offer failure");
  const delivery = createStatusDelivery((name, data) => {
    if (name === "offer") {
      emissions++;
      if (!recovered) {
        failedOffer = data as StatusOffer;
        if (emissions === throwOn) throw failure;
      } else {
        void delivery.claim({ requestID: data.requestID, sessionID: data.sessionID, receiverID: "receiver" });
      }
    } else if (name === "output") {
      delivery.acknowledge(data);
    }
    return Promise.resolve();
  }, 250);
  const actions = {
    reset: async () => {
      calls++;
      return "reset completed";
    },
  } as unknown as V2MemoryCommandActions;
  const command = createStatusCommand(actions, delivery.deliver);
  const error = await command.execute(invocation("reset confirm true")).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("offer delivery failed");
  expect((error as Error).message).toContain("No action was run");
  expect((error as Error).cause).toBe(failure);
  expect(calls).toBe(0);
  expect(emissions).toBe(throwOn);
  expect(
    await delivery.claim({ requestID: failedOffer.requestID, sessionID: failedOffer.sessionID, receiverID: "late" }),
  ).toEqual({ accepted: false });
  await pause(120);
  expect(emissions).toBe(throwOn);
  recovered = true;
  await command.execute(invocation("reset confirm true"));
  expect(calls).toBe(1);
  expect(emissions).toBe(throwOn + 1);
  await pause(120);
  expect(emissions).toBe(throwOn + 1);
  delivery.dispose();
});

test("show template creation followed by output failure warns mutation may have completed", async () => {
  const directory = await mkdtemp("/tmp/opencode/stm-show-delivery-test-");
  try {
    await mkdir(`${directory}/.opencode`);
    const memoryDir = `${directory}/memory`;
    await writeFile(`${directory}/.opencode/stm.jsonc`, JSON.stringify({ memoryDir }));
    const memoryPath = memoryPathFor("session", memoryDir);
    let offer!: StatusOffer;
    let output!: StatusOutput;
    const delivery = createStatusDelivery(async (name, data) => {
      if (name === "offer") offer = data as StatusOffer;
      if (name === "output") {
        output = data as StatusOutput;
        throw new Error("output unavailable");
      }
    }, 100);
    const command = createStatusCommand(
      createV2MemoryActions({ location: { directory } } as V2Context),
      delivery.deliver,
    );
    const result = command.execute(invocation("show"));
    const outcome = result.catch((error: Error) => error);
    expect(existsSync(memoryPath)).toBe(false);
    await delivery.claim({ requestID: offer.requestID, sessionID: offer.sessionID, receiverID: "receiver" });
    const error = await outcome;
    expect((error as Error).message).toContain("STM show output delivery failed");
    expect((error as Error).message).toContain("Mutation may have completed; no rollback is implied");
    expect(output.title).toBe("STM show");
    expect(output.message.length).toBeGreaterThan(0);
    expect(await readFile(memoryPath, "utf8")).toBe(output.message);
    delivery.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("output emission failure rejects delivery and receiver cannot acknowledge it", async () => {
  let offer: StatusOffer | undefined;
  const delivery = createStatusDelivery(async (name, data) => {
    if (name === "offer") offer = data as StatusOffer;
    else throw new Error("output emit failed");
  }, 100);
  const result = delivery.deliver(request(async () => "mutated", true));
  const outcome = result.catch((error: Error) => error);
  const receiver = { requestID: offer!.requestID, sessionID: "session", receiverID: "receiver" };
  expect(await delivery.claim(receiver)).toEqual({ accepted: true });
  expect((await outcome)?.message).toContain("output delivery failed");
  expect((await outcome)?.message).toContain("Mutation may have completed");
  expect(delivery.acknowledge(receiver)).toEqual({ accepted: false });
  delivery.dispose();
});

test.each(["reset confirm true", "setup confirm true", "update", "show"])(
  "no receiver means zero actions: %s",
  async (text) => {
    let calls = 0;
    const actions = Object.fromEntries(
      ["reset", "setup", "update", "show"].map((name) => [
        name,
        async () => {
          calls++;
          return "done";
        },
      ]),
    ) as unknown as V2MemoryCommandActions;
    const delivery = createStatusDelivery(async () => undefined, 5);
    const command = createStatusCommand(actions, delivery.deliver);
    await expect(command.execute(invocation(text))).rejects.toThrow("No action was run");
    expect(calls).toBe(0);
  },
);

test("admission precedes one long action, independent output TTL, stale ACK cannot finish action", async () => {
  const events: { name: string; data: any }[] = [];
  let complete!: (value: string) => void;
  let calls = 0;
  const delivery = createStatusDelivery(
    async (name, data) => {
      events.push({ name, data });
    },
    15,
    300,
  );
  const result = delivery.deliver(
    request(async () => {
      calls++;
      return await new Promise<string>((resolve) => {
        complete = resolve;
      });
    }, true),
  );
  expect(calls).toBe(0);
  const receiver = { requestID: events[0]!.data.requestID, sessionID: "session", receiverID: "r" };
  expect(await delivery.claim(receiver)).toEqual({ accepted: true });
  await pause(40);
  expect(calls).toBe(1);
  expect(delivery.acknowledge(receiver)).toEqual({ accepted: false });
  expect(await delivery.claim(receiver)).toEqual({ accepted: false });
  await expect(delivery.deliver(request())).rejects.toThrow("busy");
  complete("done");
  await pause(0);
  const output = events.find((event) => event.name === "output")!.data;
  expect(output.expiresAt).toBeGreaterThan(Date.now());
  expect(output.message).toBe("done");
  expect(delivery.acknowledge({ ...receiver, requestID: "stale" })).toEqual({ accepted: false });
  expect(delivery.acknowledge(receiver)).toEqual({ accepted: true });
  await result;
  expect(calls).toBe(1);
});

test("disposal or receiver cancellation after claim before command continuation prevents action", async () => {
  for (const cancel of [false, true]) {
    let offer!: StatusOffer;
    let calls = 0;
    const delivery = createStatusDelivery(async (name, data) => {
      if (name === "offer") offer = data as StatusOffer;
    }, 100);
    const result = delivery.deliver(
      request(async () => {
        calls++;
        return "done";
      }, true),
    );
    const receiver = { requestID: offer.requestID, sessionID: offer.sessionID, receiverID: "r" };
    const claim = delivery.claim(receiver);
    if (cancel) expect(delivery.cancel(receiver)).toEqual({ accepted: true });
    else delivery.dispose();
    expect(await claim).toEqual({ accepted: true });
    await expect(result).rejects.toThrow("No action was run");
    expect(calls).toBe(0);
  }
});

test("output ACK timeout and disposal during mutation are honest and never retry", async () => {
  for (const dispose of [false, true]) {
    let offer!: StatusOffer;
    let calls = 0;
    let complete!: (text: string) => void;
    const delivery = createStatusDelivery(
      async (name, data) => {
        if (name === "offer") offer = data as StatusOffer;
      },
      10,
      200,
    );
    const result = delivery.deliver(
      request(async () => {
        calls++;
        return await new Promise<string>((resolve) => {
          complete = resolve;
        });
      }, true),
    );
    const outcome = result.catch((error: Error) => error);
    const receiver = { requestID: offer.requestID, sessionID: offer.sessionID, receiverID: "r" };
    await delivery.claim(receiver);
    await pause(0);
    if (dispose) delivery.dispose();
    else complete("mutated");
    expect((await outcome)?.message).toContain("may have completed");
    if (dispose) complete("mutated");
    expect(delivery.acknowledge(receiver)).toEqual({ accepted: false });
    expect(calls).toBe(1);
  }
});

test("action timeout retains busy ownership until original action settles", async () => {
  let offer!: StatusOffer;
  let complete!: (text: string) => void;
  let calls = 0;
  const delivery = createStatusDelivery(
    async (name, data) => {
      if (name === "offer") offer = data as StatusOffer;
    },
    10,
    10,
  );
  const result = delivery.deliver(
    request(async () => {
      calls++;
      return await new Promise<string>((resolve) => {
        complete = resolve;
      });
    }, true),
  );
  await delivery.claim({ requestID: offer.requestID, sessionID: offer.sessionID, receiverID: "r" });
  await expect(result).rejects.toThrow("Mutation may have completed");
  await expect(delivery.deliver(request())).rejects.toThrow("busy");
  complete("done");
  await pause(0);
  expect(calls).toBe(1);
  const absent = delivery.deliver(request());
  await expect(absent).rejects.toThrow("No action was run");
});

test("action exceptions render bounded honest per-action errors once", async () => {
  let offer!: StatusOffer;
  let output!: StatusOutput;
  let calls = 0;
  const delivery = createStatusDelivery(async (name, data) => {
    if (name === "offer") offer = data as StatusOffer;
    if (name === "output") output = data as StatusOutput;
  }, 100);
  const result = delivery.deliver({
    ...request(async () => {
      calls++;
      throw new Error("partial write");
    }, true),
    title: "STM reset",
  });
  const receiver = { requestID: offer.requestID, sessionID: "session", receiverID: "r" };
  await delivery.claim(receiver);
  await pause(0);
  expect(output.title).toBe("STM reset error");
  expect(output.message).toContain("partial write");
  expect(output.message).toContain("Mutation may have completed");
  delivery.acknowledge(receiver);
  await result;
  expect(calls).toBe(1);
});

test("connected TUI route rejection gives server uncertain mutation delivery failure", async () => {
  const tui = tuiContext();
  let calls = 0;
  let complete!: (text: string) => void;
  const off = receiveStatus(tui.context);
  const delivery = createStatusDelivery(
    async (name, data) => {
      await tui.handlers[name]!({ data, location: tui.location });
    },
    20,
    200,
  );
  // The subscribed handlers share the original mocked RPC object; forward its calls
  // through the server using the recorded correlated receiver identity.
  const result = delivery.deliver(
    request(async () => {
      calls++;
      return await new Promise<string>((resolve) => {
        complete = resolve;
      });
    }, true),
  );
  const outcome = result.catch((error: Error) => error);
  await pause(0);
  const receiver = tui.calls[0]!.input;
  await delivery.claim(receiver);
  await pause(0);
  tui.setRoute({ type: "session", sessionID: "other" });
  complete("mutated");
  expect((await outcome)?.message).toContain("Mutation may have completed");
  expect(tui.dialogs).toEqual([]);
  expect(calls).toBe(1);
  off();
});

test("server setup failures clean acquired resources and preserve original failure", async () => {
  for (const stage of ["rpc", "command"]) {
    const disposed: string[] = [];
    const promptDisposals: string[] = [];
    const failure = new Error(stage);
    const context = {
      location: {
        directory: "/tmp/project",
        project: { id: "p", directory: "/tmp/project", canonical: "/tmp/project" },
      },
      options: {},
      session: {
        hook: async (name: string) => ({
          dispose: async () => {
            if (name === "prompt") promptDisposals.push(name);
            else disposed.push(name);
          },
        }),
      },
      tool: {
        transform: async () => ({
          dispose: async () => {
            disposed.push("tool");
          },
        }),
      },
      command: {
        transform: async () => {
          throw failure;
        },
      },
      rpc: {
        register: async () => {
          if (stage === "rpc") throw failure;
          return {
            events: { emit: async () => undefined },
            dispose: async () => {
              disposed.push("rpc");
              throw new Error("cleanup");
            },
          };
        },
      },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {},
        }),
      },
    } as unknown as V2Context;
    await expect(Root.setup(context)).rejects.toBe(failure);
    expect(disposed).toEqual([
      ...(stage === "command" ? ["rpc"] : []),
      ...Array(8).fill("tool"),
      "compaction",
      "context",
    ]);
    expect(promptDisposals).toEqual(["prompt"]);
  }
});

test("registered command/RPC disposal aborts pending output and is idempotent", async () => {
  let command: ReturnType<typeof createStatusCommand> | undefined;
  let rpcDisposals = 0;
  let commandDisposals = 0;
  const context = {
    location: { directory: "/tmp", project: { id: "p", directory: "/tmp", canonical: "/tmp" } },
    options: {},
    rpc: {
      register: async () => ({
        events: { emit: async () => undefined },
        dispose: async () => {
          rpcDisposals++;
        },
      }),
    },
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (value: typeof command) => {
            command = value;
          },
        });
        return {
          dispose: async () => {
            commandDisposals++;
          },
        };
      },
    },
  } as unknown as V2Context;
  const adapter = createV2Adapter(context);
  const off = await setupStatusCommand(context, adapter.runtime);
  const result = command!.execute(invocation());
  const outcome = result.catch((error: Error) => error);
  await pause(20);
  await off();
  await off();
  await adapter.dispose();
  await adapter.dispose();
  expect((await outcome)?.message).toContain("disposed");
  expect(rpcDisposals).toBe(1);
  expect(commandDisposals).toBe(1);
});

function tuiContext(failSecond = false) {
  const handlers: Record<string, (event: any) => Promise<void>> = {};
  const removed: string[] = [];
  const calls: { method: string; input: any }[] = [];
  const dialogs: any[] = [];
  let dismiss!: () => void;
  let cleared = 0;
  const location = { directory: "/project", workspaceID: "workspace" };
  let route = { type: "session", sessionID: "session" };
  const context = {
    location,
    client: {
      rpc: () => ({
        events: {
          on: (name: string, handler: (typeof handlers)[string]) => {
            if (failSecond && name === "output") throw new Error("subscription failed");
            handlers[name] = handler;
            return () => {
              removed.push(name);
            };
          },
        },
        claim: async (input: unknown) => {
          calls.push({ method: "claim", input });
          return { accepted: true };
        },
        acknowledge: async (input: unknown) => {
          calls.push({ method: "acknowledge", input });
          return { accepted: true };
        },
        cancel: async () => ({ accepted: true }),
      }),
    },
    ui: {
      router: { current: () => route },
      dialog: {
        alert: (value: unknown) => {
          dialogs.push(value);
          return new Promise<void>((resolve) => {
            dismiss = resolve;
          });
        },
        set: () => undefined,
        clear: () => {
          cleared++;
        },
      },
    },
  } as unknown as Parameters<typeof receiveStatus>[0];
  return {
    context,
    handlers,
    removed,
    calls,
    dialogs,
    location,
    setRoute: (value: typeof route) => {
      route = value;
    },
    dismiss: () => dismiss(),
    cleared: () => cleared,
  };
}

test("TUI routes offers/output, survives handshake expiration, and never clears unrelated dialogs", async () => {
  const tui = tuiContext();
  const off = receiveStatus(tui.context);
  const offer = { requestID: "request", sessionID: "session", expiresAt: Date.now() + 100 };
  const send = (name: string, data: unknown, location = tui.location) => tui.handlers[name]!({ data, location });
  await send("offer", offer, { ...tui.location, workspaceID: "other" });
  tui.setRoute({ type: "home", sessionID: "session" });
  await send("offer", offer);
  expect(tui.calls).toHaveLength(0);
  tui.setRoute({ type: "session", sessionID: "session" });
  await send("offer", offer);
  await send("offer", offer);
  expect(tui.calls).toHaveLength(1);
  const receiverID = tui.calls[0]!.input.receiverID;
  const output = { ...offer, receiverID, message: "generation: v2", title: "STM status" };
  await send("output", { ...output, receiverID: "wrong" });
  await send("output", { ...output, sessionID: "wrong" });
  await send("output", output, { ...tui.location, directory: "/other" });
  expect(tui.dialogs).toHaveLength(0);
  await send("output", output);
  await send("output", output);
  expect(tui.dialogs).toEqual([{ title: "STM status", message: "generation: v2" }]);
  expect(tui.calls[1]).toEqual({
    method: "acknowledge",
    input: { requestID: "request", sessionID: "session", receiverID },
  });
  await pause(110);
  expect(tui.cleared()).toBe(0);
  tui.dismiss();
  await pause(0);
  await send("offer", { ...offer, requestID: "late" });
  expect(tui.calls).toHaveLength(2);
  off();
  off();
  await send("output", { ...output, expiresAt: Date.now() + 100 });
  expect(tui.dialogs).toHaveLength(1);
  expect(tui.removed).toEqual(["offer", "output", "release"]);
  expect(tui.cleared()).toBe(0);
});

test("TUI setup failure removes first subscription; disposal with active dialog does not clear", async () => {
  const failed = tuiContext(true);
  expect(() => receiveStatus(failed.context)).toThrow("subscription failed");
  expect(failed.removed).toEqual(["offer"]);
  const tui = tuiContext();
  const off = receiveStatus(tui.context);
  const offer = { requestID: "request", sessionID: "session", expiresAt: Date.now() + 100 };
  await tui.handlers.offer!({ data: offer, location: tui.location });
  await tui.handlers.output!({
    data: { ...offer, receiverID: tui.calls[0]!.input.receiverID, message: "status", title: "STM status" },
    location: tui.location,
  });
  off();
  expect(tui.cleared()).toBe(0);
  tui.dismiss();
});

test("TUI holds reservation beyond admission TTL and across session changes until terminal release", async () => {
  const tui = tuiContext();
  const off = receiveStatus(tui.context);
  const offer = { requestID: "long", sessionID: "session", expiresAt: Date.now() + 10 };
  await tui.handlers.offer!({ data: offer, location: tui.location });
  const receiverID = tui.calls[0]!.input.receiverID;
  await pause(20);
  tui.setRoute({ type: "session", sessionID: "other" });
  await tui.handlers.offer!({
    data: { requestID: "other", sessionID: "other", expiresAt: Date.now() + 100 },
    location: tui.location,
  });
  expect(tui.calls).toHaveLength(1);
  tui.setRoute({ type: "session", sessionID: "session" });
  await tui.handlers.output!({
    data: { ...offer, expiresAt: Date.now() + 100, receiverID, title: "STM update", message: "committed" },
    location: tui.location,
  });
  expect(tui.dialogs).toEqual([{ title: "STM update", message: "committed" }]);
  await tui.handlers.release!({
    data: { requestID: "long", sessionID: "session", receiverID },
    location: tui.location,
  });
  await tui.handlers.offer!({
    data: { ...offer, requestID: "busy", expiresAt: Date.now() + 100 },
    location: tui.location,
  });
  expect(tui.calls).toHaveLength(2);
  tui.dismiss();
  await pause(0);
  await tui.handlers.offer!({
    data: { ...offer, requestID: "next", expiresAt: Date.now() + 100 },
    location: tui.location,
  });
  expect(tui.calls).toHaveLength(3);
  await tui.handlers.release!({
    data: { requestID: "stale", sessionID: "session", receiverID },
    location: tui.location,
  });
  await tui.handlers.offer!({
    data: { ...offer, requestID: "competing", expiresAt: Date.now() + 100 },
    location: tui.location,
  });
  expect(tui.calls).toHaveLength(3);
  await tui.handlers.release!({
    data: { requestID: "next", sessionID: "session", receiverID },
    location: tui.location,
  });
  await tui.handlers.offer!({
    data: { ...offer, requestID: "released", expiresAt: Date.now() + 100 },
    location: tui.location,
  });
  expect(tui.calls).toHaveLength(4);
  off();
  expect(tui.cleared()).toBe(0);
});

test("location/session/expiry targeting is exact", () => {
  const location = { directory: "/project" };
  const offer = { requestID: "r", sessionID: "s", expiresAt: Date.now() + 100 };
  expect(statusTargets(offer, location, location, { type: "session", sessionID: "s" })).toBe(true);
  expect(statusTargets(offer, undefined, location, { type: "session", sessionID: "s" })).toBe(false);
  expect(statusTargets({ ...offer, expiresAt: 0 }, location, location, { type: "session", sessionID: "s" })).toBe(
    false,
  );
});

test("output routing is rechecked after claim and stale output is not displayed", async () => {
  const tui = tuiContext();
  const off = receiveStatus(tui.context);
  const offer = { requestID: "request", sessionID: "session", expiresAt: Date.now() + 100 };
  await tui.handlers.offer!({ data: offer, location: tui.location });
  const output = { ...offer, receiverID: tui.calls[0]!.input.receiverID, message: "status", title: "STM status" };
  tui.setRoute({ type: "session", sessionID: "other" });
  await tui.handlers.output!({ data: output, location: tui.location });
  tui.setRoute({ type: "session", sessionID: "session" });
  await tui.handlers.output!({ data: { ...output, expiresAt: 0 }, location: tui.location });
  expect(tui.dialogs).toHaveLength(0);
  expect(tui.calls).toHaveLength(1);
  off();
});

test("packaging wiring leaves root intact and separates UI/portable RPC entrypoints", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.exports["."]).toEqual({ types: "./dist/index.d.ts", import: "./dist/index.js" });
  expect(manifest.exports["./server"]).toEqual(manifest.exports["."]);
  expect(manifest.exports["./tui"]).toEqual({ types: "./dist/src/tui.d.ts", import: "./dist/tui.js" });
  expect(manifest.exports["./rpc"]).toEqual({ types: "./dist/src/v2-status-output.d.ts", import: "./dist/rpc.js" });
  const config = await readFile(new URL("../tsup.config.ts", import.meta.url), "utf8");
  expect(config).toContain('entry: { index: "index.ts", tui: "src/tui.ts", rpc: "src/v2-status-output.ts" }');
  expect(config).toContain("splitting: false");
  const portable = await readFile(new URL("../src/v2-status-output.ts", import.meta.url), "utf8");
  expect(portable).not.toMatch(/from ["'](?:zod|\.\/memory|\.\/v2-memory|.*fixtures)/);
});

test("named-package loader requires explicit server export under Bun and resolves it to root", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const sandbox = await mkdtemp("/tmp/opencode/stm-loader-test-");
  try {
    for (const corrected of [false, true]) {
      const directory = join(sandbox, corrected ? "corrected" : "missing-server");
      const packageDirectory = join(directory, "node_modules", manifest.name);
      await mkdir(join(packageDirectory, "dist"), { recursive: true });
      const exports = { ...manifest.exports };
      if (!corrected) delete exports["./server"];
      await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ ...manifest, exports }));
      for (const file of ["index.js", "tui.js", "rpc.js"]) {
        await writeFile(join(packageDirectory, "dist", file), "export default {};\n");
      }
      const resolve = () => Host.resolve({ directory, name: manifest.name });
      if (!corrected) {
        expect(resolve).toThrow(`${manifest.name}/server`);
      } else {
        expect(resolve()).toEqual({
          server: pathToFileURL(join(packageDirectory, "dist/index.js")).href,
          tui: pathToFileURL(join(packageDirectory, "dist/tui.js")).href,
          rpc: pathToFileURL(join(packageDirectory, "dist/rpc.js")).href,
        });
        expect(pathToFileURL(Bun.resolveSync(manifest.name, directory)).href).toBe(resolve().server!);
      }
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test.skipIf(!existsSync(new URL("../dist/tui.js", import.meta.url)))(
  "built published exports and declarations resolve offline with both pinned loaders",
  async () => {
    const { Host: fixtureHost } =
      await import("../fixtures/v2-generation-probe/node_modules/@opencode/plugin/dist/host.js");
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const sandbox = await mkdtemp("/tmp/opencode/stm-built-loader-test-");
    try {
      const packageDirectory = join(sandbox, "node_modules", manifest.name);
      await mkdir(packageDirectory, { recursive: true });
      await cp(new URL("../dist", import.meta.url), join(packageDirectory, "dist"), { recursive: true });
      await writeFile(join(packageDirectory, "package.json"), JSON.stringify(manifest));
      for (const loader of [Host, fixtureHost]) {
        const entries = loader.resolve({ directory: sandbox, name: manifest.name });
        expect(entries).toEqual({
          server: pathToFileURL(join(packageDirectory, "dist/index.js")).href,
          tui: pathToFileURL(join(packageDirectory, "dist/tui.js")).href,
          rpc: pathToFileURL(join(packageDirectory, "dist/rpc.js")).href,
        });
        expect(pathToFileURL(Bun.resolveSync(manifest.name, sandbox)).href).toBe(entries.server!);
        for (const entry of Object.values(entries))
          expect((await readFile(new URL(entry!), "utf8")).length).toBeGreaterThan(0);
      }
      for (const subpath of [".", "./server", "./tui", "./rpc"]) {
        expect(
          (await readFile(join(packageDirectory, manifest.exports[subpath].types), "utf8")).length,
        ).toBeGreaterThan(0);
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  },
);
