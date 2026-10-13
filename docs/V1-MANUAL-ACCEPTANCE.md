# V1 Manual Acceptance

# Addendum — final paired V1/V2 STM qualification (2026-10-13)

The final paired qualification used the exact candidate
`/home/dev/workspace/opencode-work/stm-readiness-improvements/final-product-pack-2026-10-13-Le4ITRvN/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz`
with SHA256
`b4a4cf7ec856b9030f276a1f97a62c172754c624f656ad8f509ee3d1d9c2d9e1`.
The bytes are identical to the earlier qualified artifact. Consumer
`7OEy1C29` completed the paired run in `49.491s`; V1 run `v1-0Hdd64`
completed in `60.376s`; and V2 run `v2-RejHYR`
completed in `58.765s`. All functional, diagnostic, and cleanup gates passed.
This is a bounded qualification record for these exact bytes, not a
publication, registry, or final-release claim.

V1 used API-created setup/seed operations only where the acceptance fixture
requires them; no manual API action was used for the twelve functional cases.
The V1 result is model-mediated and synthetic at the result boundary, so it is
not human-TUI proof. The native task-tool, DCP, user-agent, model, and model
tools paths were exercised as applicable by the fixture. V2 covered all twelve
literal cases, including two repeated setup cases and two update cases. The
update cases verified both no-op skipping and a real committed summary.

Pending-delta compaction settled the delta before refresh. Its committed
timestamp was `commit.ts <= model-request.timestamp`, and the lifecycle
ordering was `enter < exit < request`. The exact summary delta contained the
actual durable seed user/assistant observed text. The summary persisted two
messages in one chunk, and the checkpoint fixture was persisted. The `show`
assertion remained explicitly existing-memory-only.

The paired diagnostic results were V1: 565 rows, zero errors, and zero
snapshot warnings; V2: 42 rows, four expected errors, zero unexpected errors,
zero parse failures, and zero residue. Cleanup was verified for both runs and
cost was zero. The offline parent result reported 985 tests and 4,301
assertions with type, build, and scan checks passing; the current repository
diff contains only approximately 500 lines of new runner scenarios and does
not change runtime product code.

The mutation audit was valid rather than a syntax-only or early-failure check:
the V1 native-summary mutation removed the summary provider call and was killed
by the persisted-memory assertion (`v1-EJWsKu`), and the V1 checkpoint no-op
mutation was killed by the exact checkpoint wait (`v1-ej1M30`). V2's active
`input.system.push` injection was removed and the follow-up SYSTEM assertion
killed the mutation (`v2-Z4K8Ry`); the actual compaction callback updater was
removed and the pending-delta/no-summary assertion killed it (`v2-0Nmclv`);
and a V2 reset no-op was killed by the reset dialog assertion after the initial
timestamp defect was corrected (`v2-6Nr9QB`). Three earlier wrong-site V1
mutations that were labelled V2 are explicitly adjudicated invalid and are not
counted as evidence or false passes. Mutation activation and native syntax
passed without relying on a fabricated early failure.

### Final paired qualification summary

| Component/Logic Block                | Current Findings/Hypothesis                                                                                                                                                                                                       | Implications                                                                                                                                   | Verification Status                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Exact candidate and paired consumers | The final tarball path and SHA256 above are byte-identical to the earlier artifact; consumer `7OEy1C29` ran V1 `v1-0Hdd64` and V2 `v2-RejHYR` with the recorded durations.                                                        | Results apply only to the identified unpublished RC4 bytes and bounded consumers.                                                              | PASS; no publication or new RC version claimed.            |
| V1 functional scope                  | All twelve cases passed with native task-tool/DCP and model-mediated fixture coverage; API setup/seed was allowed, but no manual API action was used for the cases.                                                               | This qualifies the bounded functional V1 path, not human-TUI interaction or unbounded model semantics.                                         | PASS; synthetic-result and human-TUI limitations explicit. |
| V2 functional scope                  | All twelve literal cases passed, including repeated setup, repeated update, no-op skip, real committed summary, reset, and pending-delta compaction.                                                                              | The tested V2 state transitions and persistence contracts are covered without claiming every registry or host variant.                         | PASS for the twelve bounded cases.                         |
| Compaction and timestamp ordering    | Settled pending delta refreshed and committed; summary delta used actual durable seed/observed text, persisted two messages in one chunk, and checkpoint state. `commit.ts <= model-request.timestamp`; `enter < exit < request`. | The recorded timestamp is bounded by the request and transition sequence, not replaced with wall-clock time.                                   | PASS in `v2-RejHYR`; source invariant corroborated below.  |
| Diagnostics and cleanup              | V1 retained 565 rows, zero errors, and zero snapshot warnings. V2 retained 42 rows, four expected errors, zero unexpected errors, zero parse failures, and zero residue. Both cleanups and zero cost were verified.               | Strict diagnostics and cleanup remain part of the qualification rather than a superficial functional pass.                                     | PASS for both paired runs.                                 |
| Mutation audit                       | Valid mutations were killed for V1 summary persistence, V1 checkpoint waiting, V2 SYSTEM injection, V2 compaction callback/update, and V2 reset. Invalid wrong-site V1/V2 labels are excluded.                                    | The assertions detect the targeted faults; syntax/native activation passes are not mistaken for behavioral evidence.                           | PASS; mutation IDs retained above.                         |
| Scope boundary and release state     | Real-model semantic quality, registry qualification, minimum-host coverage, unbounded variants, and literal human keyboard proof remain unclaimed.                                                                                | This record closes the completed bounded functional STM scope only; final release/publishing still requires separate product and release work. | PASS for stated scope; limitations remain explicit.        |

The parser and transition invariants were independently checked before choosing
the recorded ordering. V1 recovery requires the same session and operation,
an approved recovery event, no error, and a strictly later timestamp
(`nextTimestamp > timestamp`) in `scripts/v1-diagnostic-policy.ts:138-147`.
V2 shutdown and stream-disconnect exceptions require exact event fields and a
timestamp nondecreasing from `cleanupStartedAt`
(`scripts/v2-diagnostic-policy.ts:243-273`). Native deletion is dispatched
before configuration awaits so lifecycle generation invalidation precedes
outstanding work (`src/session-memory.ts:691-695`). The final record therefore
retains the bounded commit/request and enter/exit/request ordering rather than
inventing a replacement timestamp.

The full investigation artifact is
`/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-13--full-stm-acceptance.html`.
The prior top-level statements about V2 keyboard and pending-compaction gaps
remain historical records; this addendum supersedes them for the current
bounded table without rewriting dated failure history. No build, live tester,
or commit was run for this documentation-only update.

# Addendum — native V2 `/stm show` and `/stm logs` keyboard qualification (2026-10-13)

The bounded native V2 run `v2-A3XI0Q` completed in `55.829s`. Its retained
evidence is `/home/dev/workspace/stm-published-rc-e2e/v2-A3XI0Q/evidence.json`.
The run exercised all five literal keyboard routes now covered by this
iteration: `/stm status`, `/stm show`, `/stm ` (the trailing-space default
route), `/stm settings`, and `/stm logs`. The candidate, product version, and
release surface were unchanged; this record is an acceptance addendum, not a
publication or release claim.

The status, show, default, settings, and logs literals each rendered exactly
one expected result. The composer and prompt-history evidence preserved the
literal input and empty attachment arrays. The immediate pre-Enter and
baseline-dialog assertions were absent, and each route required one `Enter`.
No model calls, new session user text, or durable user transcript text were
created. Existing memory/checkpoint bytes were preserved.

The show result included the complete ordered sections, port, sentinel, and
the existing-memory-only condition. This evidence does not qualify show
behavior when memory is absent. The logs result was validated from the actual
rendered screen: it contained the production skip JSON event with the matching
session ID. A disk-only log-file observation was not accepted as rendered-log
evidence.

The retained run reports a clean strict diagnostic result: 37 valid STM rows,
four expected errors, and zero unexpected, missing, duplicate, or parse issues.
The process ID and socket were cleaned up, and cost was zero. The associated
offline report records 985 tests and 4,301 assertions, with type, format, and
gitleaks scanning clear; a parent-repository gitleaks report is not claimed by
this addendum.

### V2 show and logs qualification summary

| Component/Logic Block                 | Current Findings/Hypothesis                                                                                                                                                                   | Implications                                                                                                                             | Verification Status                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Five literal keyboard routes          | Status, show, trailing-space default, settings, and logs each rendered one expected result after literal input and one `Enter`; prompt history retained exact text and `pasted: []`.          | The evidence covers five bounded native routes, not blanket command-surface coverage.                                                    | PASS in `v2-A3XI0Q`; duration `55.829s`.                           |
| Show rendering and state preservation | Show rendered all ordered sections, the port, and sentinel against existing memory; checkpoint/memory bytes were unchanged.                                                                   | Existing-memory show is qualified without claiming absent-memory behavior or mutation semantics.                                         | PASS for existing memory only; absent-memory scope remains open.   |
| Logs rendering                        | The rendered screen contained the production skip JSON event and matching session ID; a log file alone was explicitly insufficient.                                                           | Logs acceptance proves visible session-scoped rendering rather than disk-only emission.                                                  | PASS in retained evidence.                                         |
| Prompt, dialog, and provider guards   | Baseline and immediate pre-Enter dialog checks were absent; each route used one Enter, with no model calls or new session user text.                                                          | The result is tied to settled native keyboard input and read-only behavior.                                                              | PASS; evidence retained at the path above.                         |
| Strict diagnostics and cleanup        | Evidence retained 37 valid rows, four expected errors, zero unexpected/missing/duplicate/parse issues, and clean PID/socket teardown.                                                         | The five-route result did not weaken strict diagnostics or cleanup expectations.                                                         | PASS; cost `0`.                                                    |
| Offline checks and remaining scope    | `985` tests and `4,301` assertions passed with type, format, and gitleaks scanning; setup, reset, update, absent-memory show, pending-delta compaction, and semantic quality remain separate. | This closes only the exercised five-route keyboard scope and does not claim parent-repository gitleaks or the remaining functional gaps. | PASS for reported offline checks; remaining scope explicitly open. |

The actual evidence record is retained at
`/home/dev/workspace/stm-published-rc-e2e/v2-A3XI0Q/evidence.json`. The
investigation artifact is
`/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-13--v2-keyboard-show-logs.html`.
No build, live tester, or commit was run for this documentation-only update.

# Addendum — native V2 literal keyboard command requalification (2026-10-13)

The latest bounded native V2 run `v2-MFJkkP` completed in `63.292s`. Its
retained evidence is `/home/dev/workspace/stm-published-rc-e2e/v2-MFJkkP/evidence.json`.
The run used the unchanged candidate and preserved the existing product and
policy surface. The strict functional diagnostic was clean: 37 valid STM rows,
four expected failures, and zero unknown, missing, or duplicate rows. This
record reports the actual five-run history for this iteration; it does not
claim a larger total run count. An earlier code-first attempt failed during
compilation and produced no execution result.

The run exercised literal tmux input followed by one `Enter` for `/stm status`,
`/stm ` (the trailing-space default route), and `/stm settings`. Each command
rendered the expected native dialog or status output. The captured composer
text and exact prompt-history JSON record confirm the submitted literals,
including the default route's trailing space; each accepted command added one
history entry with an empty `pasted` array. The immediate pre-Enter screen
assertion found no stale STM dialog, and the baseline dialog assertion also
passed. No provider/model calls occurred, no durable user transcript text was
created, and memory and checkpoint bytes were unchanged.

This closes only the three exercised literal keyboard routes. The existing
keyboard gap for `/stm show` and `/stm logs` remains open, and `setup`/`reset`
remain unconfirmed through the literal keyboard route. The existing API-based
coverage for `show`, `logs`, `update`, `setup`, and `reset` is not rewritten as
keyboard acceptance. Pending-delta compaction after the confirmed route and
semantic-quality evaluation remain separate gaps. The product and policy
surface remain unchanged.

### Literal keyboard requalification summary

| Component/Logic Block                | Current Findings/Hypothesis                                                                                                                                                                                                                                                                                            | Implications                                                                                                                                              | Verification Status                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Native literal routes                | `/stm status`, `/stm `, and `/stm settings` were typed through the native tmux composer and submitted with `Enter`; the expected status/settings output rendered.                                                                                                                                                      | These three routes have bounded literal-input evidence, not blanket command-surface coverage.                                                             | PASS in `v2-MFJkkP`; duration `63.292s`.                                |
| Prompt and stale-dialog guards       | The composer captured the exact command text, including the default route's trailing space; each route added one exact prompt-history record with `pasted: []`. Baseline and immediate pre-Enter dialog checks were absent/false.                                                                                      | The acceptance result is tied to real prompt input and a settled composer, rather than API command submission or a stale dialog.                          | PASS; evidence retained at the path above.                              |
| Durable state and provider isolation | Every accepted keyboard command produced an empty user-history delta, empty attachment data, no model/provider invocation, and unchanged memory/checkpoint bytes.                                                                                                                                                      | Read-only keyboard commands did not create durable user text, invoke inference, or mutate the memory checkpoint.                                          | PASS for the three exercised routes.                                    |
| Strict diagnostics                   | The run retained 37 valid STM rows, four expected failures, and zero unknown, missing, or duplicate rows.                                                                                                                                                                                                              | The literal-input result did not require weakening the strict diagnostic policy.                                                                          | PASS; no unrelated host allowance was added.                            |
| Dispatch and timestamp ordering      | Native lifecycle dispatch still invalidates deletion generation before awaiting configuration (`src/session-memory.ts:691-695`). The V2 shutdown and stream-disconnect exceptions require event timestamps `>= cleanupStartedAt` (`scripts/v2-diagnostic-policy.ts:243-273`); no replacement timestamp was introduced. | This documentation record preserves transition ordering and the recorded cleanup boundary rather than inferring ownership from wall-clock or span values. | Source inspection confirms the invariant; no product transition change. |
| Remaining keyboard scope             | `/stm show` and `/stm logs` were not literal-keyboard qualified; `setup` and `reset` remain unconfirmed through that route. Existing API coverage remains separately documented.                                                                                                                                       | Full keyboard acceptance is still open, as are pending-delta compaction and semantic-quality checks.                                                      | OPEN; intentionally not claimed.                                        |

The retained failed attempts are `iA8bsm` (whole-screen baseline false),
`omC8VM` (prompt schema used `input` instead of `text`), `HX9aUC` (incorrect
default ordered lines), and `DRvYwv` (passed before the stale-dialog guard was
added). `MFJkkP` is the final passing record. No live or build command was run
for this documentation-only update.

Investigation artifact:
`/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-12--v2-keyboard-commands.html`

# Addendum — V2 same-run lifecycle and keyboard requalification (2026-10-12)

The bounded native V2 run `v2-MP3rIR` completed in `50.135s` against the
unchanged candidate SHA256
`b4a4cf7ec856b9030f276a1f97a62c172754c624f656ad8f509ee3d1d9c2d9e1`.
Its actual evidence is retained at
`/home/dev/workspace/opencode-work/stm-published-rc-e2e/v2-MP3rIR/evidence.json`.
All 72 packaged artifact files matched. The functional and strict diagnostic
gates passed with 37 valid STM rows, four expected STM failures, and zero
unknown, missing, or duplicate STM rows. The two expected host entries were
the local-file update-check warning and the final-shutdown interrupt only.
No product, policy, host-runtime, or publication bytes changed for this
qualification.

The run also exercised the actual keyboard route boundary without an
intermediate respawn. `Escape` was sent after a 200 ms settling interval;
`Ctrl-P` was sent ten times; the observed command was session switching, the
Sessions dialog opened, and the exact reset-boundary title route was reached.
The pane PID remained `261200` before and after the route, so this is evidence
of one wrapper/TUI run and not proof of an inner CLI identity. Host logs show
one same-run TUI lifecycle with no intermediate startup. The pre-existing
`/stm` command API gap remains, so this record does not claim full keyboard
acceptance. The failed attempts `EUtHH`, `twBhCx`, and the passing
`MP3rIR` record remain preserved; the `Ctrl-P` failure in `twBhCx` is retained
as an ambiguity/failure record rather than rewritten.

### Same-run lifecycle summary

| Component/Logic Block             | Current Findings/Hypothesis                                                                                                                                                                                | Implications                                                                                                                                                                                                                | Verification Status                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Strict diagnostics                | `v2-MP3rIR` retained 37 valid rows and four expected failures; all STM completeness and uniqueness counts were clean. Only the local-file warning and final-shutdown interrupt were expected host entries. | The strict diagnostic policy remains fail-closed; no broad interruption allowance was added.                                                                                                                                | PASS in the retained evidence; run duration `50.135s`.                                                                                |
| Keyboard route and reset boundary | Escape settling followed by ten raw `Ctrl-P` inputs reached the session switch command, Sessions dialog, and exact reset-boundary title route without an intermediate respawn.                             | The observed route is bounded evidence for one native TUI run, not a universal keyboard or inner-process identity claim.                                                                                                    | PASS for the exercised route; full keyboard acceptance remains open because `/stm` commands are still an API gap.                     |
| Dispatch and transition ordering  | The dispatcher source says deletion is dispatched before any config await so generation invalidation precedes outstanding work.                                                                            | Lifecycle evidence must follow the transition boundary; nearby wall-clock values or `http.span` values are not ownership identifiers and were not used as such.                                                             | Source inspection: `src/session-memory.ts:691-695`; no runtime transition change.                                                     |
| Timestamp invariant               | V1 recovery requires `nextTimestamp > timestamp`; V2 shutdown and stream-disconnect exceptions require `timestamp(entry) >= cleanupStartedAt`.                                                             | The accepted value is the recorded cleanup boundary (or a later event), never a fabricated wall-clock replacement; the intermediate interruption remains outside the final-shutdown allowance unless explicitly correlated. | Source inspection: `scripts/v1-diagnostic-policy.ts:138-147` and `scripts/v2-diagnostic-policy.ts:243-273`; no timestamp replacement. |
| Cleanup and scope                 | Host PIDs `261169` and the socket were gone after shutdown. Cost was `0`; the product hash and all 72 artifact hashes remained unchanged.                                                                  | Cleanup evidence supports this bounded run only and does not establish universal host cleanup.                                                                                                                              | PASS for the retained run; no build/live command run for this documentation-only update.                                              |

The run therefore closes the specific intermediate-respawn/lifecycle ambiguity
for the exercised route without weakening strict diagnostics. It does not
establish a full literal-keyboard acceptance claim, an inner-CLI identity
claim, or an `/stm` API implementation. The evidence path and prior failed
attempts are retained as historical records.

Investigation artifact:
`/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-12--v2-stream-lifecycle.html`

# Addendum — strict V2 diagnostic requalification (2026-10-12)

The V2 diagnostic policy was tested against 47 focused cases in the pure
`scripts/v2-diagnostic-policy.ts`/runner strict-gate path. The cases cover
malformed rows, unknown errors, duplicate expected failures, exact four-field
session fixtures, narrow host-exception timing, and the distinction between a
functional PASS and an acceptance-clean diagnostic verdict. This addendum
records the diagnostic result; it does not claim a new product build, release,
publication, or product fix.

Two bounded runs against the unchanged unpublished RC4 candidate were
recorded. `v2-Wyj3Bi` failed after `72.729s` because the settings ordering was
wrong; after that harness correction, the transport disconnection observed
`7ms` after cleanup matched the exact post-cleanup allowance. `v2-6fe3jJ`
completed in `71.652s`: the functional gate and full stage passed, but the
strict diagnostic gate failed. It retained 37 valid rows and four expected
failures, with zero missing, zero unknown STM rows, one unknown host entry, and
no duplicate. The later `474` span (`1307` after cleanup) and the local
candidate-update warning matched their exact allowed classifications; those
observations do not authorize unrelated interruptions.

### Strict-gate summary

| Component/Logic Block         | Current Findings/Hypothesis                                                                                                                                                                                                                                                                                                                                                              | Implications                                                                                                                                                                                                                                                                                                          | Verification Status                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Focused policy suite          | 47 focused cases exercise malformed rows, unknown errors, duplicate expected failures, exact four-field/session matching, and narrow host-exception timing.                                                                                                                                                                                                                              | Expected failures must match their phase, session, event, and declared fields; malformed or unrelated diagnostics remain failures.                                                                                                                                                                                    | PASS for the 47 focused cases; no fabricated overall-suite count is claimed.      |
| `v2-6fe3jJ` verdict           | The functional and full-stage gates passed, but strict diagnostics found 37 valid rows, four expected failures, zero missing, zero unknown STM rows, one unknown host entry, and no duplicate.                                                                                                                                                                                           | Functional PASS does not overrule an uncorrelated host diagnostic. The run remains diagnostic FAIL.                                                                                                                                                                                                                   | FAIL, intentionally retained as the current strict-gate result after `71.652s`.   |
| Pre-cleanup host interruption | `host-0.log:372` contains an INFO `InterruptError` on `GET /api/event` at `03:54:33.728Z`; cleanup began at `03:54:36.049Z`.                                                                                                                                                                                                                                                             | The event is before cleanup and is not the exact allowed post-cleanup shutdown interruption. It is not confirmed as a product bug, but it cannot be suppressed by a blanket interruption rule.                                                                                                                        | Strict FAIL is justified; root cause remains unconfirmed.                         |
| Timestamp invariant           | `scripts/v1-diagnostic-policy.ts:138-147` requires a recovered event to have the same session/operation and a strictly later timestamp (`nextTimestamp > timestamp`). `scripts/v2-diagnostic-policy.ts:243-273` allows the exact shutdown interrupt or transport disconnect only when its timestamp is nondecreasing from the cleanup boundary (`timestamp(entry) >= cleanupStartedAt`). | The accepted boundary is the recorded cleanup start, not wall-clock substitution or a fabricated event timestamp. The pre-cleanup `03:54:33.728Z` event cannot be reclassified; a post-cleanup event such as the observed `03:54:36.049Z`-plus span can satisfy the narrow boundary only when all other fields match. | Source inspection confirms the ordering rules; no timestamp replacement was made. |
| Dispatch/transition ordering  | `src/session-memory.ts:691-695` states that native deletion is dispatched before any config await so the generation is invalidated before outstanding work can commit.                                                                                                                                                                                                                   | Diagnostic timing must preserve lifecycle ordering rather than infer recovery from a later unrelated success.                                                                                                                                                                                                         | Source-bounded; no product transition change was made.                            |
| Candidate and scope           | Candidate `b4a4cf...` and the existing artifact inventory are unchanged; the actual inventory remains 72 artifact files and 11 manual passes.                                                                                                                                                                                                                                            | Results remain bounded to the same unpublished bytes and do not constitute a release qualification.                                                                                                                                                                                                                   | Retained unchanged; no new product fix or release claim.                          |

The unresolved line is therefore retained as evidence of the stricter gate,
not rewritten as a clean result. A future correction must add request/closure
correlation for the specific host stream; it must not allow all
`InterruptError` entries. The existing V2 PASS history remains historical
evidence and is not lost, but its scope is now explicitly narrower because the
strict gate exposes this residual diagnostic case.

Investigation artifact:
`/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-10--v2-diagnostic-policy.html`

# Addendum — V2 same-artifact requalification (2026-10-10)

The exact DCP-fixed candidate was requalified by the bounded native V2 run
`v2-w8xIbL`, which completed in `62.741s` with all 72 evidence files matching
SHA256
`b4a4cf7ec856b9030f276a1f97a62c172754c624f656ad8f509ee3d1d9c2d9e1`.
Evidence is retained at
`/home/dev/workspace/opencode-work/stm-published-rc-e2e/v2-w8xIbL/evidence.json`.
The run passed the 11 documented manual cases, including default-off,
override, retry fallback, child, reset, and compaction scenarios. The prior
`v2-or4cov` installation timeout (`100.692s`) remains preserved as historical
evidence; this isolated rerun used the same bounds without a seeded cache.

The run recorded one expected host warning for the unsupported local-file
update checker (`NpmInstallFailedError`) and two expected shutdown interrupt
errors. These are not treated as a blanket error-free claim. Cleanup completed
with the child PID dead and the tmux socket removed; cost was zero and the
global budget was unchanged. This addendum closes only the V2 installation and
same-artifact requalification gap. It does not claim the strict whole-warning
gate, pending-delta compaction (not run), minimum-host or universal cleanup
support, semantic or registry qualification, or literal keyboard interaction.

Investigation artifact:
`/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-10--v2-dcp-artifact-requalification.html`

# Addendum — native DCP metadata closure (2026-10-10)

The current bounded native DCP run `v1-2nieQM` completed in `67.709s` with
functional, diagnostic, and clean gates passing. Evidence is retained at
`/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-2nieQM/evidence.json`.
The tested unpublished candidate is
`/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-10--dcp-rebuilt-candidate-H7TpDARz/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz`
with SHA256
`b4a4cf7ec856b9030f276a1f97a62c172754c624f656ad8f509ee3d1d9c2d9e1`.
These results apply only to those bytes; this is not a publication or registry
release claim.

The native compress operation was the tool message `call_stm_dcp_compress_1`.
Its output reported `Compressed 2 messages`; the source XML contained the
actual message IDs `m0001` and `m0002`, rather than inferred fixture IDs. The
durable tool input matched that operation. The immediate bridge path and the
replay completion were both recorded. After compression, the `MEMORY` user
message preserved `stm-dcp-parent`, the isolated deterministic tool context,
and `toolsedit=true`; no `bash` tool was introduced.

### Current DCP-closure summary

| Component/Logic Block                 | Current Findings/Hypothesis                                                                                                                                                                                                                                                                              | Implications                                                                                                                                                                                                                | Verification Status                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Native DCP operation identity         | The installed native host exercised `call_stm_dcp_compress_1`; its compressed source was exactly `m0001` and `m0002`, and the durable input matched the native operation.                                                                                                                                | The closure is bounded to an actual installed DCP operation and its recorded message identity, not a synthetic compress event or inferred message set.                                                                      | PASS in `v1-2nieQM`; evidence path above.                                                                            |
| Origin, owner, and alias context      | DCP origin state is bounded to 16 cached origin-user contexts, 16 assistant-owner mappings, and 16 origin aliases. The completed tool's native `part.messageID` is the owner key; the owner resolves to the canonical origin user and its execution metadata.                                            | Metadata follows the originating user/assistant ownership chain instead of the latest unrelated default context.                                                                                                            | Source-bounded by `src/session-state.ts:3-13,35-43,98-139` and `src/session-memory.ts:768-778`; native closure PASS. |
| Pending-generation validity           | The pending DCP record captures the current lifecycle generation and an identity. Delivery first rejects terminal or non-current generations, then requires the pending identity, latest origin user, and cached execution-metadata object to remain unchanged before and during no-reply delivery.      | A stale or newer-turn pending record cannot reinject old metadata. The timestamp is only the debounce/identity fallback (`Date.now()`); lifecycle generation and identity are the ordering guards, not wall-clock ordering. | Source-bounded by `src/session-memory.ts:426-498,758-778`; current native closure PASS.                              |
| Missing, stale, or newer-turn context | Missing owner/metadata or an origin user different from `latestOriginUserID` logs `dcp_origin_context_skipped` and clears only the matching pending DCP state. A generation or identity mismatch similarly abandons that delivery.                                                                       | DCP reinjection fails closed without borrowing another agent's metadata, while ordinary memory updates remain permitted; skipping reinjection is not a session-wide update ban.                                             | Guard behavior verified from source; native run recorded immediate bridge and replay completion.                     |
| Native post-compress memory           | The post-compress `MEMORY` user message retained `stm-dcp-parent`, isolated deterministic tools, and `toolsedit=true`, with `bash=false`.                                                                                                                                                                | The observed native path preserves the intended parent/tool context after compression.                                                                                                                                      | PASS in retained native evidence; no broader semantic-model claim.                                                   |
| Offline and coverage boundary         | The candidate reported `938` tests and `4,221` assertions passing in `31.74s`; type, format, and scan checks were clear. Remaining gates are literal keyboard interaction, real-model semantics, minimum-host support, registry release identity, cache eviction, and additional DCP operation variants. | This addendum closes the exercised DCP metadata path only; it does not claim the remaining interaction, compatibility, release, eviction, or operation-variant gates.                                                       | PASS for reported offline checks; remaining gates explicitly open.                                                   |

The seven recorded native attempts remain factual history: `rz5BId` invalid
configuration, `1FM6dH` queued assertion, `SZNapA` immediate-wait failure,
`jWpUf8` distributed aliases, `0o3nF5` pre-existing timestamp,
`oxf21r` wrong polling subset, and the current `v1-2nieQM` pass. The earlier
failed or queued harness records are not independent live qualifications and
are not rewritten as such. The candidate metadata is a different RC4 artifact
from earlier records.

### Exact source and evidence references

- Evidence: `/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-2nieQM/evidence.json`
- Candidate: `/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-10--dcp-rebuilt-candidate-H7TpDARz/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz`
- Candidate SHA256: `b4a4cf7ec856b9030f276a1f97a62c172754c624f656ad8f509ee3d1d9c2d9e1`
- Investigation artifact: `/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-10--v1-dcp-metadata.html`
- DCP state/cache source: `src/session-state.ts:3-13,35-43,74-139`
- DCP capture source: `src/session-memory.ts:426-498,737-789`

## Addendum — fail-closed diagnostic policy (2026-10-10)

The bounded native V1 run `v1-74XMSf` completed in `65.734s` against the same
unpublished product hash `fa539f3684d0edeb91c1a50aab0cce3c4a63689d4ca4df5f27267cb1d16b39f8`.
Evidence is retained at
`/home/dev/workspace/stm-published-rc-e2e/v1-74XMSf/evidence.json`. No product
bytes changed and no new release or publication claim is made. The run
retained `421` valid rows with `parseIssues: []` and `finalTail: null`; host,
STM, and snapshot error counts were zero, and the three expected unsecured
warnings remained the only residue. The native actual-task child path passed,
and all observed child PIDs (`161773`, `161907`, and `162257`) were absent after
SIGINT.

### Current diagnostic-policy summary

| Component/Logic Block    | Current Findings/Hypothesis                                                                                                                                                                                              | Implications                                                                                                                          | Verification Status                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Complete diagnostic rows | Malformed, nonobject, and invalid-known-field complete records now fail closed. Public issues retain phase, line, length, and hash metadata without raw source text.                                                     | A malformed complete record cannot disappear while the run is declared clean, and reports do not echo potentially sensitive payloads. | PASS in 25 focused policy cases and the native run; `parseIssues` was empty for the clean evidence stream. |
| Unterminated tails       | A final unterminated tail fails closed, while an interim tail may be settled by a later complete identical-prefix record.                                                                                                | Snapshot timing does not create a permanent false failure, but final incomplete evidence remains a failure condition.                 | PASS in the focused policy cases; native evidence ended with `finalTail: null`.                            |
| Error and warning policy | Collector and host-error handling, snapshot pairing, explicit identity recovery, and false-positive filters are covered by the pure policy tests. Recovery is not inferred from an unrelated later success.              | Verdicts remain conservative and scoped to the same explicit operation/session identity.                                              | PASS in 25 focused cases; source wiring and collector behavior exercised by the bounded run.               |
| Offline validation       | The TypeScript suite passed `933` tests with `4,209` assertions in `31.59s`; type and format checks passed.                                                                                                              | The policy change is independently tested without claiming a new product build.                                                       | PASS; no build was run for this documentation-only update.                                                 |
| Coverage boundary        | DCP no-reply metadata, literal keyboard interaction, and real-model semantic quality remain open. The corruption fixtures validate pure policy and source wiring, not a deliberately mutated native end-to-end artifact. | This record closes the parser/privacy/verdict-policy gap only; it does not broaden interaction or model-quality claims.               | Explicitly open and not claimed as native coverage.                                                        |

The diagnostic-policy gap is therefore closed for the documented parser,
privacy, and conservative-verdict behavior. The historical records below are
preserved, including older dated statements that described malformed rows as a
gap at the time they were written; those statements are not retroactively
rewritten.

## Addendum — native task-tool gap closure (2026-10-10)

The current bounded native V1 run `v1-ZC68GX` completed in `49.545s` with the
functional, diagnostic, and clean gates passing. Its retained evidence is
`/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-ZC68GX/evidence.json`.
The tested unpublished candidate is
`/home/dev/workspace/opencode-work/stm-readiness-improvements/taskscriptfixed-pack-2026-10-10-9Ncp1SJP/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz`
with SHA256
`fa539f3684d0edeb91c1a50aab0cce3c4a63689d4ca4df5f27267cb1d16b39f8`.
These results apply only to those bytes; no new version, publication, or
release claim is made.

### Current gap-closure summary

| Component/Logic Block            | Current Findings/Hypothesis                                                                                                                                                                                                                                                                                       | Implications                                                                                                                                                            | Verification Status                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Native task-tool call            | The run exercised a streamed native task call (`call_stm_probe_child_1`), not an API-created synthetic child. The durable task portion recorded child/parent linkage and a SYSTEM prompt.                                                                                                                         | This closes the previously unexercised task-tool creation path for the bounded scenario, while retaining the distinction from literal TUI or model-semantic acceptance. | PASS in the retained run; evidence path above.                                                                             |
| Durable-task checkpoint boundary | The child produced no child checkpoint or summary, while the parent checkpoint advanced as expected.                                                                                                                                                                                                              | The observed child boundary and parent advancement are documented without inferring a child result that was not emitted.                                                | PASS for the exercised native task scenario.                                                                               |
| No-reply metadata                | The earlier V1 no-reply path omitted the selected agent. The corrected run now snapshots the native custom agent, model, and tools metadata; raw internal IDs and SYSTEM payloads are intentionally not reproduced here.                                                                                          | Native metadata preservation is demonstrated without turning implementation identifiers or system content into acceptance claims.                                       | PASS for the corrected path; malformed diagnostic rows and literal keyboard/realtime semantic checks remain separate gaps. |
| Offline validation               | `908` local tests covering `4,142` assertions passed in `32s`; type and format scans also passed.                                                                                                                                                                                                                 | The documentation update is backed by the reported offline validation, but this addendum does not claim a new build or live run.                                        | PASS as reported; no build or live command was run for this documentation-only change.                                     |
| Harness history                  | Seven native harness runs were used in this iteration. Earlier runs exposed permission ordering (`tInAge`), persisted global allow state (`iKHuVn`/`bwhMMr`), product-agent loss (`y4KmYK`), a stale manual baseline (`zVRYVb`), and a false nested-log summary classification (`QxJkNJ`) before the current run. | Prior failures remain disclosed as harness-fix history; they are not rewritten as product failures or erased by the current PASS.                                       | Historical failures retained; current run PASS.                                                                            |

The native task call therefore closes the specific task-tool creation and
metadata-preservation gap exercised here. A no-reply DCP path whose metadata
remains absent is still an open gap, as are malformed diagnostic-row policy,
literal keyboard interaction, and real semantic-result verification. The
existing failure records below remain unchanged.

### Exact current evidence references

- Evidence: `/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-ZC68GX/evidence.json`
- Candidate: `/home/dev/workspace/opencode-work/stm-readiness-improvements/taskscriptfixed-pack-2026-10-10-9Ncp1SJP/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz`
- Candidate SHA256: `fa539f3684d0edeb91c1a50aab0cce3c4a63689d4ca4df5f27267cb1d16b39f8`
- Investigation artifact: `/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-10--v1-gap-closure.html`

## Current acceptance record — 2026-10-10

The current unpublished RC4 candidate is:

```text
/home/dev/workspace/opencode-work/stm-readiness-improvements/v1-candidate-gates-2026-10-10-ZN7rtJjg/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz
SHA256: f6b8d3de15b1631b8c37d99d4c0f07c9fb3ca3b987133f4f4537e892fff84ac0
```

These bytes are a different, unpublished RC4 candidate. The bounded V1 run
`v1-9hiCZ6` completed in `51.351s` with all three runner gates passing:
functional, diagnostic, and clean. Evidence is retained at
`/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-9hiCZ6/evidence.json`.
The run retained 352 unique rows. Snapshot accounting observed 375 final rows;
the final count may include duplicate rows before union de-duplication.
Startup/setup accounting was `1` startup, `24` rows before, `24` after, `25`
child rows, `175` manual rows, `176/177` manual-final rows, and `375` final
rows. All observed values were below the `300`-row and `20,000`-row caps.

The run recorded zero host errors, snapshot warnings, STM errors, or temporary
residue. It recorded three expected unsecured warnings for the isolated
loopback setup. Graceful SIGINT completed all three shutdowns successfully.
The prior new-gate run `v1-vDTUZm` remains historical failure evidence
(`69.120s`); its dependency symlink false positive was corrected, and its
record was not rewritten.

### Current summary table

| Component/Logic Block    | Current Findings/Hypothesis                                                                                                                                                                                                                                                                                | Implications                                                                                                                     | Verification Status                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Candidate and host       | The candidate above is an unpublished RC4 artifact with SHA256 `f6b8d3de15b1631b8c37d99d4c0f07c9fb3ca3b987133f4f4537e892fff84ac0`.                                                                                                                                                                         | Results apply only to these bytes; no release or registry qualification is claimed.                                              | PASS for artifact identity; unpublished/no-release status preserved.                        |
| V1 runner gates          | `v1-9hiCZ6` completed in `51.351s`; functional, diagnostic, and clean gates all passed.                                                                                                                                                                                                                    | The current bounded run is acceptance-clean within the runner's declared scope.                                                  | PASS.                                                                                       |
| Retention and caps       | 352 unique retained rows were observed; snapshot accounting reached 375 final rows, with possible duplicate pre-union entries. Startup/setup and phase counts were `1/24/24/25/175/176/177/375`; all were below the `300` and `20,000` caps.                                                               | Count interpretation must distinguish raw snapshot accounting from unique retained rows.                                         | PASS; duplicate-union qualification recorded.                                               |
| Diagnostics and shutdown | There were zero host errors, snapshot warnings, STM errors, or residue. Three unsecured warnings were expected. All three graceful SIGINT shutdowns exited successfully.                                                                                                                                   | The clean gate is supported without treating expected unsecured warnings as failures.                                            | PASS.                                                                                       |
| Snapshot staging         | The exact cause of the earlier warnings was adjacent temporary files disappearing between Git enumeration and staging: atomic STM writes create the temporary path and then rename it away. The correction ignores only the transient directory metadata, not the repository root or arbitrary user files. | Snapshot behavior remains enabled and metadata remains observable; no blanket root ignore was introduced.                        | Previous warning cause reproduced and correction accepted in the current run.               |
| Snapshot retention phase | Snapshot retention reached its explicit cap. Malformed JSON is currently ignored by the retention path.                                                                                                                                                                                                    | The run does not establish strict malformed-JSON parsing or a stronger retention semantic than the declared cap.                 | PASS for the exercised bounded gate; strict-parse behavior remains a documented limitation. |
| Coverage boundaries      | Offline `907` tests and strict TypeScript build passed. V2 used the same artifact (`a8a6c846-2207-47f1-acb6-7fb4af40f0ba`) for `51.021s` and retained 72 artifact files. No unit-classification fixture exists yet; task-tool/keyboard/semantic claims and arbitrary-user temp cleanup are not asserted.   | V1/V2 results remain bounded evidence rather than claims of literal interaction, model-mediated semantics, or universal cleanup. | PASS for exercised scope; separate fixture and interaction gaps remain.                     |

### Exact recorded reproduction

```bash
/usr/bin/timeout --kill-after=5s 350s /home/dev/.bun/bin/bun scripts/published-v1-e2e.ts /home/dev/workspace/opencode-work/stm-readiness-improvements/v1-candidate-gates-2026-10-10-ZN7rtJjg/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz
```

The current evidence path is
`/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-9hiCZ6/evidence.json`.
The corresponding run directory is
`/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-9hiCZ6/`.
The V2 evidence run identifier is `a8a6c846-2207-47f1-acb6-7fb4af40f0ba`.
The current acceptance artifact is
`/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-10--v1-clean-acceptance.html`.

No new version release, commit, or publication was performed. The preceding
`v1-80zJZR` record below is retained unchanged as historical failure evidence.

Recorded **2026-10-09** from one isolated V1 manual audit run. This document
records the run and its evidence boundaries; it does not change or reclassify
the existing source/test bugfixes.

## Summary Table

| Component/Logic Block          | Current Findings/Hypothesis                                                                                                                                                                                                                                                                                                                                                                                                                    | Implications                                                                                                                                                 | Verification Status                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate and host             | The fixed-runtime candidate is `/home/dev/workspace/opencode-work/stm-readiness-improvements/fixedruntime-unpublished-pack-2026-10-09-m2eUAQK1/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz`, SHA256 `f56cddc52c86bc274aa558d5344e2b474bc4da285ea73b072b726181b5a4f95f`. It ran on host V1 `1.14.25`; its bytes differ from the released/prepared RC4 candidate digest `1d99e9968faac8af1cfa58d5816fd8b6f0e32251d04174efa76b9398e29a0646`. | Results apply to the fixed unpublished bytes only; registry qualification is not claimed.                                                                    | PASS for artifact identity; publication/relabel: NOT CLAIMED.                                                                             |
| Isolated V1 workflow           | Run `v1-80zJZR` completed in `44.930s`: 44 HTTP 200 responses and five external install/host commands exited 0. It made 20 local provider requests and three summaries. The initial-prompt-to-follow-up interval was 360 ms; the memory-observation-to-follow-up interval was 0 ms. Main checkpoints were verified.                                                                                                                            | Functional workflow behavior passed at zero inference cost.                                                                                                  | Runner functional PASS.                                                                                                                   |
| Manual command/setup gates     | Setup refusal, creation and no-overwrite checks passed. The external install/host command count is five; `manualUsage` contains additional manual cases and is not being reduced to five commands.                                                                                                                                                                                                                                             | The command surface and setup idempotence are covered for this run.                                                                                          | PASS.                                                                                                                                     |
| Child-session behavior         | The API-created native child used `POST /session` with `parentID`, issued a SYSTEM snapshot request, produced no child summary or checkpoint, and left the parent unchanged.                                                                                                                                                                                                                                                                   | This verifies the exercised API-child snapshot/skip boundary, but not task-tool-created child creation or literal keyboard interaction.                      | PASS for the exercised native API-child case; coverage remains bounded.                                                                   |
| Retained STM log               | Retained STM lines `13:42:51.177` through `13:42:55.087` contain no errors or toasts. The retained file is a finite tail, not the entire run.                                                                                                                                                                                                                                                                                                  | No whole-run error-free claim is justified from this log alone.                                                                                              | PASS for inspected tail; whole-run log coverage incomplete.                                                                               |
| Host diagnostics and cleanup   | There are nine snapshot warnings total: one `side-sessions.json.tmp` path warning plus eight `session-memory.log.tmp` path warnings; each was accompanied by a failed-to-add-snapshot-files message. Separately, one log temporary file remained. No actual host `ERROR` or non-2xx response was observed. Three unsecured warnings are expected for the isolated loopback setup.                                                              | Snapshot warnings and temporary residue require classification; residue after SIGKILL is not, by itself, proof of a product crash, wrong data or corruption. | Runner PASS; auditor acceptance-clean gate FAIL.                                                                                          |
| Historical regression coverage | Prior `v1-Gpt35C` retained history-error/toast evidence and did not inspect a native child. The missing-hooks unit directly called lifecycle behavior instead of exercising the generic native event path; the earlier manual run did not check the native child. The current runner records three forbidden events across the shared-core and child phase, using `coreLogBefore` as the baseline; it is not a complete whole-log assertion.   | Earlier PASS results missed the native-child issue and whole-run retained-log errors; they should not be silently diagnosed as the current run’s failure.    | Gap and reason confirmed from retained history and runner scope; prior failed ID/temp identity is not available for a stronger diagnosis. |

## Exact Recorded Reproduction

The single bounded run was recorded as:

```bash
/usr/bin/timeout --kill-after=5s 350s /home/dev/.bun/bin/bun scripts/published-v1-e2e.ts /home/dev/workspace/opencode-work/stm-readiness-improvements/fixedruntime-unpublished-pack-2026-10-09-m2eUAQK1/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz
```

Run identifier: `v1-80zJZR`. Evidence is retained at
`/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-80zJZR/evidence.json`.
The corresponding retained files are under the full run root
`/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-80zJZR/`:
`stm.log` and `serve.log`. The relevant references are `serve.log:456-457`
and the actual snapshot paths at `serve.log:1623-1629`; these are not
`evidence.json` line references. No second run, build, source/test change, or
publication was performed for this document. The fixed-runtime artifact differs from the
released/prepared RC4 candidate digest `1d99e9968faac8af1cfa58d5816fd8b6f0e32251d04174efa76b9398e29a0646`;
registry qualification is not claimed here.

## Evidence Interpretation

The runner is **functional PASS**, not **acceptance-clean**. The audit
conclusion is FAIL for the warning/cleanup gate because the host log recorded
nine snapshot path warnings and temporary-file residue, even though the run
had no observed host `ERROR`, no non-2xx response, and the required functional
checks passed. This is an auditor classification, not a rewrite of the
runner's exit verdict. The warnings should be classified against the actual
snapshot-staging lines before treating them as a product defect. A safe atomic
shutdown observation is needed before making a stronger cleanup claim.

The STM log retained only a finite tail (`13:42:51.177-13:42:55.087`); its lack
of errors/toasts cannot disprove earlier-run errors. Likewise,
`historicalErrors[]` covers only a finite pre-restart window. The prior
`v1-Gpt35C` history-error/toast result therefore explains why an earlier
functional PASS did not establish error-free acceptance, while the absence of
a native child explains the earlier child-coverage gap. It does not establish
the cause of the prior failed ID/temp identity.

The native child case is narrower than full child coverage: this run exercised
an API-created native child, but not task-tool-created child creation. The
original missing-hooks unit directly called lifecycle behavior rather than the
generic native event path, and the existing manual run did not inspect native
child behavior. The current runner's three forbidden events cover the
shared-core and child phase, with `coreLogBefore` as the baseline; they are not
a complete whole-log assertion. The manual flow
also does not constitute literal TUI keyboard acceptance, a model-mediated
semantic result, or an acknowledgement of a real model response; its provider
traffic is the deterministic isolated scenario.

## Remaining Bounded Gates

1. **Acceptance owner — retained evidence:** preserve whole-run STM/host logs
   and classify errors by phase, snapshot attempt, retry and shutdown. Expected
   refusals/skips may remain allowed; transient retry errors must not be made a
   blanket failure without classification. Acceptance requires complete
   retained evidence and an explicit error policy.
2. **Runtime/cleanup owner — snapshot staging:** inspect the one
   `side-sessions.json.tmp` warning and eight `session-memory.log.tmp` warnings,
   each with its failed-to-add-snapshot-files message, then reproduce safe
   atomic shutdown observation. Shutdown PIDs `117549`, `117671` and `117899`
   were absent and `side-sessions[]` was empty; the remaining temporary file
   followed SIGKILL. Acceptance requires no unexplained snapshot warning and no
   unexplained temporary residue after graceful cleanup; SIGKILL residue alone
   is not a crash, corruption or data-integrity assertion.
3. **Child-lifecycle owner — native host:** retain the API-created child check
   and separately exercise a task-tool-created child. Acceptance requires the
   intended child snapshot/skip behavior, no unintended child
   summary/checkpoint, and an unchanged parent where specified.
4. **Manual-acceptance owner — interaction scope:** decide whether literal TUI
   keyboard and model-mediated semantic checks are required. If required,
   record them as separate gates rather than treating this deterministic
   functional PASS as an acknowledgement or semantic PASS.

## References

- Investigation artifact: `/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-09--v1-manual-run-audit.html`
- Runner: `scripts/published-v1-e2e.ts`
- Evidence: `/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-80zJZR/evidence.json`
- Prior retained run: `v1-Gpt35C` (history-error/toast and no native-child inspection)
- Fixed candidate: `/home/dev/workspace/opencode-work/stm-readiness-improvements/fixedruntime-unpublished-pack-2026-10-09-m2eUAQK1/atonev-opencode-short-term-memory-1.4.0-rc.4.tgz`
