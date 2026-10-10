# V1 Manual Acceptance

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
