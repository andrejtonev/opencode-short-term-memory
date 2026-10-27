# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Net changes from `main` (v1.3.0) through RC14. The prerelease entries below retain their historical release details.

### Added

- **OpenCode V2 support alongside V1:** automatic background updates, clean and active summaries, explicit memory models, session-message and system-context delivery, runtime status diagnostics, child-session snapshots, compaction and DCP completion hooks, and durable reset boundaries.
- **Native `/stm` menus in both versions:** inspect Status, Show, Settings and Logs without invoking the chat model; confirm Reset and optional Setup locally. Update invokes the memory model. V1 uses paged readers and V2 uses scrollable dialogs for long results; argument-based slash commands remain model-mediated.
- **Dedicated `stm_memory_*` tools** for the seven memory actions, while retaining `short_term_memory` compatibility.
- **Installation-scoped configuration:** automatically create a minimal `stm.json` for supported global or project installations, preserve existing settings, and expose configuration paths and bootstrap diagnostics. Setup remains optional.
- **Isolated Windows launchers and release acceptance:** install frozen candidates into private V1/V2 environments for manual testing; verify archive consumers and native generation, injection, reset and UI behavior separately.

### Changed

- **Session-message delivery is now the default.** Tagged memory reminders preserve the current agent, model and tools. Periodic system-context delivery remains available through `enableLegacyPeriodicSystemTransform`; active summaries use message delivery.
- **Logs returns the absolute log-file path**, keeping log contents out of dialogs and model prompts. Successful Update displays refreshed memory; deferred, failed and partially completed updates report their actual outcome.
- **Child sessions receive a parent-memory startup snapshot**, with controlled restoration after compaction or DCP compression.

### Fixed

- **Reset no longer replays the old conversation into cleared memory.** A persistent history boundary and stale-update fencing prevent background work from restoring pre-reset memory.
- **Memory and checkpoints stay consistent under races and write failures:** preserve concurrent external edits and existing empty files, reject stale generations, and roll back prepared memory if checkpoint persistence fails.
- **Clean summaries cannot execute tools or recursively summarize themselves.** Exclude internal summary traffic from collection and bound cleanup waits while retaining orphan-session recovery.
- **Provider failures retain actionable diagnostics**, including authentication and model restrictions, instead of appearing as empty summaries. Permanent failures stop retries and fallback; transient failures retain bounded recovery.

## [1.4.0-rc.14] - 2026-10-27

Includes the dev review improvements, V2 runtime diagnostics, shared native menu descriptions and isolated Azure Luna launchers. The default manual profiles are fresh RC14 directories. See [RC14 acceptance](docs/RC14-LOCAL-ACCEPTANCE.md) for exact archive identity and verification scope.

## [1.4.0-rc.11] - 2026-10-26

Published under `rc` from release commit `64c2bc3e0887d5f7eeaa54e92a5a904e3fef2447` and local tag `v1.4.0-rc.11`, with `latest` left at `1.3.0`. Registry bytes match the validated frozen archive. RC11 includes the branch-review fixes below. Source and deterministic native-host checks are separate from exact-archive consumer checks and live-provider qualification; see [RC Readiness](docs/RC-READINESS.md). Git push was not part of this publication.

### Fixed

- Initialize memory atomically only when absent, preserving empty files and concurrent external writes.
- Route V1 primary memory injection through message-aware NoReply delivery in active mode, preventing summary requests from consuming primary reminder cadence.
- Remove tools from individual V2 active summary requests, including clean-to-active fallback, while preserving ordinary generation requests and disposing the temporary hook.
- Capture and verify owned Windows descendants around termination, preserve paid-run admission closure reasons, and correct historical acceptance-runner contracts and update assertions.
- Fence V1 memory delivery across reset/deletion, report history failures as Update errors, and read live child delivery status. Bound fresh pre-compaction waiting while retaining unfinished update ownership.
- Use durable visible history for V2 context summaries and reset cadence, preserve injection during busy updates, and fence pending generation/reset/file creation across plugin disposal.
- Release abandoned V2 dialog ownership without letting stale dismissals release newer results.
- Serialize automatic/example config creation, release completed write locks, and report UTF-8 memory sizes and effective update hooks accurately.
- Refresh current probe contracts, enforce settling service deadlines, reject invalid acceptance selectors, and verify owned Windows cleanup before reporting overall success.
- Bound V1 clean-session cleanup waits to five seconds while retaining pending deletion ownership; read tools no longer create missing memory files after deletion.
- Fence V2 child snapshot persistence across plugin disposal and keep reminder cadence intact when lineage metadata is unavailable.
- Suppress stale deferred V1 reader rendering and serialize configuration creation across Windows path case aliases.
- Require complete host/mock cleanup in the clean-tools acceptance runner and enforce a settling deadline for final probe log observation.

### Documentation

- Correct release qualifiers and add a maintained/historical acceptance runner map. RC11 changes are separate from the published RC10 archive and its qualification receipts.

## [1.4.0-rc.10] - 2026-10-26

Published under `rc` from release commit `473c2273051d0fb86df3c455732c5e142dae2b0b` and tag `v1.4.0-rc.10`, with `latest` left at `1.3.0`. The registry tarball matches the validated frozen archive byte for byte. Source checks passed 1,216 tests, with 3 skipped and 0 failed; fresh-consumer and native V1 reset/V2 dialog checks passed. Exact archive and host scope are recorded separately in [RC Readiness](docs/RC-READINESS.md).

### Fixed

- V1 reset establishes a persistent forward history boundary before clearing saved memory/checkpoint, preventing direct replay of pre-reset history. Missing anchors or malformed boundary/history stop summarization. Updates after reset retrieve full history to locate the boundary before applying the usual recent-message cap. Old RC9 resets are not migrated, and conversation history remains available to the host model.

### Documentation

- Correct clean tool visibility/execution isolation, retry/fallback exclusions, cleanup recovery, reader limits and logging exposure. Refresh current V1/V2 controls and distinguish archived acceptance records from current instructions. RC10 ships these corrections, including exact RC10 installation examples; the frozen RC9 package remains unchanged.

## [1.4.0-rc.9] - 2026-10-26

Published under `rc` from release commit `8ba7c6c286eacadf697b3c19e320f6646ae53b90` and tag `v1.4.0-rc.9`, with `latest` left at `1.3.0`. Registry bytes matched the frozen validated archive. See [RC Readiness](docs/RC-READINESS.md) for exact artifact and host scope.

### Changed

- V1 exposes one native `/stm` menu, replacing the `/stm-*` aliases and legacy model-mediated server command. Menu results add no chat messages or main-model response; Reset and optional example-config creation ask for confirmation.
- Logs returns only the absolute attached-server log file path in V1, V2 and all memory tools. Users inspect the file themselves; log contents are no longer included in results.

### Fixed

- V1 long results use a paged reader with Up/Down, PgUp/PgDn and Home/End navigation.
- V2 results use native scrollable dialogs with bounded height and fixed title/footer. Short results do not reserve unnecessary rows.
- V2 delivery acknowledgment follows reader construction; a failed or dismissed construction is not reported as successful delivery.

### Validation and limits

- Source checks: 1,199 passed, 3 skipped, 0 failed. Exact-archive fresh-consumer/declaration checks and bounded native V1/V2 UI checks passed on OpenCode `1.18.35` and `2.0.32` respectively. These do not qualify live V2 generation or every native registry installation/provider combination.
- Both readers retain a 16,384-character output cap. The published README contains preparation status and RC8 installation examples; at RC9 publication, repository instructions pinned RC9 for the next candidate. RC10 shipped corrected RC10 examples. The published archive remains unchanged.

## [1.4.0-rc.8] - 2026-10-23

Published under `rc` on 2026-10-23 from release commit `7d33df7e252d11a7517d9a7ec87f627d525be40a` and tag `v1.4.0-rc.8`, after local preparation on 2026-10-22. The registry tarball matched the frozen qualified archive byte for byte, with `latest` left at `1.3.0`. Exact RC8 archive qualification is recorded separately in [RC Readiness](docs/RC-READINESS.md).

### Fixed

- Preserve provider errors returned inside native session responses instead of replacing authentication or free-tier rejections with "empty output." Permanent failures stop clean retries and active fallback; transient failures retain bounded retries.
- Report failed manual memory updates as failures rather than displaying unchanged memory as a refreshed result.
- Restore automatic V1 `stm.json` creation on first activation in the selected global or local installation scope, using OpenCode's plugin origin metadata. Preserve existing JSON/JSONC and inherited settings, and expose config paths and bootstrap diagnostics.

### Added

- V1 clean-session execution fencing: retain tool definitions with approval permissions so OpenCode free models can generate summaries, while rejecting every native tool invocation from STM side sessions before execution. Unguarded standalone runtimes retain request-level tool denial. Supersedes the temporary environment override.
- A native V1 STM action menu and bounded dialogs for local settings, logs, and stored memory, keeping read results out of model prompts. The packaged TUI companion also retains its existing V2 receiver.
- Large V1 log dialogs retain the newest log text when the display limit is reached.

### Documentation

- Document V1's local/global `opencode plugin` installation paths and `opencode console login` authentication flow. Local RC8 fixes remain separate from published RC7.

## [1.4.0-rc.7] - 2026-10-21

Published under `rc` on 2026-10-21 from committed fixes through `e644b30517cc27923ba7ce916e65423c8d9de828`, with `latest` left at `1.3.0`. The registry tarball matched the frozen qualified archive. RC7 artifact validation is recorded separately in [RC Readiness](docs/RC-READINESS.md); earlier RC6 results do not qualify this archive, and later source changes do not alter its published bytes.

### Fixed

- Recognize native V2 `Generate.UnavailableError` as a settled transient generation failure, so provider 503 responses use the configured bounded retry budget. Unknown errors, cancellation and timeouts remain non-retryable.
- Keep V1 history bootstrap read-only and bind delayed scheduling to its original lifecycle generation, so it cannot recreate an empty memory after session deletion or cross a reset boundary.
- Defer V1 manual tool updates until idle when active generation (or clean-to-active fallback) would prompt the same busy session. The tool reports deferral instead of waiting for a re-entrant prompt or claiming that memory was refreshed.
- Restore internal side-session identity during startup cleanup, retain it after deletion, and invalidate work admitted before side-session registration. Failed clean-session deletions remain tracked for recovery. Regression coverage checks delayed events, registration races, and absence of side-session memory files and history reads.
- Clarify that summarizers receive the retained memory, incremental conversation and optional project context in the prompt and must return memory without tools or additional lookups.
- V1 clean summarizer sessions now disable all tools, including plugin and MCP tools. The restriction applies only to disposable side sessions because V1 persists prompt tool settings as session permissions.

### Added

- Native Windows acceptance runners, portable test fixtures, keyboard-turn grouping and incremental provider-request evidence for interrupted test runs.

### Known Limits

- V2 active summaries requesting tools and long-log dialog visibility remain unresolved in the recorded RC6 Windows tests. Fresh installation and the full DeepSeek profile remain unqualified for RC7.
- The Windows supervisor can miss descendants whose parent exits before discovery, and the evidence audit can ignore newer journal records when a snapshot exists. These harness issues remain open.

## [1.4.0-rc.6] - 2026-10-17

Unpublished local candidate preparation, not published or stable, starting from source commit `1577d4f58fe751efb9717aeb91018206f1aece0d`. The final new RC6 artifact SHA-256 and exact-artifact qualification remain **pending**; see [RC Readiness](docs/RC-READINESS.md) for upcoming exact RC6 results.

### Fixed

- V1 excludes its own generated user/assistant messages and suppresses automatic updates on unchanged active input. Real-user busy turns wait for idle, and early temporary-session registration prevents self-triggered replays, session hijacks and internal-session history reads. These fences are process-local, not persistent across restarts, and do not ban manual retries.
- Reject malformed JSONC files when the parser reports errors rather than accepting recovered partial objects. Valid comments and trailing commas remain accepted, with fallback to valid sibling files, lower configuration layers or defaults preserved.

### Added

- Testing/tooling: isolated setup/configuration matrix and three-ordinary-message keyboard journeys for V1 clean/active and V2 default-off/opt-in, with exact provider/delta, NoReply cadence and owned-cleanup validators. These are acceptance tools, not new production features; the existing memory tools were introduced earlier.

### Tested

- Historical source gate at `1577d4f58fe751efb9717aeb91018206f1aece0d`: 1,139 tests and 5,774 assertions passed, not new RC6 artifact qualification.
- Four prior native keyboard PASS results on V1 `1.19.3` and V2 `2.0.32` used one frozen development archive, SHA-256 `e5590eeb71683a1712346093fd936ed61e1c8f33fcb27fc21ef27562e64c6826`, with an RC5 development manifest, not the published RC5 artifact. This is historical runtime proof, not qualification of the new RC6 tarball.

## [1.4.0-rc.5] - 2026-10-13

RC5 preparation dated 2026-10-13, based on exact commit `cbf55e300c3c7f0b62e0be3e51b7dce55feb4c4c`. The exact artifact from source commit `aef359cd4e72d72d79d5dbe76c8b3ed8dfe9906d`, SHA-256 `d34558b13c38736315593f322bc6b5d7e16471c0301382ecc6549f73a5f69682`, received bounded qualification before publication, not stable-release qualification. The date records preparation, not publication; that prepublication evidence does not establish registry availability or semantic memory quality. See [RC Readiness](docs/RC-READINESS.md) for exact artifact evidence and limits.

Publication observed 2026-10-17: registry dist-tags report `rc: 1.4.0-rc.5` and `latest: 1.3.0`. RC5 is a published prerelease, not stable; this observation does not rerun or broaden its bounded qualification.

### Added

- Native V1 create/delete handling and message-bus routing with internal-side suppression.
- Canonical original-agent/model/tool metadata, normal no-reply handling, DCP origin metadata, alias/generation/latest-user fences, and snapshot cleanup for owned staging.
- Honest V1/V2 strict diagnostic gates, V2 keyboard coverage across all 12 actions, manual committed coverage, and pending-compaction coverage.

### Fixed

- Child first-snapshot race handling.

### Tested

- Exact RC5 artifact bounded acceptance: clean consumer PASS in 33.476 seconds, native V1 PASS in 60.751 seconds, and native V2 PASS in 51.869 seconds. These are deterministic workflow results, not semantic-quality or universal host-compatibility guarantees.
- Retained prior RC4 runtime qualification context: consumer `29.491`, V1 `60.376`, and V2 `58.765`; the prior five-fault challenges remain historical, not an RC5 rerun. The intended `rc` tag is not `latest`; no npm publication or new acceptance run is implied by this changelog update.

## [1.4.0-rc.4] - 2026-10-09

Unpublished prerelease candidate based on local dev commit `a3c22514967b7eca567c038330fd552d1cb06209`. This candidate includes the finalized code and release text, with every suite awaiting owned Bun server shutdown before teardown. It adds no production feature or runtime-routing change relative to the latest committed dev state. The version identity is a new rc.4 candidate, not a requalification of rc.3; exact rc.4 qualification remains pending in the release notes. The `rc` tag is unchanged and this candidate is unpublished.

### Known Limits

- Registry/bootstrap, minimum-host compatibility, semantic quality, typed acceptance and committed manual coverage remain separately scoped release gates; see [RC Readiness](docs/RC-READINESS.md) for the retained evidence and gaps.

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
