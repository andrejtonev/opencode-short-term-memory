import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import Tui from "../src/tui";
import { setupV1Tui } from "../src/v1-tui";
import { V1_REQUEST_PREFIX, V1_RESPONSE_PREFIX } from "../src/v1-native-actions";
import { wrapReaderText } from "../src/tui-text-reader";

function host(directory = process.cwd()) {
  const rendered: any[] = [],
    calls: any[] = [];
  let commands: any[] = [],
    dispose = () => {},
    onClose: (() => void) | undefined;
  let eventHandler = (_event: any) => {};
  let deferredRender: (() => unknown) | undefined;
  let deferRender = false;
  let route = { name: "session", params: { sessionID: "ses_test" } };
  const keys = new EventEmitter();
  const api = {
    renderer: { width: 100, height: 35, keyInput: keys },
    state: { ready: true, path: { directory } },
    route: {
      get current() {
        return route;
      },
    },
    event: {
      on(_name: string, cb: any) {
        eventHandler = cb;
        return () => {
          eventHandler = () => {};
        };
      },
    },
    command: {
      register(cb: () => any[]) {
        commands = cb();
        return () => {
          commands = [];
        };
      },
    },
    lifecycle: {
      onDispose(cb: () => void) {
        dispose = cb;
      },
    },
    client: {
      path: {
        async get() {
          calls.push("path.get");
          return { data: { directory }, request: new Request("http://localhost/path") };
        },
      },
      tui: {
        async publish(input: any) {
          calls.push(input);
          return {};
        },
      },
    },
    ui: {
      DialogSelect(props: any) {
        return { kind: "menu", ...props };
      },
      DialogConfirm(props: any) {
        return { kind: "confirm", ...props };
      },
      DialogAlert(props: any) {
        return { kind: "alert", ...props };
      },
      dialog: {
        replace(render: () => unknown, close?: () => void) {
          onClose?.();
          onClose = close;
          if (deferRender) deferredRender = render;
          else rendered.push(render());
        },
        setSize() {},
      },
    },
  };
  return {
    api,
    rendered,
    calls,
    keys,
    get commands() {
      return commands;
    },
    dispose: () => dispose(),
    changeSession: () => {
      route = { name: "session", params: { sessionID: "ses_other" } };
    },
    deferNextRender: () => {
      deferRender = true;
    },
    evaluateDeferred: () => {
      deferRender = false;
      const render = deferredRender!;
      deferredRender = undefined;
      return render();
    },
    dismiss: () => {
      onClose?.();
      onClose = undefined;
    },
    reply(message: string, overrides = {}) {
      const input = calls.findLast((x) => typeof x === "object");
      const request = JSON.parse(input.body.properties.command.slice(V1_REQUEST_PREFIX.length));
      eventHandler({
        properties: { command: V1_RESPONSE_PREFIX + JSON.stringify({ ...request, message, ...overrides }) },
      });
    },
    key(name: string) {
      let handled = false;
      keys.emit("keypress", {
        name,
        propagationStopped: false,
        preventDefault() {
          handled = true;
        },
        stopPropagation() {
          this.propagationStopped = true;
        },
      });
      return handled;
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// Compile-time contract against the pinned native host API, including public renderer keys.
const nativeSetup: (api: TuiPluginApi) => Promise<void> = setupV1Tui;
void nativeSetup;

test("one native /stm menu exposes all seven actions, preserving V2 entrypoint", async () => {
  expect(Tui.tui).toBe(setupV1Tui);
  expect(typeof Tui.setup).toBe("function");
  const h = host();
  await setupV1Tui(h.api);
  expect(h.commands.map((c) => c.slash.name)).toEqual(["stm"]);
  h.commands[0].onSelect();
  expect(h.rendered.at(-1).options.map((o: any) => o.value)).toEqual([
    "show",
    "logs",
    "settings",
    "status",
    "update",
    "reset",
    "setup",
  ]);
  expect(h.rendered.at(-1).options.find((o: any) => o.value === "update").title).toContain("uses memory model");
  h.dispose();
});

test("native reads publish events without prompt, command, tool or provider invocation", async () => {
  const h = host();
  await setupV1Tui(h.api);
  h.commands[0].onSelect();
  h.rendered.at(-1).onSelect({ value: "logs" });
  await settle();
  expect(h.calls[0]).toBe("path.get");
  expect(h.calls[1].body.type).toBe("tui.command.execute");
  const literal = "/server/STM logs/session-memory.log";
  h.reply(literal);
  expect(h.rendered.at(-1).message).toContain(literal);
  expect(h.rendered.at(-1).message).toContain("Lines");
  expect(h.calls).toHaveLength(2);
  h.dispose();
});

test("reader reaches every wrapped memory line and removes its key handler on dismissal", async () => {
  const h = host();
  await setupV1Tui(h.api);
  h.commands[0].onSelect();
  h.rendered.at(-1).onSelect({ value: "show" });
  await settle();
  let hostNavigation = 0;
  const hostKey = (key: any) => {
    if (!key.propagationStopped) hostNavigation++;
  };
  h.keys.on("keypress", hostKey);
  h.reply(Array.from({ length: 120 }, (_, i) => `LINE_${i}`).join("\n"));
  expect(h.rendered.at(-1).message).toContain("LINE_0\n");
  expect(h.rendered.at(-1).message).not.toContain("LINE_119");
  for (let i = 0; i < 9; i++) expect(h.key("pagedown")).toBe(true);
  expect(h.rendered.at(-1).message).toContain("LINE_119");
  expect(h.key("home")).toBe(true);
  expect(h.rendered.at(-1).message).toContain("LINE_0\n");
  expect(h.key("end")).toBe(true);
  expect(h.rendered.at(-1).message).toContain("LINE_119");
  expect(hostNavigation).toBe(0);
  h.keys.off("keypress", hostKey);
  h.dismiss();
  expect(h.keys.listenerCount("keypress")).toBe(0);
  h.dispose();
});

test("reset and optional setup request literal confirmation and preserve captured session scope", async () => {
  for (const action of ["reset", "setup"]) {
    const h = host();
    await setupV1Tui(h.api);
    h.commands[0].onSelect();
    h.rendered.at(-1).onSelect({ value: action });
    expect(h.rendered.at(-1).kind).toBe("confirm");
    expect(h.calls).toHaveLength(0);
    h.rendered.at(-1).onConfirm();
    await settle();
    const request = JSON.parse(h.calls[1].body.properties.command.slice(V1_REQUEST_PREFIX.length));
    expect(request.confirm).toBe(true);
    expect(request.sessionID).toBe("ses_test");
    h.dispose();
  }
  const h = host();
  await setupV1Tui(h.api);
  h.commands[0].onSelect();
  h.rendered.at(-1).onSelect({ value: "reset" });
  h.changeSession();
  h.rendered.at(-1).onConfirm();
  await settle();
  expect(h.calls).toHaveLength(0);
  h.dispose();
});

test("stale, unrelated and wrong-scope results cannot replace the current dialog", async () => {
  for (const mode of ["change", "dispose", "dismiss", "wrong-request", "wrong-project"]) {
    const h = host();
    await setupV1Tui(h.api);
    h.commands[0].onSelect();
    h.rendered.at(-1).onSelect({ value: "logs" });
    await settle();
    if (mode === "change") h.changeSession();
    if (mode === "dispose") h.dispose();
    if (mode === "dismiss") h.dismiss();
    const count = h.rendered.length;
    h.reply(
      "STALE_PRIVATE_OUTPUT",
      mode === "wrong-request"
        ? { requestID: "unrelated" }
        : mode === "wrong-project"
          ? { directory: "/different" }
          : {},
    );
    expect(h.rendered).toHaveLength(count);
    h.dispose();
  }
});

test("workspace change or dismissal during path validation prevents sending an action", async () => {
  for (const mode of ["change", "dispose", "dismiss"]) {
    const h = host();
    let release!: () => void;
    h.api.client.path.get = async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { data: { directory: process.cwd() }, request: new Request("http://localhost/path") };
    };
    await setupV1Tui(h.api);
    h.commands[0].onSelect();
    h.rendered.at(-1).onSelect({ value: "update" });
    if (mode === "change") h.changeSession();
    else if (mode === "dispose") h.dispose();
    else h.dismiss();
    release();
    await settle();
    expect(h.calls).toHaveLength(0);
    h.dispose();
  }
});

test.each(["change", "dispose", "dismiss"])(
  "deferred V1 reader rendering refuses stale scope after %s and releases its listeners",
  async (mode) => {
    const h = host();
    await setupV1Tui(h.api);
    h.commands[0].onSelect();
    h.rendered.at(-1).onSelect({ value: "show" });
    await settle();
    h.deferNextRender();
    h.reply("PREVIOUS_SESSION_PRIVATE_MEMORY");
    expect(h.keys.listenerCount("keypress")).toBe(1);
    if (mode === "change") h.changeSession();
    else if (mode === "dispose") h.dispose();
    else h.dismiss();
    const renderedBefore = h.rendered.length;
    expect(h.evaluateDeferred()).toBeNull();
    expect(h.keys.listenerCount("keypress")).toBe(0);
    // Abandoning the old component never replaces or clears a host dialog.
    expect(h.rendered).toHaveLength(renderedBefore);
    h.dispose();
  },
);

test("reader wraps tabs, long lines and Unicode without dropping text", () => {
  expect(wrapReaderText("abc\tdef", 4)).toEqual(["abc ", "   d", "ef"]);
  expect(wrapReaderText("😀界áxyz", 4)).toEqual(["😀界", "áxyz"]);
});
