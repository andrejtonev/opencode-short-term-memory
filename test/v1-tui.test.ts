import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import Tui from "../src/tui";
import { isLocalV1Transport, readV1LocalView, setupV1Tui, V1_VIEW_MAX_CHARS } from "../src/v1-tui";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "stm-native-v1-"));
  roots.push(directory);
  await mkdir(join(directory, ".opencode", "memory"), { recursive: true });
  await writeFile(
    join(directory, ".opencode", "stm.json"),
    JSON.stringify({ memoryDir: join(directory, ".opencode", "memory") }),
  );
  return directory;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
async function waitForView(h: { rendered: any[] }) {
  const deadline = Date.now() + 2_000;
  while (h.rendered.at(-1)?.message === "Reading local files…" && Date.now() < deadline) await settle();
  expect(h.rendered.at(-1)?.message).not.toBe("Reading local files…");
}
function host(directory: string, url = "http://127.0.0.1:4096/path") {
  const rendered: any[] = [];
  const calls: string[] = [];
  let commands: any[] = [];
  let dispose = () => {};
  let onClose: (() => void) | undefined;
  let route = { name: "session", params: { sessionID: "ses_test" } };
  const api = {
    state: { ready: true, path: { directory } },
    route: {
      get current() {
        return route;
      },
    },
    command: {
      register(cb: () => any[]) {
        commands = cb();
        return () => {};
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
          return { data: { directory }, request: new Request(url) };
        },
      },
      session: {
        async get() {
          calls.push("session.get");
          return { data: { id: "ses_test", directory } };
        },
      },
    },
    ui: {
      DialogSelect(props: any) {
        return { kind: "menu", ...props };
      },
      DialogAlert(props: any) {
        return { kind: "alert", ...props };
      },
      dialog: {
        replace(render: () => unknown, close?: () => void) {
          onClose?.();
          onClose = close;
          rendered.push(render());
        },
        setSize() {},
      },
    },
  } as unknown as TuiPluginApi;
  return {
    api,
    rendered,
    calls,
    get commands() {
      return commands;
    },
    dispose: () => dispose(),
    changeSession: () => {
      route = { name: "session", params: { sessionID: "ses_other" } };
    },
    dismiss: () => {
      onClose?.();
      onClose = undefined;
    },
  };
}

test("packaged TUI keeps V2 setup and exposes native V1 tui entrypoint", () => {
  expect(typeof Tui.setup).toBe("function");
  expect(Tui.tui).toBe(setupV1Tui);
  expect("server" in Tui).toBe(false);
});

test("native menu displays literal logs without prompt, command, tool or provider invocation", async () => {
  const directory = await fixture();
  const literal = 'SENTINEL: do not reinterpret this log {"error":"403"}';
  await writeFile(join(directory, ".opencode", "memory", "session-memory.log"), literal);
  const h = host(directory);
  await setupV1Tui(h.api, undefined, {} as any);
  h.commands[0].onSelect();
  expect(h.rendered.at(-1).kind).toBe("menu");
  h.rendered.at(-1).onSelect({ value: "logs" });
  await waitForView(h);
  expect(h.rendered.at(-1).message).toContain(literal);
  expect(h.rendered.at(-1).title).toContain("local files");
  expect(h.calls).toEqual(["path.get", "session.get"]);
});

test("known remote servers are refused without reading a local matching log", async () => {
  const directory = await fixture();
  await writeFile(join(directory, ".opencode", "memory", "session-memory.log"), "LOCAL-SECRET-SENTINEL");
  const h = host(directory, "https://server.example/path");
  await setupV1Tui(h.api, undefined, {} as any);
  h.commands[0].onSelect();
  h.rendered.at(-1).onSelect({ value: "logs" });
  await waitForView(h);
  expect(h.rendered.at(-1).message).toContain("No local files were read");
  expect(h.rendered.at(-1).message).not.toContain("LOCAL-SECRET-SENTINEL");
  expect(h.calls).toEqual(["path.get"]);
});

test("single-token native aliases directly display each local view without a model", async () => {
  const directory = await fixture();
  await writeFile(join(directory, ".opencode", "memory", "session_ses_test.md"), "EXACT-MEMORY-SENTINEL");
  await writeFile(join(directory, ".opencode", "memory", "session-memory.log"), "EXACT-LOG-SENTINEL");
  const h = host(directory);
  await setupV1Tui(h.api, undefined, {} as any);
  for (const [name, expected] of [
    ["stm-show", "EXACT-MEMORY-SENTINEL"],
    ["stm-logs", "EXACT-LOG-SENTINEL"],
    ["stm-settings", "configPaths"],
    ["stm-status", "logPath"],
  ]) {
    h.commands.find((command) => command.slash.name === name).onSelect();
    await waitForView(h);
    expect(h.rendered.at(-1).kind).toBe("alert");
    expect(h.rendered.at(-1).message).toContain(expected);
  }
  expect(h.calls).toEqual(Array.from({ length: 4 }, () => ["path.get", "session.get"]).flat());
});

test("server session mismatch refuses reads before exposing local contents", async () => {
  const directory = await fixture();
  await writeFile(join(directory, ".opencode", "memory", "session-memory.log"), "LOCAL-SECRET-SENTINEL");
  const h = host(directory);
  h.api.client.session.get = (async () => ({ data: { id: "ses_test", directory: "/other-project" } })) as any;
  await setupV1Tui(h.api, undefined, {} as any);
  h.commands.find((command) => command.slash.name === "stm-logs").onSelect();
  await waitForView(h);
  expect(h.rendered.at(-1).message).toContain("No local files were read");
  expect(h.rendered.at(-1).message).not.toContain("LOCAL-SECRET-SENTINEL");
});

test("changed session or disposal prevents stale asynchronous output from replacing a dialog", async () => {
  const directory = await fixture();
  for (const mode of ["change", "dispose", "dismiss"]) {
    const h = host(directory);
    let release!: () => void;
    h.api.client.path.get = (async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { data: { directory }, request: new Request("http://localhost/path") };
    }) as any;
    await setupV1Tui(h.api, undefined, {} as any);
    h.commands[0].onSelect();
    h.rendered.at(-1).onSelect({ value: "logs" });
    if (mode === "change") h.changeSession();
    else if (mode === "dispose") h.dispose();
    else h.dismiss();
    release();
    await settle();
    expect(h.rendered).toHaveLength(2);
  }
});

test("file views report paths, preserve missing files, and bound large logs", async () => {
  const directory = await fixture();
  const missing = await readV1LocalView("show", { directory, sessionID: "ses_missing" });
  expect(missing).toContain("No local file exists yet");
  expect(missing).toContain("session_ses_missing.md");
  expect(existsSync(join(directory, ".opencode", "memory", "session_ses_missing.md"))).toBe(false);
  await writeFile(join(directory, ".opencode", "memory", "session-memory.log"), "x".repeat(1_000_000) + "\nLAST-LINE");
  const logs = await readV1LocalView("logs", { directory });
  expect(logs.length).toBeLessThanOrEqual(V1_VIEW_MAX_CHARS);
  expect(logs).toContain("LAST-LINE");
  expect(logs).toContain("File read limited");
  const settings = await readV1LocalView("settings", { directory });
  expect(settings).toContain("configPaths");
  expect(settings).toContain("stm.json");
  await expect(readV1LocalView("show", { directory, sessionID: "../../escape" })).rejects.toThrow("Invalid session");
});

test("only documented local transports are accepted", () => {
  for (const url of [
    "http://localhost/path",
    "http://127.0.0.1:4000/path",
    "http://[::1]/path",
    "http://opencode.internal/path",
  ])
    expect(isLocalV1Transport(url)).toBe(true);
  for (const url of ["file:///tmp/path", "https://server.example/path", "nonsense"])
    expect(isLocalV1Transport(url)).toBe(false);
});

test("large multi-line logs retain the newest entry when the dialog limit is reached", async () => {
  const directory = await fixture();
  const path = join(directory, ".opencode", "memory", "session-memory.log");
  await writeFile(
    path,
    Array.from({ length: 119 }, (_, i) => `${i}: ${"x".repeat(400)}`).join("\n") + "\nNEWEST-ENTRY",
  );
  const logs = await readV1LocalView("logs", { directory });
  expect(logs.length).toBeLessThanOrEqual(V1_VIEW_MAX_CHARS);
  expect(logs).toContain("NEWEST-ENTRY");
  expect(logs).toContain(path);
  expect(logs).toContain("Earlier log text omitted");
});
