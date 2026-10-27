# RC12 local acceptance — 2026-10-27

RC12 is prepared locally. It has not been pushed or published as part of this work.

## Frozen artifact

- Package: `@atonev/opencode-short-term-memory@1.4.0-rc.12`.
- Release source commit: `dde9370785f4767307ed60f5db9146ae1fd78cc1`.
- Archive: `.opencode/rc12/atonev-opencode-short-term-memory-1.4.0-rc.12.tgz`.
- SHA-256: `016464dfdbbdb9642b09c47a93c980613ae554aa5cfb66784ecc6bf14b51ec6f`.
- Size: 261,998 bytes; 102 packaged files. Every shipped file matched the release checkout before freezing. Later acceptance-runner changes are not packaged and did not change the archive.

The release build, typecheck and full source suite passed: **1,370 passed, 4 skipped, 0 failed**. The four skips concern Windows symlink privileges and Unix FIFO support. A fresh Bun production consumer installed this exact archive and passed all four public imports, strict TUI-only declarations and strict combined declarations. The consumer now checks the added native menu `action` RPC method alongside the delivery methods.

## Native Windows results

| Host         | Primary injection | Installation scope | Result | Retained receipt                                      |
| ------------ | ----------------- | ------------------ | ------ | ----------------------------------------------------- |
| V1 `1.18.35` | Session message   | Global             | PASS   | `.opencode/rc12/native-v1-message-evidence.json`      |
| V1 `1.18.35` | System/context    | Project local      | PASS   | `.opencode/rc12/native-v1-system-local-evidence.json` |
| V2 `2.0.32`  | Session message   | Global             | PASS   | `.opencode/rc12/native-v2-message-evidence.json`      |
| V2 `2.0.32`  | System/context    | Global             | PASS   | `.opencode/rc12/native-v2-system-evidence.json`       |

Each run began with a fresh isolated profile and caches. OpenCode's own installer consumed the candidate through a loopback npm registry serving the exact frozen bytes and forwarding dependency downloads to npm. Product hooks were not replaced, product dependencies did not use repository junctions, and the harness did not pre-create STM config or memory. The installed package's shipped bytes matched the archive.

All four workflows proved:

- First native activation creates scoped `stm.json` without Setup.
- Typed `/stm` opens the native menu and Show reaches the server without inference or chat writes. V1 initializes an empty template during native session creation; V2 initially leaves the memory file absent. Show preserves either state.
- Ordinary terminal chat triggers automatic idle memory generation, and generated memory reaches the next provider request in the selected transport.
- The clean summarizer's conversation data excludes injected memory and its own summarizer content.
- The native reader reaches the end of a generated 120-line memory and returns to the start using End/Home.
- Logs returns a file path; Settings and Status display native results without inference or conversation writes.
- Confirmed Reset completes while a provider response is held, and its late result cannot restore old memory.
- The next automatic summary uses only post-reset conversation and saves the new fact.
- Owned processes and listeners are cleaned up; incomplete cleanup would fail acceptance.

Captured provider requests were additionally revalidated using the strengthened fixture assertions. Injection requires the STM marker **and generated memory text**, so the original user instruction remaining in history cannot produce a false PASS. Every real conversation data block contains only ordinary chat text. V1 made five summary requests for four chat turns because it separately checkpointed the first user message and its assistant reply; V2 made four. This is valid incremental input, not summarizer recursion. These checks and receipt hashes are retained in `.opencode/rc12/trace-validation.json`.

## Repairs and boundaries

Native keyboard entry exposed a production bug missed by command-API dispatch: a base-mode `/stm` registration becomes unreachable when OpenCode enters autocomplete mode. RC12 registers the menu globally, matching native plugin menus.

Runner repairs distinguish native empty-template initialization from harness seeding, examine the current rendered screen rather than historical terminal output, parse the actual conversation data block rather than instruction text mentioning its tags, validate generated injection content, and check the current RPC interface. Empty-cache install deadlines remain bounded. Earlier failed attempts are retained locally and do not count as passing receipts.

These are deterministic-provider integration checks in clean summarizer mode. They do not qualify live free-model access, semantic memory quality, provider cache reuse, active-mode native acceptance, external DCP-package compatibility, Ubuntu/Lima, or public npm publication. V2 project-local bootstrap has source coverage; its native CLI installs globally, and these V2 runs qualify global installation only.

See [Acceptance Runners](ACCEPTANCE-RUNNERS.md) for executable commands and [Feature Parity](FEATURE-PARITY.md) for the wider implementation and qualification limits. Local receipts are ignored by Git and are not present in a clean clone.
