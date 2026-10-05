# RC Readiness

Recorded: **2026-10-05**. Recommendation: **not RC-ready**. Native integration
passes, but reproducible tests, installation, compatibility and release identity
remain unresolved. This records the prior audit, not a new build or live run;
no findings are fixed by this document.

## Summary Table

| Component/Logic Block  | Current Findings/Hypothesis                                                                    | Implications                                                                     | Verification Status                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Native integration     | All seven commands, 16 connected states and four headless refusals pass on staged host 2.0.12. | Native wiring accepted within this scope, not published installation.            | PASS; live JSON inspected.                                              |
| Reproducible tests     | Latest recorded full suite: 720 pass, one directory-order failure.                             | Confirmed flaky test prevents a repeatable green gate.                           | Prior failure recorded; unsorted assertions independently inspected.    |
| Installation docs      | README omits V2 `plugin add` and uses unsupported `--global`.                                  | Confirmed V2 instruction defect; correct generation-specific instructions.       | Pinned authoritative CLI specification inspected.                       |
| Package installation   | Pack dry-run passes; live harness reuses dependencies and seeds host cache.                    | Clean production-only tarball install and consumer declarations remain unproven. | Evidence gap, not an observed install failure.                          |
| Compatibility/update   | Final installed V1, minimum V2 and native committed multi-chunk update not verified.           | Test claimed hosts on the same final artifact or narrow support claims.          | Evidence gap; existing wrapper matrix is insufficient.                  |
| Release identity/gates | Version/changelog remain 1.3.0; tracked and untracked candidate work is unresolved.            | Review candidate scope, locks and immutable release identity before RC.          | Manifest, changelog and worktree inspected; final gate evidence absent. |
| Lifecycle/trust        | Action can outlive 120-second completion timeout; same-server RPC clients are trusted.         | No rollback/cancellation or multi-user isolation guarantee.                      | Known risks, not confirmed product correctness blockers.                |

## Recorded Evidence

The audit artifact is dated `2026-10-04`; the live JSON contains UTC timestamps
on **2026-10-05**, including `2026-10-05T04:13:42.751Z`. The static results below
are the latest results recorded in that artifact; separate execution timestamps
and the exact prior touched-file formatter argument list were not preserved there.
They were not rerun while writing this document.

Run from the repository root, with the checkout's installed dependencies and built
output. These are the recorded commands, **not clean-install acceptance commands**:

```bash
/usr/bin/timeout --kill-after=5s 100s /home/dev/.bun/bin/bun fixtures/v2-generation-probe/tui-output/production-acceptance.ts
PATH=/home/dev/.bun/bin:$PATH bun test --isolate
PATH=/home/dev/.bun/bin:$PATH bun run typecheck
PATH=/home/dev/.bun/bin:$PATH bun run build
/home/dev/.bun/bin/bun pm pack --dry-run --ignore-scripts
git diff --check
```

- **Live PASS:** `/tmp/opencode/stm-production-commands-KVzpJW/evidence.json`,
  `verdict: "pass"`, `failures: []`, `nativeConnectedCount: 16`. Covers default and
  explicit status, settings, logs, show, setup, update and reset, including accepted
  settled-snapshot reset and post-reset status/update/logs. Four absent-receiver
  refusals took approximately three seconds and left persistence unchanged.
- Native entry is `session.command({sessionID, name: 'stm', text})`, not an agent
  prompt or synthetic command publication. Actual TUI screen evidence is retained.
  `costConsumed: 0`, `globalBudgetChanged: false`, `tuiStopped: true`, server exit
  `130` after cleanup. JSON run record exists; adaptive journey is not applicable.
- **Unit gate FAIL:** 720 pass, one fail, 3,146 assertions. In
  `test/v2-reset-persistence.test.ts:232,260`, recursive `readdir` inventories are
  compared without sorting; byte-preservation assertions are separate at line 259.
  This is a confirmed test-order defect, not evidence of reset corruption. No
  retry-based green result supersedes the recorded failure.
- **Static gates PASS:** typecheck exit 0; build output index 156.82 KB, TUI
  5.74 KB, RPC 2.56 KB; touched-file Prettier check and `git diff --check` passed.
  Prior audit records `./tools/llm/toolchain-check.sh` as absent in this repository.
- **Pack dry-run PASS:** 64 files, approximately 0.60 MB, export entries and
  declarations present. `--ignore-scripts` disables lifecycle scripts; dry-run
  creates no tarball and proves neither installation nor `prepare`/bootstrap.

The staged target was `@atonev/opencode-short-term-memory@1.3.0`, with separate
server, TUI and RPC exports. The harness used an existing dependency symlink and a
pinned host-compatible numeric NPM cache generation. This is **not** registry
publication, fresh dependency resolution, or an isolated tarball consumer install.
Its model-free update cases are `no-model` and post-reset `no_assistant_in_delta`
with zero checkpointed chunks, not a committed summarization update.

## Defects, Gaps And Risks

**Confirmed documentation defect:** `README.md:31-35` says
`opencode plugin @atonev/opencode-short-term-memory@latest --global`. The pinned
V2 CLI specification defines `plugin add <package>` as globally installing and
configuring a plugin, with no `global` flag for that subcommand. The supported
syntax is `opencode plugin add <package>`; use an exact candidate spec when one
exists, not `@latest`. This does not verify the V1 CLI syntax or prove that the
command configures both server and TUI loading correctly for this package.
`README.md:13` also still describes full-command acceptance as pending; replace
that stale statement with the bounded staged PASS, not a published-support claim.

**Evidence gaps:** install a real final tarball with production dependencies only,
no checkout symlinks and no pre-seeded OpenCode cache; verify all runtime exports,
consumer declaration resolution, supported install/bootstrap and server/TUI
activation. Use that same artifact for V1 `1.14.25` and claimed V2 hosts. Root V2
API is pinned to `2.0.8`, while this live host is `2.0.12`; either verify the
minimum host or explicitly narrow RC support. The existing
`test/production-host-load-matrix.ts` installs hosts but wraps checkout
`dist/index.js`; it witnesses lifecycle loading, not final installed-package
compatibility. A native committed multi-chunk `/stm update` must demonstrate
memory/checkpoint persistence, cumulative progress, UI delivery and cleanup.
Earlier agent-tool update evidence and unit tests do not close that native gap.

**Release tasks:** `package.json` remains `1.3.0`; the latest changelog entry is
`1.3.0`, dated `2026-06-24`, without the candidate V2 changes. Select a prerelease
version and non-`latest` dist-tag, document changes/limits, review tracked and
untracked work, and make lock scope deliberate. There are root and fixture
dependency environments; a clean release procedure must state which locks and
tool versions govern each. The reviewed worktree on `dev` has 16 tracked changed
files (1,446 insertions, 229 deletions), plus untracked runtime/tests/fixtures;
`git diff --stat` alone excludes those untracked files. Historical audit HEAD was
`804dd30`, not an immutable identity for these working-tree bytes.

No `.github` workflow files were found. This is an automation/evidence gap, not
an independent requirement to add CI: a documented, repeatable manual release
gate tied to the exact candidate and tarball can suffice. Existing
`check:package`/`prepublishOnly` gates do not prove clean install or host acceptance.

**Known operational limits:** `src/v2-status-output.ts:4` sets the action bound
to 120 seconds. `src/v2-status-command.ts:98-110` races completion against the
action without aborting it; busy ownership remains until the original action
settles. Mutations can continue after timeout, cancellation or delivery failure;
inspect persisted state before retrying. Matching request/session/receiver IDs
are routing correlation, not user authorization. The prior audit treats
same-server RPC clients as trusted: keep the deployment single-user/trusted and
do not claim multi-user isolation. Reset is forward-boundary control, not semantic
erasure. These are documented risks to disclose, not newly confirmed lifecycle
defects.

## Prioritized Acceptance Checklist

1. **Test owner; no dependency:** normalize directory inventories without weakening
   byte checks, then run `bun test --isolate`, typecheck, build, format and diff
   checks. Acceptance: deterministic full green gate without retries.
2. **Docs/package owner; depends on 1:** correct installation/status instructions,
   choose candidate version and lock scope, build and pack a real tarball in a clean
   environment. Acceptance: production-only consumer imports/typechecks and actual
   supported install/bootstrap pass with no checkout symlink or cache seeding;
   preserve exact commands, tool versions and tarball digest.
3. **Compatibility owner; depends on 2:** exercise that tarball on final V1 and
   each claimed V2 host, then a bounded native committed multi-chunk update.
   Acceptance: supported-host loading, memory/checkpoint bytes, cumulative progress,
   rendered result and cleanup all witnessed; narrow claims if minimum V2 is omitted.
4. **Release owner; depends on 1-3:** review all tracked/untracked candidate files,
   finalize changelog, known limits, prerelease tag and immutable candidate identity.
   Acceptance: repeatable manual or CI gates identify the exact commit and tarball,
   with installation/compatibility evidence retained. Publication needs separate
   authorization; this document authorizes no commit, push or release.

## Follow-Up: 2026-10-05

**Recommendation remains NOT RC-ready.** The sections above preserve the original
historical audit, including its 720-pass/one-failure test result and then-current
README defects. The following records subsequent working-tree fixes and retained
evidence, not a claim that those failures never happened. Candidate changes and
this follow-up are pending the lead's local commit; no immutable release identity
is assigned here. The final post-retirement full suite was rerun for this edit;
no builds or live workflows were rerun.

| Component/Logic Block  | Current Findings/Hypothesis                                                                                                                               | Implications                                                                                     | Verification Status                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Tests/static gates     | Final post-retirement full suite: 710 pass, 0 fail, 3,080 assertions across 41 files; lead reports root typecheck/build and both fixture typechecks pass. | Supersedes the prior failing gate for the tested working tree, not for a final release artifact. | Full suite independently rerun with the exact command below; static gates remain lead-reported.      |
| Cleanup                | Reset inventories sorted; shared sanitizer/deferred helpers reused; registration cleanup retained; obsolete prototype retired, net -876 lines.            | Fixes ordering defect and removes duplication without claiming cancellation/rollback.            | Current source/diffs inspected; retirement counts and fixture checks recorded in hardening artifact. |
| Docs/lock identity     | README uses V2 `plugin add` without `--global`; root lock name matches manifest.                                                                          | Corrects recorded syntax and identity defects, not install/bootstrap acceptance.                 | README, `bun.lock` and `package.json` inspected.                                                     |
| Pack/live evidence     | Lead reports 64-file pack dry-run; new staged host 2.0.12 live record is PASS.                                                                            | Confirms bounded native wiring, not clean installation or committed summarization.               | Dry-run lead-reported; live JSON independently inspected.                                            |
| Remaining release gaps | Clean production tarball install, final host compatibility, native committed multi-chunk update and release identity remain open.                         | NOT RC-ready; remaining acceptance checklist still applies.                                      | No closing evidence supplied.                                                                        |

Source references: `test/v2-reset-persistence.test.ts` sorts both recursive
inventories while preserving byte checks; `src/v2-memory-update.ts` calls shared
`sanitizeMessage`; `test/async-helpers.ts` supplies the five suites' deferred
scaffolding. `src/v2-status-command.ts` disposes acquired RPC registration on
command-registration failure and makes disposal idempotent; `src/index.ts`
retains adapter cleanup, with failure/disposal coverage in `test/v2-status.test.ts`.
The earlier 730-pass result preceded retirement of 20 prototype-only tests; the
final post-retirement result is 710 pass, 0 fail, with 3,080 assertions across 41
files. All six independent baseline tests and the production acceptance tests
remain intact, alongside the production harness and baseline validator. The
hardening artifact records its 2,717-to-1,841-line
reduction, fixture tests and typechecks:
`/home/dev/workspace/opencode-work/opencode-short-term-memory-v2-forced-update/2026-10-05--lean-release-hardening.html`.

Follow-up gate commands (full suite rerun for this edit; other commands are
recorded results above, **not rerun by this document**):

```bash
PATH=/home/dev/.bun/bin:$PATH bun test --isolate
PATH=/home/dev/.bun/bin:$PATH bun run typecheck
PATH=/home/dev/.bun/bin:$PATH bun run build
/home/dev/.bun/bin/bun node_modules/typescript/bin/tsc -p fixtures/v2-generation-probe/tsconfig.json
/home/dev/.bun/bin/bun node_modules/typescript/bin/tsc -p fixtures/v2-generation-probe/tui-output/tsconfig.json
/home/dev/.bun/bin/bun pm pack --dry-run --ignore-scripts
/usr/bin/timeout --kill-after=5s 100s /home/dev/.bun/bin/bun fixtures/v2-generation-probe/tui-output/production-acceptance.ts
```

New retained live evidence:
`/tmp/opencode/stm-production-commands-fvXKGG/evidence.json` has `verdict: "pass"`,
`failures: []`, 16 connected states and four absent-receiver refusals; it covers
all seven commands, accepted settled reset and post-reset status/update/logs.
`paidInference: false`, `costConsumed: 0`, `globalBudgetChanged: false`,
`tuiStopped: true` and server exit `130` record model-free execution and cleanup,
not paid-inference acceptance. The staged package still uses existing dependency
symlinks and a pinned cache generation. A 64-file dry-run creates no tarball and
does not close the production-only install gap. Native updates remain `no-model`
and `no_assistant_in_delta` with zero checkpointed chunks, not a successful
committed multi-chunk update. Final installed V1/minimum-V2 compatibility and
candidate version/changelog/commit/tarball identity still require qualification.

## Clean Tarball Follow-Up

**2026-10-05: NOT RC-ready; packaging does not fully pass.** This follow-up
preserves the historical sections above. The tested tarball was built from
`297317f`: `/tmp/opencode/stm-297317f-package.tgz`, SHA256
`6fc5267f7ef77efa10dbdf3d660c25146e5ac1cb367da7985f0cb4d08f45b8f0`.
The lead records normal pack lifecycle execution, including `prepare`, rather
than `--ignore-scripts`; that is not proof of supported host bootstrap.

| Component/Logic Block      | Current Findings/Hypothesis                                                                                                                     | Implications                                                                                  | Verification Status                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Production install/imports | Fresh isolated production install: 282 packages; all direct dependencies resolve inside the consumer; root, server, TUI and RPC exports import. | Closes the bounded install/runtime-import gap, not host activation.                           | PASS; final retained JSON inspected.                                        |
| Strict declarations        | Consumer exits 2 with seven diagnostics in upstream declarations.                                                                               | Public declaration closure still blocks package acceptance; ownership is split below.         | FAIL; final retained JSON inspected, matching the recorded earlier failure. |
| Lifecycle/trust            | Bun blocks one postinstall; `bun pm untrusted` exits 1 because no production lockfile exists.                                                   | Diagnostic unavailable; blocked package identity is not established. No trust changes.        | Install output and diagnostic stderr inspected.                             |
| Host/release acceptance    | No live host or supported install/bootstrap exercised by these package runs.                                                                    | Final host compatibility, committed multi-chunk update and release qualification remain open. | UNVERIFIED; inference cost 0, global budget unchanged.                      |

Final evidence: `/tmp/opencode/stm-package-acceptance-5CYWkU/evidence.json`.
Investigation artifact:
`/home/dev/workspace/opencode-work/opencode-short-term-memory-v2-forced-update/2026-10-05--clean-package-acceptance.html`.
The exact bounded package command was:

```bash
/usr/bin/timeout --kill-after=5s 190s /home/dev/.bun/bin/bun scripts/package-acceptance.ts /tmp/opencode/stm-297317f-package.tgz
```

Three bounded package executions occurred, not one: initial failure retained at
`/tmp/opencode/stm-package-acceptance-Bx4u7t`, intermediate diagnostic failure at
`/tmp/opencode/stm-package-acceptance-PGXov8`, and final hardened execution at
`/tmp/opencode/stm-package-acceptance-5CYWkU`. The final verdict is **FAIL** on
strict declarations, despite passing install/import gates. No acceptance run was
performed for this documentation edit.

**Declaration ownership:** two diagnostics originate in `@ai-sdk/provider` from
missing `@types/json-schema`; four originate in `@opencode/plugin` TUI declarations
from absent optional peers `@opencode/theme/tui`, `@opentui/core`,
`@opentui/solid` and `solid-js/store`; one originates in Effect
`4.0.0-beta.48` from undeclared `SchemaErrorTypeId`. These are upstream dependency
closure failures, but STM owns the public boundary exposing that closure and the
choice of dependency corrections needed for a strict production consumer.

**Next bounded unit:** the STM TUI owner should narrow only `src/tui.ts` to a
structural public boundary while preserving host assignability, then address
remaining upstream dependency corrections. Acceptance requires host assignability
checks and the same isolated strict consumer to pass on a newly identified
tarball. The recorded consumer uses `skipLibCheck: false`; suppressing declaration
checking is not a fix or an acceptance claim.

## References

- Prior readiness audit:
  `/home/dev/workspace/opencode-work/opencode-short-term-memory-v2-forced-update/2026-10-04--rc-readiness.html`.
- Investigation/decision context:
  `/home/dev/workspace/opencode-work/opencode-short-term-memory-v2-forced-update/2026-10-04--overlap-audit.html`
  and `2026-10-04--full-command-integration.html` in the same directory.
- Live record: `/tmp/opencode/stm-production-commands-KVzpJW/evidence.json`
  (especially `packageProof`, `limitations`, coverage, counts and final verdict).
  External HTML and temporary evidence are local references, not shipped artifacts;
  retain sanitized evidence with the final candidate for portable reproduction.
- Authoritative pinned OpenCode CLI
  [command specification](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/cli/src/commands/commands.ts),
  commit `2670273ff17da96f85c5826ced57aa1b368754fa`, `plugin` / `add` specification;
  source independently fetched on 2026-10-05, not inferred from README examples.
- Repository inspection: `package.json`, `CHANGELOG.md`, `README.md`,
  `test/v2-reset-persistence.test.ts`, `test/production-host-load-matrix.ts`,
  `src/v2-status-command.ts`, `src/v2-status-output.ts`, `git status --short`,
  `git diff --stat` and `.github/**/*` file search. No runtime/test/package edits,
  new build, live execution, commit or push were performed for this record.
