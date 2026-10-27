# V1/V2 feature parity

V1 is the reference for STM features and user interaction. This document describes the RC12 development candidate after the 2026-10-27 parity review. Published RC11 is unchanged; RC12 is prepared locally.

## Shared policy, separate host integration

Configuration, defaults, templates, file ownership, logging, summary prompts, normalization and tagged memory rendering are shared. V1 and V2 need separate session APIs, event handling, request fencing and TUI integration. V2 did not reimplement every component.

The existing injection selector has the same effective behavior in both generations:

| Setting and mode                             | Primary delivery                                                |
| -------------------------------------------- | --------------------------------------------------------------- |
| `enableLegacyPeriodicSystemTransform: false` | Append a memory session message without starting a reply.       |
| Flag true, clean summarization               | Inject memory into system/context at cadence.                   |
| Flag true, active summarization              | Use message delivery, following V1's request-identity fallback. |

Child startup/DCP delivery and compaction use their separate system-context policies. Message delivery avoids rewriting the system prompt; provider KV-cache reuse still requires measurement.

## Implemented corrections

| Area                     | V2 implementation matching V1                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary memory messages  | The prompt hook admits a synthetic `steer` message with `resume: false` before the originating primary prompt. Distinct prompt IDs, reset boundaries and delivery claims prevent duplicate or stale delivery.                                                                                                                      |
| Summarizer ownership     | Internal temporary sessions are registered before creation and marked in durable metadata. Memory injection, child capture and automatic updates exclude them. Conversation projection excludes synthetic STM memory.                                                                                                              |
| Clean generation         | An unparented native session has one supplied summary prompt and an isolated system instruction. Native tool definitions remain available; native `session.generate` does not execute tools. Cleanup is bounded and failed removals remain fenced.                                                                                 |
| Memory model selection   | Blank clean settings use host model resolution. Blank active settings use the active session model. Explicit `provider/model` overrides work in both modes and in the enabled clean-to-active fallback. An active override captures context before provider dispatch, then generates in an owned session with the requested model. |
| Background updates       | Idle terminal events schedule updates. Primary context hooks only read saved memory and cannot block the user's request on a summarizer. Compaction refresh has a bounded wait. Native sessions with an unset default model can resolve it from durable model records.                                                             |
| History and chunk limits | `maxDeltaMessages` caps the recent durable history window for the whole update, before checkpoint and visible-text filtering. Oversized entries use V1's truncation marker and one checkpoint instead of multiple fragment generations.                                                                                            |
| Retry policy             | Clean generation retries nonpermanent settled failures up to the configured budget; active generation makes one attempt. Cancellation, deadlines and a still-pending provider prevent overlapping attempts.                                                                                                                        |
| Installation             | Supported static npm declarations in native global or local JSON/JSONC config files create a sparse `stm.json` at a verified directory searched by STM. Existing JSON/JSONC is preserved. An unverified origin skips creation and reports the reason in settings. Example setup remains optional.                                  |
| Child memory             | Observed child creation captures and persists the parent snapshot before child context delivery. Later parent changes do not replace the snapshot. Startup and completed-compress delivery are claimed once; compaction reads the frozen snapshot. Parent deletion also removes known child state.                                 |
| DCP completion           | A native completed `compress` tool event schedules a debounced primary refresh and no-reply memory delivery; child completions arm frozen-snapshot delivery. This bridge does not establish compatibility of the external DCP package.                                                                                             |
| Reset                    | Menu and tools use one fresh durable-history anchor, including a verified empty-history boundary. Reset revokes an outstanding generation and completes while a slow provider is still pending. Old results cannot restore pre-reset memory. Conversation history is retained.                                                     |
| Read/show                | Show reads existing bytes and reports a missing file without creating storage.                                                                                                                                                                                                                                                     |
| Commands and tools       | One native `/stm` picker offers the seven V1 actions, including native Reset/Setup confirmations. Server slash commands are removed. Completed Update returns saved memory; Logs returns only an absolute file path. The legacy tool defaults a missing action to Status.                                                          |
| Long results             | The native reader provides scrolling and keyboard navigation. Status delivery retains request deduplication, receiver admission, route checks, deadlines and output acknowledgement.                                                                                                                                               |

## Verification boundaries

Frozen RC12 Windows acceptance now passes on V1 `1.18.35` and V2 `2.0.32` in
both primary delivery modes, using fresh native installations and ordinary
terminal chat. The native `/stm` autocomplete registration bug is fixed.
See [RC12 Local Acceptance](RC12-LOCAL-ACCEPTANCE.md) for exact archive identity,
verified workflows, captured-request checks and remaining limits. The records
below describe the earlier development qualification and do not replace that
frozen-artifact receipt.

The final source suite passed **1,366 tests, with 4 skipped and 0 failures** (`bun test --isolate`). Build, type checking, changed-file formatting and whitespace checks passed. The tests cover both injection selectors, model combinations, command/action contracts, cancellation, stale writes, reset, child lifecycle and completed-compress handling. Shared V1/V2 contract tests compare Show, Logs and confirmed empty-history Reset using the actual implementations. The four skips concern Windows symlink privilege and Unix FIFO support.

Isolated native OpenCode **2.0.32**, plugin API **2.0.8** checks establish session-generation isolation, explicit-model context transfer, cleanup, and synthetic-message ordering without extra inference. Whole development-bundle runs with a deterministic local provider establish automatic idle memory creation and delivery into the next primary request in both message and system modes. The clean summarizer excludes injected memory and does not recurse.

A native ConPTY run establishes one reachable `/stm` registration, command-API dispatch into the seven-action picker, successful Show RPC delivery, and keyboard End/Home navigation through a 120-line saved memory. It makes zero provider requests and changes no session messages. This does not qualify typing `/stm` through every terminal's keyboard protocol. Native validation exposed an unsupported regex pattern in the action RPC schema; the schema now omits patterns while the server action parser retains strict identity validation. These checks use owned temporary directories and do not modify the working RC11 installation.

The following remain qualification limits:

- Live free-model access is provider/account dependent. Native tool/header attribution is restored, but deterministic provider checks do not prove that DeepSeek free access is restored for an account.
- The earlier ConPTY slash probe exposed a base-mode registration bug: native autocomplete changes keyboard mode and hides base-mode commands. RC12 registers `/stm` globally, matching native plugin menus. The frozen-package keyboard runs now qualify the correction; earlier command-API dispatch alone did not prove slash entry.
- Automatic config creation currently accepts static npm package declarations. Explicit/virtual config sources, local plugin paths, ambiguous declarations, dynamic substitutions, symlinks and plugin-directory autodiscovery skip creation rather than guessing a destination. Existing settings and defaults still work.
- The completed-compress bridge is tested independently of the external DCP package; full native V2 DCP-package compatibility remains unqualified.
- Cross-generation reset-boundary migration and provider cache-hit behavior remain unqualified.

See [FEATURE-MATRIX](FEATURE-MATRIX.md) for the historical RC11 comparison and [RC Readiness](RC-READINESS.md) for immutable published-release evidence.
