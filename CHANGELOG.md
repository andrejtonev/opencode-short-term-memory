# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
