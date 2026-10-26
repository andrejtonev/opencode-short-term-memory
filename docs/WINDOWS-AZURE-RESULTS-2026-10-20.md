# Windows Azure test findings, 2026-10-20

> Archived results for 2026-10-20. References to "current" describe that dated source/candidate. Preserve these results as historical evidence; see [Feature Matrix](FEATURE-MATRIX.md), [RC Readiness](RC-READINESS.md) and [Acceptance Runners](ACCEPTANCE-RUNNERS.md) for current contracts and verification scope.

The expanded sweep runs one isolated setup at a time under a resource supervisor.
After stopping at 14:55:41 UTC for sustained CPU/network threshold breaches,
testing resumed at 18:29 UTC with an offline prepared V2 package cache.
The latest source passes 1,145 unit tests (two platform skips) and the
build. Production fixes validated during these resumes include busy V1 manual
update deferral, read-only history bootstrap preventing deleted-memory
resurrection, and native V2 provider-unavailability retries. The full sweep
remains incomplete and is not release qualification.

Current candidate: `1.4.0-rc.6` on `dev`, including the side-session guards,
busy-session deferral, bootstrap lifecycle fix and native V2 retry fix:
`.opencode/azure-native-retry-candidate.tgz`, SHA256
`5a1b35315714799cd20cae160f73030715760c0a53b93459c30827714bee6853`.
Subsequent edits affect the harness and documentation, not production code.

Earlier candidate, including uncommitted guard fixes, SHA256
`2eacd437968a655cf9c0f900e238a041214e6054a29c07a3050d60adcc166578`.
The working tree now additionally contains the busy V1 manual-update deferral
fix described below. That fix is **not in the older frozen tarball**. The new
`.opencode/azure-active-deferral-candidate.tgz` has SHA256
`bf95abc3fa1223615dafc7ba69b404017c334e31ccbe323be847d266b7c268af`.
Prior artifact passes do not qualify the newer source.
The later bootstrap/deletion fix is packaged separately as
`.opencode/azure-bootstrap-candidate.tgz`, SHA256
`38ab528b767907132a63b20bb56187b58143d3c17ec941738ef0bed898e2afaf`.
Earlier native results do not include that bootstrap fix.
The latest candidate adds native V2 provider-unavailability retry handling:
`.opencode/azure-native-retry-candidate.tgz`, SHA256
`5a1b35315714799cd20cae160f73030715760c0a53b93459c30827714bee6853`.
Pinned plugin/SDK dependencies: `@opencode-ai/plugin` and `@opencode-ai/sdk`
`1.14.25`, `@opencode/plugin` `2.0.8`. Native hosts: V1 `1.18.23`, V2 `2.0.32`.
These are different version axes.

## Current candidate coverage

| Coverage                        | Current artifact result                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full source suite and build     | 1,145 pass, two platform skips; build/declarations pass. Two added harness regressions pass separately.                                              |
| Settings                        | 32/32 pass, 16 per SDK generation, including config layers and hot reload.                                                                           |
| V1 Luna clean/system            | 27/27 phases pass.                                                                                                                                   |
| V1 Luna clean/NoReply           | 8/8 phases pass after correcting the cadence harness.                                                                                                |
| V1 Luna active/NoReply          | 8/8 phases pass, including busy deferral followed by idle commit.                                                                                    |
| Native fault/lifecycle profiles | V1 8/8 and V2 8/8 pass.                                                                                                                              |
| V2 Luna clean/no injection      | 8/8 phases pass.                                                                                                                                     |
| V2 Luna anchored actions        | 23/23 phases pass, including model-free literal commands.                                                                                            |
| V2 DeepSeek expanded clean      | 28 phases pass; long-log dialog visibility fails.                                                                                                    |
| V1 DeepSeek expanded clean      | 15 phases pass, then the overall deadline stops the run after two provider timeouts. Current-artifact keyboard-only profile separately passed 12/12. |
| V2 Luna active                  | Summary isolation fails: two summaries request tools instead of returning text; execution of those calls was not observed.                           |
| Installation loading routes     | Nine prepared-library probes pass, including four expected unsupported-path rejections. Fresh installation remains unqualified.                      |
| V2 CLI negative routes          | Three explicit rejections pass: local directory, local file and legacy `--global`; no config is written.                                             |

The two source-suite skips are the symlinked-file and FIFO project-context
checks unavailable on this Windows setup. This table is scoped to the executed
Windows profiles; it does not mark every row of the broader RC matrix complete.

## Expanded monitored sweep

### Resume after 18:29 UTC

The latest bootstrap candidate passed the targeted V1 reset-during-generation
case and final side-session cleanup. The host used `stm_memory_reset`; the held
summary could not write stale memory after reset. Evidence:
`stm-azure-v1-gpt-6-luna-6e5bGA`, supervisor
`monitored-azure-v1-reset-race-182944` (67 seconds, five requests, no surviving
owned processes). CPU samples were 14–62%, below the configured stop threshold.

V2 retry uses `stm-bootstrap-v2-cache-BcwVUZ`, a new cache generation staged
offline from the verified bootstrap package/dependency seed. Each run copies
the library bytes into its own cache; settings, databases and memory stay
isolated. This is prepared-cache coverage, **not fresh installation coverage**.
The previous incomplete cache and its resource-aborted result are retained.

V2 full fault run `stm-azure-v2-gpt-6-luna-Owsw4c` completed under
`monitored-azure-v2-luna-faults-183120` without a resource stop (204 seconds,
no remaining owned processes). Empty history, empty-once recovery, exhausted
empty/malformed output, deletion during held generation, and final cleanup
passed. A provider 503 exposed a production retry gap: native
`Generate.UnavailableError` was not classified as a settled transient failure.
The local fix recognizes that specific native error name, retaining the existing
attempt and deadline limits and leaving arbitrary errors non-retryable.
The focused updater suite passes 68 tests, with two platform skips, in
`monitored-v2-native-retry-regression-183622`.

The same run's reset assertion expected only a busy refusal. Native V2 instead
cancelled the prior context generation before executing the reset successfully.
The harness now accepts either outcome and requires absence of the held stale
sentinel after every completed reset. Native rerun of this corrected assertion
and the retry fix subsequently passed in `stm-azure-v2-gpt-6-luna-1S1wqN`:
all eight fault/lifecycle phases passed, including two-attempt 503 recovery and
completed-reset stale-write rejection. Supervisor
`monitored-azure-v2-luna-faults-183911` completed in 107 seconds with 21 requests
(one intentionally injected 503) and no surviving owned processes.
The final retry source suite passed 1,145 tests with two platform skips and
5,836 assertions in `monitored-unit-native-retry-fix-183646`; build/declarations
passed in `monitored-build-native-retry-fix-183826`.

The new-artifact V2 anchored action profile `stm-azure-v2-gpt-6-luna-mXrel7`
passed all 23 phases: seven compatibility actions, two named reset checks,
13 literal commands and provider transport health (18 requests, no transport
errors). Every literal command was model-free and preserved durable chat
history; confirmed reset used a real tool-history anchor. Supervisor
`monitored-azure-v2-luna-actions-anchored-184115` completed in 100 seconds with
no surviving owned processes. The log output was short in this profile, so it
does not resolve the earlier long-log viewport failure.

Expanded V2 DeepSeek run `stm-azure-v2-deepseek-v4-flash-kP7bqA` completed
28 phases successfully and failed `literal-command-3-logs` with
`Timed out: visible /stm logs`. The ordinary typed journey (facts, Unicode,
cadence), public tools, eight tool-free summaries, anchored reset and every
other keyboard action passed. All 42 recorded provider requests returned 200;
the dedicated final transport phase was not reached because the action profile
retained its UI failure. Supervisor
`monitored-azure-v2-deepseek-clean-full-184320` completed in 228 seconds with
no surviving owned processes. A single 96% total-CPU sample recovered to 52%
and then 7–12%, so the sustained-resource guard did not fire. That system sample
does not establish process attribution.

The latest-artifact settings matrix passed **32/32** (16 per SDK generation),
including both hot-reload policies, all config layers, malformed/empty JSONC,
normalization/clamps and model-selection reporting. Evidence:
`stm-windows-config-sweep-mzwWuX/result.json`; supervisor
`monitored-settings-current-candidate-184722` completed in 565 seconds with
no surviving owned processes. These are deterministic local-provider settings
checks, separate from Azure model quality. The prepared library entrypoints
matched the tarball before testing and remained unchanged after every case.
V2 used private Npm metadata with shared immutable library code; all config,
home/data directories, databases and memories were fresh per case.

Latest V2 active profile `stm-azure-v2-gpt-6-luna-XNC7RI` passed setup,
typed facts/Unicode, the previously failing read/log/status tool-routing step,
and manual update. It **failed summary output isolation**: provider requests
21 and 23 requested `stm_memory_update` and compatibility `update`, respectively,
with no text. Neither requested call ID occurs in durable history; STM logged
two `empty_generation` failures before later context generation recovered.
This proves undesired tool-call output, not execution of those tools. The
assertion wording was corrected accordingly without relaxing the zero-call
requirement. Pinned `session.generate` takes only `sessionID` and `prompt`,
and active mode inherits the session tool surface; clean mode's tool-free
generation remains separate. Supervisor `monitored-azure-v2-luna-active-185711`
completed in 113 seconds with no surviving owned processes.

V1 DeepSeek keyboard rerun `stm-azure-v1-deepseek-v4-flash-HEPPjy` passed
all 11 literal commands plus provider transport health, including the final
invalid action that previously hit quota. It made 11 successful provider calls;
V1 commands require model continuation even in commands-only mode. Supervisor
`monitored-azure-v1-deepseek-keyboard-185937` completed in 83 seconds with
no surviving owned processes. This closes the missing command/transport rerun,
but is separate from the older full DeepSeek ordinary-memory result.

Latest-artifact V1 Luna clean/system-delivery profile
`stm-azure-v1-gpt-6-luna-JFI0AX` passed all 27 phases, including the complete
ordinary/tools/keyboard journey, summary isolation and provider transport
(48 requests). Supervisor `monitored-v1-clean-current-190112` completed in
198 seconds. V1 active/default-NoReply profile `stm-azure-v1-gpt-6-luna-0kkR50`
passed all eight phases (19 requests), including explicit busy manual deferral
followed by idle commit. Supervisor `monitored-v1-active-current-190504`
completed in 102 seconds. Both finished with no surviving owned processes.

The current-artifact V1 full fault profile `stm-azure-v1-gpt-6-luna-qVZZ5d`
passed all eight phases, including retry, reset/deletion races and side-session
cleanup (24 requests, `monitored-azure-v1-luna-faults-190657`). V2 clean with
no context injection passed all eight phases in
`stm-azure-v2-gpt-6-luna-x7n2rD` (25 requests,
`monitored-v2-clean-current-190840`). Both monitors recorded complete cleanup.

The V1 clean/NoReply run `stm-azure-v1-gpt-6-luna-TQZZFx` exposed a harness
cadence error: the last three provider requests included a tool continuation
and omitted the first typed turn. Actual typed-turn request groups were
`[8]`, `[11,12]`, `[14]`, with the expected memory counts `[0,1,1]`.
The harness now groups requests by their genuine typed user prompt and checks
continuations separately. A focused regression passes in
`monitored-keyboard-turn-selection-191342`; strict harness typechecking also
passes. This added test is separate from the 1,145-test full source run.
The original failed profile remains recorded. The native rerun
`stm-azure-v1-gpt-6-luna-qvFyxr` passed all eight phases under
`monitored-v1-clean-noreply-current-192240` (102 seconds), including NoReply
cadence, manual update, summary isolation and transport. All owned processes
exited; CPU samples stayed at or below 49% with no resource guard stop.

Two subsequent NoReply attempts were interrupted by missing prepared
dependencies: the Temp package seed disappeared, then the terminal bridge
could not find `node-pty`. Several Temp dependency directories changed around
19:14 UTC; the cause is unconfirmed. Logs and frozen tarballs remained intact.
The user reported no known cleanup tool running; no external cleaner has been
identified as the cause.
Remaining test dependencies were reconstructed under the workspace, preserving
the candidate tarball and pinned host/client versions. All interrupted runs
recorded no surviving owned processes. Workspace libraries are prepared-cache
coverage and do not qualify a fresh registry installation.

All nine prepared installation-route probes passed between 19:24 and 19:26 UTC.
V2 candidate package loading worked from global and project `opencode.json`;
V1 `src/index.ts` loaded from both global and project configuration; V2 loaded
the checkout directory. V2 rejected configured source-file, bare-tarball,
installed-package-directory and missing-path forms without exposing active STM
commands. These last four are passing negative cases, not supported installation
instructions. Monitors `monitored-install-*-192430` through `*-192610` all
recorded no surviving owned processes and no resource stop. Each probe used
fresh host configuration, data and memories; the dependency library code was
prepared and shared. These headless probes do not independently qualify CLI
`plugin add`, global `cli.json`, Bun-link, duplicate-plugin or fresh-registry
installation behavior.

The current-artifact V1 DeepSeek expanded rerun
`stm-azure-v1-deepseek-v4-flash-iSVrcR` passed 15 phases: setup/settings,
typed facts/Unicode/cadence, public tools, manual update, summary isolation,
all seven compatibility actions, and confirmed reset. Two upstream calls timed
out at 90 seconds during the action journey. OpenCode retried and progressed,
but supervisor `monitored-azure-v1-deepseek-current-full-192622` stopped the
run at its 420-second deadline (424 seconds including cleanup). Remaining
literal-command phases were not reached. This is **INTERRUPTED**, not a passing
full profile, and the observed transport errors fail the error-free transport
requirement. The earlier current-artifact keyboard-only 12/12 pass remains
separate evidence. All owned processes exited. Maximum sampled CPU was 53%;
one system-wide network sample reached 10.7 MB/s and recovered immediately;
no sustained resource threshold fired. Network attribution is unavailable.

That forced stop exposed an evidence-retention gap: the old harness wrote
`requests.json` only during normal shutdown. The interrupted run retains phase
results and host logs, including both timeout errors, but no provider snapshot.
The harness now appends redacted request snapshots at request start and finish
to `requests.jsonl`. The audit can recover complete journal lines after a torn
final append and marks missing request evidence explicitly. A focused regression
verifies interrupted-call recovery, write ordering and redaction. This change
does not recover the already interrupted run, and its next live Azure exercise
remains pending. The keyboard-grouping and journal regressions both passed
in `monitored-final-harness-regressions-193459`; strict harness typechecking
passed in `monitored-final-harness-check-193451`.

Additional native CLI probes in `stm-windows-plugin-cli-kxWPQl` passed all
three negative cases under `monitored-v2-plugin-cli-routes-193431`. OpenCode
2.0.32 rejects both local directory and local source-file arguments to
`plugin add` with `Plugin target must be an npm registry package or Git package
specifier`; it rejects `--global` as an unrecognized flag. No configuration
was written and all processes exited. The initial directory-as-positive
expectation failed in `stm-windows-plugin-cli-5snDHH`; that harness assumption
was corrected to the observed CLI contract, retaining the original result.
Directory loading via `opencode.json` remains a distinct passing route.
No positive registry/Git CLI installation is qualified by these probes.

Final audit `monitored-audit-final-native-193501` inspected 2,065 files across
14 retained native runs, including two older bootstrap-artifact runs. It found
no real Azure key in scanned files, no personal-home configuration references
in inspected host logs, no internal-session memory files, no remaining tracked
side sessions and no history-read errors. Dependency/cache trees are excluded
from the credential scan. The V2 active run alone contains the two previously
reported summary tool-call outputs. The deadline-stopped DeepSeek run has no
request snapshot; transport and request-completion counts are unknown there,
not zero. Its supervisor independently confirms process cleanup.
The retained cadence-only recheck passed for the original NoReply false failure,
V1 system delivery and V2 DeepSeek delivery, without changing original profile
verdicts (`monitored-cadence-retained-recheck-193515`).

### Earlier stop at 14:55 UTC and remaining work

The V2 fault profile `stm-azure-v2-gpt-6-luna-wdArR1` was stopped during initial
package loading after only the empty-history case. Consecutive samples were
82% CPU / 4,711,113 network bytes/s, 79% / 7,436,871, and 89% / 578,901. At least
one resource limit was exceeded in each sample. Supervisor evidence is in
`monitored-azure-v2-luna-faults-145308`; no owned processes remained. This does
not identify which process caused the total machine load. No further live
profiles were launched. Final strict harness typechecking passed in
`monitored-final-harness-check-145617`.
The final read-only audit inspected 1,023 files across seven completed/failed
retained runs: no real Azure key persisted, no personal-home config references,
no side-session memory files, and no history-read errors. The older PVIJ7H
failure still retains its tracked side-session entry; the corrected targeted
kB03vI run has an empty tracker. Audit output is in
`monitored-audit-completed-resume-145648`. No test processes were left running.

At that earlier stop, outstanding work was: V1 targeted reset race with either valid reset tool; V2 native fault
and lifecycle cases; V2 remaining anchored keyboard commands and clipped long
dialogs; V2 active tool-routing failure; expanded V2 DeepSeek; V1 DeepSeek final
invalid-command case/transport gate after quota recovery; fresh installation and
install routes. Those earlier 32 native settings passes were older-artifact
evidence; the later current-artifact 32/32 run is recorded above.
Prepared case files and exact seed/tarball paths are in
`.opencode/full-sweep/resume-state.json` and the individual case JSON files.

### V1 fault findings after 14:37 UTC

The first V1 fault profile (`stm-azure-v1-gpt-6-luna-uzDsAc`,
`monitored-azure-v1-luna-faults-143719`) passed empty history, empty-once recovery,
exhausted empty/malformed output, reset during a held summary, and side-session
cleanup. Two checks failed. The 503-once check observed recovered memory before
its checkpoint write completed; the harness now waits for both. The deletion
check found a real **empty memory resurrection**: `session.updated` had already
passed its lifecycle guard, yielded while logging, then the bootstrap helper
called `ensureMemoryFile` after deletion. The retained stale summary was fenced,
but an empty template remained on disk.

The source fix makes bootstrap read-only (creation remains under the existing
persistence lock) and binds its scheduling callback to the original generation.
A regression exercises a bootstrap resumed after deletion. These findings mean
the earlier artifact/full-suite passes cannot qualify the additional source fix.
The fix passed 88 focused tests/512 assertions (`monitored-late-bootstrap-regression-144103`)
and build/declaration generation (`monitored-build-bootstrap-fix-144200`).
Fresh package acceptance again hit sustained total CPU of 94%, 97%, and 98%
(`monitored-package-bootstrap-fix-144237`) and stopped with no owned processes
remaining. Limiting download concurrency only in the installer did not prevent
that stop. Fresh installation remains unqualified; no further fresh-install
attempt is planned for this session.
The latest source subsequently passed the full suite: **1,144 pass, two platform
skips, zero failures, 5,830 assertions**, in `monitored-unit-bootstrap-fix-144435`
(96.24 s). Native fault regression uses the latest bootstrap tarball and a new
dependency-only seed `stm-bootstrap-seed-0a37a44abbf54f7892e6ccd40dd2d045`.
The first latest-artifact native rerun (`stm-azure-v1-gpt-6-luna-PVIJ7H`) kept
deleted memory absent and passed the corrected checkpoint check, but final
tracking cleanup failed. Inspection also found that global fault targeting had
held a replay from an earlier case rather than the intended reset/delete session.
Its held-race PASS labels are therefore **not qualification evidence**. The
harness now embeds a unique case marker, injects only into matching summary
prompts, waits for temporary-session cleanup between cases, and starts held
turns without awaiting the context call that the test deliberately blocks.
The targeted rerun (`stm-azure-v1-gpt-6-luna-kB03vI`,
`monitored-azure-v1-luna-faults-145019`) passed deletion with the intended summary
held and final cleanup, plus all four output-fault cases. Reset used the
compatibility `short_term_memory(action=reset, confirm=true)` entry point instead
of the requested named tool, so its name-specific assertion failed. The race
test now accepts either actual reset entry point and records which ran; a
targeted native rerun is required. Earlier failed runs remain failed.

### Resume after 14:08 UTC

Fresh package acceptance stopped during dependency installation when total CPU
reached 84%, 89%, and 83% on consecutive samples. The supervisor confirmed no
owned processes remained. Evidence: `monitored-package-active-deferral-140849`
and Temp `stm-package-acceptance-elR9h8/evidence.json`. Fresh installation of the
new package remains unqualified. CPU dropped afterward; this does not establish
which process caused the earlier spike.

For the native retry, a separate dependency-only seed was copied from the prior
prepared install, then its STM package was extracted from the new tarball. The
runner verifies package bytes against the tarball; settings, history, memory,
and user directories remain fresh per run. Seed provenance is retained in Temp
`stm-active-deferral-seed-34aca706ce374b5ea57a2a36083c9209/seed-provenance.json`.
The active manual-update assertion now requires both explicit deferral and a
subsequent completed memory update with an advanced checkpoint.

Native V1 active with Luna **passed all eight phases** on the new artifact in
Temp `stm-azure-v1-gpt-6-luna-rZ1Plp`, supervisor
`monitored-azure-v1-luna-active-deferral-141250`. The named manual update returned
an explicit deferred result, then completed at idle and advanced its checkpoint.
Three typed turns retained the facts and Unicode; NoReply cadence was `[0,1,1]`.
All 19 provider requests completed, no summary invoked tools, and all owned
processes exited. Keyboard command expansion and fault profiles are separate.

The preceding attempt `stm-azure-v1-gpt-6-luna-BWzHlD` returned deferral but failed
the new assertion while parsing a concurrently appended log. Its completed log
parsed cleanly (301 lines). The harness now parses only newline-terminated records
and selects events by timestamp instead of slicing a potentially partial line.
That attempt remains FAIL; the subsequent native run above is the passing evidence.

The first new full-suite run (`monitored-unit-active-deferral-141454`) had 1,142
passes, two platform skips, and one failure: the side-session concurrency test
saw three cleanup calls for two created sessions. Manual-summary tests had also
scheduled unrelated bootstrap updates via `session.created`, allowing timers to
outlive a temporary cwd. Those events were removed from these manual-only tests;
the concurrency test now explicitly holds both prompts and checks both tracked
IDs together instead of relying on a 20 ms delay. Three focused repetitions
passed (39 tests) in `monitored-side-session-concurrency-141721`; the full suite
was rerun separately. No additional production change was made for this issue.
The final complete suite passed **1,143 tests, two platform skips, zero failures,
5,826 assertions** in `monitored-unit-active-deferral-141740` (86.24 s).
The skips remain the Windows file-symlink privilege check and POSIX FIFO case.

V2 active Luna (`stm-azure-v2-gpt-6-luna-QLZw5A`, supervisor
`monitored-azure-v2-luna-active-141922`) passed setup, settings/status, and the
three-turn Unicode/fact/cadence journey. It **failed** the compatibility-tool
step: despite direct STM functions in the request, the model called `execute`
twice and then refused STM invocation. The host system prompt contains a Code
Mode catalog for its separate OpenCode management tools, a possible source of
confusion. This is not a passing active profile; later phases were not reached.
All owned processes exited. Its loaded entrypoint was independently hashed
against the new candidate (`loaded-entrypoint-audit.json`).

V2 initialization took about 80 seconds for the new tarball cache entry. The
harness now labels the initial server-only phase `isolated-host-start`, records
inventory after actual STM tool use, verifies the loaded entrypoint against the
candidate, and bounds prompt submission to 90 seconds. Strict runner typechecking
passed in `monitored-verify-harness-142301`.

V2 Luna clean with injection disabled (`stm-azure-v2-gpt-6-luna-SWNhCm`,
`monitored-azure-v2-luna-clean-full-off-142315`) passed the complete ordinary
journey, summary/tool isolation, seven compatibility actions, both reset refusal
paths, and confirmed tool reset with a real history anchor. The loaded entrypoint
matched the candidate. Literal status/settings/show passed, but **literal logs
failed** its title visibility check. The terminal retained actual log output;
the long alert overflowed the 45-row viewport and clipped its title. Settings
has the same known clipping limitation. This is an unresolved UI usability issue;
the remaining literal commands and anchored keyboard reset were not reached.
All owned processes exited. The run is FAIL, not a completed keyboard profile.

V1 expanded DeepSeek (`stm-azure-v1-deepseek-v4-flash-46EUXs`,
`monitored-azure-v1-deepseek-clean-full-142844`) passed the ordinary journey,
summary isolation, all seven compatibility actions, confirmed reset, and the
first ten of eleven literal commands. The final invalid-command case hit Azure
`RateLimitReached` (DeepSeek token quota in italynorth); repeated upstream 429s
continued until the eight-minute supervisor deadline. All owned processes exited.
This is an incomplete/failed profile, not a transport-health pass. The earlier
DeepSeek fact omission remains retained separately; this attempt retained the
facts and Unicode correctly.

### Resume after 13:37 UTC

The resumed V1 active run `stm-azure-v1-gpt-6-luna-2jRFwC` passed setup, status,
three typed turns, Unicode, reminder cadence, and read/logs/compatibility tools.
The manual update tool then stalled: its active summarizer attempted to prompt
the same session while the invoking tool was still executing. Source inspection
identified the re-entrant wait risk. V1 tools now return an explicit deferral
while that session is busy and active generation or clean-to-active fallback is
enabled; the existing idle path performs the update. Clean-only synchronous
updates and idle manual retries retain their existing path.

The new source passes 10 self-generation tests (including active and fallback
deferral regressions), 88 related tool/lifecycle tests, the build/declaration
check, and strict runner typechecking. Evidence is under
`.opencode/full-sweep/monitored-v1-manual-active-regression-135543`,
`monitored-v1-related-regression-135628`, `monitored-build-active-deferral-135746`,
and `monitored-verify-harness-135856`. The new fix has not yet passed a live native
rerun or the complete suite; earlier full-suite counts apply to the earlier source.

The live run was stopped at 13:52:23 UTC after free RAM samples of 1,728, 1,842,
and 1,870 MiB. No live test was restarted after that stop. The monitor's reported
remaining PID 8544 had been reused by `svchost.exe`, parent 1572, created at
13:51:23 UTC; it was not the earlier test host and was left untouched. The
supervisor now verifies parent creation time when discovering descendants and
verifies identity again in the final survivor report, avoiding PID reuse errors.

The V2 receiver failure was traced to the harness setting
`BUN_CONFIG_MAX_HTTP_REQUESTS=2` in the host/TUI environment. The persistent event
stream and pending command occupied the runtime HTTP pool, delaying the claim
until after the command deadline. A temporary diagnostic receiver confirmed
matching session/location and a late rejected claim. Removing the runtime pool
cap fixed admission without changing candidate code. Both Windows runners now
leave that pool uncapped; the external resource supervisor remains in place.

All 13 literal V2 command cases passed in Temp
`stm-azure-v2-gpt-6-luna-ZVi0cr`, with zero provider requests and unchanged durable
conversation history. This command-only session has no ordinary message anchor;
confirmed reset can therefore refuse on that boundary. The earlier live tool
journey covers confirmed reset with a real history anchor. Long settings output
clips its title in a 45-row viewport, so the harness checks actual visible
settings values; this does not establish that every settings line is readable
without resizing the terminal.

V1 active attempt `stm-azure-v1-gpt-6-luna-VSc5wW` retained all three facts but
exposed another counting error: the harness counted the literal reminder marker
inside old summarizer instructions. The fixed check only counts actual reminder
messages beginning with that marker. Re-evaluation of the saved request trace
passes `[0, 1, 1]`; `.opencode/full-sweep/active-cadence-audit.json` is explicitly
an offline assertion check, not a completed live profile. A fresh live rerun is
required for the later tool and cleanup phases.

Diagnostic attempts and their failures remain retained: `VuVrXo` rejected an
uppercase log level; `liulGG` proved TUI setup succeeded; `7l2Zk7` captured the
late claim; `kkbtVk` displayed status/settings but failed the old title-only
visibility assertion. These suffixes refer to Temp `stm-azure-v2-gpt-6-luna-*`.

### Earlier expanded runs

- Full Windows suite: 1,141 passed, two skipped, zero failures; 5,802 assertions.
  Windows cannot create file symlinks with the current token, and POSIX FIFO
  coverage is unavailable. Directory-junction boundary tests do run.
  Evidence: `.opencode/full-sweep/unit-fourth.log`.
- Native settings: all 16 cases passed for each SDK generation (32 total).
  Evidence: `.opencode/full-sweep/settings-summary.json`. Deterministic local
  provider responses exercise settings; these are not Azure inference tests.
- Fresh package acceptance passed installation, exports and strict declaration
  checks: Temp `stm-package-acceptance-JT092j/evidence.json`.
- V1/Luna clean full journey passed: Temp `stm-azure-v1-gpt-6-luna-SeSepe`,
  48 provider requests, no transport errors, three literal chat turns including
  Unicode, all seven compatibility actions, reset and 11 literal slash commands.
  Audit found no summary tools, side-session memories, tracked side sessions,
  history-read errors, unfinished requests, or persisted Azure credential in
  inspected files. All owned processes exited.
- V2/Luna expanded attempt `stm-azure-v2-gpt-6-luna-fWxGo0` passed the base
  journey and tool actions, but failed keyboard acceptance: no TUI receiver
  admitted the command. A substring oracle incorrectly accepted an error containing
  `STM status`; audit corrected that phase to FAIL. The history read then
  stalled. The run was stopped, owned processes were removed, and the harness
  now rejects receiver errors and bounds V2 history reads. This interrupted
  run has partial evidence only. The CLI config copy happened after TUI startup;
  a retry must place it in the effective config directory before launch.
- V2/Luna retry `stm-azure-v2-gpt-6-luna-wiMvtj` again passed the base journey
  and tool actions, but correctly failed the receiver assertion. The audit
  found seven tool-free summaries, no transport/history-read errors, no
  side-session memories and no unfinished requests. All owned processes exited.
  A keyboard-only run `stm-azure-v2-gpt-6-luna-dXswhr` with an explicit CLI
  package declaration also failed receiver admission, with zero model requests.
  Config placement alone does not explain this; TUI load/admission diagnosis
  remains open. Do not claim the plugin is absent solely from this error.
- V1/Luna active attempt `stm-azure-v1-gpt-6-luna-v0bbE3` retained all three
  typed facts including Unicode, but failed a harness cadence assertion:
  historical summary prompts caused later chat requests to be misclassified.
  Classification now uses the latest user message. Three actual summaries
  completed without transport errors; the corrected full profile is unverified.
- The active retry `stm-azure-v1-gpt-6-luna-qtlMVU` was stopped by the resource
  supervisor at 13:21:13 UTC after CPU samples of 85%, 80%, 83%. Every owned
  process exited. A contemporaneous process sample identified Android emulator
  `qemu-system-x86_64.exe` as the largest CPU consumer; after test cleanup it
  still used approximately 38% of total machine CPU in a short sample. This
  does not establish the cause of earlier machine-wide incidents. Evidence:
  `.opencode/full-sweep/resource-stop-132113.json` and monitor resource logs.

Live testing stopped after this threshold breach. Remaining profiles: corrected
V1 active, V2 active, V2 periodic injection disabled, both DeepSeek expanded
journeys, both native fault/race profiles, installation-route checks and V2
keyboard delivery diagnosis. This is explicitly an incomplete sweep; RC6 is
not qualified for production by these results.
The updated Windows runners passed strict TypeScript checking after the harness
corrections (`monitored-verify-harness-132316`). No runtime candidate bytes were
changed during these retries.

Behavior runs use byte-verified prepared package code after an independent
fresh-install acceptance. They isolate all mutable settings, home, database,
cache copies and memories. A subsequent installer stalled resolving dependencies
and was stopped (`stm-azure-v1-gpt-6-luna-zmobE1`); that is not a passing install.
The supervisor limits each process tree to two logical CPUs at BelowNormal
priority, samples machine CPU/network/RAM/disk about every six seconds, and
stops sustained threshold breaches or the case deadline. Samples do not prove
the absence of peaks between observations. Only one case is launched at a time.

## Sequential V2 retry, 11:36-11:42 UTC

Each model ran alone with a fresh home, settings, project, database, package
cache and memories (`packageCacheSeed: null`). Both passed all eight phases:
install/load, settings/status, setup refusal/confirmation/no-overwrite, literal
keyboard input and automatic memory, read/logs/compatibility tools, manual
update, summary isolation/cleanup, and error-free provider transport.

| Azure model         | Requests | Summary requests | Result | Evidence directory under Windows Temp   |
| ------------------- | -------: | ---------------: | ------ | --------------------------------------- |
| `gpt-6-luna`        |       23 |                6 | PASS   | `stm-azure-v2-gpt-6-luna-wOU2we`        |
| `deepseek-v4-flash` |       28 |                8 | PASS   | `stm-azure-v2-deepseek-v4-flash-RdTpeY` |

Both retained port 7319 and release color violet. Every summary request had
no tools. The audits found zero unfinished requests, transport errors,
history-read errors, side-session memories, or outstanding side sessions.
Settings outputs pointed to the respective roots; no Azure key was found in
inspected files and no personal-home config references appeared in host logs.
All owned test processes exited. No personal installation was changed.

Fresh dependency installation took 32.27 seconds for Luna and 25.03 seconds
for DeepSeek. Seven coarse resource samples showed a maximum combined test
working set of 760.6 MB and at least 6,819 MB of free system memory. These are
sampled values, not continuous peak measurements. The earlier machine problem
was not reproduced, and its cause cannot be attributed to or ruled out as STM
from these short runs. Samples: `.opencode/v2-retry-resource-samples.jsonl` in
the checkout.

DeepSeek repeated the status tool five times despite the prompt requesting
one call; exact call-count adherence is not a gate in this runner. One of its
summary requests took 71.6 seconds but returned HTTP 200 and completed; Luna's
slowest request took 2.756 seconds. This provider wait can delay a chat update
without indicating a machine-wide resource problem. The earlier V1/DeepSeek
omitted-fact failure is not invalidated by this successful V2 sample.

## Earlier verified findings

- V1/Luna completed setup, settings/status, two literal keyboard messages,
  automatic memory, read/logs/compatibility tools, and manual update. The
  retained memory contained port 7319 and release color violet. All six actual
  summary requests had no tools; all requests finished, side-session tracking
  was empty, no side-session memory existed, and no history-read error was
  logged. The overall run failed the strict transport gate because one initial
  connection error was recovered by the host. This is not an error-free PASS.
- V1/DeepSeek passed setup/settings and generated memory, but omitted violet
  from its second update. Request 12 contains the complete new user instruction
  in `<conversation_update>`; its response repeats the previous memory and
  omits the new fact. There were three tool-free summary requests, zero
  transport errors, no outstanding requests or side sessions, no side-session
  memory files, and no history-read errors. The semantic assertion correctly
  failed. The model did not need to look up additional history.
- Earlier V2 runs with both models completed the shared functional journey,
  including typed input, tools and summary persistence. Their initial harness
  stopped with a final summary outstanding, so their aggregate PASS labels do
  **not** qualify cleanup. Subsequent strict reruns hit gateway connection
  errors before successful model responses. All earlier evidence is retained;
  no failing result was rewritten as a PASS.

The guard fix keeps internal-session identity after deletion and during orphan
cleanup, invalidates work admitted before the create response identifies the
session, and retains failed deletions for restart cleanup. V1 clean requests
deny every tool. The prompt explicitly supplies retained memory and the
incremental conversation and requires a direct answer without tools or history
lookup. V2 clean generation uses standalone generation rather than disposable
side sessions.

## Retained evidence

All paths are beneath `C:\Users\Andreja\AppData\Local\Temp`:

| Case                       | Evidence directory                      | Meaning                                                                  |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| V1/Luna strict run         | `stm-azure-v1-gpt-6-luna-Y40eiG`        | Functional and isolation assertions verified; recovered transport error. |
| V1/DeepSeek strict run     | `stm-azure-v1-deepseek-v4-flash-hjDFaz` | Missing-new-fact semantic failure; isolation audit passed.               |
| V2/Luna functional run     | `stm-azure-v2-gpt-6-luna-NAwHTh`        | Functional journey completed; cleanup interrupted by the old harness.    |
| V2/DeepSeek functional run | `stm-azure-v2-deepseek-v4-flash-gzdt74` | Functional journey completed; cleanup interrupted by the old harness.    |
| V2/Luna strict attempt     | `stm-azure-v2-gpt-6-luna-su38fB`        | Transport timeout with no successful model response.                     |
| V2/DeepSeek strict attempt | `stm-azure-v2-deepseek-v4-flash-fXOTLn` | Transport timeout with no successful model response.                     |

The last two V2 attempts, `stm-azure-v2-gpt-6-luna-Lj0xvm` and
`stm-azure-v2-deepseek-v4-flash-clpdGp`, used independent copies of package
caches from isolated runs. Both reached the 300-second package-install limit
while resolving dependencies, before a host or model call started. Their
`install.log` files are retained; the runner was subsequently improved to
also write structured evidence for installation failures.

Inspect `evidence.json`, `requests.json`, `history.json`, `isolation-audit.json`,
`host.log`, `terminal.ansi`, and `project/.opencode/memory`. The audit found no
Azure key in inspected files, no personal-home configuration references in
the inspected logs, and settings tool output pointing to each case's root.
Dependency/cache trees are excluded from the credential scan. Earlier harness
versions retained only the most recent host log; the checked-in runner retains
both host lifetimes.

## Scope and reproduction

See [Windows Azure acceptance](WINDOWS-AZURE-ACCEPTANCE.md) for executable
PowerShell commands, isolation controls and transport details. Each case has
separate settings, home, project, database, and memories. Azure credentials
remain in the controller; hosts receive only a temporary loopback token.
Luna uses `reasoning_effort: none`; V2 uses `azure-isolated` to avoid inherited
built-in Azure endpoint templates. Responses are real Azure completions
converted to SSE, not deterministic fixtures.

Historically, the side-session fixes passed 67 focused regression tests, build, typecheck
and formatting. The full Windows suite was not green: 1,018 passed, 62 failed
and 2 errors, compared with 1,015 passed, 61 failed and 2 errors on the unchanged
baseline. The two changed-only failures passed individually; this does not
turn the full suite into a PASS. The Windows runner and audit also typecheck.

At that earlier checkpoint, outstanding acceptance included the complete settings matrix, active mode,
command/keyboard variants, reset/delete races and provider fault injection.
Memory-quality and transport failures must remain visible alongside passing
isolation checks. Nothing was published or installed into personal OpenCode
settings by these test runs.
