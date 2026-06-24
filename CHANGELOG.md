# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
