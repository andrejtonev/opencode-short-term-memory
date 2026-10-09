# Production RPC/TUI Acceptance

This fixture exercises the production packaged server, RPC and TUI entries on the
adjacent pinned OpenCode 2.0.12 host. The superseded isolated bridge is retired.
`contract.ts` retains the shared session-log baseline validator; `probe.test.ts`
retains its independent positive and negative coverage. The adjacent paid
generation probe is separate and unchanged.

## Validation Without Hosts

From the repository root, using the root development dependencies (including
`node_modules/typescript` and `node_modules/prettier`) and the installed fixture
dependencies:

```sh
/home/dev/.bun/bin/bun test --isolate fixtures/v2-generation-probe/tui-output
/home/dev/.bun/bin/bun node_modules/typescript/bin/tsc -p fixtures/v2-generation-probe/tui-output/tsconfig.json
/home/dev/.bun/bin/bun node_modules/prettier/bin/prettier.cjs --check fixtures/v2-generation-probe/tui-output
```

Importing the harness in tests does not launch its live workflow. Tests validate
baseline, packaging, readiness, file-state, screen and failure-observation helpers.

## Authorized Live Workflow

Requires existing production `dist` artifacts, the root checkout dependencies,
installed fixture dependencies, the pinned host binary and tmux. This command
launches hosts; run it only with separate authorization, not as part of ordinary
fixture validation:

```sh
/usr/bin/timeout --kill-after=5s 100s /home/dev/.bun/bin/bun fixtures/v2-generation-probe/tui-output/production-acceptance.ts
```

The harness stages manifest-listed production files and verifies server/TUI/RPC
exports, declarations and UI bundle separation. It launches an authenticated
loopback server on an ephemeral port and actual TUIs in a private tmux socket
with a 160x240 PTY. HOME/XDG state and configuration are sandbox-local; child
environments exclude inherited provider credentials, proxies and user tmux
configuration. Auto-updates and model-catalog fetches are disabled.

The active API is native `session.command({ sessionID, name: "stm", text })`,
not a fixture publisher, prompt, synthetic message or generation API. Read-only
inventory polling verifies package activation and command registration before
measuring delivery. Four headless commands must refuse before action execution
and leave file state unchanged. Sixteen connected commands cover status,
settings, logs, show, setup, update refusal, reset refusal, accepted reset over
imported settled history, and post-reset update skip. Actual terminal captures,
not ACKs alone, witness output. Status must survive the handshake deadline until
explicit dismissal. File snapshots verify permitted changes and exact reset bytes.

Session snapshots compare catalog identity, messages, model, cost and tokens to
the empty or independently verified imported baseline. Replay requires a matching
terminal `log.synced` witness and correlated, strictly increasing nonnegative
integer event sequences within its watermark. Sequence gaps and marker-only
replay are valid; forbidden inbox, execution, synthetic, tool and usage events
fail closed. Marker-only replay cannot prove absence of non-persisted activity.

## Retained PASS Evidence

Latest retained production result:
`/tmp/opencode/stm-production-commands-fvXKGG/evidence.json`.
This is an existing run, not a new execution performed by the retirement task.

- `verdict: pass`, `failures: []`, `nativeConnectedCount: 16`.
- `costConsumed: 0`, `paidInference: false`, `globalBudgetChanged: false`.
- `tuiStopped: true`; `serverExit: 130` records server termination during cleanup.
- The sandbox retains command screens, session snapshots, import transfer,
  file-state evidence and redacted server diagnostics.

## Scope Limits

The named exact-version package target is backed by locally staged publishable
files and a pinned host-compatible NPM cache generation. The staged acceptance
workflow uses dependencies from the checkout root and the installed fixture
dependencies; it is not a clean production-final-artifact qualification. This
proves staged packaged activation, not a clean registry install, dependency
installation, publication or release readiness. Clean native tarball
qualification remains covered by the existing native tarball scripts.

The model-free workflow does not cover a successful native committed update;
shared unit tests cover committed-update logic. Settled messages are imported
existing history, not new command effects or inference. Unchanged history does
not prove absence of internal history reads; receiver-first unit tests provide
that separate proof. The separate paid generation probe is not run by this harness.

The workflow has a 90-second internal deadline, 85-second server and 65-second TUI
process deadlines, and short per-operation limits. Failures exit nonzero and retain
redacted diagnostics and, when available, a failure screen in the sandbox.
