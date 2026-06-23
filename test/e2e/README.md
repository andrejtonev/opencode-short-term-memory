# STM End-to-End Tests

Live `opencode` instance with the local STM plugin loaded via symlink. Each
suite gets a fresh temp project dir + temp `XDG_CONFIG_HOME` so the user's
`~/.config/opencode/` is never touched. No npm install, no global mutation.

## Prerequisites

- `opencode` binary on `$PATH` (verified via `opencode --version`)
- A working chat model accessible to the `opencode` binary
- `OPENCODE_E2E=1` exported in the environment

## Running

```bash
# default model + port
bun run test:e2e

# override the chat model (used by `opencode run --model`)
STM_E2E_MODEL=opencode-go/minimax-m2.7 bun run test:e2e

# override the port (default 18999)
STM_E2E_PORT=19000 bun run test:e2e

# keep the temp project dir for debugging
STM_E2E_KEEP_TMP=1 bun run test:e2e

# raise the per-test timeout (opencode run can take 60–180s)
bun test --isolate --timeout 300000 test/e2e/
```

## Architecture

```
test/e2e/
├── harness.ts          # shared scaffolding (setup, serve, run, helpers)
├── stm-e2e.test.ts     # the four test groups
└── README.md           # this file

scripts/
└── e2e-symlink-plugin.mjs   # creates <XDG>/opencode/plugins/opencode-short-term-memory.ts
```

The harness:

1. `setupE2EWorkspace()` — `mkdtemp` a root dir, then create a sub-dir for
   the project and one for the temp `XDG_CONFIG_HOME`. The plugin auto-creates
   its `stm.jsonc` in `<XDG>/opencode/` (no global pollution), and the test
   seeds a per-project `.opencode/stm.jsonc` so the test config wins over the
   auto-created one.
2. `enableStmPluginSymlink()` — symlinks `src/index.ts` into
   `<XDG>/opencode/plugins/opencode-short-term-memory.ts`. The user's real
   `~/.config/opencode/plugins/` is left untouched.
3. `startServe()` — spawns `opencode serve --port <STM_E2E_PORT>` with
   `XDG_CONFIG_HOME=<temp>` and captures stderr to a file so the
   `[STM-STARTUP]` factory-time marker is greppable.
4. `runAttach()` — spawns `opencode run --attach http://localhost:<port>
--dir <projectDir> --model <STM_E2E_MODEL> <prompt>` and parses NDJSON.
5. `cleanupE2EWorkspace()` — `rm -rf` the whole temp root unless
   `STM_E2E_KEEP_TMP=1`.

## What the tests cover

| Group                                  | Test                                                                            | What it proves                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Plugin loads and /stm status works     | `opencode serve is up and serving HTTP`                                         | The serve actually came up.                                                      |
|                                        | `plugin_loaded log entry was written`                                           | The plugin's background init ran.                                                |
|                                        | `stm status returns the plugin status text`                                     | The plugin's tool responds to the slash command.                                 |
|                                        | `a chat produces a memory file`                                                 | The end-to-end pipeline (chat → summarise → write) works.                        |
| Clean summarizer side session tracking | `clean update creates and deletes a side session; tracking file is empty after` | The side session is created, used, and cleaned up.                               |
| Orphan cleanup on next startup         | `stale side-sessions.json entries are deleted when serve restarts`              | The crash-recovery path works.                                                   |
| Factory startup is <10ms               | `factory_returned_ms is under 10ms in the serve stderr`                         | The hard <10ms requirement holds under a live opencode, not just in a unit test. |

## Differences from the unit tests

| Unit (`test/`)             | E2E (`test/e2e/`)                                                            |
| -------------------------- | ---------------------------------------------------------------------------- |
| Fake `client` (no network) | Live `opencode` process                                                      |
| Deterministic timing       | Wall-clock LLM calls                                                         |
| Runs on every `bun test`   | Gated by `OPENCODE_E2E=1`                                                    |
| <50ms factory bound        | <10ms factory bound (live)                                                   |
| Asserts in-process         | Asserts observable artifacts (memory files, log entries, side-session state) |

## Troubleshooting

- **`opencode --version` fails** — the harness reports `shouldRunE2E() = false`
  and the suite is skipped. Install opencode or fix `$PATH`.
- **`Serve on port X did not start within 60s`** — the temp symlink wasn't
  found by opencode. The harness sets `XDG_CONFIG_HOME` for the serve; if your
  opencode is older than 1.0.0 the XDG-aware plugin path may not be supported.
- **`Memory file never appeared`** — the chat model may have failed. Run
  with `STM_E2E_KEEP_TMP=1` and inspect `<tmp>/project/.opencode/memory/`.
- **`plugin_loaded` log entry missing** — the plugin crashed during
  background init. Read `<tmp>/opencode.serve.log` for the stderr trace.
