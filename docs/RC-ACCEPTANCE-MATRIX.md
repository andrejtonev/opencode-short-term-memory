# STM RC Acceptance Matrix

> **Archived acceptance inventory.** This document records RC5/RC6-era contracts and dated runs, not RC9 instructions or a current PASS matrix. Its uses of "current" and "latest" refer to those snapshots. V1 now has a native `/stm` menu with confirmed reset and paged results; Logs returns a path in both generations. Native V1 clean summaries expose tool definitions and block execution, so an advertised-tool-absence assertion is no longer the native V1 contract. Use the [current feature matrix](FEATURE-MATRIX.md), [README controls](../README.md#native-v1-controls-rc9) and [RC Readiness](RC-READINESS.md) for current behavior and exact release scope. Historical results below remain attributed to their original bytes.

> **Scope.** This is the source-grounded acceptance inventory for the RC5
> candidate, not a claim that every row has been run. `SOURCE` means the
> implementation or a stable contract was inspected; `UNIT` means a retained
> unit result; `NATIVE` means an exact host invocation; `PENDING` means that the
> scenario still needs an exact run record; `UNSUPPORTED` means the generation
> does not provide the capability. A row is not `PASS` merely because a related
> runner passed.

## Required coverage for both SDK generations (2026-10-20)

V1 and V2 identify the OpenCode SDK/plugin API generations targeted by STM.
Record the SDK/plugin package versions and the native host executable version
separately in each result. Both generations must receive the same breadth of
product acceptance testing against the same candidate package. A successful
V1 run does not qualify V2, and a host version number alone does not establish
which SDK integration was exercised.

| Required area                | Cases required for each SDK generation                                                                                                                                                                                                                          | Existing entry points                                                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation and isolation   | Public package loading, fresh config/data/cache, project/global setup, missing or invalid installation, repeat setup without overwriting user settings, owned-process cleanup.                                                                                  | `scripts/package-acceptance.ts`, `scripts/rc-setup-acceptance.ts`, both `scripts/published-v*-e2e.ts` runners.                                                                                                                               |
| Settings                     | All 17 fields; defaults, each config layer, JSON/JSONC precedence, malformed syntax, invalid values, clamps, model selection, hot reload, and observable behavior after a setting changes.                                                                      | The 16 shared cases in `scripts/rc-config-scenarios.ts`, executed for both generations by `scripts/rc-setup-acceptance.ts`; generation-specific behavioral tests.                                                                            |
| Ordinary keyboard use        | Literal typing and Enter; multiple user/assistant turns; clean and active generation; injection enabled/disabled; cadence; busy turns; follow-up context and visible output.                                                                                    | `scripts/rc-keyboard-chat.ts` and `scripts/rc-keyboard-driver.ts`. The four existing scenarios do not cover every required combination.                                                                                                      |
| Commands and tool calls      | Every `/stm` action, all eight public tool entry points and compatibility actions; read/status/settings/logs, update, setup, reset; confirmation refusal/acceptance, invalid arguments and missing session identity.                                            | Both `scripts/published-v*-e2e.ts` runners, shared tool cases in `fixtures/v2-generation-probe/index.ts`, command/TUI fixtures and adapter tests. Keyboard command evidence and model-issued tool-call evidence must be recorded separately. |
| Summary inputs and isolation | Retained memory plus incremental visible conversation and optional project context are supplied in the prompt; no additional lookup or delegation is required. Verify the provider tool surface, no recursive STM generation, and no internal memory artifacts. | V1 side-session lifecycle tests and native provider capture; V2 standalone/session generation tests and generation probe.                                                                                                                    |
| Lifecycle and persistence    | Idle/busy transitions, concurrent updates, late results, reset/delete during generation, restart, child inheritance, compaction, checkpoint advancement, failed persistence and recovery.                                                                       | Both native runners plus `test/lifecycle-safety.test.ts`, `test/v1-self-generation.test.ts`, `test/side-sessions-cleanup.test.ts`, and the corresponding `test/v2-*.test.ts` suites.                                                         |
| Model and input edge cases   | Empty/malformed output, transport errors, timeout/cancellation, retry/fallback, explicit/invalid model, empty history, missing/stale checkpoint, Unicode, large/chunked input and self-generated-message filtering.                                             | Shared memory/collector tests, V1 summarizer tests, V2 updater/history tests, and native fault scenarios where supported.                                                                                                                    |

The expected product invariant is shared; the API-specific assertion may differ.
For example, V1 clean generation uses disposable side sessions while V2 clean
generation uses standalone text generation. Test isolation and non-recursion
for both, without inventing a V2 side session. Similarly, model overrides,
confirmation rules, injection defaults, and reset behavior have documented
generation-specific semantics. Unsupported combinations require an explicit
refusal/skip assertion and a reason; they must not silently count as PASS.

For every required case, record V1 and V2 independently as PASS, FAIL, NOTRUN,
or UNSUPPORTED with a reason. Keep unit, native API, literal keyboard, and
real-model semantic evidence distinct. Capture the candidate hash, exact
SDK/plugin and host versions, settings, provider requests/tool calls, visible
output where applicable, memory/checkpoints, diagnostics, and cleanup outcome.
Deterministic provider tests establish integration behavior, not model quality.

The original native acceptance runners contain Linux dev-box paths and
dependencies (`tmux`, `/proc`, Linux host packages). The separate
[Windows Azure runner](WINDOWS-AZURE-ACCEPTANCE.md) now exercises a common
V1/V2 setup, settings, literal keyboard, model-tool, and clean-summary subset
in isolated roots. Transport health and the full settings/lifecycle matrix
remain separate gates; a functional journey does not qualify every row.
See the [2026-10-20 Windows findings](WINDOWS-AZURE-RESULTS-2026-10-20.md)
for the tested candidate and the retained failures.
Historical records below remain tied to their original artifacts; none qualify
the current uncommitted guard fixes. This section defines required coverage,
not a claim that the complete matrix has passed.

## Release identity and evidence rules

The comparison targets are V1 OpenCode `1.19.2` and V2 CLI `2.0.30`, resolved
from a fresh registry lookup. The current runtime source fix is committed at
`da960a11ea0f23d0325d0e9c91499d358de82a63`; no new release version is claimed.
The qualification artifact was executed before that fix was committed, using
the then-uncommitted source at `2b9bb226e942e7bccbd0443a8bf9eb08419b16b9`;
its recorded results and provenance remain unchanged. The published RC5
reference is the immutable hash
`d34558b13c38736315593f322bc6b5d7e16471c0301382ecc6549f73a5f69682`, without
those new fixes. The observed npm dist-tags are `rc: 1.4.0-rc.5` and
`latest: 1.3.0`; no `.npmrc` assertion is made here. The packaged README has a
stale published-scope statement and is not evidence for behavior below.

Existing exact-artifact records are linked from [RC Readiness](RC-READINESS.md)
and the source comparison from [FEATURE-MATRIX](FEATURE-MATRIX.md). They prove
only their recorded artifact and host. The final section is deliberately
reserved for the latest run and must be filled with run IDs, hashes, outputs,
cost and budget state; it must not be backfilled from inventory evidence.

| Component/Logic Block      | Current Findings/Hypothesis                                                                                                                                                                  | Implications                                                                                                                                          | Verification Status                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Settings and loading       | All 17 shared fields, defaults, clamps and precedence are implemented in `src/memory-utils.ts`; V1 and V2 interpret some fields differently.                                                 | Test equivalence classes and boundaries rather than the Cartesian product.                                                                            | SOURCE; exact host runs PENDING                                    |
| Tools and commands         | Eight public tools/actions exist, with literal-confirmation and parser differences between generations.                                                                                      | Assert schemas, refusal strings, persistence and receiver behavior separately.                                                                        | SOURCE; native expansion PENDING                                   |
| Installation               | Global/local and package/source routes have generation-specific loader contracts.                                                                                                            | Package install alone is not activation; each route needs an isolated smoke record.                                                                   | SOURCE; setup smoke PENDING                                        |
| Lifecycle and interactions | Update, injection, reset, compaction, child snapshots and deletion have distinct gates and fences.                                                                                           | A passing update does not prove reset, retry, late-write or privacy behavior.                                                                         | SOURCE/UNIT; broad NATIVE matrix PENDING                           |
| Current candidates         | V1 `1.19.2`, V2 `2.0.30`, local RC5 development patch with runtime fix `da960a1` versus published hash. Historical qualification ran against source `2b9bb22` before that fix was committed. | Never attribute historical execution to the current commit or the published artifact; harness `06ca52d6d519e7e1f4b9d327375f45f3e538fe59` is verified. | NATIVE; historical artifact retained; latest-run evidence recorded |

## Matrix legend and test dimensions

Every scenario has an ID so a runner can record one deterministic evidence
object per row. Dimensions should be selected from the listed equivalence
classes; do not multiply unrelated settings into an unbounded matrix.

- **Host:** V1 `1.19.2`, V2 `2.0.30`, fresh registry package, local RC5, or
  published hash.
- **Location:** global XDG/HOME config, project root, nested project, worktree,
  subdirectory, or explicit `OPENCODE_CONFIG_DIR`.
- **Mode:** `clean`, `active`, inherited model, valid override, malformed
  override, disabled, busy, no-model, unavailable history, and provider error.
- **Input:** empty/new session, settled user+assistant history, unfinished
  assistant, tool/internal-only records, long single entry, multi-chunk delta,
  continuation, reset boundary, and child session.
- **Action result:** completed, skipped, unavailable, refused, busy, invalid,
  provider error, partial progress, rollback, output failure, and late result.
- **Evidence:** record source file/line, exact command, artifact hash, host
  version, output, persistence diff, and cost/budget fields. A retained result
  must identify whether it was local or published.

## CFG — configuration, parsing and precedence

Sources: `src/memory-utils.ts` (`DEFAULT_CONFIG`, normalization, config search
and `readConfig`), `docs/FEATURE-MATRIX.md` configuration table, and
`stm.example.jsonc`. Boolean parsing accepts the source's recognized textual
forms; unrecognized, `null`, and absent values fall back to the field default.
Numeric values are integer-normalized; blank strings become numeric zero and
therefore clamp to the minimum, while non-finite/unparseable values fall back
to the default. Unknown keys are dropped.
`summarizerMode` is case-folded for `active`/`clean`, but surrounding spaces do
not make a padded value valid. A key typo is ignored. Current parser behavior
rejects a source file when `jsonc-parser` reports any recovery error, then
continues to an existing valid same-directory JSON fallback when one exists;
without any valid fallback, normal default resolution remains in effect. This
is strict whole-file rejection, not an always-disabled or fail-closed claim.

| ID      | Dimensions / setup                                                                                                 | Action                           | Expected result, persistence and negative case                                                                                                                                                                                                                                                                                       | Evidence                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| CFG-001 | Empty nearest `stm.jsonc` and no competing project `stm.json`                                                      | Load config                      | The empty object is a valid accepted project layer; it contributes no keys but still leaves previously merged global values intact. Do not assume HOME/XDG variables are absent.                                                                                                                                                     | SOURCE                                           |
| CFG-002 | Each boolean field: absent, native boolean, recognized string true/false, `null`, unknown string                   | Load config                      | Valid forms normalize; null/unknown/absent use that field's default.                                                                                                                                                                                                                                                                 | SOURCE; UNIT PENDING                             |
| CFG-003 | Each numeric field: blank, fractional, negative, below minimum, in range, above maximum, non-finite/string garbage | Load config                      | `Number(value.trim())` makes a blank string `0`, so blank values clamp to the field minimum, not the default. Non-finite/unparseable values use the default; valid values truncate and clamp. Bounds: retries 0–10; cadence 1–1000; memory 200–50000; input 500–200000; debounce 100–120000; logs 20–20000; delta messages 20–10000. | SOURCE (`memory-utils.ts:352-358`)               |
| CFG-004 | `summarizerMode` values `clean`, `active`, upper/mixed case, padded value, arbitrary value                         | Load config                      | Case-folded exact values select modes; padded/unknown values fall back to `clean`.                                                                                                                                                                                                                                                   | SOURCE                                           |
| CFG-005 | Valid field plus misspelled key                                                                                    | Load config and inspect settings | Misspelled key is ignored; valid field remains effective and unknown key is absent from resolved output.                                                                                                                                                                                                                             | SOURCE; UNIT PENDING                             |
| CFG-006 | Recoverable JSONC syntax error, comments/trailing syntax, unrecoverable object shape                               | Load config                      | Current behavior rejects the whole invalid source file when parser errors are reported. A valid same-directory JSON fallback may then be accepted; with no valid fallback, default resolution remains in effect. This does not claim every invalid configuration disables the feature.                                               | SOURCE; focused NATIVE PASS; unit verified       |
| CFG-007 | `$XDG_CONFIG_HOME/opencode`, fallback `~/.config/opencode`, then `~/.opencode`                                     | Load with no project file        | Global candidates are considered in documented order and later layers override earlier keys.                                                                                                                                                                                                                                         | SOURCE                                           |
| CFG-008 | `OPENCODE_CONFIG_DIR` plus global config                                                                           | Load config                      | Explicit config directory is a later layer; verify it overrides matching global keys.                                                                                                                                                                                                                                                | SOURCE; NATIVE PENDING                           |
| CFG-009 | Project root and nested project/subdirectory                                                                       | Load from nested cwd             | Nearest project `.opencode` is selected; nearer empty `.opencode` blocks an ancestor rather than merging it.                                                                                                                                                                                                                         | SOURCE; NATIVE PENDING                           |
| CFG-010 | Same directory contains both `stm.jsonc` and `stm.json`, including valid `{}` JSONC                                | Load config                      | The first accepted object is `stm.jsonc`; it shadows `stm.json` even when empty. Files are not merged.                                                                                                                                                                                                                               | SOURCE (`memory-utils.ts:420-426`); UNIT PENDING |
| CFG-011 | Higher layer has `{}` or a valid partial object while lower layer has values                                       | Load config                      | The higher layer overrides only keys it contains; an accepted empty object contributes no key but still prevents its same-directory alternate file from being considered.                                                                                                                                                            | SOURCE                                           |
| CFG-012 | No project file, then `stm.jsonc`, then setup-created file                                                         | Reload in V1 and V2              | V1 caches for up to 60,000 ms unless its force/reload path is used; V2 actions/hooks reread. Restart is the deterministic installed-host boundary.                                                                                                                                                                                   | SOURCE; NATIVE PENDING                           |
| CFG-013 | Relative `memoryDir`, changed process cwd, worktree and subdirectory                                               | Read/write memory                | Relative storage follows process cwd/filesystem resolution, not plugin location. Changing `memoryDir` does not migrate existing files. Capture both old and new paths.                                                                                                                                                               | SOURCE; NATIVE PENDING                           |
| CFG-014 | All 17 fields set simultaneously to valid values                                                                   | Inspect settings/status          | Every field is represented by resolved configuration; mode-dependent effects remain conditional and are not silently removed.                                                                                                                                                                                                        | SOURCE; NATIVE PENDING                           |
| CFG-015 | `enabled=false`, with manual read/reset/setup/status and automatic update                                          | Invoke each action               | Disabled gates automatic summarization/system injection, but does not disable all tools: read, reset and setup remain exposed.                                                                                                                                                                                                       | SOURCE; NATIVE PENDING                           |

### Native configuration sweep (planner cases)

The following 16 planner cases were run independently on both hosts. `N` is
the concrete observed setting value in the probe; it is included so the matrix
does not reduce native evidence to a generic “settings loaded” claim. The
configuration sweep contains 43 positive base probes plus two extra V1 hot-load
probes and one extra V2 hot-load probe: 46 native settings probes in total.

| ID                         | Host(s) | Setup and action                                                                                                           | Concrete expected/observed result                                                                                                                                                                                                                                                                                                              | Evidence                                     |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| CFG-N01 defaults           | V1, V2  | Fresh process with no configuration override; inspect all 17 settings                                                      | All real defaults are observed: reminder baseline/default `N=4`; no fabricated `N=2` baseline.                                                                                                                                                                                                                                                 | NATIVE PASS; setup evidence                  |
| CFG-N02 layer-home         | V1, V2  | XDG layer then HOME/global layer; inspect settings                                                                         | Layer probes observe `XDG N=2`, then `HOME N=3`; later layers have not yet been applied.                                                                                                                                                                                                                                                       | NATIVE PASS; setup evidence                  |
| CFG-N03 layer-env          | V1, V2  | HOME/global layer plus `OPENCODE_CONFIG_DIR`                                                                               | HOME remains `N=3`; environment layer overrides it with `N=5`.                                                                                                                                                                                                                                                                                 | NATIVE PASS; setup evidence                  |
| CFG-N04 layer-project      | V1, V2  | Global, HOME, environment, and nearest project layers                                                                      | Precedence is observed as global `N=2`, HOME `N=3`, environment `N=5`, project `N=7`.                                                                                                                                                                                                                                                          | NATIVE PASS; setup evidence                  |
| CFG-N05 jsonc-precedence   | V1, V2  | Project `stm.jsonc` sets `N=7`; project `stm.json` sets `N=9` and another key                                              | Accepted project JSONC wins with `N=7`; JSON's `N=9` and other values are ignored.                                                                                                                                                                                                                                                             | NATIVE PASS; setup evidence                  |
| CFG-N06 jsonc-empty        | V1, V2  | Project `stm.jsonc` is `{}`; project JSON sets `N=9`; inherited global is `N=2`                                            | Empty JSONC shadows project JSON; inherited global value remains `N=2`.                                                                                                                                                                                                                                                                        | NATIVE PASS; setup evidence                  |
| CFG-N07 jsonc-rejected     | V1, V2  | Project `stm.jsonc` is `[]`; project JSON sets `N=9`                                                                       | Non-object JSONC is rejected and JSON fallback is accepted with `N=9`.                                                                                                                                                                                                                                                                         | NATIVE PASS; setup evidence                  |
| CFG-N08 mode-typo          | V1, V2  | Only a misspelled project mode key; lower global mode is valid `clean`                                                     | Misspelled project key is ignored; valid lower global mode remains `clean`. No unsupported-value case is attributed to this scenario.                                                                                                                                                                                                          | NATIVE PASS; setup evidence                  |
| CFG-N09 mode-whitespace    | V1, V2  | Project mode is padded `active`; valid global model and absolute private path remain configured                            | Padded mode normalizes to `clean`; valid global model and absolute private path remain unchanged.                                                                                                                                                                                                                                              | NATIVE PASS; setup evidence                  |
| CFG-N10 normalization      | V1, V2  | Numeric bounds and boolean/string normalization, with padded valid model/path                                              | Observed values include reminder `1000`, retries `0`, max memory `200`, input `200000`, debounce `100`, logs `20000`, delta `60`; booleans normalize to enabled `false`, fallback `true`, AGENTS `false`, child `false`, legacy `true`, debug `false`, collapse `true`; padded valid model and private path trim.                              | NATIVE PASS; setup evidence                  |
| CFG-N11 invalid-overrides  | V1, V2  | Garbage numeric/boolean/model/path/mode values in project layer                                                            | Garbage reminder resets to default `N=4` even over global `N=2`; `debug=1` resets to default `false` even over global `true`; whitespace model becomes blank/default and whitespace path becomes default relative `memoryDir`; padded invalid mode becomes `clean`.                                                                            | NATIVE PASS; setup evidence                  |
| CFG-N12 model-invalid      | V1, V2  | Settings-only probe with nonempty `memoryModel="not-a-model"`, clean mode, disabled update path                            | Both V1 and V2 expose the invalid-model diagnostic in settings. No provider rejection, fallback, or summary-generation behavior is claimed because this case only exercises settings with updates disabled.                                                                                                                                    | NATIVE PASS; settings-only                   |
| CFG-N13 malformed-recovery | V1, V2  | **Historical qualification contract:** project partial/bad JSONC would otherwise set `N=9`; valid JSON fallback sets `N=8` | **Historical pre-strict-fix result:** the old 46-case candidate `855cebf94dd80b263bad94eab3ecab3b62931fec4ee96bbd2d875a288fa417d2` reproduced the known bug because parser recovery errors were ignored and partial JSONC behavior was observed. This row is retained unchanged as historical evidence; it is not the current parser contract. | Historical NATIVE PASS; old issue reproduced |
| CFG-N14 nearest-inherits   | V1, V2  | Launch from nested cwd; nearest project config sets `N=9` and parent project config exists                                 | Nested launch sees the nearest project value `N=9`, not the parent value.                                                                                                                                                                                                                                                                      | NATIVE PASS; setup evidence                  |
| CFG-N15 nearest-empty      | V1, V2  | Launch from nested cwd with an empty nearest `.opencode` directory and parent project value `N=9`                          | Empty nearest directory has no file but blocks the parent project; global value `N=2` is observed. No replacement or hot reload is attributed to this case.                                                                                                                                                                                    | NATIVE PASS; setup evidence                  |
| CFG-N16 hot-reload         | V1, V2  | Change config while host remains alive; inspect fresh sessions and PID                                                     | V1 has three probes: old `N=7`, then after 61 seconds new `N=11` clean in the same host PID. V2 has two probes and observes the new value immediately across fresh sessions.                                                                                                                                                                   | NATIVE PASS; V1/V2 hot cases                 |

Native setup evidence: `/home/dev/workspace/opencode-work/stm-readiness-improvements/rc-setup-9higiw/evidence.json`,
`complete: true`, 46 results, 14 setup cases (11 positive and 3 negative),
and 32 configuration cases. The source-only/bare-tar negatives recorded the
exact warning after shutdown and the silent package-directory/no-native-entry
behavior. A buggy read-only helper reported stdout `plugin_loaded=0` for hot
cases; that count is not used as identity evidence. Independent verification
found V1 STM log initialization count `1` in the same host PID. V2 does not log
`plugin_loaded`, so no zero-count claim is made for V2.

## SET — shared defaults and generation-specific meaning

The canonical defaults are: `enabled=true`, `memoryModel=""`, `summarizerMode`
`clean`, `cleanFallbackToActiveSession=false`, `includeAgentsMdOnFirstUpdate`
`false`, `injectInSubagents=true`, `enableLegacyPeriodicSystemTransform=false`,
`sideSessionRetries=1`, `remindEveryN=4`, `maxMemoryLength=10000`,
`maxUpdateInputLength=20000`, `debounceMs=1200`, `debug=false`,
`logMaxLines=300`, `maxDeltaMessages=200`, `collapseAssistantBursts=false`,
and `memoryDir=".opencode/memory"`.

The mode differences are intentional. V1 clean uses a temporary side session;
V2 clean uses standalone text generation. V1 active accepts a valid model
override; V2 active skips an override as unsupported. V1's legacy periodic
transform selects a delivery transport while V2's same-named flag gates all
system injection. V1 retry behavior is broad clean retry; V2 retries only
settled transient or malformed-output failures inside one shared 90-second
deadline.

| ID      | Dimensions / setup                                               | Action                              | Expected result, persistence and negative case                                                                                                          | Evidence               |
| ------- | ---------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| SET-001 | Defaults, V1 clean, empty model                                  | Automatic clean update              | V1 creates a side session and relies on host model resolution when no override is supplied.                                                             | SOURCE                 |
| SET-002 | Defaults, V2 clean, current session model                        | Automatic clean update              | V2 passes current input/history model to standalone text generation; no side session is created.                                                        | SOURCE                 |
| SET-003 | Valid `provider/model` override, clean                           | Update in both generations          | Override is used in clean mode.                                                                                                                         | SOURCE; NATIVE PENDING |
| SET-004 | Valid override, active                                           | Update V1 then V2                   | V1 supports it; V2 skips with `active_model_override_unsupported`.                                                                                      | SOURCE                 |
| SET-005 | Malformed nonempty override, V2                                  | Status/settings/update              | Settings expose invalid selection; update is unavailable/error without inventing a host model.                                                          | SOURCE                 |
| SET-006 | `sideSessionRetries=0`, then 1 and max 10                        | Inject deterministic clean failures | Attempt count is `1 + retries`, subject to generation-specific retryability/deadline.                                                                   | SOURCE; UNIT PENDING   |
| SET-007 | `maxMemoryLength` at min, default, max and oversized stored line | Normalize/store/inject              | It is a normalization/injection character target, not a strict stored-file byte ceiling; the crossing line and format marker may exceed it.             | SOURCE                 |
| SET-008 | `maxUpdateInputLength` and oversized entry                       | Update                              | V1 truncates oversized entry and checkpoints the tail loss; V2 fragments losslessly and checkpoints only after the final fragment.                      | SOURCE; NATIVE PENDING |
| SET-009 | `maxDeltaMessages` boundary and multi-chunk history              | Update                              | V1 bounds raw recent-history retrieval; V2 bounds entries per chunk, not total invocation.                                                              | SOURCE                 |
| SET-010 | `remindEveryN` 1, default 4, upper bound; continuation           | Primary injection                   | V1 and V2 count their documented admitted-turn units; V2 continuation remains eligible without being a new user.                                        | SOURCE; NATIVE PENDING |
| SET-011 | `debug=true`, sensitive prompt/memory                            | Update/inject and inspect log       | V1 may log full prompt/injected memory; V2 records metadata rather than new prompt/response bodies. Existing errors/old entries may still be sensitive. | SOURCE                 |
| SET-012 | `logMaxLines` below minimum, minimum, default, high value        | Append more than retention          | Effective minimum is 20; logs retain the latest shared lines, not a per-session view.                                                                   | SOURCE; UNIT PENDING   |

### Complete 17-field settings effect table

This is the per-key acceptance checklist. `provider` covers model, retry and
delivery behavior; `log` covers diagnostics/retention; `persist` covers memory,
checkpoint, boundary, snapshot and path effects.

| Key (default; bounds)                                    | V1 provider/action effect                                                             | V2 provider/action effect                                                                                                         | Log effect                            | Persistence effect                                                 | Evidence |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ | -------- |
| `enabled` (`true`; boolean)                              | Gates automatic update/delivery; manual controls remain exposed.                      | Gates summarization/system injection; tools remain exposed.                                                                       | Skip reason is diagnostic.            | Does not delete memory/checkpoint.                                 | SOURCE   |
| `memoryModel` (`""`; string)                             | Empty omits override; valid model works in clean/active; invalid is silently omitted. | Empty inherits in clean; valid is clean-only; invalid is operational failure `invalid_memory_model`; active override unsupported. | Selection appears in status/settings. | No model migration.                                                | SOURCE   |
| `summarizerMode` (`clean`; mode)                         | Clean temporary side session; active current session.                                 | Clean standalone text; active session generation.                                                                                 | Mode appears in outputs.              | V1 clean tracks side sessions.                                     | SOURCE   |
| `cleanFallbackToActiveSession` (`false`; boolean)        | Active fallback after clean failures.                                                 | One fallback only after settled retryable failure, no override and time remaining.                                                | Fallback/skips logged.                | No persistence until commit.                                       | SOURCE   |
| `includeAgentsMdOnFirstUpdate` (`false`; boolean)        | Bounded project reference in first no-checkpoint update.                              | Bounded reference in first eligible chunk.                                                                                        | Inclusion is diagnostic.              | Reference is not stored as instruction.                            | SOURCE   |
| `injectInSubagents` (`true`; boolean)                    | Creation-time parent snapshot delivery.                                               | First-eligible-read durable child snapshot, also requiring injection opt-in.                                                      | Snapshot failures fail closed.        | V1 startup snapshot; V2 frozen child snapshot.                     | SOURCE   |
| `enableLegacyPeriodicSystemTransform` (`false`; boolean) | Selects legacy transform versus no-reply; ordinary injection remains enabled.         | Opts in to all system/context injection; updates remain independent.                                                              | Delivery mode shown.                  | No deletion when false.                                            | SOURCE   |
| `sideSessionRetries` (`1`; 0–10)                         | Broad clean attempts, total `1 + value`.                                              | Typed transient/malformed-output attempts in either mode within one deadline.                                                     | Attempts/failures logged.             | Only committed chunks persist.                                     | SOURCE   |
| `remindEveryN` (`4`; 1–1000)                             | Primary cadence over V1 eligible turns.                                               | Cadence over admitted distinct users, not child/compaction cadence.                                                               | Claims/counters diagnostic.           | Process-local state can reset/evict.                               | SOURCE   |
| `maxMemoryLength` (`10000`; 200–50000)                   | Normalization/injection character target, not strict stored limit.                    | Same plus snapshot bounds, not byte limit.                                                                                        | Sizes diagnostic.                     | Crossing line and marker may exceed target.                        | SOURCE   |
| `maxUpdateInputLength` (`20000`; 500–200000)             | Chunk target; oversized entry tail truncates and checkpoints.                         | Chunk target; oversized entry fragments losslessly; final fragment checkpoints.                                                   | Partial progress reports fragments.   | V1 may lose tail; V2 preserves it.                                 | SOURCE   |
| `debounceMs` (`1200`; 100–120000)                        | Idle/debounce and duplicate/drain windows.                                            | Terminal-event idle scheduling.                                                                                                   | Replay/debounce logged.               | V1 pending replay can remain; V2 ownership explicit.               | SOURCE   |
| `debug` (`false`; boolean)                               | May log full prompt/injected memory.                                                  | New diagnostics log metadata, not bodies.                                                                                         | Changes sensitivity.                  | Does not change memory.                                            | SOURCE   |
| `logMaxLines` (`300`; 20–20000)                          | Shared append-log retention.                                                          | Same shared retention.                                                                                                            | `/stm logs` tails latest 120.         | Log is under `memoryDir`.                                          | SOURCE   |
| `maxDeltaMessages` (`200`; 20–10000)                     | Raw recent-history retrieval limit.                                                   | Visible entries per chunk, not total invocation.                                                                                  | Count/progress differs.               | Checkpoint follows truncation/final fragment.                      | SOURCE   |
| `collapseAssistantBursts` (`false`; boolean)             | Keeps last consecutive visible assistant reply when enabled.                          | Same after eligibility checks.                                                                                                    | Decision diagnostic.                  | Changes input selection only.                                      | SOURCE   |
| `memoryDir` (`.opencode/memory`; string)                 | Memory/checkpoint/log/side-session paths.                                             | Memory/checkpoint/log/boundary/child paths.                                                                                       | Log path follows it.                  | Changing it does not migrate old files; relative path follows cwd. | SOURCE   |

### Status and settings output contracts

V1 `statusText` emits the heading `# Session Memory Plugin Status` and these
fields: `enabled`, `activeSessionID`, `memoryModelSelection`, `memoryModel`,
`summarizerMode`, `cleanFallbackToActiveSession`, `includeAgentsMdOnFirstUpdate`,
`injectInSubagents`, `effectiveDeliveryMode`, `sideSessionRetries`,
`remindEveryN`, `maxDeltaMessages`, `memoryDir`, `debug`, `memoryBytes`,
`updateCount`, `injectCount`, `injectCharCount`, `compactCount`,
`memoryRevision`, `deliveryClaimPending`, `childStartupInjectionPending`,
`childDcpInjectionPending`, `mainDcpDeliveryPending`, `lastUpdateAt`,
`lastInjectAt`, `startupWarning`, `lastError`, `memoryPath`, and `logPath`
(`src/commands.ts:53-91`). V1 `settings` is flattened JSON containing all
config keys plus `memoryModelSelection` and `effectiveDeliveryMode`
(`commands.ts:106-116`).

V2 status emits `generation`, `enabled`, authoritative `sessionID`, configured
and effective model fields, `memoryModelSelection`, `summarizerMode`, paths for
memory/checkpoint/reset boundary, boundary state and optional anchor, reset
policy, UTF-8 `memoryBytes`, checkpoint, and `updaterBusy`
(`v2-memory-tools.ts:86-132`). V2 settings contains `generation`, complete
`resolvedConfig`, `effective`, and `inactiveSettings`. The effective object
includes model selection, `activeWithExplicitMemoryModel`, all configured
effects, `updateHook: "context"`, and `injectionHooks: ["context", "compaction"]`;
`inactiveSettings: []` does not remove conditional gates
(`v2-memory-tools.ts:284-316`).

| ID       | Setup                                                | Action   | Expected result                                                                                                                             | Evidence                       |
| -------- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| STAT-001 | V1 session with counters/child flags                 | Status   | Assert every V1 field above and JavaScript string-length `memoryBytes`.                                                                     | SOURCE; NATIVE PENDING         |
| STAT-002 | V2 Unicode memory and valid boundary                 | Status   | Assert every V2 field above and UTF-8 byte `memoryBytes`, including anchor/state.                                                           | SOURCE; NATIVE PENDING         |
| STAT-003 | V1/V2 nonempty invalid model override, settings-only | Settings | Both generations expose invalid-model diagnostics; this settings probe does not claim provider rejection, fallback, or generation behavior. | SOURCE; NATIVE PASS in CFG-N12 |

## TOOL — all eight tools and action schemas

The public tools are `stm_memory_read`, `stm_memory_status`,
`stm_memory_update`, `stm_memory_logs`, `stm_memory_settings`,
`stm_memory_reset`, `stm_memory_setup`, and `short_term_memory`. V1 granular
reset uses a literal `true`; V1 compatibility reset retains shipped behavior
and does not require confirmation, though the warning should remain. V2
granular and compatibility reset require literal `true`. V2 compatibility action
is an enum and is case-sensitive; V1 action handling lowercases but does not
trim. The exact output strings must be asserted from `src/commands.ts`,
`src/tools.ts`, `src/v2-memory-tools.ts`, and `src/v2-memory-command.ts`, never
invented from this matrix.

| ID        | Dimensions / setup                                                     | Action                     | Expected result, persistence and negative case                                                                                                                                                                             | Evidence                                                     |
| --------- | ---------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| TOOL-001  | Fresh session, missing memory file                                     | `stm_memory_read` / `show` | Creates the blank/template memory file and returns it; this is not an update.                                                                                                                                              | SOURCE; NATIVE PENDING                                       |
| TOOL-002  | Existing memory/checkpoint                                             | `read` then `status`       | Read is pull-first and does not require injection or an available model.                                                                                                                                                   | SOURCE                                                       |
| TOOL-003  | Valid session                                                          | `stm_memory_status`        | V1 reports runtime counters, mode and paths; V2 reports authoritative session, configured/effective model selection, UTF-8 bytes, checkpoint, reset boundary and busy state.                                               | SOURCE                                                       |
| TOOL-004  | Unicode memory                                                         | Status                     | V1 byte field follows JavaScript string length; V2 `memoryBytes` is UTF-8 byte length.                                                                                                                                     | SOURCE                                                       |
| TOOL-005  | Any log history                                                        | `stm_memory_logs`          | Returns the final 120 shared lines, not an invented per-session subset.                                                                                                                                                    | SOURCE                                                       |
| TOOL-006  | Resolved config, valid clean override, active override                 | `settings`                 | V1 returns flattened resolved settings/model selection; V2 returns resolved config/effective declarations including `null` plus selection states.                                                                          | SOURCE                                                       |
| TOOL-007  | Update with settled delta                                              | `stm_memory_update`        | V1 returns stored memory after its attempt; V2 returns status/reason/cumulative progress and requires a separate read for memory.                                                                                          | SOURCE                                                       |
| TOOL-008  | V2 update with fresh history then disabled config                      | Update                     | Fresh durable history is read first; disabled state then controls update. A no-model result may precede disabled handling where source ordering requires it.                                                               | SOURCE; NATIVE PENDING                                       |
| TOOL-009A | V1 busy update/idle lifecycle                                          | Update                     | V1 can retain a pending replay after an in-flight update; verify the debounced replay rather than asserting universal refusal.                                                                                             | SOURCE (`session-memory.ts:123,762,942-945`); NATIVE PENDING |
| TOOL-009B | V2 busy update                                                         | Update/reset mutation      | V2 returns `update: busy`, `reason: update_in_flight`, `progress: not-started`, and does not queue a second tool update.                                                                                                   | SOURCE (`v2-memory-tools.ts:228-237`); NATIVE PENDING        |
| TOOL-010  | Invalid, unavailable, provider-error, malformed-output update          | Update                     | Output identifies invalid/unavailable/error and source; counters and partial fragments are truthful; checkpoint/memory rollback is reported where applicable.                                                              | SOURCE; NATIVE PENDING                                       |
| TOOL-011  | V1 reset command/compat tool without confirm                           | Reset                      | Shipped V1 behavior does not require confirmation; preserve warning semantics and do not retrofit V2 policy.                                                                                                               | SOURCE                                                       |
| TOOL-012  | V1 granular reset `confirm` absent, false, truthy string, literal true | Reset                      | The V1 schema itself is `tool.schema.literal(true)`; only literal true is accepted and other values refuse without mutation.                                                                                               | SOURCE (`tools.ts:66-76`)                                    |
| TOOL-013  | V2 reset tool `confirm` absent/false/true/nonboolean                   | Reset                      | The V2 schema accepts a boolean property, while runtime requires `confirm === true`; schema acceptance and runtime confirmation are separate checks.                                                                       | SOURCE (`v2-memory-tools.ts:30-35,362-381`)                  |
| TOOL-014  | V2 compatibility reset absent/false/true/case variant                  | Reset                      | Compatibility input declares boolean `confirm`; runtime requires literal boolean true and a message ID. Action enum values are case-sensitive.                                                                             | SOURCE (`v2-memory-tools.ts:43-54,420-447`)                  |
| TOOL-014  | Reset while busy or unfinished/unavailable snapshot                    | V2 reset                   | Refuses without mutation; reset anchor is last settled snapshot record, not invocation message.                                                                                                                            | SOURCE                                                       |
| TOOL-015  | V1 reset then update                                                   | Reset/update               | No forward boundary exists; available history may replay subject to look-back.                                                                                                                                             | SOURCE                                                       |
| TOOL-016  | V2 command reset versus granular tool reset                            | Reset/update               | Command anchors through last settled durable snapshot; tool anchors invocation message. Forward processing pauses if anchor is absent.                                                                                     | SOURCE                                                       |
| TOOL-017  | Setup with no confirmation, false, literal true                        | `setup`                    | Guidance/refusal without creation unless confirmed; confirmed setup creates project-local `.opencode/stm.jsonc` and does not overwrite existing JSON/JSONC.                                                                | SOURCE; setup NATIVE PENDING                                 |
| TOOL-018  | V2 `short_term_memory` actions all seven enum values                   | Compatibility tool         | Exact action enum succeeds; unknown/case-variant action is rejected.                                                                                                                                                       | SOURCE                                                       |
| TOOL-019  | V1 compatibility action with leading/trailing spaces or uppercase      | Compatibility tool         | Lowercasing occurs but trimming does not; record the exact shipped rejection/dispatch behavior.                                                                                                                            | SOURCE; UNIT PENDING                                         |
| TOOL-021  | V1 no active session, read/status/setup/logs                           | V1 tool/action             | V1 action resolution can use the last active session; show/reset/update require an active ID and return the exact source string `No active session ID found yet. Send one chat message, then run this again.` when absent. | SOURCE (`commands.ts:131-134`); NATIVE PENDING               |
| TOOL-022  | V2 empty/path-unsafe authoritative session ID                          | Read/status/update/reset   | V2 explicitly requires a nonempty path-safe ID. Update returns structured `reason: invalid_session_id`; read/status throw their exact source errors.                                                                       | SOURCE (`v2-memory-tools.ts:75-88,215-225`)                  |
| TOOL-023  | V1 session ID that `safeSessionID` canonicalizes                       | Read/write                 | Do not apply V2's strict equality claim to V1; V1 path construction uses the canonical safe-session transformation. Verify the resulting path and no traversal.                                                            | SOURCE; NATIVE PENDING                                       |

## CMD/TUI — command admission, output and lifecycle protocol

V2 parsing is in `src/v2-memory-command.ts`; delivery and receiver behavior are
in `src/v2-status-command.ts` and `src/tui.ts`. Every command requires receiver
admission, including reads and guidance. An absent or mismatched receiver has a
three-second admission limit and performs no action. Mutating completion has a
120-second limit; output acknowledgment has a three-second limit. Dialog output
is capped at 16,384 JavaScript characters, with a suffix, not a byte cap and not
a headless limit. A busy old STM dialog is dismissed before the next command.

| ID      | Dimensions / setup                                               | Action                                    | Expected result, persistence and negative case                                                                                                                                                                                             | Evidence                                                        |
| ------- | ---------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| CMD-001 | Matching receiver/session/workspace                              | `/stm status`, `show`, `logs`, `settings` | Admission succeeds; action runs natively without model-mediated display.                                                                                                                                                                   | SOURCE; NATIVE PENDING                                          |
| CMD-002 | No receiver, wrong session, wrong project/workspace              | Any command                               | No action is invoked after about 3 seconds; persistence is unchanged.                                                                                                                                                                      | SOURCE; NATIVE PENDING                                          |
| CMD-003 | Mutating update/reset/setup                                      | Command completion                        | 120-second completion deadline; timeout/output failure does not imply mutation rollback. Inspect state before retry.                                                                                                                       | SOURCE                                                          |
| CMD-004 | Large Unicode result                                             | Any dialog output                         | Truncates at 16,384 JS characters with explicit suffix; it is not a byte or headless limit.                                                                                                                                                | SOURCE; UNIT PENDING                                            |
| CMD-005 | Existing STM dialog busy                                         | New command                               | Old dialog is dismissed before next command; unrelated dialog cleanup is not promised.                                                                                                                                                     | SOURCE; NATIVE PENDING                                          |
| CMD-006 | Negative session ID, attachments, uppercase V2 confirm           | Parse command                             | Invalid session and attachments reject. V2 action is lowercased, but `confirm` tokens are case-sensitive (`true` only); exact usage/refusal text is asserted from parser.                                                                  | SOURCE (`v2-memory-command.ts:19-39`)                           |
| CMD-007 | V1 first token uppercase, extra tokens, setup/reset confirmation | Parse V1 action                           | V1 trims and lowercases, dispatches the first whitespace token, and ignores later tokens through its action parser. Setup/reset unconfirmed requests retain shipped guidance; command semantics are not replaced by V2 confirmation rules. | SOURCE (`commands.ts:17-23,103-126`)                            |
| CMD-008 | V2 unknown action, extra arguments, attachments                  | Parse command                             | V2 rejects unknown actions and unexpected arguments; setup/reset require exactly `confirm true`; read/status/logs/settings/update require exactly one action token.                                                                        | SOURCE (`v2-memory-command.ts:26-57`)                           |
| CMD-009 | Output delivery failure after successful mutation                | Command                                   | Action may continue or complete; output failure does not imply abort or rollback. Subsequent status reveals whether mutation completed.                                                                                                    | SOURCE (`v2-status-command.ts:118-130,194-197`); NATIVE PENDING |
| CMD-010 | Same-server second client or forged receiver correlation         | Command/RPC                               | Correlation is not authorization; trust is single-user/server scoped and no multi-user isolation is claimed.                                                                                                                               | SOURCE                                                          |

## INS — installation and setup variants

Installation acceptance must separate loading from package installation. The
observed registry target is RC5 under `rc` and `1.3.0` under `latest`; moving
`rc` or using `latest` is a different artifact. A named-file tarball route is a native
candidate; a package install without activation is not a pass. V1 uses a global
or local plugin route and a singular `plugin` configuration key. V2 uses
`plugins` in global server `opencode.json` and global CLI `cli.json`, tested
separately. V2 configured source-file loading warns/skips where a directory is
required; autodiscovered standalone plugin files may be possible. Do not add a
compatibility adapter to make an unsupported route pass.

Windows OpenCode 2.0.32 verification (2026-10-20): a checkout directory loads
through server `opencode.json`, but `plugin add` rejects local directories and
files and requires an npm registry or Git package specifier. `--global` is also
rejected. These native negative CLI checks do not qualify registry installation;
see the [Windows results](WINDOWS-AZURE-RESULTS-2026-10-20.md).

| ID      | Dimensions / setup                                                                   | Action                                        | Expected result, persistence and negative case                                                                                                                                                                                                                                | Evidence               |
| ------- | ------------------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| INS-001 | Fresh registry install of exact RC5/latest target                                    | Install package only                          | Package resolves exact bytes/version; no activation claim until server, TUI and RPC loading are observed.                                                                                                                                                                     | PENDING                |
| INS-002 | V1 global plugin                                                                     | Configure global plugin and restart V1        | Plugin loads and public tools/commands are visible.                                                                                                                                                                                                                           | PENDING                |
| INS-003 | V1 local plugin                                                                      | Configure project-local plugin and restart V1 | Local plugin loads for nearest project; unrelated project does not inherit it.                                                                                                                                                                                                | PENDING                |
| INS-004 | V2 global server `opencode.json`                                                     | Add package under `plugins`, restart server   | Server loads; preserve pre-existing entries.                                                                                                                                                                                                                                  | PENDING                |
| INS-005 | V2 global CLI `cli.json`                                                             | Add package under `plugins`, restart CLI/TUI  | TUI loads; server-only success is insufficient.                                                                                                                                                                                                                               | PENDING                |
| INS-006 | `opencode plugin add <package>` versus legacy `plugin add --global`                  | Run exact CLI route                           | V2 supported route is `plugin add <package>`; legacy `--global` form is a negative/documentation case.                                                                                                                                                                        | SOURCE; NATIVE PENDING |
| INS-007 | Named RC5 tarball file                                                               | Configure exact named file                    | Candidate route may load natively; record tarball hash and all exports.                                                                                                                                                                                                       | PENDING                |
| INS-008 | `plugin add` pointed at a file                                                       | CLI add named file                            | Rejection is expected if CLI requires a package spec/directory; do not relabel as product failure without CLI evidence.                                                                                                                                                       | SOURCE; NATIVE PENDING |
| INS-009 | V2 configured source file versus source directory                                    | Configure each                                | Configured source file warns/skips when directory required; autodiscovered standalone source plugin remains a separate candidate.                                                                                                                                             | SOURCE; NATIVE PENDING |
| INS-010 | Unnamed checkout directory                                                           | Start host from checkout                      | Physical index/server resolution is not export resolution; unqualified source TUI/RPC loading is unsupported unless observed. A headless tool may still be able to use a safe/canonicalized session ID and create its memory file without proving that a host session exists. | SOURCE; NATIVE PENDING |
| INS-011 | V1 `src/index` universal definition; V1 adapter multi-export; root adjacent manifest | Load each                                     | `src/index` is the universal source definition; adapter multi-export is risky; root adjacent manifest may resolve `dist`, not source. Record failures, no adapter.                                                                                                            | SOURCE; NATIVE PENDING |
| INS-012 | Bun link/symlink                                                                     | Install/restart                               | Unproved until exact native run records resolution and loaded bytes.                                                                                                                                                                                                          | PENDING                |
| INS-013 | Global and local duplicate V1 npm name                                               | Restart V1                                    | Last merged definition wins.                                                                                                                                                                                                                                                  | SOURCE; NATIVE PENDING |
| INS-014 | V2 duplicate package ID on later boot                                                | Restart V2                                    | First boot may load; later duplicate ID fails as observed by host contract.                                                                                                                                                                                                   | SOURCE; NATIVE PENDING |
| INS-015 | Old cache same tar path, then immutable fresh path                                   | Restart process and new session               | Restart does not guarantee new bytes from old cache/path; use a fresh immutable path and record digest.                                                                                                                                                                       | SOURCE; NATIVE PENDING |
| INS-016 | Worktree/subdir nearest config                                                       | New process/session                           | Capture process cwd, selected nearest config, loaded package hash and TUI/RPC exports.                                                                                                                                                                                        | PENDING                |
| INS-017 | Setup smoke, all source/package variants                                             | Run setup then inspect                        | Setup variants need native smoke coverage; no setup row is assumed PASS from source inspection.                                                                                                                                                                               | PENDING                |

## INT — updates, injection, retries, children, compaction and reset

| ID      | Dimensions / setup                                            | Action                                       | Expected result, persistence and negative case                                                                                                                                                                          | Evidence                                             |
| ------- | ------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| INT-001 | Active mode, self-generated loop, same fingerprint            | Automatic update after bootstrap/idle/replay | New fixes suppress unchanged automatic retry after any failed active attempt; changed config/new data/manual update may allow it.                                                                                       | SOURCE; NATIVE PENDING                               |
| INT-002 | Genuine user turn followed by busy status                     | Automatic update                             | Busy status waits/does not hijack the user turn; session-created/updated bootstrap gates remain respected.                                                                                                              | SOURCE; NATIVE PENDING                               |
| INT-003 | Clean failure, retries 1, broad V1 failure                    | Clean update                                 | V1 attempts once plus retry and broadly retries caught clean failures within its behavior.                                                                                                                              | SOURCE                                               |
| INT-004 | V2 typed transient/malformed failure, shared deadline         | Clean/active update                          | Typed retry only, with one 90-second shared deadline; no abort guarantee for already-started host work.                                                                                                                 | SOURCE                                               |
| INT-005 | Blank model, fresh host                                       | Clean update                                 | V1 uses host side-session resolution; V2 uses current model for clean.                                                                                                                                                  | SOURCE                                               |
| INT-006 | Valid active override                                         | Active update                                | V1 supports; V2 skips as unsupported and does not silently use it.                                                                                                                                                      | SOURCE                                               |
| INT-007 | V2 default injection flag false, automatic updates            | Update then context hook                     | Automatic update remains independent; system injection remains off.                                                                                                                                                     | SOURCE                                               |
| INT-008 | Two admitted distinct users versus one continuation           | Injection cadence                            | V2 requires distinct admitted users, not merely one user plus continuation; continuation eligibility is preserved.                                                                                                      | SOURCE; NATIVE PENDING                               |
| INT-009 | Parent and task child                                         | Child first eligible context read            | V1 freezes startup snapshot; V2 persists first eligible durable snapshot, never child summary; V2 fork is classified primary.                                                                                           | SOURCE; NATIVE PENDING                               |
| INT-010 | Parent changes after child snapshot                           | Child injection                              | Frozen snapshot does not change; lineage/snapshot failure skips fail-closed.                                                                                                                                            | SOURCE                                               |
| INT-011 | Pre-compaction with injection disabled/enabled                | Compaction hook                              | Refresh is independent of injection; opted-in injection uses stored memory on skipped/failed/busy refresh and does not wait for updater.                                                                                | SOURCE; NATIVE PENDING                               |
| INT-012 | DCP event with origin agent/model/tools/noReply               | V1 compress path                             | V1 DCP records origin metadata for the primary update and redelivery. Missing/stale origin skips the DCP reinjection rather than borrowing another context; it does not categorically forbid an ordinary memory update. | SOURCE (`session-memory.ts:535-589`); NATIVE PENDING |
| INT-013 | DCP event on V2                                               | Compress path                                | No DCP trigger exists; mark unsupported, not failed.                                                                                                                                                                    | UNSUPPORTED                                          |
| INT-014 | Reset/delete generation fence then late provider result       | Complete provider call                       | Tombstone/generation fence prevents late local writes; cancellation is not provider abort and host work may continue.                                                                                                   | SOURCE; NATIVE PENDING                               |
| INT-015 | `includeAgentsMdOnFirstUpdate=true`, first chunk              | Update                                       | `AGENTS.md` reference is included only in the first eligible chunk and source-defined bounded form.                                                                                                                     | SOURCE; NATIVE PENDING                               |
| INT-016 | Long line over max memory                                     | Normalize/store                              | Line-preserving target may exceed nominal max; do not assert strict stored limit.                                                                                                                                       | SOURCE                                               |
| INT-017 | Oversized single entry V1/V2                                  | Update                                       | V1 tail truncation/checkpoint; V2 lossless fragments/final checkpoint.                                                                                                                                                  | SOURCE; NATIVE PENDING                               |
| INT-018 | Debug on, sensitive prompt                                    | Update/log                                   | V1 may expose full prompt; V2 metadata-only new diagnostic output.                                                                                                                                                      | SOURCE                                               |
| INT-019 | Log writes beyond configured minimum                          | Logs                                         | Retention never drops below 20 lines; `/stm logs` returns latest 120 shared lines where available.                                                                                                                      | SOURCE                                               |
| INT-020 | Reset command, reset tool, missing/duplicate anchor           | Reset then update                            | Command uses settled snapshot anchor; tool uses invocation anchor; absent anchor pauses forward processing and does not replay past reset.                                                                              | SOURCE; NATIVE PENDING                               |
| INT-021 | Partial multi-chunk success then later provider error         | Update                                       | Persisted completed chunks remain reported; uncheckpointed fragments, rollback and counters are truthful.                                                                                                               | SOURCE; NATIVE PENDING                               |
| INT-022 | V2 task child created versus V2 primary fork                  | First eligible child context                 | A task child uses the first eligible durable parent snapshot and never summarizes; a V2 fork is classified as a primary session and must be tested separately rather than treated as a task child.                      | SOURCE; NATIVE PENDING                               |
| INT-023 | V1 active failure with fallback enabled and explicit override | Retry/fallback                               | V1 clean fallback may retain the configured override according to its source path; V2 clean fallback is forbidden with an explicit override, requires time remaining, and only follows settled retryable failure.       | SOURCE; NATIVE PENDING                               |
| INT-024 | V2 invalid `memoryModel` override                             | Update                                       | Invalid override produces operational failure with exact detail `invalid_memory_model`; it is not silently omitted as V1 does.                                                                                          | SOURCE; NATIVE PENDING                               |

## Protocol and security boundaries

The protocol is admission and correlation, not authorization. Attachments are
rejected, uppercase V2 confirmation is invalid, and a provider/output failure
after a mutation may leave the mutation completed. Reset is a generation fence
and persistence operation, not semantic conversation erasure. Same-server RPC
trust is a single-user assumption; this matrix does not claim tenant isolation.

## Exact public strings and structured outcomes

These are source references for assertions, not replacement prose. V1 setup
refusal is the three-line response beginning `Setup not run: explicit
confirmation is required.` and includes the `/stm setup confirm true` and
non-overwrite lines (`src/commands.ts:120-126`). V1 no-session behavior is
`No active session ID found yet. Send one chat message, then run this again.`
(`commands.ts:131-131`). V1 reset returns `Reset memory for session
<sessionID>.` after persistence (`commands.ts:136-148`). V1 absent logs returns
`No logs yet.` (`commands.ts:118`).

V2 reset refusal is `Refused to reset V2 short-term memory: set confirm to
literal true to confirm this destructive action.`; busy reset adds `an update
is active for this session; retry after it finishes.`; successful reset emits
`generation: v2`, `reset: completed`, scope, anchor, policy, `crashAtomic:
false`, and `semanticErasure: false` (`v2-memory-tools.ts:146-206`). V2 setup
refusal is `Refused to create a project example config: set confirm to literal
true to confirm setup.` (`v2-memory-tools.ts:318-327`). V2 update output has
`generation`, `sessionID`, `update`, `reason`, `source`, optional
`stoppedBeforeMessageID`, cumulative `checkpointedChunks`,
`checkpointedMessages`, `persistedPartialFragments`, `rollback`, and `detail`
(`v2-memory-tools.ts:215-268`). The matrix must assert exact `status`/`reason`
values from the updater result enum and should not invent provider error text.

| ID      | Setup                                          | Action | Expected result                                                                                                                             | Evidence                                              |
| ------- | ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| OUT-001 | V1 no logs                                     | Logs   | Exact `No logs yet.` string.                                                                                                                | SOURCE (`commands.ts:118`); UNIT PENDING              |
| OUT-002 | V1 setup unconfirmed                           | Setup  | Exact three-line refusal/guidance response.                                                                                                 | SOURCE (`commands.ts:120-126`); UNIT PENDING          |
| OUT-003 | V2 reset false and busy                        | Reset  | Exact literal-confirmation or active-update refusal; no mutation.                                                                           | SOURCE (`v2-memory-tools.ts:153-159`); UNIT PENDING   |
| OUT-004 | V2 invalid session/update unavailable/no-model | Update | Structured fields remain truthful: `source: not-read` or `unavailable`, `progress: not-started`, and `rollback: not-applicable`.            | SOURCE (`v2-memory-tools.ts:215-249`); NATIVE PENDING |
| OUT-005 | V2 partial commit then error                   | Update | Cumulative progress and rollback/detail reflect persisted chunks/fragments; never claim all-or-nothing when source reports partial success. | SOURCE (`v2-memory-tools.ts:252-268`); NATIVE PENDING |

## Coverage references and non-results

The exact unit tests to consult when a row is promoted are
`test/v2-reset-persistence.test.ts` for reset byte/boundary behavior,
`test/v1-self-generation.test.ts` for V1 self-generation behavior, and the
configuration/tool tests under `test/` that import `memory-utils.ts`,
`commands.ts`, or `v2-memory-tools.ts`. This document does not claim a unit
PASS merely because a test file exists; the exact test invocation and retained
result must be attached to the row. The bounded records in
`docs/RC-READINESS.md` and `docs/FEATURE-MATRIX.md` remain artifact-scoped and
do not promote every row here to native PASS.

## Priority matrix

| Priority | Acceptance gate                                                                                                                                          | Required evidence                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| P0       | Actual eight native invocations, not inventory; config precedence/typo/loading; disabled, busy, malformed, invalid override, retry and reset differences | Exact V1 `1.19.2` and V2 `2.0.30` run records, artifact hashes, persistence snapshots, and stable output strings |
| P0       | Setup/package activation across global/local/server/TUI/RPC/source/named-file routes                                                                     | Fresh registry or immutable tarball setup smoke; unsupported routes explicitly recorded                          |
| P1       | Cadence greater than one, multi-chunk lengths, `AGENTS.md`, logs/privacy and headless behavior                                                           | Native event trace plus output/log inspection; no inferred PASS from full runner                                 |
| P1       | Child snapshot, compaction refresh, DCP generation split, deletion fences and partial rollback                                                           | Focused native/unit records with before/after files and provider outcome                                         |
| P2       | Symlink/cache/duplicate-definition and worktree/subdir permutations                                                                                      | Fresh process/session evidence with resolved path/hash                                                           |

All rows without an exact retained invocation remain `PENDING`, even where
related unit or bounded native qualification is green. Existing coverage in
`docs/RC-READINESS.md`, `docs/FEATURE-MATRIX.md`, and the acceptance scripts is
regression context, not automatic coverage of every row here.

## Existing coverage and limitations

The source matrix and retained RC readiness records cover the shared defaults,
generation differences, public tool surface, native command lifecycle, exact
RC5 artifact identity, and prior bounded consumer/V1/V2 journeys. The expanded
configuration sweep below is now native evidence for its matching cells only;
it does not turn every broad matrix row into `NATIVE PASS`. The sweep is
headless settings/tool/configuration coverage: it is not keyboard/chat-complete
coverage and does not establish model semantic quality.

## Historical Latest Run Results (pre-strict-parser fix)

| Field                          | V1                                                                                                                                                                                             | V2                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Host version                   | `1.19.2`                                                                                                                                                                                       | `2.0.30`                                                                                                   |
| Run/evidence path              | `/home/dev/workspace/opencode-work/stm-published-rc-e2e/v1-o8YkVf/evidence.json`                                                                                                               | `/home/dev/workspace/opencode-work/stm-published-rc-e2e/v2-gke0yb/evidence.json`                           |
| Outcome/duration               | `PASS`, 72.938 s                                                                                                                                                                               | `PASS`, 150.958 s                                                                                          |
| Functional/diagnostic verdict  | Clean functional and diagnostic PASS                                                                                                                                                           | Clean functional and diagnostic PASS                                                                       |
| Artifact under test            | `/home/dev/workspace/opencode-work/stm-readiness-improvements/v1-active-idle-fence-local-20261015.tgz`                                                                                         | Same candidate                                                                                             |
| Artifact identity              | SHA256 `855cebf94dd80b263bad94eab3ecab3b62931fec4ee96bbd2d875a288fa417d2`; mode `0444`; 175,552 bytes; RC5 development patched                                                                 | Same candidate                                                                                             |
| Publication distinction        | Local development patch, not published RC5; published hash `d34558b...` does not include current V1 fixes                                                                                      | Same distinction                                                                                           |
| Native scope                   | V1 API automatic/task/DCP paths plus 10 tool cases and 8 tool names; not keyboard/chat-complete                                                                                                | V2 12 keyboard STM cases, ordinary SDK automatic path, and 11 tool cases; not model-semantic qualification |
| Selected journey/adaptive path | No adaptive journey; aggregate journal is fixed 46-case setup/config evidence                                                                                                                  | No adaptive journey; aggregate journal is fixed 46-case setup/config evidence                              |
| Current revision handling      | Current local patched revision exercised; no publication claim                                                                                                                                 | Current local patched revision exercised; no publication claim                                             |
| Cost / budget                  | Cost `0`; global budget unchanged; no paid provider                                                                                                                                            | Cost `0`; global budget unchanged; no paid provider                                                        |
| Resource cleanup               | Workspace cleanup complete; ports/PIDs closed; evidence preserved; original root fill recovered 6.44 GB; cleanup owner is unknown, not attributed to OpenCode                                  | Same shared cleanup record                                                                                 |
| Blockers/limits                | Earlier parallel run `v1-cC1RvA` failed rapid-gap under concurrent load and remains non-qualifying; serial retry passed with strict assertions unchanged. TTL is not exact 59,999 ms evidence. | No equivalent parallel failure; TTL is not exact 59,999 ms evidence.                                       |

### Expanded setup/configuration evidence

`/home/dev/workspace/opencode-work/stm-readiness-improvements/rc-setup-9higiw/evidence.json`
is `complete: true`, with 46 native results, 14 setup cases (11 positive and
3 negative), and 32 configuration cases. All 16 `CFG-N01`–`CFG-N16` cases are
recorded for both V1 and V2. The 46 settings probes consist of 43 positive base
cases, two extra V1 hot-reload cases, and one extra V2 hot-reload case. The
malformed-recovery PASS rows mean the pre-fix `jsonc-parser`-errors-ignored bug
was reproduced; they are not current syntax-acceptance or parser-fix results.

The full configuration/setup command was:

```bash
/usr/bin/timeout --kill-after=5s 1800s /home/dev/.bun/bin/bun scripts/rc-setup-acceptance.ts /home/dev/workspace/opencode-work/stm-readiness-improvements/v1-active-idle-fence-local-20261015.tgz --v1-host-version 1.19.2 --v2-host-version 2.0.30
```

The per-host commands were:

```bash
/usr/bin/timeout --kill-after=5s 350s /home/dev/.bun/bin/bun scripts/published-v1-e2e.ts /home/dev/workspace/opencode-work/stm-readiness-improvements/v1-active-idle-fence-local-20261015.tgz --host-version 1.19.2
/usr/bin/timeout --kill-after=5s 350s /home/dev/.bun/bin/bun scripts/published-v2-e2e.ts /home/dev/workspace/opencode-work/stm-readiness-improvements/v1-active-idle-fence-local-20261015.tgz --host-version 2.0.30
```

The root checks were run as:

```bash
PATH=/home/dev/.bun/bin:$PATH bun run typecheck && PATH=/home/dev/.bun/bin:$PATH bun test --isolate
```

All 1,055 tests and 5,089 assertions passed; typecheck, format and diff
checks passed. Safety/lifecycle helper coverage recorded 12 tests/73
assertions, plan coverage recorded 33 tests/466 assertions, and settings
coverage recorded 6 tests/156 assertions. These totals are aggregate evidence,
not permission to mark every matrix row native PASS.

The retained evidence includes no Alonzo journal or adaptive journey: those
fields are `Not applicable` for this run. The full native configuration sweep is
headless settings/tool/configuration coverage. V2 additionally has the 12 STM
keyboard cases and SDK ordinary automatic path; V1 has API automatic/task/DCP
coverage. Neither result is keyboard/chat-complete or a model-semantic result.

Known release issue: the matrix is not an “all release green” claim. The
historical source tree changes were uncommitted at `dev` HEAD
`2b9bb226e942e7bccbd0443a8bf9eb08419b16b9`; no commit, push or publication was
performed. The development tarball must not be relabeled as published RC5.

The native setup negatives remain explicit: source-file/bare-tar handling emits
the recorded warning after shutdown, and package-directory loading is silent
with no native entry. The source helper's broken `plugin_loaded=0` stdout count
is not used to claim a plugin identity failure. V1's independently verified STM
log initialization count is `1` in the same host PID; V2 does not emit that
label.

## Current Parser Follow-Up

At the time of focused qualification, the parent was
`06ca52d6d519e7e1f4b9d327375f45f3e538fe59`, with the parser change in the
working tree. This follow-up includes that parser change; its commit is
identified by repository history. The source behavior fix is the second
commit, `da960a11ea0f23d0325d0e9c91499d358de82a63`.

Focused native evidence is
`/home/dev/workspace/opencode-work/stm-readiness-improvements/rc-setup-yynglL/evidence.json`:
`PASS`, eight cases, `completeMatrix: false`, `259543 ms`, on V1 `1.19.2` and
V2 `2.0.30`. The cases were `malformed-recovery`, `jsonc-precedence`,
`jsonc-empty`, and `jsonc-rejected` on both hosts. The malformed fixture now
rejects the partial JSONC source; the valid same-directory JSON fallback keeps
`N=8`, and the global `enabled=false` remains effective. `knownIssues=[]`.
This focused run does not replace the historical 46-case/native record above.

The focused artifact is a development archive, not a registry RC5 release:
`/home/dev/workspace/opencode-work/stm-readiness-improvements/strict-config-local-20261017.tgz`,
SHA256
`e5590eeb71683a1712346093fd936ed61e1c8f33fcb27fc21ef27562e64c6826`, mode
`0444`, `175567` bytes, version `RC5 development`. Published RC5 remains the
older bytes identified by `d34558b13c38736315593f322bc6b5d7e16471c0301382ecc6549f73a5f69682`.
The corrected focused invocation was bounded to 900 seconds:

```bash
/usr/bin/timeout --kill-after=5s 900s /home/dev/.bun/bin/bun scripts/rc-setup-acceptance.ts /home/dev/workspace/opencode-work/stm-readiness-improvements/strict-config-local-20261017.tgz --v1-host-version 1.19.2 --v2-host-version 2.0.30 --case malformed-recovery --case jsonc-precedence --case jsonc-empty --case jsonc-rejected
```

The guard records `errors.length > 0`; the parser still silently falls through
to the next candidate and introduces no warning or API throw. If no valid
fallback exists, existing default behavior remains, including default
`enabled=true`; this is not an always-disabled failure mode. JSONC comments,
trailing commas, and duplicate-key-last-wins behavior are unit-verified.
Mode/key typos and summarizer padding semantics are unchanged. The harness
commit is verified as `06ca52d6d519e7e1f4b9d327375f45f3e538fe59`; it is not
pending or invented here.

## Historical Keyboard Checkpoint (2026-10-17)

One bounded native V2 default-off keyboard run is retained as **FAIL**, not
native qualification. The corrected runner has not been rerun; offline tests
and audits cannot retroactively turn this record into PASS. Latest pinned
baselines are V1 `1.19.3` (not run) and V2 `2.0.32` (this nonqualifying run).
They do not rewrite historical V1 `1.19.2` / V2 `2.0.30` results above.

| Component/Logic Block | Current Findings/Hypothesis                                                  | Implications                                        | Verification Status                         |
| --------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Scope                 | Development candidate; V2 default-off only.                                  | No published-release or four-journey closure claim. | One bounded native run.                     |
| Observed run          | First typed pair and automatic memory commit succeeded; decoder timed out.   | Preserve overall FAIL and cleanup refusal.          | First-turn evidence verified; journey FAIL. |
| Current oracles       | V2 decoding, exact call/delta/cadence and joint checkpoint checks corrected. | Offline success is not native proof.                | Reported UNIT/audit success; no rerun.      |
| Remaining gap         | V2 needs a qualifying rerun; V1 gates remain incomplete.                     | Qualify V2 off first, then opt-in and V1 unit.      | V2 PENDING; V1 explicitly BLOCKED.          |

The exact single command executed was:

```bash
env PATH="/home/dev/.bun/bin:$PATH" /usr/bin/timeout --kill-after=10s 300s /home/dev/.bun/bin/bun scripts/rc-keyboard-chat.ts --candidate /home/dev/workspace/opencode-work/stm-readiness-improvements/strict-config-local-20261017.tgz --scenario v2-default-off --v2-host-version 2.0.32
```

- Run ID: `df91086e-cedc-461a-bef7-9245f3138622`; case:
  `v2-default-off-90a96f3e`; outcome: `FAIL`; elapsed: `180009 ms`.
- Candidate: `/home/dev/workspace/opencode-work/stm-readiness-improvements/strict-config-local-20261017.tgz`;
  SHA256 `e5590eeb71683a1712346093fd936ed61e1c8f33fcb27fc21ef27562e64c6826`.
  These are development bytes, not published RC5.
- Evidence: `/home/dev/workspace/opencode-work/stm-readiness-improvements/keyboard-chat-60qZbi/evidence/result.json`.
  Investigation: `/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-17--keyboard-chat.html`.
- First literal keyboard prompt appears in native prompt history and durable
  context; the ordinary assistant completed `STM_PROBE_STREAM_SENTINEL`.
  Session: `ses_eb777ca14ffe05AjfKmhuSYKfO`; typed user:
  `msg_1488841420012k0aiiQWQQReAm`; ordinary assistant/checkpoint:
  `msg_14888416c001eFE0j9mrn3G8nX`.
- Automatic memory has three production log events: generation start,
  successful outcome, and commit. They are retained at
  `/home/dev/workspace/opencode-work/stm-readiness-improvements/keyboard-chat-60qZbi/cases/v2-default-off-90a96f3e/memory/session-memory.log`.
- The harness applied V1 history decoding to V2 `type`, `text`, and `content`
  records, causing FAIL despite the successful first reply/update.
  `cleanup.runtime.refused` was `shutdown-not-verified`; cache cleanup completed.
- Cost consumed: `0`, local deterministic inference; global budget unchanged.
  No paid inference, infrastructure budget padding, or semantic-quality claim.

Subsequent runner corrections cover V2 JSON decoding, exact call cardinality,
fresh delta, cadence, joint checkpoint/commit settlement, V1-only lineage
checks, safe PID/socket/listener verification, and owned stable evidence.
V1 remains explicitly blocked on incomplete split-delta unions and cumulative
NoReply cadence gates. The second independent audit reported no remaining major
V2 defects in the audited scope; this is not native proof.

Current offline validation: **1078 pass, 0 fail, 5608 assertions,
57 files**; the two new test files contribute **12 tests, 130 assertions**.
Root typecheck, strict script/test TypeScript checks, and four-file formatting
passed. A direct offline replay of the saved first turn also passed the corrected
projection and turn validator: two durable IDs, one primary request, two provider
invocations and one commit. This does not change the retained native FAIL.
The corresponding validation commands are:

```bash
env PATH="/home/dev/.bun/bin:$PATH" /home/dev/.bun/bin/bun test --isolate
env PATH="/home/dev/.bun/bin:$PATH" /home/dev/.bun/bin/bun run typecheck
/home/dev/.bun/bin/bun node_modules/typescript/bin/tsc --noEmit --strict --target ESNext --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --types bun scripts/rc-keyboard-chat.ts scripts/rc-keyboard-driver.ts test/rc-keyboard-chat.test.ts test/rc-keyboard-driver.test.ts
/home/dev/.bun/bin/bun node_modules/prettier/bin/prettier.cjs --check scripts/rc-keyboard-chat.ts scripts/rc-keyboard-driver.ts test/rc-keyboard-chat.test.ts test/rc-keyboard-driver.test.ts
```

Next milestone, in the next turn: the keyboard runner executes **one** bounded
V2 default-off case using the exact same command/archive above with the current
runner. Acceptance requires three literal typed user/ordinary-assistant pairs,
three automatic summaries, three checkpoint commits, no injection with opt-in
off, no tool activity, and verified cleanup. Only after that qualifies should
V2 opt-in proceed, followed by the bounded V1 gate implementation unit. No
native rerun, build, packaged README, or version change is part of this
harness checkpoint.

## Current Qualified Keyboard Journeys (2026-10-17)

**All four independent keyboard journeys PASS** against the same frozen
development archive:
`/home/dev/workspace/opencode-work/stm-readiness-improvements/strict-config-local-20261017.tgz`,
SHA256 `e5590eeb71683a1712346093fd936ed61e1c8f33fcb27fc21ef27562e64c6826`.
The historical checkpoint above describes its then-current state verbatim;
these later runs do not reclassify earlier decoder `df91086e`, merged-SYSTEM
`ace89db1`, or bootstrap `24140573` FAIL records.

| Component/Logic Block | Current Findings/Hypothesis                                                                                          | Implications                                                           | Verification Status                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| Delivery              | Each journey has three literal typed user/ordinary-assistant pairs.                                                  | Typing plus Enter, not sender API prompt delivery.                     | Four independent native PASS records.       |
| Generation/injection  | Each has three primary calls, actual summary calls and ordinary-assistant checkpoint commits; cadence matches below. | Automatic memory and configured delivery qualified.                    | Provider/history/log/persistence evidence.  |
| Cleanup               | Owned host/TUI processes and tmux dead, listener closed, socket absent; runtime/cache cleanup complete.              | No retained live owned runtime or cleanup refusal.                     | Verified in all four records.               |
| Scope                 | Same development bytes, pinned hosts and distinct harness commits.                                                   | Deterministic keyboard milestone only, not release-wide qualification. | Four journeys PASS; broader matrix pending. |

`wallMs` below is total run time, not the per-case duration. Harness commits
identify the runner used for each retained execution, not a later documentation
HEAD or the runtime commit packaged inside the archive.

| Scenario         | Host     | Harness Commit                             | Run ID                                 | wallMs | Status |
| ---------------- | -------- | ------------------------------------------ | -------------------------------------- | ------ | ------ |
| `v1-clean`       | `1.19.3` | `385b5b2c973700aceeaca2b9e36de215c5a543bd` | `3de55cc9-7d1e-496a-bb8d-cfa8ff85a002` | 94778  | PASS   |
| `v1-active`      | `1.19.3` | `385b5b2c973700aceeaca2b9e36de215c5a543bd` | `9d482a5f-2bbd-47c3-9b67-e2234d505608` | 65269  | PASS   |
| `v2-default-off` | `2.0.32` | `8a1b36e55aa2129199366358f0b0270ce69c74b8` | `8add35d1-76f8-4616-93df-05d1e921fc62` | 42237  | PASS   |
| `v2-opt-in`      | `2.0.32` | `db05ef2884de3b5d4c41c91513ef5d63c852d5b9` | `83d408fc-799c-49a5-a1e3-c7edf9c3dfd2` | 44632  | PASS   |

- V1 clean, case `v1-clean-e95c9191`: `/home/dev/workspace/opencode-work/stm-readiness-improvements/keyboard-chat-NmfEup/evidence/result.json`.
- V1 active, case `v1-active-114d304b`: `/home/dev/workspace/opencode-work/stm-readiness-improvements/keyboard-chat-1kCHBm/evidence/result.json`.
- V2 off, case `v2-default-off-88962f39`: `/home/dev/workspace/opencode-work/stm-readiness-improvements/keyboard-chat-nZHkRm/evidence/result.json`.
- V2 on, case `v2-opt-in-94713b69`: `/home/dev/workspace/opencode-work/stm-readiness-improvements/keyboard-chat-CQvOY6/evidence/result.json`.

V1 clean completed three side sessions with final tracking `[]`. V1 active
created zero side sessions and three generated wrapper/assistant pairs in main
native history, with actual production-log/provider/native-parent correlation
and no extra summary/replay. Both V1 journeys have fresh NoReply cadence
`0,1,0`, cumulative `0,1,1`; the third provider request legitimately retains
the second turn's tag. Source ID registration, observable lineage and absence
of extra summary work are verified, but the private runtime ownership Set was
not independently read or causally instrumented.

V2 SYSTEM memory counts are `0,0,0` off and `0,1,0` opt-in, using corrected
merged-SYSTEM recognition. All four have zero tool executions and no unexpected
host or STM diagnostics. Each consumed `0` local deterministic inference cost,
with `globalBudgetChanged: false`; no budget padding is involved.

Exact retained commands, executed with their respective harness commits above:

```bash
env PATH="/home/dev/.bun/bin:$PATH" /usr/bin/timeout --kill-after=10s 300s /home/dev/.bun/bin/bun scripts/rc-keyboard-chat.ts --candidate /home/dev/workspace/opencode-work/stm-readiness-improvements/strict-config-local-20261017.tgz --scenario v1-clean --v1-host-version 1.19.3
env PATH="/home/dev/.bun/bin:$PATH" /usr/bin/timeout --kill-after=10s 300s /home/dev/.bun/bin/bun scripts/rc-keyboard-chat.ts --candidate /home/dev/workspace/opencode-work/stm-readiness-improvements/strict-config-local-20261017.tgz --scenario v1-active --v1-host-version 1.19.3
env PATH="/home/dev/.bun/bin:$PATH" /usr/bin/timeout --kill-after=10s 300s /home/dev/.bun/bin/bun scripts/rc-keyboard-chat.ts --candidate /home/dev/workspace/opencode-work/stm-readiness-improvements/strict-config-local-20261017.tgz --scenario v2-default-off --v2-host-version 2.0.32
env PATH="/home/dev/.bun/bin:$PATH" /usr/bin/timeout --kill-after=10s 300s /home/dev/.bun/bin/bun scripts/rc-keyboard-chat.ts --candidate /home/dev/workspace/opencode-work/stm-readiness-improvements/strict-config-local-20261017.tgz --scenario v2-opt-in --v2-host-version 2.0.32
```

Only V1 active was executed in the qualification turn being rolled up; the
other three passed in earlier turns. This documentation update performs no
further native execution. Investigation:
`/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-17--keyboard-qualification-rollup.html`;
V1 gates: `/home/dev/workspace/opencode-work/stm-readiness-improvements/2026-10-17--v1-keyboard-gates.html`.

This qualifies the four-journey deterministic pipeline on V1 `1.19.3` and V2
`2.0.32`, not published RC5 hash
`d34558b13c38736315593f322bc6b5d7e16471c0301382ecc6549f73a5f69682`,
real-provider semantic quality, universal OS support, or the full strict-parser
installation/configuration matrix. Next milestone: the setup/configuration
runner qualifies broader installation/configuration coverage for these strict
bytes, starting with one bounded missing case and an exact retained result.
The old 46-case archive was `855cebf94dd80b263bad94eab3ecab3b62931fec4ee96bbd2d875a288fa417d2`,
not `e559`; current strict-parser focused coverage remains eight cases, not a
full-matrix requalification. No release publication or push is authorized here.
