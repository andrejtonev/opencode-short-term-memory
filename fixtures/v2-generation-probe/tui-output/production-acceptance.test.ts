import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Host } from "@opencode/plugin/host";
import { Npm } from "@opencode/util/npm";
import { Global } from "@opencode/util/global";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { Effect } from "effect";
import { Schema } from "effect";
import { SessionTransfer } from "@opencode/schema/session-transfer";
import {
  observeFailure,
  serializeFailure,
  stageInstalledPackage,
  tuiReadiness,
  warmCommandInventory,
  dialogRows,
  fileState,
  settledTransfer,
  HEADLESS_COMMANDS,
  WORKFLOW_MS,
  assertOnlyChanged,
  verifyImportedPage,
  verifySessionBaseline,
} from "./production-acceptance.js";

test("inventory warmup awaits observed registration before delivery measurement (harness contract, not host proof)", async () => {
  const directory = "/isolated-project";
  const target = "@atonev/opencode-short-term-memory@1.3.0";
  const plugins = {
    location: { directory },
    data: [{ source: { type: "package", target }, state: { status: "active" } }],
  };
  const commands = { location: { directory }, data: [{ name: "stm" }] };
  const events: string[] = [];
  let release!: (value: typeof commands) => void;
  const pending = new Promise<typeof commands>((resolve) => {
    release = resolve;
  });
  const observation: Record<string, unknown> = {};
  const client = {
    plugin: {
      list: async () => {
        events.push("plugins");
        return plugins;
      },
    },
    command: {
      list: async (input: unknown, options: { signal: AbortSignal }) => {
        expect(input).toEqual({ location: { directory } });
        expect(options.signal).toBeInstanceOf(AbortSignal);
        events.push("commands");
        return pending;
      },
    },
  } as unknown as Parameters<typeof warmCommandInventory>[0];
  const warming = warmCommandInventory(client, directory, target, observation).then(() =>
    events.push("measure-delivery"),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(["plugins", "commands"]);
  expect(observation.ready).toBeUndefined();
  release(commands);
  await warming;
  expect(events).toEqual(["plugins", "commands", "measure-delivery"]);
  expect(observation).toMatchObject({ ready: true, attempts: 1, plugins, commands });
  expect(observation.elapsedMs).toBeGreaterThanOrEqual(0);
  let attempts = 0;
  const pollingObservation: Record<string, unknown> = {};
  const pollingClient = {
    plugin: { list: async () => plugins },
    command: { list: async () => (++attempts === 1 ? { location: { directory }, data: [] } : commands) },
  } as unknown as Parameters<typeof warmCommandInventory>[0];
  await warmCommandInventory(pollingClient, directory, target, pollingObservation);
  expect(pollingObservation).toMatchObject({ ready: true, attempts: 2, commands, plugins });
});

test("warmup requires exact active package, stm registration and location; missing readiness aborts", async () => {
  const directory = "/isolated-project";
  const target = "@atonev/opencode-short-term-memory@1.3.0";
  for (const variant of ["missing-package", "wrong-target", "missing-command", "failed", "wrong-location"]) {
    const controller = new AbortController();
    const observation: Record<string, unknown> = {};
    let calls = 0;
    const client = {
      plugin: {
        list: async () => {
          if (++calls > 1) controller.abort(new Error("warmup deadline"));
          return {
            location: { directory },
            data:
              variant === "missing-package"
                ? []
                : [
                    {
                      source: { type: "package", target: variant === "wrong-target" ? "other" : target },
                      state: { status: variant === "failed" ? "failed" : "active" },
                    },
                  ],
          };
        },
      },
      command: {
        list: async () => {
          return {
            location: { directory: variant === "wrong-location" ? "/other" : directory },
            data: variant === "missing-command" ? [] : [{ name: "stm" }],
          };
        },
      },
    } as unknown as Parameters<typeof warmCommandInventory>[0];
    await expect(warmCommandInventory(client, directory, target, observation, controller.signal)).rejects.toThrow();
    expect(observation.ready).toBeUndefined();
    expect(observation.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(observation.attempts).toBe(1);
  }
  const source = await readFile(new URL("./production-acceptance.ts", import.meta.url), "utf8");
  expect(source.indexOf("await warmCommandInventory(client")).toBeLessThan(
    source.indexOf("for (const text of HEADLESS_COMMANDS) await absent(text)"),
  );
  expect(source).toContain("elapsedMs > 4_000");
  expect(source).toContain('await connected("status", "explicit-status", statusLines)');
});

test("full native workflow has finite success/refusal coverage and no inference or fixture publishing", async () => {
  const source = await readFile(new URL("./production-acceptance.ts", import.meta.url), "utf8");
  expect(HEADLESS_COMMANDS).toEqual(["setup confirm true", "reset confirm true", "update", "show"]);
  expect(WORKFLOW_MS).toBe(90_000);
  for (const state of [
    "default-status",
    "explicit-status",
    "settings-success",
    "logs-empty",
    "show-created",
    "show-existing",
    "setup-unconfirmed",
    "setup-created",
    "setup-no-overwrite",
    "update-no-model",
    "reset-unconfirmed",
    "reset-empty-refused",
    "reset-settled-accepted",
    "status-after-reset",
    "update-post-reset-skipped",
    "logs-persisted",
  ])
    expect(source).toContain(`"${state}"`);
  expect(source).toContain('name: "stm", text');
  expect(source).toContain("evidence.nativeConnectedCount !== 16");
  expect(source).toContain("await client.session.import(transfer");
  expect(source).toContain("await client.session.export(");
  expect(source).toContain("import-baseline");
  expect(source).toContain("verifySessionBaseline(messages, session, created, expectedPage)");
  expect(source).toContain('"-y", "240"');
  expect(source).toContain("await waitScreen");
  expect(source).toContain("No action was run.");
  expect(source).toContain("no connected TUI receiver admitted");
  expect(source).toContain('"85s"');
  expect(source).toContain('"65s"');
  expect(source).not.toMatch(/\.(?:prompt|synthetic|generate|publish)\s*\(/);
  expect(source).not.toMatch(/from ["'][^"']*(?:src\/|sqlite|drizzle)/);
  expect(source).not.toContain("await pause(150)");
});

test("actual PTY title and ordered body rows are required, including wrapped paths and final settings rows", () => {
  const screen = [
    " STM settings                 esc",
    '  "generation": "v2",',
    ' "memoryDir": "/tmp/opencode/very-long-',
    ' path/memory",',
    ' "inactiveSettings": [',
    ' "collapseAssistantBursts"',
    " ok",
  ].join("\n");
  const lines = [
    '"generation": "v2"',
    '"memoryDir": "/tmp/opencode/very-long-path/memory"',
    '"inactiveSettings":',
    '"collapseAssistantBursts"',
  ];
  expect(dialogRows(screen, "STM settings", lines)).toBe(true);
  expect(dialogRows(screen, "STM logs", lines)).toBe(false);
  expect(dialogRows(screen.replace("collapseAssistantBursts", "missing"), "STM settings", lines)).toBe(false);
  expect(dialogRows(screen, "STM settings", [...lines].reverse())).toBe(false);
  expect(dialogRows(screen.replace("esc", "another-dialog"), "STM settings", lines)).toBe(false);
  expect(dialogRows('"generation": "v2"\nSTM settings esc', "STM settings", ['"generation": "v2"'])).toBe(false);
});

test("file snapshots distinguish missing, empty, binary, created directories and changed bytes", async () => {
  const sandbox = await mkdtemp("/tmp/opencode/stm-file-state-");
  const directory = join(sandbox, "memory");
  try {
    expect(await fileState([directory])).toEqual({});
    await mkdir(directory);
    await writeFile(join(directory, "empty"), "");
    await writeFile(join(directory, "binary"), Buffer.from([0, 255, 1]));
    const before = await fileState([directory]);
    expect(before).toEqual({
      [`${directory}/`]: "directory",
      [join(directory, "binary")]: "AP8B",
      [join(directory, "empty")]: "",
    });
    expect(await fileState([directory])).toEqual(before);
    await writeFile(join(directory, "empty"), "changed");
    expect(await fileState([directory])).not.toEqual(before);
    await symlink(join(directory, "binary"), join(directory, "link"));
    await expect(fileState([directory])).rejects.toThrow("Unexpected non-file");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("mutation verification rejects collateral files while allowing necessary parent directory creation", () => {
  const before = { "/memory/old": "AP8B" };
  const after = {
    ...before,
    "/memory/": "directory",
    "/memory/checkpoints/": "directory",
    "/memory/checkpoints/new": "",
  };
  expect(() => assertOnlyChanged(before, after, ["/memory/checkpoints/new"])).not.toThrow();
  expect(() =>
    assertOnlyChanged(before, { ...after, "/memory/unexpected/": "directory" }, ["/memory/checkpoints/new"]),
  ).toThrow("Unexpected action file change");
  expect(() => assertOnlyChanged(before, { ...after, "/memory/old": "changed" }, ["/memory/checkpoints/new"])).toThrow(
    "Unexpected action file change",
  );
});

test("import payload uses verified pinned transfer fields and only settled model-free existing text", () => {
  const baseline: Parameters<typeof settledTransfer>[0] = {
    info: {
      id: "ses_original",
      projectID: "global",
      location: { directory: "/isolated" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 100, updated: 100 },
    },
    messages: [],
  };
  const transfer = settledTransfer(baseline, "ses_imported");
  // Decode the real pinned schema, not a test-local imitation. This does not launch a host.
  expect(() =>
    Schema.decodeUnknownSync(SessionTransfer.Data)({ info: transfer.info, messages: transfer.messages }),
  ).not.toThrow();
  expect(transfer.info.id).toBe("ses_imported");
  expect(transfer.location).toEqual({ directory: "/isolated" });
  expect(transfer.info.model).toEqual({ providerID: "stm-acceptance-unconfigured", id: "import-only-no-inference" });
  expect(transfer.messages.map((message) => message.type)).toEqual(["user", "assistant"]);
  const assistant = transfer.messages[1]!;
  expect(assistant.type).toBe("assistant");
  if (assistant.type !== "assistant") throw new Error("Wrong transfer record");
  expect(assistant.time.completed).toBe(102);
  expect(assistant.model).toEqual(transfer.info.model!);
  expect(assistant.cost).toBe(0);
  expect(assistant.content).toEqual([
    { type: "text", text: "Imported existing settled assistant text; no model was called." },
  ]);
  expect(baseline.info.id).toBe("ses_original");
  expect(baseline.messages).toEqual([]);
});

test("snapshot baseline accepts schema-null empty endpoints and rejects history, cursor, model and usage changes", () => {
  const session: Parameters<typeof verifySessionBaseline>[1] = {
    id: "ses_fresh",
    projectID: "global",
    location: { directory: "/isolated" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 100, updated: 100 },
  };
  const page: Parameters<typeof verifySessionBaseline>[0] = { data: [], cursor: { previous: null, next: null } };
  expect(() => verifySessionBaseline(page, session, { model: undefined })).not.toThrow();
  for (const cursor of [{}, { previous: null }, { previous: "wrong", next: null }, { previous: null, next: "wrong" }])
    expect(() => verifySessionBaseline({ ...page, cursor }, session, session)).toThrow("baseline");
  expect(() =>
    verifySessionBaseline(
      { ...page, data: [{ id: "msg_unexpected", type: "user", time: { created: 101 }, text: "unexpected" }] },
      session,
      session,
    ),
  ).toThrow("baseline");
  for (const field of ["input", "output", "reasoning", "read", "write"] as const) {
    const changed = structuredClone(session);
    if (field === "read" || field === "write") changed.tokens.cache[field] = 1;
    else changed.tokens[field] = 1;
    expect(() => verifySessionBaseline(page, changed, session), field).toThrow("baseline");
  }
  expect(() => verifySessionBaseline(page, { ...session, cost: 1 }, session)).toThrow("baseline");
  expect(() =>
    verifySessionBaseline(page, { ...session, model: { providerID: "unexpected", id: "model" } }, session),
  ).toThrow("baseline");
  const transfer = { info: session, location: session.location, messages: [] };
  const imported = { ...session, model: { providerID: "import-only", id: "model" } };
  const importedTransfer = { ...transfer, info: imported };
  const importedSession = { ...imported, model: { ...imported.model, variant: "default" } };
  const importedPage = verifyImportedPage(importedTransfer, page, importedSession);
  expect(() => verifySessionBaseline(page, importedSession, importedSession, importedPage)).not.toThrow();
  expect(() => verifyImportedPage(importedTransfer, { data: [], cursor: {} }, importedSession)).toThrow(
    "exact durable transfer projection",
  );
});

test("import validator verifies descending durable projection and exact endpoint cursors before retaining a baseline", () => {
  const transfer = settledTransfer(
    {
      info: {
        id: "ses_original",
        projectID: "global",
        location: { directory: "/isolated" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 100, updated: 100 },
      },
      messages: [],
    },
    "ses_imported",
  );
  const page = {
    data: structuredClone([...transfer.messages].reverse()),
    cursor: {
      previous: Buffer.from('{"id":"msg_stm_import_assistant","order":"desc","direction":"previous"}').toString(
        "base64url",
      ),
      next: Buffer.from('{"id":"msg_stm_import_user","order":"desc","direction":"next"}').toString("base64url"),
    },
  } as Parameters<typeof verifyImportedPage>[1];
  const session: Parameters<typeof verifyImportedPage>[2] = {
    id: transfer.info.id,
    projectID: transfer.info.projectID,
    location: { directory: "/isolated" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    model: { ...transfer.info.model!, variant: "default" },
    time: { created: 100, updated: 200 },
  };
  // Pinned handler emits next for the last record, not only when more records exist.
  expect(page.cursor.next).toBeTruthy();
  const baseline = verifyImportedPage(transfer, page, session);
  expect(baseline).toEqual(page);
  expect(baseline).not.toBe(page);
  expect(() => verifySessionBaseline(page, session, session, baseline)).not.toThrow();
  const mutations: [string, (page: any) => void][] = [
    [
      "wrong id",
      (page) => {
        page.data[0].id = "msg_wrong";
      },
    ],
    [
      "wrong assistant text",
      (page) => {
        page.data[0].content[0].text = "changed";
      },
    ],
    [
      "wrong user text",
      (page) => {
        page.data[1].text = "changed";
      },
    ],
    [
      "missing record",
      (page) => {
        page.data.pop();
      },
    ],
    [
      "reordered records",
      (page) => {
        page.data.reverse();
      },
    ],
    [
      "unfinished assistant",
      (page) => {
        delete page.data[0].time.completed;
      },
    ],
    [
      "completion timestamp",
      (page) => {
        page.data[0].time.completed++;
      },
    ],
    [
      "changed role",
      (page) => {
        page.data[1].type = "system";
      },
    ],
    [
      "changed model",
      (page) => {
        page.data[0].model.id = "another";
      },
    ],
    [
      "added model variant",
      (page) => {
        page.data[0].model.variant = "default";
      },
    ],
    [
      "assistant usage",
      (page) => {
        page.data[0].tokens.cache.write++;
      },
    ],
    [
      "assistant cost",
      (page) => {
        page.data[0].cost++;
      },
    ],
    [
      "extra history",
      (page) => {
        page.data.push(structuredClone(page.data[1]));
      },
    ],
    [
      "unrequested metadata",
      (page) => {
        page.data[0].metadata = { injected: true };
      },
    ],
    [
      "wrong next cursor",
      (page) => {
        page.cursor.next = "another";
      },
    ],
    [
      "missing next cursor",
      (page) => {
        delete page.cursor.next;
      },
    ],
    [
      "wrong previous cursor",
      (page) => {
        page.cursor.previous = page.cursor.next;
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(page);
    mutate(changed);
    expect(() => verifyImportedPage(transfer, changed, session), label).toThrow("exact durable transfer projection");
    expect(() => verifySessionBaseline(changed, session, session, baseline), label).toThrow("baseline");
  }
  for (const mutate of [
    (session: any) => {
      session.id = "ses_other";
    },
    (session: any) => {
      session.model.providerID = "other";
    },
    (session: any) => {
      session.model.variant = "other";
    },
    (session: any) => {
      session.cost = 1;
    },
    (session: any) => {
      session.tokens.output = 1;
    },
    (session: any) => {
      session.tokens.cache.read = 1;
    },
  ]) {
    const changed = structuredClone(session);
    mutate(changed);
    expect(() => verifyImportedPage(transfer, page, changed)).toThrow("zero-usage transfer");
    if (changed.id === session.id)
      expect(() => verifySessionBaseline(page, changed, session, baseline)).toThrow("baseline");
  }
  page.data[0]!.id = "msg_later_change";
  expect(baseline.data[0]!.id).toBe("msg_stm_import_assistant");
  expect(page).not.toEqual(baseline);
});

test("actual pinned Npm lookup rejects flat staging and reuses a proper exact-version generation offline", async () => {
  const sandbox = await mkdtemp("/tmp/opencode/stm-installed-contract-");
  try {
    const cache = join(sandbox, "cache");
    const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
    const packageDir = join(cache, "node_modules", manifest.name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest));
    await symlink(resolve(import.meta.dir, "../../../dist"), join(packageDir, "dist"), "dir");
    await writeFile(
      join(cache, "package.json"),
      JSON.stringify({ dependencies: { [manifest.name]: manifest.version } }),
    );
    const layer = LayerNode.compile(Npm.node, {
      replacements: [
        Global.node.replace(
          Global.layerWith({
            cache,
            state: join(sandbox, "state"),
            data: join(sandbox, "data"),
            config: join(sandbox, "config"),
            log: join(sandbox, "log"),
            bin: join(sandbox, "bin"),
            repos: join(sandbox, "repos"),
            tmp: join(sandbox, "tmp"),
          }),
        ),
      ],
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const npm = yield* Npm.Service;
        const flat = Host.resolve({ directory: cache, name: manifest.name });
        expect(flat.tui).toBeDefined();
        const absent = yield* npm.resolve(manifest.name);
        expect(absent.version).toBeUndefined();
        expect(absent.directory).toBe(join(cache, "npm", `${manifest.name}@latest`, "node_modules", manifest.name));
        yield* Effect.promise(async () => {
          await expect(stat(absent.directory)).rejects.toThrow();
        });
        const failed = yield* npm.check(manifest.name).pipe(Effect.flip);
        expect(failed._tag).toBe("NpmInstallFailedError");
        expect(String(failed.cause)).toContain(`Package is not installed: ${manifest.name}`);
        const staged = yield* Effect.promise(() => stageInstalledPackage(cache, manifest.name, manifest.version));
        expect(staged.target).toBe(`${manifest.name}@${manifest.version}`);
        const installed = yield* npm.add(staged.target);
        expect(installed).toEqual({
          directory: join(staged.generation, "node_modules", manifest.name),
          name: manifest.name,
          version: manifest.version,
          revision: manifest.version,
        });
        expect(yield* npm.resolve(staged.target)).toEqual(installed);
        expect(yield* npm.check(staged.target)).toBe(false);
        expect(Host.resolve(installed)).toEqual(flat);
        return staged;
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
    expect(await readFile(join(result.generation, "node_modules", manifest.name, "package.json"), "utf8")).toBe(
      JSON.stringify(manifest),
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("readiness requires connected CLI and target-specific successful setup followed by reconciliation", () => {
  const target = "@atonev/opencode-short-term-memory@1.3.0";
  const connected = 'level=INFO run=tui message="event stream connected" component=client role=cli';
  const setup = `level=DEBUG run=tui message="plugin operation completed" component=plugin id=9 stage=setup durationMs=1 plugin=opencode-short-term-memory target=${target} role=cli`;
  const complete = 'level=INFO run=tui message="plugin reconciliation completed" component=plugin role=cli';
  expect(tuiReadiness([connected, setup, complete].join("\n"), target)?.run).toBe("tui");
  for (const lines of [
    [connected, complete],
    [setup, complete],
    [connected, setup],
    [connected, setup.replace("completed", "failed"), complete],
    [connected, setup.replace(target, "another-package"), complete],
    [connected, setup, complete.replace("run=tui", "run=server")],
  ])
    expect(tuiReadiness(lines.join("\n"), target)).toBeUndefined();
});

test("structured command failures retain diagnostic fields rather than object coercion", () => {
  const error = {
    _tag: "CommandExecutionError",
    message: "receiver failed",
    command: "stm",
    status: 500,
    diagnostic: { receiverID: "receiver-one", attempt: 2 },
  };
  expect(serializeFailure(error)).toEqual(error);
  expect(JSON.parse(JSON.stringify(serializeFailure(error)))).toEqual(error);
});

test("native Error preserves non-enumerable name/message/stack/cause and enumerable diagnostics", () => {
  const error = Object.assign(new TypeError("outer", { cause: new Error("inner") }), { code: "E_RECEIVER" });
  const result = serializeFailure(error) as Record<string, any>;
  expect(result.name).toBe("TypeError");
  expect(result.message).toBe("outer");
  expect(result.stack).toContain("TypeError: outer");
  expect(result.cause.name).toBe("Error");
  expect(result.cause.message).toBe("inner");
  expect(result.cause.stack).toContain("Error: inner");
  expect(result.code).toBe("E_RECEIVER");
});

test("redaction covers credentials in fields, free text, Error causes and terminal screens", async () => {
  const password = "sandbox-private-password";
  const basic = Buffer.from(`opencode:${password}`).toString("base64");
  const error = Object.assign(new Error(`password ${password}; Basic ${basic}`, { cause: new Error(password) }), {
    diagnostic: { Authorization: `Basic ${basic}`, password, apiKey: "other-key", token: "other-token" },
    url: "http://user:private@localhost/path",
    bearer: "Bearer private-token",
  });
  let screen = "";
  const observation = await observeFailure(error, "connected-native-status", [password, basic], {
    capture: async () => `${password} Basic ${basic} Bearer private-token`,
    save: async (value) => {
      screen = value;
    },
  });
  const json = JSON.stringify(observation);
  for (const secret of [password, basic, "other-key", "other-token", "private-token", "user:private"])
    expect(json + screen).not.toContain(secret);
  expect((observation.error as any).diagnostic.Authorization).toBe("[redacted]");
  expect(screen).toBe("[redacted] Basic [redacted] Bearer [redacted]");
});

test("diagnostics are JSON-safe and bounded without invoking getters or toJSON", () => {
  let calls = 0;
  const error: Record<string, unknown> = {
    _tag: "CommandExecutionError",
    message: "x".repeat(10_000),
    command: "stm",
    bigint: 1n,
    nonfinite: Infinity,
    toJSON: () => {
      calls++;
      throw new Error("must not run");
    },
    entries: Array.from({ length: 1_000 }, () => "row"),
  };
  error.self = error;
  Object.defineProperty(error, "accessor", {
    enumerable: true,
    get: () => {
      calls++;
      throw new Error("must not run");
    },
  });
  let deep: unknown = "leaf";
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  error.deep = deep;
  const json = JSON.stringify(serializeFailure(error));
  expect(calls).toBe(0);
  expect(json).toContain("[circular]");
  expect(json).toContain("[accessor]");
  expect(json).toContain("[entry limit]");
  expect(json).toContain("[depth limit]");
  expect(json).toContain("[truncated]");
  expect(json.length).toBeLessThan(6_000);
  expect(JSON.parse(json).bigint).toBe("1");
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i]));
  expect(JSON.stringify(serializeFailure(wide))).toContain("[entry limit]");
  const tree = Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => ({ leaf: "value" })));
  expect(JSON.stringify(serializeFailure(tree))).toContain("[node limit]");
  const boundary = JSON.stringify(
    serializeFailure({ message: "x".repeat(4_090) + "private-password" }, ["private-password"]),
  );
  expect(boundary).not.toContain("private");
});

test("connected failure capture finishes before snapshot/teardown; capture failure is separate", async () => {
  const events: string[] = [];
  const primary = { _tag: "CommandExecutionError", command: "stm", message: "no ACK" };
  const observation = await observeFailure(primary, "connected-native-status", [], {
    capture: async () => {
      events.push("capture");
      return "failure screen";
    },
    save: async (screen) => {
      events.push("save");
      expect(screen).toBe("failure screen");
    },
  });
  events.push("snapshot", "teardown");
  expect(events).toEqual(["capture", "save", "snapshot", "teardown"]);
  expect(observation).toEqual({
    phase: "connected-native-status",
    error: primary,
    failureScreen: "failure-screen.txt",
  });
  const failed = await observeFailure(primary, "connected-native-status", [], {
    capture: async () => {
      throw new Error("pane unavailable");
    },
    save: async () => {
      throw new Error("must not save");
    },
  });
  expect(failed.error).toEqual(primary);
  expect((failed.failureScreenError as any).message).toBe("pane unavailable");
  expect(failed.failureScreen).toBeUndefined();
  const saveFailed = await observeFailure(primary, "connected-render", [], {
    capture: async () => "screen",
    save: async () => {
      throw new Error("disk unavailable");
    },
  });
  expect((saveFailed.failureScreenError as any).message).toBe("disk unavailable");
});

test("no-TUI observations skip terminal capture; harness wires capture before snapshot and finally cleanup", async () => {
  const observation = await observeFailure(new Error("no TUI"), "no-tui-before", []);
  expect(observation.phase).toBe("no-tui-before");
  expect(observation.failureScreen).toBeUndefined();
  expect(observation.failureScreenError).toBeUndefined();
  const source = await readFile(new URL("./production-acceptance.ts", import.meta.url), "utf8");
  const catchBlock = source.slice(source.indexOf("evidence.failure = await observeFailure"));
  expect(catchBlock).toContain("tuiStarted\n");
  expect(catchBlock).toContain(": undefined,");
  expect(catchBlock.indexOf('terminal("capture-pane"')).toBeLessThan(catchBlock.indexOf('snapshot("after-failure")'));
  expect(catchBlock.indexOf('snapshot("after-failure")')).toBeLessThan(catchBlock.indexOf('terminal("kill-server")'));
});
