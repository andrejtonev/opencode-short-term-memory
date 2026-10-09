# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0-rc.3] - 2026-10-08

Unpublished prerelease candidate for V2 parity and readiness improvements, not shipped in published `1.4.0-rc.2`. The bounded qualification recorded below applies only to the exact immutable candidate; no publication is established by this entry.

The exact current candidate SHA-256 `1adcfdc1eefaa23704d7117f7f7321c40518f9312427d4723e55877f83a48212` passed bounded clean-consumer, native V1 and native V2 acceptance in 22.512, 49.725 and 52.736 seconds, respectively. The latest recorded local gate passed 897 tests and 4,074 assertions. These results qualify only the exact unpublished candidate and do not claim registry publication, semantic-model quality, universal host compatibility or generic V2 qualification; see [RC Readiness](docs/RC-READINESS.md) for retained evidence and limits. Prior exact candidate `1ca912...` and its bounded acceptance remain historical qualification, not evidence for these bytes. Paid V1 run `stm-paid-e2e-cNWSEN` remains 50/51; its serialization assertion was corrected and verified deterministically locally without a paid rerun or a claim of 51/51. The earlier 777-test result and native run `8b0960f9` remain historical evidence.

### Added

- Debounced idle updates from native execution terminal events using fresh settled durable history, alongside context-hook catchup. Execution start, deletion, move and shutdown invalidate scheduled idle work.
- Literal every-N-admitted-user-turn primary-session injection, retaining eligibility across tool continuations. Cadence is bounded and process-local; restart or eviction can restart counting.
- Pre-compaction settled-history refresh with stored-memory fallback on skipped, failed or busy updates, bypassing reminder cadence without waiting for an active update to drain.
- Persisted frozen parent-memory snapshots for task children on first eligible context read, controlled by `injectInSubagents`. This is not creation-time capture or fork inheritance; children never summarize, and child reset boundaries suppress injection.
- Clean-mode `memoryModel` overrides, bounded retries for settled transient/malformed generation and opt-in active fallback without an explicit override. Active mode with an explicit override is unsupported.
- Bounded project-root `AGENTS.md` reference data in the first chunk of an eligible no-checkpoint update, optional assistant-burst collapse, and debug generation/injection metadata with append-based `logMaxLines` retention.
- V2 legacy `short_term_memory` compatibility tool, bringing both generations to eight tools: seven granular `stm_memory_*` tools plus legacy. V2 reset/setup retain literal confirmation and invoking-message tool reset boundaries.
- Native qualification runner checks default-off and explicit opt-in injection plus bounded advanced variants against the current immutable candidate. Paid-runner `--cli-path` selects an absolute executable per run without replacing the installed CLI.

### Changed

- All V2 system injection is disabled by default, including primary-session, task-child and compaction injection. Set `enableLegacyPeriodicSystemTransform: true` to opt in; automatic updates remain independently enabled.

### Fixed

- V2 status/settings distinguish configured and effective model selection: valid clean overrides report `explicit-override`, inherited selection remains `unresolved`, and invalid/unsupported overrides report `unavailable` rather than claiming host-model resolution.
- Hook log assertions are session-scoped instead of relying on shared-log size changes from unrelated sessions.
- Received V2 session deletion synchronously tombstones the session, fences coordinated late local writes and removes its own memory, checkpoint, reset boundary and child snapshot. Locationless events are accepted on the location-scoped subscription; explicit locations must match. Parent deletion preserves surviving children's frozen snapshots while fencing new parent captures.
- V1 serialization coverage now deterministically asserts non-overlapping updates and intentional queued replay rather than expecting one completion. Production replay behavior is unchanged.
- Paid-result text parsing excludes consecutive repeated Bun failure-summary rows without suppressing separate same-name test executions; retained `stm-paid-e2e-cNWSEN` output correctly reports 50 pass, 1 fail and 0 skip.
- V1 trailing-idle updates now use a generation fence so stale scheduled work cannot publish after newer durable history settles.
- Current user-text handling now qualifies generation matching, model/path/limit behavior, and E2E configuration/listener ownership safety.

### Known Limits

- Native advanced coverage is bounded: pending-delta compaction refresh remains unqualified, task-child capture is first-context rather than creation-time/fork inheritance, and deletion fencing does not establish provider abort or missed-event, crash or cross-process guarantees. Other model/reset/child/error variants remain local/source coverage; the retained paid V1 50/51 result is not a fully passing suite, and the bounded exact RC3 qualification above does not establish broader release qualification.
- Timeout/cancellation does not trigger retries or fallback. An underlying generation may continue and retains its reservation until settled. Existing action timeout, delivery, trusted-server and forward-reset limits remain unchanged.
- No DCP-compress trigger or durable cadence reconstruction. Task-child lineage/snapshot errors fail closed. Debug metadata excludes prompt/response bodies, but operational logs can still contain sensitive details.

## [1.4.0-rc.2] - 2026-10-06

### Fixed

- V1 native `/stm` commands now read `arguments` and deliver completed action results through in-place mutation of `output.parts`. Native command output remains model-mediated, not model-free.
- V1 memory injection now recognizes the user role from `chat.message` output when native input metadata omits it.

The corrected V1 runtime-equivalent candidate and exact rc.2 V2 named-file candidate passed bounded deterministic workflows. Subsequently published under the `rc` tag: isolated registry installation/loading/setup passed on V1 `1.14.25` and V2 `2.0.12`, including confirmation refusal, creation and no-overwrite refusal. Those setup-only checks did not rerun conversation/memory or validate the Unreleased additions.

## [1.4.0-rc.1] - 2026-10-06

Prerelease candidate for additive V2 support alongside V1. The intended npm dist-tag is `rc`, not `latest`; this entry does not establish publication or final release qualification.

### Added

- V2 context-hook updates from new visible conversation text, requiring an assistant message in the delta and respecting checkpoints/reset boundaries, followed by stored-memory injection into system context. V2 compaction injects existing memory for preservation without triggering an update; V1 idle/pre-compaction updates and periodic injection remain distinct.
- Seven native V2 `/stm` controls (`status`, `show`, `logs`, `settings`, `update`, `setup`, `reset`), with `/stm` defaulting to status, plus seven `stm_memory_*` tools. Commands require matching connected TUI receiver admission; tools remain available headlessly. The legacy `short_term_memory` tool remains V1-only.
- Confirmed V2 reset forward boundaries: `/stm reset confirm true` anchors at the latest settled durable snapshot under the shared mutation lock; `stm_memory_reset` with `confirm: true` anchors at its invoking message. Later updates process only post-anchor history and pause if the anchor is absent. Reset does not erase conversation history or replay it in full.
- Separate server, `/tui` and `/rpc` package exports for V2 integration.

### Changed

- Narrowed public V1/TUI declarations to STM-owned boundaries and pinned `@opencode-ai/sdk` to `1.14.25` as a production dependency. Strict STM public-declaration acceptance does not imply that the full upstream host SDK/Effect declaration closure is fixed.

### Known Limits

- Use a trusted single-user server; RPC routing correlation is not user authorization or a multi-user isolation guarantee. Action completion timeouts, cancellation and delivery failures do not abort or roll back mutations; busy ownership remains until the action settles.
- Installed-tarball native multi-chunk acceptance is adapter-mediated on V2 `2.0.12`; lifecycle acceptance uses wrappers on V1 `1.14.25` and V2 `2.0.8`/`2.0.12`. This does not establish direct loader/registry bootstrap, `plugin add` installation, unwrapped root compatibility or universal OpenCode 2.x support. See [RC Readiness](docs/RC-READINESS.md) for retained evidence and remaining release qualification.

## [1.3.0] - 2026-06-24

### Added

- Orphan side-session cleanup runs at plugin startup: a `.opencode/memory/side-sessions.json` tracking file is consulted, a live scan supplements it for any "Session Memory Summarizer" sessions from older plugin versions, and every orphaned side session is deleted (with `client.session.delete`). Failed deletions are kept in the tracking file for the next startup; already-gone sessions are dropped to avoid leaks.
- `AbortController` + 90 s default timeout (`CLEAN_SUMMARIZER_TIMEOUT.ms`) for the clean summarizer. On timeout the plugin calls `client.session.abort` to stop the server and throws a clear error.
- Diagnostic `[STM-STARTUP] factory_returned_ms=…` line on stderr, gated by `STM_STARTUP_TIMING=1` or `OPENCODE_E2E=1`. The factory body no longer awaits heavy I/O — config load, default-config seed, log write, and orphan cleanup are deferred to a microtask so the plugin returns in <10 ms under a live opencode (e2e-verified 0.14–1.92 ms).
- End-to-end test suite (51 tests across 5 files) under `test/e2e/`: plugin wireup, `/stm` commands, event handling, direct hook coverage, and `includeAgentsMdOnFirstUpdate`. Harness spins up `opencode serve` against a temp project + temp `XDG_CONFIG_HOME`/`XDG_DATA_HOME` and symlinks the local source so the test never touches the developer's real config.
- Unit-test coverage for chunking, retry/drain, message collection, compaction-drain timeout, direct hook wire (Tier 3), and the `includeAgentsMdOnFirstUpdate` config. Combined with the new e2e suite, the test count grew from 146 + 48 to 180 + 51 = 231 tests.
- Unofficial-plugin disclaimer in `README.md`.

### Fixed

- `bun run build` was inheriting the host's Node 14 runtime; the installed `rollup` uses `??=` (Node 15+) and failed to bundle. Switched the `build` script to use `bun --bun run …` so it always uses bun's own runtime.
- `backgroundInitDone` flag was set before the background work actually completed, racing with concurrent `reloadConfigLocal()` calls. Set in `finally` after the work (or its error) completes.
- Orphan tracking file no longer leaks entries on opencode 1.17.x, whose `client.session.delete` returns a generic `"Unexpected server error"` (`UnknownError`) for sessions that are already gone. Both `NotFoundError` and the generic message are now treated as "already gone".
- Clean summarizer can no longer hang indefinitely; the 90 s `AbortController` timeout bounds every prompt and the matching `client.session.abort` stops the server-side generation.

## [1.2.0] - 2026-05-15

### Changed

- Clean summarizer now uses the OpenCode SDK API instead of spawning external `opencode` binaries for side sessions.
- Side sessions are created, prompted, and deleted via `client.session.create/prompt/delete` — no temp directories or shell processes.

### Removed

- **Breaking:** Removed `opencodeExecutable` config option — no longer needed when using the SDK API.
- Removed binary discovery (`resolveCleanExecutable`), validation (`validateRuntimeConfig`), and output parsing utilities (`stripAnsi`, `parseJsonSummarizerOutput`).

## [1.1.1] - 2026-05-14

### Changed

- Default `stm.jsonc` is now installed in the global config directory (`~/.config/opencode/` or `$XDG_CONFIG_HOME/opencode/`) instead of the project `.opencode/` directory.
- Clean summarizer side sessions now run in a temp directory inside the memory directory instead of the system tmp directory.
- Side session env filtering narrowed to strip only parent-process/session vars (`OPENCODE`, `OPENCODE_CLIENT`, `OPENCODE_PID`, `OPENCODE_PROCESS_ROLE`, `OPENCODE_RUN_ID`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`) instead of all `OPENCODE_*` vars, allowing config dirs and API keys to pass through.

## [1.1.0] - 2026-05-13

### Added

- Auto-create a default `.opencode/stm.jsonc` on first run if no project config exists, so users no longer need to manually copy from the example file.

### Changed

- Clean summarizer now parses `--format json` output to extract the assistant response and side-session ID, then deletes the side session automatically after summarization completes.

## [1.0.1] - 2026-05-08

### Changed

- Simplified README installation section to a single `opencode plugin` command.

## [1.0.0] - 2026-05-08

### Added

- Initial release of the OpenCode Short-Term Memory plugin.
- Automatic conversation summarization into structured session memory.
- Memory injection back into the system prompt every N user turns.
- Clean summarizer mode (side session) and active summarizer mode.
- Sub-agent memory inheritance support.
- DCP compaction awareness and automatic memory updates.
- `/stm` user commands for manual memory control.
- `short_term_memory` agent tool for programmatic access.
- Configurable via `.opencode/stm.jsonc`.
