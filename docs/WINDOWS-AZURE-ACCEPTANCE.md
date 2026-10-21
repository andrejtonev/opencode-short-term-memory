# Isolated Windows Azure acceptance

`scripts/windows-azure-acceptance.ts` runs the same clean-mode journey against
the V1 and V2 SDK/plugin generations, using real Azure `gpt-6-luna` or
`deepseek-v4-flash` responses. It uses native Windows ConPTY for literal typing
and Enter. This complements the Linux/tmux release runners.

## Prepare and run

Requires Bun, Node, Git, a native V1 OpenCode executable, and Azure access to
the selected deployment. The controller reads the existing Azure credential
from OpenCode's auth store (or `AZURE_OPENAI_API_KEY`) and the existing
`AZURE_RESOURCE_NAME`. Do not put credentials into the example files below.

Run from the repository root in PowerShell:

```powershell
bun run build
$candidate = Join-Path $PWD '.opencode\azure-test-candidate.tgz'
bun pm pack --ignore-scripts --filename $candidate
$hosts = Join-Path $PWD ('.opencode\full-sweep\workspace-hosts-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $hosts | Out-Null
'{"private":true,"dependencies":{"@opencode/cli":"2.0.32","@opencode/client":"2.0.32","node-pty":"1.1.0"}}' | Set-Content (Join-Path $hosts 'package.json')
Push-Location $hosts
try { bun install --ignore-scripts } finally { Pop-Location }
$v1 = Join-Path $env:USERPROFILE '.bun\install\global\node_modules\opencode-ai\bin\opencode.exe'
foreach ($sdk in @('v1', 'v2')) {
  foreach ($model in @('gpt-6-luna', 'deepseek-v4-flash')) {
    bun scripts/windows-azure-acceptance.ts $sdk $model $candidate $hosts $v1
    if ($LASTEXITCODE -ne 0) { Write-Warning "Failed: $sdk / $model; inspect the printed evidence directory" }
  }
}
```

The V1 executable defaults to the native Bun global installation above; pass
its actual path if installed elsewhere. Host versions and the candidate SHA256
are recorded per run. SDK versions are pinned in the candidate package.

## Isolation and provider transport

Each invocation creates a new temporary root with a fresh Git project, home,
config, data, cache, temporary directories, database, and memory directory.
`OPENCODE_TEST_HOME` is set because HOME/XDG overrides alone do not isolate all
native host home discovery. Child processes inherit a minimal environment.
Personal OpenCode plugins, settings, and auth files are not copied.

Optional `STM_TEST_PACKAGE_CACHE_SEED` points to a previous isolated run to
copy its package caches into the new root. The copies are independent; home,
config, database, project, and memories still start fresh. This is recorded
in the result and does not qualify a cold-cache installation.

A loopback gateway holds the Azure key in the controller process. OpenCode
receives an ephemeral gateway token. The gateway allows only the selected
deployment and forwards real Azure Chat Completions, converting their actual
responses to SSE. Luna uses `reasoning_effort: none`, required by the tested
Azure deployment when function tools are supplied. V2 uses the provider alias
`azure-isolated` to avoid inheriting built-in Azure catalog endpoint templates.
These runs qualify this transport, not every built-in Azure provider path.

Each case is capped at 32 inference requests (96 with `STM_TEST_FULL=1`) and 4,096 output tokens per
request. Requests incur real provider usage. The gateway captures prompts,
responses, tool names, usage, and errors; test prompts contain only synthetic
data. Summarizer requests must advertise no tools. All owned host and terminal
processes are stopped on journey completion or failure; evidence is retained.

## Assertions and evidence

The shared journey checks package loading, settings/status tools, setup
without confirmation, confirmed setup, repeat setup without overwriting,
three literal keyboard messages, automatic memory containing the supplied
facts, read/logs/compatibility tools, a manual update, and side-session memory
exclusion. Cleanup waits for all requests to complete, a quiet period, and
V1 side-session tracking to become empty. V2 tool prompts explicitly request direct function calls because
models can otherwise route plugin tools through the host's `execute` tool.

The printed root contains `evidence.json`, `requests.json`, `history.json`,
`host.log`, `terminal.ansi`, and the isolated project/settings/memories. A
failure stops that journey; subsequent phases are unexecuted. Inspect errors
and tool results as well as the phase verdicts.

`requests.jsonl` records redacted snapshots at request start and finish, so a
supervisor stop does not depend on normal shutdown to retain provider evidence.
The audit falls back to complete journal lines when `requests.json` is absent;
unfinished requests remain unfinished, and a torn trailing append is ignored.
Older runs without either file have unknown request/transport counts.

Cadence assertions group captured requests by the actual typed user prompt.
Tool continuations belong to the same turn, and injected NoReply memory messages
do not count as new user turns. The first request for each turn establishes its
delivery count; continuations must preserve that count.

The separate transport-health gate fails on any recorded provider error,
including a connection error recovered by the host's retry. Functional
assertions and this stricter error-free transport requirement are distinct.

Audit a retained run with `bun scripts/audit-windows-azure-run.ts RUN_ROOT`.
The audit checks for the Azure key in retained files outside dependency/cache
trees, personal-home configuration references in host logs, and the isolated
root in settings tool output. Results are saved as `isolation-audit.json`.

This is a common live-provider subset, not full release qualification. The
full settings matrix, active mode, command/keyboard variants, reset/delete
races, and provider failure injection still require the broader
[acceptance matrix](RC-ACCEPTANCE-MATRIX.md). A V1 pass does not qualify V2.

## Monitored Windows sweep

After the resource interruption on 2026-10-20, run one case at a time through
`scripts/windows-monitored-case.ps1 -CaseFile CASE.json`. The JSON contains
`label`, `args` (arguments to Bun), and optional process-scoped `env` values.
A workspace lock prevents overlapping supervised cases. Sequential batch runners
must stop after a supervisor resource/deadline stop before starting another case.

The supervisor restricts its child processes to two logical CPUs, sets below-normal
priority, and samples system CPU, total network traffic, free memory, and owned
processes approximately every six seconds. It stops the case after three successive
samples at CPU >=80%, network >=2 MiB/s, or free RAM <2 GiB; the default case deadline
is 360 seconds. Free disk below 8 GiB is also a stop condition. These are system measurements, not per-process network attribution.
Telemetry and child stdout/stderr are retained under `.opencode/full-sweep/monitored-*`.
Telemetry also records approximate CPU usage by owned processes and the highest
CPU consumers when total CPU reaches 60%; network measurements remain system-wide.
Cleanup checks process creation times before stopping only owned descendants.
Parent identity is checked during discovery, and surviving PIDs are checked by
creation time again, because Windows can reuse an exited test process's PID.
Do not set `BUN_CONFIG_MAX_HTTP_REQUESTS=2` in the live host/TUI environment:
the event stream and command can exhaust that pool and prevent the receiver's
claim RPC from running before its deadline.

`STM_TEST_NPM_CACHE_SEED` points to an earlier isolated case containing
`localappdata/npm-cache/_cacache`. Only registry cache bytes are copied to each new
case; settings, authentication, databases and memories remain independent. V1 no
longer copies the unrelated V2 installed-package cache. Long Windows cache paths
use namespaced paths. Earlier failing and interrupted evidence remains retained.

The settings runner accepts one selection such as `v1:hot-reload` or
`v2:layer-project`. The Azure runner additionally supports process-scoped
`STM_TEST_FULL=1`, `STM_TEST_MODE=clean|active`, `STM_TEST_INJECTION=on|off`,
`STM_TEST_ACTIONS=on|off`, and `STM_TEST_FAULTS=1`. Fault mode deliberately substitutes
selected provider replies or holds a summary; it is integration evidence, not a
real-model quality result. A profile's existence does not mean it has passed.
The `STM_TEST_INJECTION` flag controls `enableLegacyPeriodicSystemTransform`:
`off` selects V1's default NoReply delivery, but disables V2 injection. It does
not disable V1 delivery. Evidence records `configuredDelivery` explicitly.
`STM_TEST_FAULT_CASE` can select a single named native fault phase; final cleanup
still runs. Reset accepts safe V2 busy refusal or successful reset after host
cancellation, and successful reset must reject the held stale generation.

For the settings matrix, `STM_TEST_SHARED_LIBRARIES=1` stages a private Npm
generation whose `node_modules` junction references the prepared library seed.
Only library code is shared, as with V1's prepared file entrypoint. Each case
still has fresh configuration, credentials, Npm metadata, database and memories.
The runner compares manifest/runtime entrypoints with the tarball before use and
checks their hashes again after each case. This avoids large duplicate library
copies during settings coverage; it does not qualify a fresh dependency install.
Keep reusable host/dependency seeds under the workspace when Temp cleanup could
remove them. Reconstruct a missing seed into a new directory, verify dependency
versions and native `node-pty` loading, then update only future case inputs.
Retained case inputs and results remain historical evidence.

`STM_TEST_COMMANDS_ONLY=1` runs the literal-command cases without the preceding
model journey. Its session has no ordinary history anchor, so confirmed reset
may correctly refuse. `STM_TEST_TUI_PROBE=1` adds an isolated diagnostic receiver
that records offers and claim timing; such a diagnostic run does not qualify the
unmodified receiver by itself. Normal acceptance must run without that probe.
V1 literal commands still invoke the model for their continuation, including in
commands-only runs. Only V2 commands-only runs are model-free.
`STM_TEST_INSTALLED_PACKAGE_SEED` reuses prepared dependency code only after
byte-comparing the package manifest and runtime entrypoints with the selected
tarball. A source fix requires a new artifact and matching seed; never bypass
that check or reuse a previous artifact's passing verdict for changed source.

`STM_TEST_ACTIONS_ONLY=1` runs the compatibility tools, confirmed/refused reset,
and literal commands in a new session. Those real tool turns provide a history
anchor for V2 reset; the ordinary three-turn memory journey remains a separate
profile. Failed literal commands are retained, their dialog is dismissed, and
the remaining commands are attempted independently. Any failed case keeps the
overall profile failed. Long settings/log alerts can overflow a short viewport;
visible content alone does not establish usability of the complete output.

V2 prompt submission is bounded to 90 seconds. After a real Azure 429, the proxy
records that failure and rejects subsequent requests locally for that run, rather
than forwarding repeated calls against exhausted quota. Retry later in a fresh
run. Synthetic fault-profile responses are recorded separately. Package-only
acceptance limits installer HTTP concurrency; this setting must never be copied
to native host/TUI environments.
