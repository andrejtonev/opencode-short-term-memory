import { expect, test } from "bun:test";
import { registerV2TuiMenu, V2_TUI_MENU_OPTIONS } from "../src/v2-tui-menu";
import type { StatusActionRequest, StatusLocation } from "../src/v2-status-output";

function host() {
  const calls: { input: StatusActionRequest; location?: StatusLocation }[] = [];
  const selections: unknown[] = [];
  const confirmations: unknown[] = [];
  const alerts: unknown[] = [];
  let route = { type: "session", sessionID: "ses_menu" };
  let location: StatusLocation = { directory: "/project", workspaceID: "workspace" };
  let selected: StatusActionRequest["action"] | undefined = "show";
  let confirmation: boolean | undefined = true;
  let selectEffect: (() => void) | undefined;
  let confirmEffect: (() => void) | undefined;
  let invokeEffect: (() => void) | undefined;
  let command: { run(): Promise<void>; slash: { name: string }; palette: true } | undefined;
  let keyboardMode: string | undefined;
  const controller = new AbortController();

  const context = {
    get location() {
      return location;
    },
    keymap: {
      layer(input: () => { mode?: string; commands: any[] }) {
        const layer = input();
        keyboardMode = layer.mode;
        command = layer.commands[0] as typeof command;
      },
    },
    ui: {
      router: { current: () => route },
      dialog: {
        select: async (input: unknown) => {
          selections.push(input);
          selectEffect?.();
          return selected;
        },
        confirm: async (input: unknown) => {
          confirmations.push(input);
          confirmEffect?.();
          return confirmation;
        },
        alert: async (input: unknown) => {
          alerts.push(input);
        },
      },
    },
  };
  const invoke = async (input: StatusActionRequest, options?: { location?: StatusLocation }) => {
    calls.push({ input, location: options?.location });
    invokeEffect?.();
    return { accepted: true };
  };
  registerV2TuiMenu(context, invoke, controller.signal);
  return {
    calls,
    selections,
    confirmations,
    alerts,
    get keyboardMode() {
      return keyboardMode;
    },
    get command() {
      return command!;
    },
    select(value: StatusActionRequest["action"] | undefined) {
      selected = value;
    },
    confirm(value: boolean | undefined) {
      confirmation = value;
    },
    changeRoute(value: typeof route) {
      route = value;
    },
    changeLocation(value: StatusLocation) {
      location = value;
    },
    onSelect(callback: () => void) {
      selectEffect = callback;
    },
    onConfirm(callback: () => void) {
      confirmEffect = callback;
    },
    onInvoke(callback: () => void) {
      invokeEffect = callback;
    },
    dispose() {
      controller.abort();
    },
  };
}

test("one native slash/palette command opens the seven V1 actions in the same order", async () => {
  const h = host();
  // Native autocomplete masks base-mode commands; menu dispatch alone would
  // miss this. The frozen-package keyboard gate verifies actual reachability.
  expect(h.keyboardMode).toBe("global");
  expect(h.command.slash).toEqual({ name: "stm" });
  expect(h.command.palette).toBe(true);
  expect(V2_TUI_MENU_OPTIONS).toEqual([
    { title: "Show memory", value: "show" },
    { title: "Show log file path", value: "logs" },
    { title: "Show settings and config paths", value: "settings" },
    { title: "Show status and live counters", value: "status" },
    { title: "Update memory (uses memory model)", value: "update" },
    { title: "Reset saved memory...", value: "reset" },
    { title: "Create optional example config...", value: "setup" },
  ]);
  await h.command.run();
  expect(h.selections).toHaveLength(1);
  expect(h.calls).toEqual([
    {
      input: {
        requestID: expect.any(String),
        sessionID: "ses_menu",
        action: "show",
      },
      location: { directory: "/project", workspaceID: "workspace" },
    },
  ]);
  expect(h.confirmations).toHaveLength(0);
});

test.each([
  [
    "reset",
    "Reset this session's saved memory and checkpoint? Future memory updates use only conversation after the saved reset boundary. Conversation history remains.",
  ],
  [
    "setup",
    "Create an optional project-local .opencode/stm.jsonc example? Existing STM configuration is preserved. Installation already creates the minimal config.",
  ],
] as const)("requires the matching native confirmation before %s", async (action, message) => {
  const h = host();
  h.select(action);
  await h.command.run();
  expect(h.confirmations).toEqual([
    {
      title: `STM ${action}`,
      message,
      label: { confirm: action === "reset" ? "Reset memory" : "Create example", cancel: "Cancel" },
    },
  ]);
  expect(h.calls[0]?.input).toMatchObject({ action, confirm: true, sessionID: "ses_menu" });
});

test.each([false, undefined])("cancelled or dismissed confirmation performs no action: %s", async (value) => {
  const h = host();
  h.select("reset");
  h.confirm(value);
  await h.command.run();
  expect(h.calls).toEqual([]);
});

test.each(["route", "location"] as const)("does not dispatch a stale menu after %s changes", async (change) => {
  const h = host();
  h.onSelect(() => {
    if (change === "route") h.changeRoute({ type: "session", sessionID: "ses_other" });
    else h.changeLocation({ directory: "/other", workspaceID: "workspace" });
  });
  await h.command.run();
  expect(h.calls).toEqual([]);
});

test("reset/setup recheck the captured session after confirmation and delivery errors stay scoped", async () => {
  const h = host();
  h.select("reset");
  h.onConfirm(() => h.changeRoute({ type: "session", sessionID: "ses_other" }));
  await h.command.run();
  expect(h.calls).toEqual([]);

  const next = host();
  next.onInvoke(() => next.changeRoute({ type: "session", sessionID: "ses_other" }));
  await next.command.run();
  expect(next.alerts).toEqual([]);
});

test("native structured RPC failures display their message", async () => {
  const h = host();
  h.onInvoke(() => {
    throw { type: "rpc.invalid_input", message: "Native validation rejected the request" };
  });
  await h.command.run();
  expect(h.alerts).toEqual([{ title: "STM show delivery error", message: "Native validation rejected the request" }]);
});
