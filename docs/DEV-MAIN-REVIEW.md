# Dev against main: RC13 review

Reviewed on 2026-10-27 against refreshed remote refs: `origin/main` at `79d52c2` (v1.3.0), and local `dev` at `f07c658` (v1.4.0-rc.13). Local `main` was stale; it was not used as the baseline.

The committed diff contains 218 files: 45 production source files, 86 test files, 34 scripts, 34 fixtures, 12 documentation files and seven root files. Four review slices covered V1/shared lifecycle and persistence; V2 generation, scheduling and reset; V2 delivery, configuration and UI; and maintained acceptance/package harnesses. Reviews emphasized races, cancellation, ownership, V1/V2 behavior and unnecessary abstraction. This is a scoped code review, not an exhaustive proof of every changed line.

The net release overview is in [CHANGELOG.md](../CHANGELOG.md#unreleased). Fixes to features introduced within dev are folded into those features rather than listed as main-to-dev bug fixes.

## Follow-up verification and improvements

All six findings below were confirmed and addressed in commit `db2c4c3`. The original findings describe the committed RC13 baseline. RC14 packages the follow-up improvements; its archive qualification is recorded in [RC14 Acceptance](RC14-LOCAL-ACCEPTANCE.md).

| Finding                    | Verified improvement                                                                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2 global config bootstrap | Replay only enabled discovery scopes. Global installation now creates `stm.json` when project discovery is disabled, including the native legacy flag alias; malformed disabled project files cannot block it.                                                                     |
| V2 Status diagnostics      | Report runtime update/injection/compaction counts, injected character count, timestamps and latest error. Record actual checkpoint commits and deliveries; diagnostic clock failures cannot interrupt persistence. Dispose runtime telemetry and ignore late events.               |
| V1 effective transport     | Status now describes the same active-mode message fallback used by delivery.                                                                                                                                                                                                       |
| V2 controller retention    | Abort and release controllers on deletion, retain lightweight deletion markers while runtimes remain active, and clear them when the last runtime owner disposes. Keep pending provider reservations until settlement to prevent overlapping calls.                                |
| Windows cleanup false pass | Capture owned process identities while parents are live, then verify descendants after normal exit. Untracked or incomplete ownership remains a failed cleanup result; exited parent PIDs are never signalled. The maintained runner tracks every installer, host and TUI process. |
| Dual-delivery acceptance   | Fresh fixed-mode gates require every matching generated-memory injection to use the selected role. Both system-plus-user permutations are covered.                                                                                                                                 |

Regression checks confirmed the config and harness failures before the fixes. Integrated checks cover actual V2 update/injection/compaction counters, provider-error reporting, disposal, deletion/reset races and provider reservation ownership. Old Status snapshots and cleanup expectations were updated to the new contracts.

The native Windows process check observed incomplete cleanup while a captured detached descendant remained alive, then `verified-gone` after it exited, without signalling the exited parent. An instrumented 1,000-session run retained zero session/generation controllers after deletion and zero deletion markers after runtime disposal.

Follow-up validation: **1,393 tests passed, four platform skips, zero failures**, process exit code 0 across 88 files. Build, declarations and typechecking passed. The native process check validates the cleanup helper; the entire release acceptance runner and frozen RC13 archive were not requalified.

The optional quality suggestions were also assessed:

- Removed unused V1 registration collectors. The adapter now advertises and rejects unsupported dynamic registration operations honestly; native V1 hooks remain constructed by the existing implementation.
- Shared V1/V2 menu action order and descriptions, and removed an unused retry-classification helper.
- Added an explicit test watchdog to the isolated short-timeout scenario so it proves timely completion and keeps Bun's event loop alive.
- Retained generation-specific session APIs and installation helpers where host semantics and qualification rules differ. Broadly unifying them was not established as a correctness fix and would add migration risk. Native config replay remains necessary because the supported V2 setup API lacks installation provenance; the enabled-scope regression fixtures now cover the confirmed drift.

## Product findings

### P2: disabling project discovery prevents global config creation

[`bootstrapV2InstalledConfig`](../src/v2-config-installation.ts) skips all creation when `OPENCODE_CONFIG_PROJECT_DISABLE=1`, including a valid global STM installation. A fresh global RC13 declaration creates global `stm.json` normally, but the same case with project discovery disabled returns `skipped`.

The pinned [OpenCode V2 server entrypoint](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/cli/src/server-process.ts) maps this flag to project discovery only; global discovery remains enabled. This is a supported host configuration, not just a synthetic environment case. The code's analogous global-disable branch was not established as a supported native environment flag and is excluded from this finding.

**Suggested fix:** replay enabled scopes independently and create settings in the verified global installation scope. Add the global-installed/project-disabled case alongside the existing project-installed/project-disabled test.

### P2: V2 Status omits existing V1 diagnostics

[`readV2MemoryStatus`](../src/v2-memory-tools.ts) reports saved memory, checkpoint and updater activity, but omits update/injection/compaction counts, recent update/injection times and the latest error. V1 exposes these, while the V2 menu promises “status and live counters.” A read-only reproduction confirmed the fields are absent. Users investigating generated memory without injection must consult logs.

**Suggested fix:** maintain runtime telemetry at successful operation boundaries and failures; expose it through Status. Cover update success, injection success/failure and disposal. Counts should retain the same scope as their V1 counterparts.

### P3: V1 Status can name the wrong effective transport

[`statusText`](../src/commands.ts) reports `legacySystemTransform` whenever its flag is enabled. With active summarization, [`session-memory.ts`](../src/session-memory.ts) instead selects `prompt_no_reply`. Reproduced with `summarizerMode: "active"` and `enableLegacyPeriodicSystemTransform: true`. This is a diagnostic error; delivery itself follows the intended fallback.

**Suggested fix:** derive the status value from the same transport selection rule as delivery and cover both modes with the flag enabled.

### P3: V2 coordination controllers accumulate after deletion

[`v2-mutation-coordination.ts`](../src/v2-mutation-coordination.ts) retains session and generation controllers indefinitely, including deleted temporary summary sessions. An instrumented copy reproduced 1,000 completed deletions leaving 1,000 entries in each controller map; mutation and reservation maps returned to zero.

**Suggested fix:** scope coordination state to runtime lifetime and reclaim entries once outstanding work settles. Preserve deletion fencing until then; simply removing tombstones would let late operations recreate live state.

## Acceptance harness findings

### P2: unverified process trees can receive cleanup PASS

[`windows-owned-process.cjs`](../scripts/windows-owned-process.cjs) correctly avoids signalling an already-exited parent's stale PID, but then accepts `already-terminal-unverified` as complete cleanup. The reproduction reports `complete: true` with zero descendant checks. A parent exiting before teardown could leave descendants without failing the receipt.

**Suggested fix:** capture ownership while the root is live and verify retained descendant identities after exit. Without that evidence, report tree cleanup as unqualified or failed. Keep functional success separate from containment success.

### P2: system-mode acceptance permits dual delivery

[`assertGeneratedMemoryInjection`](../scripts/acceptance-memory-fixture.cjs) accepts the same generated memory in both system and user messages when system mode is selected. Reproduced against the actual assertion. The maintained gate uses a fresh profile and fixed transport, so this could hide a duplicate-delivery regression.

**Suggested fix:** require all matching injected memory in this fresh-profile gate to use the selected role. Test dual delivery explicitly; historical reminders after a real mode switch need separate expectations. No dual-delivery product failure was demonstrated.

## Code quality and validation

- Simplify the unused V1 registration collectors and the broad runtime contract that V2 bypasses for native session operations. Share genuinely common behavior rather than duplicate an API surface.
- Isolate V2's native configuration discovery replay and keep compatibility fixtures tied to the supported host version; its approximately 400 lines otherwise risk drifting from native discovery.
- Share menu descriptions/order and appropriate registry/install helpers. Preserve distinct manual, archive-consumer and native acceptance qualification rules. Historical runners are already documented separately.

The original review checkout passed **1,380 tests, four platform skips, zero failures**, with process exit code 0, plus typechecking. Both checkout sweeps include pre-existing uncommitted Azure launcher changes; those were excluded from the committed branch review. The first redirected run's exit discrepancy was a PowerShell stderr-wrapper artifact, confirmed by a clean direct-shell rerun.

An isolated Bun 1.3.13 short-timeout test also stalled without an event-loop keepalive; a timer-only preload let all 11 current-history tests pass. Treat this as harness liveness, not evidence of a product late-write defect.

No confirmed high-priority lifecycle/persistence regression was found in the original reviewed core slices. The review checks do not requalify the frozen RC13 archive, live providers, Linux/macOS native behavior, external DCP compatibility or actual provider cache reuse. Follow-up product and harness fixes are committed; release qualification is recorded separately.
