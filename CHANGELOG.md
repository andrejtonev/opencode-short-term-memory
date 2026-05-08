# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
