# STM end-to-end tests

These tests start a live `opencode serve` process and load the checkout's STM
source through a temporary plugin symlink. Each suite creates a temporary
project, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME`. This is scoped isolation, not
full process isolation: `HOME` is inherited, and the harness symlinks the
normal `$HOME/.local/share/opencode/auth.json` when it exists. Other runtime
cache, credential, proxy, or host settings may therefore still come from the
normal user locations. The harness does not modify or delete the user's global
configuration.

## Prerequisites and commands

- `bun` (the package requires Bun `>=1.0.0`)
- `opencode` on `$PATH` (the harness checks `opencode --version`)
- credentials and a model available to the `opencode` process for tests that
  perform real model calls

The package commands are:

```bash
# Runs all six suites; the package script sets the gate and a 300-second test timeout.
bun run test:e2e

# Equivalent direct invocation with the gate explicit.
OPENCODE_E2E=1 bun test --isolate --timeout 300000 test/e2e/

# Primary chat model used by opencode run.
STM_E2E_MODEL=opencode-go/minimax-m2.7 bun run test:e2e

# Model written into the project STM config for summarization.
STM_E2E_FALLBACK_MODEL=opencode-go/minimax-m2.7 bun run test:e2e

# Other supported harness overrides.
STM_E2E_PORT=19000 bun run test:e2e
STM_E2E_KEEP_TMP=1 bun run test:e2e
STM_E2E_TIMEOUT=300000 bun run test:e2e
```

`OPENCODE_E2E=1` is a gate, not a cost or safety budget. A direct
`bun run test:e2e` can make nonzero-cost model calls and does not enforce a
spend cap. Paid runs are a separate workflow:

```bash
bun scripts/paid-e2e.ts --self-test
bun scripts/paid-e2e.ts --run --prior-evidence /absolute/evidenceDirectory [--prior-report /absolute/report.json ...]
```

The paid guard requires prior ledgers/evidence, configured caps, and the
appropriate credentials; its published-rate exposure limit is independent of
the ordinary E2E command.

## What the harness isolates—and what it does not

`setupE2EWorkspace()` creates a temporary root containing the project,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, plugin directory, memory directory, and
serve log. It seeds only project-local `opencode.json` and `.opencode/stm.jsonc`.
`isolateServeEnv()` and `isolateRunEnv()` preserve the inherited environment,
set the two temporary XDG homes, retain `HOME`, and remove
`OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` for the local test
server. Authentication is intentionally made available by symlinking the
normal auth file into the temporary data home; this does not mean all runtime
state is isolated.

The harness stops only serve children that it owns. Before spawning, it probes
the loopback port and refuses an occupied port with
“refusing to kill or adopt its listener”; it does not `fuser`-kill or adopt an
unrelated process. Cleanup removes the temporary root, unless
`STM_E2E_KEEP_TMP=1` is set. Tests are not documented as parallel-safe, and
`maxConcurrency` is not a required harness setting: a shared configured port
still has to be free for the run.

## Six-suite inventory

| Suite                       | Scope                                                                                                             | Model calls?                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `stm-e2e.test.ts`           | Live serve/plugin status, memory-producing chat, clean side-session tracking, orphan cleanup, and startup timing. | **Yes** for chat and summarization; serve/status checks do not require a successful completion. |
| `events.test.ts`            | Live plugin load plus synthetic event dispatch and filesystem/log assertions.                                     | **No**; uses a fake client for direct hook work.                                                |
| `hooks.test.ts`             | Direct hook contracts, including command/chat hooks, deduplication, counters, and path safety.                    | **No**; synthetic payloads and a fake client.                                                   |
| `wireup.test.ts`            | Live plugin hook surface and input/output wiring.                                                                 | **No**; handlers are exercised with a fake client.                                              |
| `commands.test.ts`          | `/stm` command actions through the live server; command hook short-circuits the agent.                            | **No model completion** for command results.                                                    |
| `include-agents-md.test.ts` | Project `AGENTS.md` inclusion in the first summarizer prompt.                                                     | **No real model**; captures the prompt with a fake client.                                      |

All six suites require `OPENCODE_E2E=1` and an `opencode` binary, even when
their assertions use fake clients. The live serve proves host/plugin loading;
it does not turn synthetic hook tests into model or provider acceptance.

## Architecture

```
test/e2e/
├── harness.ts                 # workspace, environment, serve, run, helpers
├── stm-e2e.test.ts            # live model and lifecycle scenarios
├── events.test.ts             # synthetic event dispatch
├── hooks.test.ts              # direct hook contracts
├── wireup.test.ts             # direct wire-up contracts
├── commands.test.ts           # live /stm command transport
├── include-agents-md.test.ts  # captured summarizer prompt
└── README.md

scripts/
└── e2e-symlink-plugin.mjs     # temporary XDG plugin symlink
```

The primary model is `STM_E2E_MODEL`: it is passed to `opencode run --model`.
`STM_E2E_FALLBACK_MODEL` is the model seeded as `memoryModel` in the temporary
STM project config. They are separate variables even when their defaults are
the same.

## Installation and release workflows

This checkout test harness intentionally uses a source symlink and does not
test package installation. For release installation checks, prefer the pinned
isolated native V1/V2 tarball runners (`scripts/published-v1-e2e.ts` and
`scripts/published-v2-e2e.ts`), which exercise a package artifact. Their
`--setup-only` mode prepares the isolated runner without executing the runtime
journey; it is not equivalent to a completed acceptance run. The checkout
suite and the tarball runners therefore answer different questions.

## Troubleshooting and scope of guarantees

- **`opencode --version` fails** — the suites skip because the E2E gate also
  requires the host binary.
- **Occupied port** — choose `STM_E2E_PORT`; the harness refuses to kill or
  adopt the existing listener.
- **Serve does not become ready** — inspect the retained temporary
  `opencode.serve.log` with `STM_E2E_KEEP_TMP=1`.
- **No memory file** — the real primary or summarizer model/auth request may
  have failed; inspect the retained project and serve log.

The suite reports measured assertions from the current tests. It does not
promise unconditional startup timing, semantic memory quality, parallel
execution, zero spend, or complete isolation from inherited user runtime
state. Fake-client suites prove direct contracts; only the explicitly listed
chat/summarization scenarios exercise real model calls.
