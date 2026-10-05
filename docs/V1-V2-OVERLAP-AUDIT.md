# V1/V2 Overlap Audit

Recorded: **2026-10-05**, against current working-tree sources, not an immutable
release artifact. **Keep separate orchestration before RC; consolidate targeted
helpers and common-invariant tests instead of merging a generic engine.** V2 is
neither an independent implementation of every primitive nor simply V1 behind a
new adapter. Release acceptance remains governed by [RC Readiness](RC-READINESS.md).

This is a source-verifying, read-only execution audit with one documentation
addition. No source, tests, package, reset version or runtime behavior was changed;
no tests, builds, live workflows, commits or pushes were executed for this report.
Existing worktree changes are outside this document's scope.

## Summary Table

| Component/Logic Block  | Current Findings/Hypothesis                                                                                      | Implications                                                                             | Verification Status                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Entry/runtime boundary | Dual entry; V1 uses operational RuntimeContract methods, V2 uses registration/disposal plus direct Context APIs. | A common interface does not imply a common engine.                                       | Source traced in index, adapters and consumers.                   |
| Shared primitives      | Config, template, paths, checkpoints, prompt, normalization and tagged rendering are reused.                     | Protect shared behavior with independent golden tests.                                   | Imports and call sites inspected.                                 |
| Orchestration          | Collector/filter/chunk/generation/commit/reset/delivery flows remain separate.                                   | Retain generation-specific policies and failure tests.                                   | Source control flow inspected; not executed.                      |
| Persisted state        | Shared checkpoint path; V1 does not enforce V2 reset boundaries.                                                 | Migration and simultaneous-host contract is missing; switching is not proven compatible. | Both reset/update paths inspected.                                |
| Size/test overlap      | Disjoint file categories measured; mixed utility files contain generation-specific code.                         | LOC is not a clone or duplication percentage.                                            | Reproducible wc counts verified.                                  |
| Consolidation strategy | Test scaffolding and exact sanitization duplication are safer targets than persistence or engine merging.        | Do not block RC on a broad merge; first improve independent evidence.                    | Ranked from source semantics, not runtime or performance results. |

## Actual Architecture

**Dual entry:** `src/index.ts:9-17` exports `SessionMemoryPlugin`, exposes it as
`server`, and separately constructs V2 injection/updater during `setup`.
`src/index.ts:18-43` registers context/compaction/tools/command and handles disposal.
`src/v1-adapter.ts:263-270` creates V1 hooks using its operational runtime.

**V1 contract is operational:** `src/v1-adapter.ts:150-240` maps reads, generated
prompts, no-reply delivery and temporary-session operations onto the V1 client.
Consumers include `src/message-collector.ts:91`, `src/summarizer.ts:239-321,334-342`
and `src/injection.ts:88-97`. V1 scheduling and lifecycle remain in
`src/session-memory.ts`, rather than in `src/runtime-contract.ts`.

**V2 contract is primarily registration/disposal:** `src/v2-adapter.ts:35-53`
marks all read/generation/temporary-session operations unsupported;
`src/v2-adapter.ts:150-204` implements those refusals and host registrations.
Operational calls instead use direct `Context`: `src/v2-current-history.ts:224-243`
reads durable history/current model, and `src/v2-memory-update.ts:269-274` calls
`context.session.generate` or `context.generate.text`. This is deliberately not
one engine executing both generations through the full contract.

**Verified reuse:** `readConfig`, `DEFAULT_CONFIG`, `STANDARD_MEMORY_TEMPLATE`,
`memoryPathFor`, `checkpointPathFor`, `ensureMemoryFile` and file primitives come
from `src/memory-utils.ts`. Both use `readLastProcessedMessageID` and
`writeLastProcessedMessageID` (`src/message-collector.ts:64-74`), as well as
`isLikelyInternalAssistantMessage` (`src/message-collector.ts:28-53`). V2 imports
these at `src/v2-memory-update.ts:1-20`; its filtering calls the classifier at 117.

Both reuse `buildMemoryPrompt`, `normalizeMemory`, and, through normalization,
`truncateMemoryLines` (`src/summarizer.ts:39-157`);
`buildTaggedMemoryForInjection` delegates to `compactMemoryForInjection`
(`src/injection.ts:25-30`, `src/summarizer.ts:190-225`). V2 injection imports and
calls the same renderer (`src/v2-context-injection.ts:3,18`). Shared formatting
includes the `<!-- stm:v1 -->` marker, not a new V2 memory schema.

**Separate orchestration:** V1 reads/sorts a bounded recent-message window,
optionally collapses assistant bursts, schedules debounced updates and manages
side sessions/retries. V2 projects settled durable history for explicit updates,
filters supplied context, enforces visible IDs and an assistant-delta gate,
fragments oversized entries, generates directly and reports cumulative progress.
Commit, reset and delivery policies also differ, as detailed below.

## Size Inventory

Physical `wc -l` counts include comments and blanks. Categories are disjoint by
filename, **not semantic responsibility or duplicate-code attribution**.

| Source category     | Files                                                                                                                                                                                                                                                       | Lines |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| Mixed utility files | memory-utils.ts, message-collector.ts, summarizer.ts, injection.ts                                                                                                                                                                                          | 1,601 |
| V1-specific files   | v1-adapter.ts, session-memory.ts, session-state.ts, memory-lifecycle.ts, commands.ts, tools.ts, config.ts, types.ts                                                                                                                                         | 2,063 |
| V2-specific files   | v2-adapter.ts, v2-context-injection.ts, v2-current-history.ts, v2-memory-command.ts, v2-memory-tools.ts, v2-memory-update.ts, v2-mutation-coordination.ts, v2-reset-boundary.ts, v2-reset-persistence.ts, v2-status-command.ts, v2-status-output.ts, tui.ts | 2,017 |
| Contract and entry  | runtime-contract.ts, index.ts                                                                                                                                                                                                                               |   209 |
| Total src/\*.ts     | All four categories above                                                                                                                                                                                                                                   | 5,890 |

The 1,601 lines are **not all reused**. Root shared/mixed files contain
generation-specific sections: V1 collection in `message-collector.ts:76-217`,
V1 side-session/active generation in `summarizer.ts:227-355`, V1 delivery in
`injection.ts:45-232`, and side-session tracking plus V2 reset-oriented raw-file
primitives in `memory-utils.ts:164-241,565-604`. No clone detector was run;
these measurements cannot support a LOC duplication percentage.

| Test/fixture category                   | Exact selection                                                                                |  Lines |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- | -----: |
| V1-oriented top-level tests             | Explicit list in command below, including runtime-contract.test.ts                             |  5,383 |
| V2 top-level tests                      | test/v2-\*.test.ts                                                                             |  5,143 |
| Shared utility test                     | test/memory-utils.test.ts                                                                      |    292 |
| Top-level support                       | test/test-helpers.ts, test/runtime-contract-v1-fixture.ts, test/production-host-load-matrix.ts |    336 |
| E2E tests                               | test/e2e/\*.test.ts                                                                            |  1,748 |
| E2E support                             | test/e2e/harness.ts                                                                            |    587 |
| Dual fixture                            | fixtures/v1-v2-dual-proof/\*.ts                                                                |    214 |
| V2 fixture and nested TUI support/tests | fixtures/v2-generation-probe/_.ts and tui-output/_.ts                                          | 11,046 |

Reproduce from the repository root; wildcards select the current inventory, so
later additions change totals. Fixture counts mix tests, probes and implementation;
they are not assertion counts, runtime coverage or redundant-test percentages.

```bash
wc -l src/memory-utils.ts src/message-collector.ts src/summarizer.ts src/injection.ts
wc -l src/v1-adapter.ts src/session-memory.ts src/session-state.ts src/memory-lifecycle.ts src/commands.ts src/tools.ts src/config.ts src/types.ts
wc -l src/v2-*.ts src/tui.ts
wc -l src/runtime-contract.ts src/index.ts
wc -l src/*.ts
wc -l test/compaction-drain.test.ts test/compaction.test.ts test/dcp-compress-e2e.test.ts test/delivery-conversion.test.ts test/integration-memory.test.ts test/lifecycle-safety.test.ts test/lru-eviction.test.ts test/memory-lifecycle.test.ts test/message-collector.test.ts test/runtime-contract.test.ts test/session-memory.test.ts test/side-sessions-cleanup.test.ts test/stress.test.ts test/summarizer-correctness.test.ts test/v1-adapter.test.ts
wc -l test/v2-*.test.ts
wc -l test/memory-utils.test.ts
wc -l test/test-helpers.ts test/runtime-contract-v1-fixture.ts test/production-host-load-matrix.ts
wc -l test/e2e/*.test.ts
wc -l test/e2e/harness.ts
wc -l fixtures/v1-v2-dual-proof/*.ts
wc -l fixtures/v2-generation-probe/*.ts fixtures/v2-generation-probe/tui-output/*.ts
```

## Ranked Consolidation Candidates

1. **Test sandbox/deferred/memory fixtures: low runtime risk, useful first cleanup.**
   Environment restoration repeats in `test/v2-context-injection.test.ts:43-69`;
   sandboxes recur in V1 lifecycle and collector suites. Deferred helpers recur in
   `test/v2-adapter.test.ts:15`, `test/v2-memory-update.test.ts:45`,
   `test/v2-reset-persistence.test.ts:50` and `test/lifecycle-safety.test.ts:8`.
   Extract only identical lifecycle mechanics or literal memory samples; keep
   generation-specific host/envelope factories separate. `test/test-helpers.ts`
   already contains V1-specific client/plugin construction, not a neutral V2 host.
   Await cleanup and preserve cwd/environment isolation rather than hiding it.
2. **sanitizeMessage: exact small runtime duplication.**
   `src/v2-memory-update.ts:105-107` repeats the two regex replacements and trim
   in `src/memory-utils.ts:725-730`. Reuse that helper after V2 text-part joining;
   do not substitute V1's permissive parts extraction for V2's text-only policy.
   First pin thinking-block removal and ordinary visible-text preservation.
3. **Raw-summary validation: common rejection intent, different policy.**
   V1 validates SDK assistant envelopes, nonempty text, header and template-marker
   rejection (`src/summarizer.ts:159-188`), then checks normalized structure
   (`src/memory-lifecycle.ts:176-187`). V2 validates generated text and requires
   all five headings (`src/v2-memory-update.ts:160-167`); marker regex handling
   also differs. Share only explicitly agreed checks, not a stricter validator
   silently applied to V1. Keep host response extraction outside a pure validator.
4. **Ordinary-entry packing: moderate risk, narrowly reusable.**
   Separator/length accumulation overlaps (`src/memory-lifecycle.ts:71-100`,
   `src/v2-memory-update.ts:136-158`). V1 truncates oversized input and advances
   its entry checkpoint; V2 uses lossless input fragments and checkpoints only
   after the final fragment. V2 also applies maxDeltaMessages per chunk, whereas
   V1 bounds the fetched window. A helper must exclude these semantic branches.
   Lossless fragments mean input reaches generation, not guaranteed model retention.
5. **Persistence helper: high risk; defer.**
   V1 uses instance-local lifecycle generations and per-session persistence tails
   (`src/session-memory.ts:123-169,485-499`). V2 owns process-local directory/session
   mutation coordination (`src/v2-mutation-coordination.ts:4-57`), compare-and-replace
   writes and conflict-aware rollback (`src/v2-memory-update.ts:275-305`). V2 reset
   stages three raw files with conditional restoration (`src/v2-reset-persistence.ts`).
   Superficially similar memory/checkpoint writes do not establish common lock,
   stale-work, partial-fragment, external-change or rollback contracts.
6. **Read/log/setup wrappers: low payoff.**
   Existing primitives already serve both (`src/commands.ts:101-117`,
   `src/v2-memory-tools.ts:44-48,281-290`). Preserve confirmation, authoritative
   identity, status vocabulary and host delivery shape; avoid a dispatch framework
   merely to replace a few calls to readText/tailLog/createProjectExampleConfig.

## Test Contract Matrix

Consolidate common expectations, not entire suites or unlike execution paths.

| Area                           | Consolidate common invariant tests                                                                         | Retain generation-specific semantics                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Prompt/normalization/rendering | Literal golden inputs and independently authored outputs; empty sections, marker/fence handling, clipping. | Host delivery shape, generation envelopes and raw-summary heading policy.                                 |
| Visible text                   | Thinking/injection exclusions and shared internal-assistant classifier examples.                           | V1 sorting/recent window/burst collapse; V2 durable projection, unique IDs and unfinished-history cutoff. |
| Model overrides                | No cross-generation override expectation.                                                                  | V1 parses configured override; V2 uses current model and lists memoryModel inactive.                      |
| Assistant gate                 | Preserve shared visible-text exclusion fixtures only.                                                      | V2 requires assistant in delta; V1 accepts any nonempty visible entries.                                  |
| Chunk limits/fragments         | Exact ordinary-entry ordering and separator accounting.                                                    | V1 fetch-window limit/truncation; V2 per-chunk limit/lossless fragments and partial progress.             |
| Cadence/delivery               | Tagged payload bytes and duplicate-tag exclusion.                                                          | V1 turns, revisions, noReply/DCP/debounce; V2 context/compaction system mutation.                         |
| Child sessions                 | No presumed shared inheritance behavior.                                                                   | V1 parent-memory snapshots and skipped child updates; V2 has no equivalent child orchestration.           |
| Reset/persistence              | Shared path/checkpoint serialization primitives.                                                           | V1 stale lifecycle invalidation; V2 anchor boundary, busy ownership and conditional rollback.             |

**Current evidence weaknesses:** `test/memory-lifecycle.test.ts:185-227` names a
truncation-marker test but checks only a memory header and one update, not the
marker in the generated prompt. Its 80-entry case (`106-183`) permits one input
budget of slack in aggregate characters and does not assert exact entry coverage
or final per-entry retention. Separator characters can also mask missing input.
Strengthen these claims rather than treating the tests as complete loss evidence.

`test/v2-context-injection.test.ts:75,83,99` sometimes computes expected output
with the same renderer used by production. These are useful wiring/path tests,
but cannot independently detect a renderer regression. Searches for
`buildMemoryPrompt|normalizeMemory|compactMemoryForInjection` in `test/**/*.ts`
and `fixtures/**/*.ts` found no direct references: no dedicated pure tests were
found for those helpers. Existing indirect assertions do not close that gap.

## State Compatibility And RC Decision

Both generations use `checkpoints/<safe-session-id>.last-message-id.txt`
(`src/memory-utils.ts:532-534`). V2 additionally persists a reset-boundary JSON
with **version 1** and an anchor (`src/v2-reset-persistence.ts:57-60`), enforcing
the boundary before filtering/checkpoint selection (`src/v2-memory-update.ts:206-235`).
V1 reset removes memory/checkpoint and recreates the template, while its collector
reads no V2 boundary (`src/session-memory.ts:191-200`, `src/message-collector.ts:76-185`).
V1 can therefore reintroduce pre-boundary history after a V2 reset. Its coordination
also does not join V2's mutation ownership. **Do not claim compatible state switching
or safe simultaneous hosts merely because paths and markdown are shared.** Define
migration/exclusive ownership separately; this report changes no reset version.

Before RC, prioritize independent golden tests for prompt, normalization and tagged
rendering, then harden weak V1 chunk assertions. Do not block RC on a broad engine
merge or test-suite rewrite; the concrete release gates in RC Readiness still apply.

**Next bounded recommended task:** test owner adds exactly one pure contract test
file, proposed `test/shared-memory-contract.test.ts`, with literal prompt,
normalization and tagged-rendering expectations, without runtime extraction.
Dependency: agree expected bytes, including current line-preserving truncation
behavior (which can exceed the nominal limit). Proposed validation:
`bun test --isolate test/shared-memory-contract.test.ts`. Acceptance: independent
oracles cover empty and populated memory, thinking/fences/version markers, section
compaction and clipping; expected outputs never call the function under test.
This is a recommendation, not an executed or authorized follow-up edit.

## Audit References

- Investigation artifact, read and existence-checked, not modified:
  `/home/dev/workspace/opencode-work/opencode-short-term-memory-v2-forced-update/2026-10-04--overlap-audit.html`.
- Inspection used Read on the source/test files cited above, Glob inventories for
  `src/**/*.ts` and `test/**/*`, targeted Grep on helper names and fixture patterns,
  and the wc commands above. Line references were verified in this working tree.
- Document-only checks: `test -f docs/V1-V2-OVERLAP-AUDIT.md`,
  `/home/dev/.bun/bin/bun node_modules/prettier/bin/prettier.cjs --check docs/V1-V2-OVERLAP-AUDIT.md`,
  `git diff --no-index --stat /dev/null docs/V1-V2-OVERLAP-AUDIT.md`, and
  `git diff --check`. A no-index addition diff normally exits 1; that means a
  difference exists, not validation failure. Ordinary git diff omits untracked docs.
  The direct Prettier launcher failed because Node is absent from PATH; Prettier
  was run with Bun instead, including document-only `--write` formatting.
