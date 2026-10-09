# OpenCode Short-Term Memory Plugin

Automatically summarizes conversation context into structured session memory and supports injecting it back into the system prompt — aiming to preserve user instructions, project context, decisions, and active references across long chats and compactions, without guaranteeing semantic preservation. Update and injection timing differ between OpenCode generations; in the unpublished `1.4.0-rc.3` V2 candidate, system injection is opt-in and disabled by default, independently of automatic memory updates.

> **Unofficial plugin:** This is an independent project and is not affiliated with, endorsed by, or maintained by the opencode team.

## V1 / V2 support

See the [feature matrix](https://github.com/andrejtonev/opencode-short-term-memory/blob/dev/docs/FEATURE-MATRIX.md) for the repository's feature, configuration and validation comparison, including historical evidence and its version scope. This repository document is not included in the npm package.

- **Version scope:** The current candidate is **`1.4.0-rc.3`, not yet published**. The latest published prerelease identified by repository release records is `1.4.0-rc.2` under the npm `rc` tag; npm examples below intentionally remain on rc.2. Pinned compatibility evidence uses V1 plugin/SDK `1.14.25`, V2 plugin API `2.0.8`, and V2 host `2.0.12`; it does not establish universal OpenCode 2.x support. The exact pre-text-correction candidate `final-v1-pack-2026-10-08-aXIaob` (SHA-256 `1ca912f7176d4c8965ce2f6a1763b6762851de62ea9c1fd82fcd8f798ad29e22`) passed the bounded consumer in 34.812 seconds, an unpaced native V1 run in 37.108 seconds (including a 362 ms prompt follow-up), and native V2 in 53.987 seconds with all 72 files. That evidence qualifies those immutable bytes only; this README correction creates a new candidate and requires fresh final-artifact validation. These deterministic checks do not guarantee semantic-model quality. See repository [RC Readiness](https://github.com/andrejtonev/opencode-short-term-memory/blob/dev/docs/RC-READINESS.md) for the evidence history and limits; that document is not included in the npm package.
- **V1:** Provides `/stm` commands and eight tools: seven `stm_memory_*` tools plus legacy `short_term_memory`. Uses idle/pre-compaction updates, periodic injection and a separate side session in clean mode, as described below.
- **V2 updates:** Native execution terminal events schedule an idle update after `debounceMs`, reading fresh settled durable history; the context hook also catches up from new visible conversation text. Updates require an assistant message in the delta and respect checkpoints and forward reset boundaries. Execution start, deletion, move and shutdown invalidate scheduled idle work. There is no DCP-compress trigger.
- **V2 injection (RC3 candidate):** Native context/system transform injection is supported but disabled by default. Set `enableLegacyPeriodicSystemTransform: true` to enable primary-session, task-child and compaction memory injection. When opted in, primary sessions inject on literally every N admitted user turns (`remindEveryN`), retaining that turn's eligibility across tool continuations. Cadence is process-local and bounded, not reconstructed from old history; restart or eviction can restart counting. Compaction attempts a refresh from settled durable history independently of injection opt-in; when opted in, it injects stored memory as fallback even if refresh skips, fails or is busy. Compaction injection bypasses reminder cadence and does not wait for an already-running update to drain.
- **V2 task children:** With system injection opted in and `injectInSubagents: true`, a task child freezes and persists a parent-memory snapshot on its first eligible context read. This is not creation-time capture or fork inheritance; later parent updates do not change a frozen snapshot. Task children never summarize, and a child reset boundary suppresses snapshot injection. Unavailable lineage metadata or invalid snapshot state fails closed.
- **V2 controls:** Implements native `/stm` (default status), `/stm status`, `show`, `logs`, `settings`, `update`, `setup` and `reset`, plus eight tools: seven `stm_memory_*` tools and legacy `short_term_memory`. Every command requires the configured TUI companion to be connected, viewing the invoking session in the matching project/workspace, and admitted before any action runs. Without an available receiver, admission fails within three seconds and no action runs. Headless users can still use the tools; legacy reset/setup use the same literal confirmation rules.
- **V2 model/retries:** `summarizerMode: "clean"` uses isolated direct text generation with the summarizer prompt, without a side session or main-session instructions, using the current model unless `memoryModel` supplies a valid `provider/model` override. `"active"` uses session generation; an explicit override is unsupported. `sideSessionRetries` bounds retries of settled transient or malformed output within one per-chunk deadline. Opt-in `cleanFallbackToActiveSession` allows one active fallback only after those settled failures and only without an explicit override. Timeout/cancellation is not retried or followed by fallback; the underlying operation may continue, retaining its generation reservation until it settles.
- **V2 prompt/log options:** `includeAgentsMdOnFirstUpdate` adds bounded project-root `AGENTS.md` reference data to the first chunk of an eligible update with no checkpoint, not as instructions. `collapseAssistantBursts` retains the last consecutive visible assistant reply in the delta. `debug` adds generation/injection metadata (models, counts, sizes and outcomes, not prompt/response bodies); logs append with `logMaxLines` retention. Existing operational logs can still contain sensitive details.

The bounded acceptance evidence above covered the prior immutable candidate, not this post-correction README. It did not exercise every host activation path, semantic quality, or unsupported OpenCode variant; no publication or npm registry claim is made.

The bounded native workflow passed default-off automatic updates without SYSTEM injection, explicit opt-in injection and clean isolation, distinct clean-model override routing, one clean retry, one active fallback, deletion/cancellation persistence fencing, command reset/post-boundary delta, first-read task-child snapshot/injection without child summarization, and completed native compaction with exact SYSTEM injection. These are specific fixture checks, not exhaustive variant coverage or semantic-quality guarantees. The host continued generation during deletion/cancellation; PASS establishes bounded persistence fencing, not provider abort. Pending-delta compaction refresh was `NOTRUN`; refresh failure/busy paths and other unexercised variants remain locally tested or source-grounded. See the feature matrix for per-capability limits.

**Test readiness:** Historical pre-task validation totals 890 tests. The paid V1 legacy sweep `stm-paid-e2e-cNWSEN` remains historically **50/51**, not a fully passing paid suite; no paid rerun and no 51/51 result is claimed. Neither deterministic acceptance nor that paid result guarantees semantic memory quality. The prior candidate hash identifies tested bytes rather than this final README-correction tree. No build, inference, test-suite rerun, release or publication was performed for this README preparation; fresh final-artifact validation remains required.

**V2 configuration:** Both generations read the shared config files and defaults below, but the table's behavioral descriptions remain V1-specific. The RC3 candidate V2 runtime applies the options described above, along with `enabled`, `maxMemoryLength`, `maxUpdateInputLength`, `maxDeltaMessages` (per-chunk message bound) and `memoryDir`. `enableLegacyPeriodicSystemTransform` defaults to `false`; set it to `true` in the shared STM config to opt into all V2 system memory injection, including compaction. Automatic memory updates remain enabled independently when `enabled: true`. This opt-in behavior belongs to the unpublished RC3 candidate, not behavior shipped in published `1.4.0-rc.2`. Use `stm_memory_settings` to inspect effective behavior in the installed version rather than assuming candidate changes are released.

**V2 TUI loading:** On the pinned host, add the same package entry to both the server's `opencode.json` and the CLI/TUI's global `cli.json` `plugins` lists, preserving existing entries. The example below installs published rc.2, not the unpublished RC3 candidate. For a minimal global configuration, put the following in each of `~/.config/opencode/opencode.json` and `~/.config/opencode/cli.json` (or the corresponding `$XDG_CONFIG_HOME/opencode/` paths):

```json
{
  "plugins": ["@atonev/opencode-short-term-memory@1.4.0-rc.2"]
}
```

The packaged plugin supplies separate server, `/tui` and `/rpc` exports resolved by the host. A checkout source path alone is not a packaged TUI installation. V2 command results appear in per-action dialogs (`STM status`, `STM show`, etc.); action exceptions use an error dialog. Output is capped at 16,384 characters with an explicit truncation notice (a character limit, not a 16 KiB UTF-8 byte limit). Press `esc` to dismiss; delivery timeouts do not expire displayed dialogs. Dismiss the current STM dialog before running another command.

**V2 operational limits:** An action can continue after its 120-second completion timeout, cancellation or delivery failure; these do not abort or roll back mutations. Busy ownership remains until the action settles; inspect persisted state before retrying. Same-server RPC clients are trusted: request/session/receiver matching is routing correlation, not user authorization. Use a single-user/trusted server; multi-user isolation is not guaranteed.

**V2 reset:** `/stm reset confirm true` resets persisted memory/checkpoint and establishes a forward boundary through the last record of the latest settled durable history snapshot, read under the shared mutation lock, not at an invoking message. Empty, no-model, unfinished or malformed history is safely refused without persistence changes; an active update also causes refusal. The tool `stm_memory_reset` with `confirm: true` instead anchors at its invoking message. Later updates process only history after the anchor and pause if it is absent; reset followed by update does **not** replay full history. Reset is not semantic erasure: conversation history remains, and later messages can reintroduce earlier information.

## Installation

### V2

The [pinned authoritative CLI specification](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/cli/src/commands/commands.ts) defines `plugin add <package>` as installing a plugin and adding it to global configuration, with no `--global` flag. All npm installation examples here remain pinned to published rc.2; `1.4.0-rc.3` is not yet available as a published package at README preparation. Install the published prerelease explicitly:

```bash
opencode plugin add '@atonev/opencode-short-term-memory@1.4.0-rc.2'
```

Verify both server and TUI configuration against [V2 TUI loading](#v1--v2-support) above, preserving existing entries. Published rc.2 passed native registry `plugin add`, loading and setup on `2.0.12` with both configurations checked; this does not establish that `plugin add` alone configures both loaders or validate the RC3 candidate parity additions.

### V1

Use config-based installation; V1 CLI installation syntax is not verified here. Add the published prerelease to the singular `plugin` list in project `opencode.json` or global `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/opencode.json`), preserving existing entries:

```json
{
  "plugin": ["@atonev/opencode-short-term-memory@1.4.0-rc.2"]
}
```

V1 installs configured npm plugins automatically using Bun at startup. Packages and their dependencies are cached in `~/.cache/opencode/node_modules/`. The singular key is also used by the repository's V1 host-load fixture; it is distinct from V2's `plugins` key.

### Post-install

Run `/stm setup` for confirmation guidance, then `/stm setup confirm true` to create a project-local `.opencode/stm.jsonc` example. In V2, first configure and connect the TUI companion above; unconfirmed setup only displays refusal/guidance and runs no setup action. Headless users can ask the agent to call `stm_memory_setup` with `confirm: true`. Both generations create the shared example only in the project, never write global config and refuse to overwrite an existing `stm.jsonc` or `stm.json`. In V2, check `/stm settings` or `stm_memory_settings` for effective settings rather than assuming all example keys apply. You can also copy `stm.example.jsonc` manually, then restart OpenCode.

Restart OpenCode after setup or configuration edits before checking settings or testing behavior. V1 caches resolved configuration for up to 60 seconds, so an immediate check without restarting can still show the previous settings.

## Configuration (V1 behavior)

All keys are optional. Place in `.opencode/stm.jsonc` (project) or a global config directory. Global → env → project merge with project taking precedence.

| Key                                   | Type                 | Default              | Description                                                                                                                                                                                                                                              |
| ------------------------------------- | -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                             | bool                 | `true`               | Enable/disable the plugin.                                                                                                                                                                                                                               |
| `summarizerMode`                      | `"clean"` `"active"` | `"clean"`            | **V1 `clean`** — creates a separate side session via the OpenCode SDK API as a pure summarizer. **V1 `active`** — uses session generation. V2 mode behavior is described above.                                                                          |
| `memoryModel`                         | string               | `""`                 | V1 clean mode: empty omits the override and uses the fresh host default; V1 active mode supports a valid `provider/model` explicit override. V2 clean mode uses the current model when empty and supports an explicit override; V2 active mode does not. |
| `remindEveryN`                        | number               | `4`                  | Inject memory every N user turns. `1` = every turn. After `/stm reset` the counter restarts at 0 (injection on 4th, 8th, … turn).                                                                                                                        |
| `injectInSubagents`                   | bool                 | `true`               | Copy parent memory into sub-agent (fork) sessions. Sub-agents never run the summarizer; they inherit a snapshot. Set `false` to keep sub-agents memory-free.                                                                                             |
| `enableLegacyPeriodicSystemTransform` | bool                 | `false`              | V1: optional legacy system-transform delivery selector; the default delivery uses a no-reply user-context message. V2: enables native system injection, including compaction injection, independently of automatic updates.                              |
| `cleanFallbackToActiveSession`        | bool                 | `false`              | If clean summarizer fails, fall back to the active session model.                                                                                                                                                                                        |
| `includeAgentsMdOnFirstUpdate`        | bool                 | `false`              | Include `AGENTS.md` content in the first memory update prompt.                                                                                                                                                                                           |
| `sideSessionRetries`                  | number               | `1`                  | Retries for clean summarizer before giving up or falling back.                                                                                                                                                                                           |
| `maxMemoryLength`                     | number               | `10000`              | Target length used when normalizing stored memory. It is not a strict file-size limit: a complete line plus metadata can cross the target.                                                                                                               |
| `maxUpdateInputLength`                | number               | `20000`              | Max characters of conversation delta sent to the summarizer per chunk.                                                                                                                                                                                   |
| `maxDeltaMessages`                    | number               | `200`                | Max recent messages processed per update cycle. Caps look-back when a checkpoint is stale or lost. In V1, `/stm reset` then `/stm update` reprocesses available history subject to this cap.                                                             |
| `collapseAssistantBursts`             | bool                 | `false`              | When `true`, consecutive assistant messages between user turns are collapsed into the last visible assistant reply. When `false`, every assistant turn is kept (thinking/tool parts are still filtered).                                                 |
| `debounceMs`                          | number               | `1200`               | Debounce before triggering an update after idle.                                                                                                                                                                                                         |
| `debug`                               | bool                 | `false`              | Verbose logging. Set to `true` to enable debug output.                                                                                                                                                                                                   |
| `logMaxLines`                         | number               | `300`                | Max lines kept in the log file.                                                                                                                                                                                                                          |
| `memoryDir`                           | string               | `".opencode/memory"` | Directory for memory files, checkpoints, and logs (relative to the current working directory). Keep identical across instances sharing sessions.                                                                                                         |

## Usage

In V1, memory summarization and injection is fully automated — the plugin watches the conversation, updates memory on idle and before compactions, and injects it every N turns. The commands below are exposed for manual control. For V2 timing and controls, see [V1 / V2 support](#v1--v2-support).

**User commands (`/stm ...`, V1 and V2)**

| Command                   | Description                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/stm` or `/stm status`   | V1: enabled state, counters, paths and mode. V2: authoritative session, configured/effective model, paths, memory bytes, checkpoint, reset boundary/policy and updater busy state.          |
| `/stm show`               | Read current session memory; creates the standard template if absent.                                                                                                                       |
| `/stm update`             | V1: attempt immediate summarization and return memory. V2: same outcome/reason and cumulative progress as `stm_memory_update`, not memory; use `/stm show` or `stm_memory_read` to read it. |
| `/stm reset`              | V1: clear memory and checkpoint without confirmation (existing syntax). V2: display confirmation guidance/refusal only; no reset action runs.                                               |
| `/stm reset confirm true` | V2: reset through the latest settled durable snapshot boundary, subject to the safe refusals above.                                                                                         |
| `/stm logs`               | Read the latest ~120 log lines shared across sessions using the memory directory. Logs may contain sensitive context; review before sharing and do not disclose secrets.                    |
| `/stm settings`           | V1: resolved configuration as JSON. V2: resolved config, effective behavior and inactive settings.                                                                                          |
| `/stm setup`              | Show safe project-local confirmation guidance; no config is created.                                                                                                                        |
| `/stm setup confirm true` | Create `.opencode/stm.jsonc`; never overwrite existing config.                                                                                                                              |

In V1 rc.2, `/stm` executes the action before the model runs, then supplies the completed result to the model for display. The visible response is model-mediated, is not guaranteed verbatim and may consume inference even for read-only commands. The `stm_memory_*` tools are the headless alternative for structured action results; an agent's subsequent reply can still be model-mediated.

All V2 commands, including reads and unconfirmed guidance, require TUI receiver admission before execution. `/stm setup confirm true` and `/stm reset confirm true` require the exact literal `confirm true`; unconfirmed V2 setup/reset never invoke their actions. V2 read-only commands do not generate model output; `/stm update` can invoke the summarizer.

**Agent tools**

Agents should use `stm_memory_read` when prior instructions, decisions, or constraints may affect the current task. This pull-first workflow retrieves the current session's stored memory only when it is relevant.

| Tool                  | Description                                                                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stm_memory_read`     | Read the current session memory. Use when prior instructions, decisions, or constraints may matter.                                                                                                                                                                                            |
| `stm_memory_status`   | Show the current session's runtime and status information.                                                                                                                                                                                                                                     |
| `stm_memory_update`   | V1: attempt an update and return memory. V2: update from fresh settled durable visible text; return outcome/reason and cumulative progress, not memory. Use `stm_memory_read` to read memory.                                                                                                  |
| `stm_memory_reset`    | Requires `confirm: true`. V1: clear memory/checkpoint. V2: also establish a forward reset boundary; pause updates if its anchor is absent. See V2 reset above.                                                                                                                                 |
| `stm_memory_logs`     | Show plugin logs. Logs may include sensitive content; do not disclose secrets or other sensitive information from them.                                                                                                                                                                        |
| `stm_memory_settings` | V1: show resolved configuration. V2: show resolved config, effective behavior and inactive settings.                                                                                                                                                                                           |
| `stm_memory_setup`    | Create a project-local shared example with `confirm: true`; never overwrite existing config. V1 gives guidance without confirmation; V2 refuses creation.                                                                                                                                      |
| `short_term_memory`   | Legacy compatibility tool in V1 and RC3 candidate V2: `action` selects show/status/update/reset/logs/settings/setup. V1 reset runs without confirmation; V1 setup requires `confirm: true`. V2 reset and setup both require literal `confirm: true`; V2 reset anchors at the invoking message. |

## How it works (V1)

- **Delta summarization** — Only new messages since the last checkpoint are sent to the summarizer. A message-ID checkpoint is saved after each successful update.
- **Injection** — By default, compacted memory (with placeholder lines and the outer `## Session Memory` header stripped) is delivered as a no-reply user-context message every N eligible user turns. Set `enableLegacyPeriodicSystemTransform: true` to select the optional legacy system-transform delivery instead.
- **Compaction-aware** — Before a session compacts, the plugin attempts a memory update and pushes stored memory into the compaction context so it survives compression. If an update remains in-flight after the drain timeout, it uses the memory on disk and logs a warning.
- **DCP compress** — When DCP's `compress` tool completes, a memory update is triggered automatically to keep memory in sync after conversation compression.
- **Sub-agents** — By default, V1 sub-agent sessions inherit the parent's memory snapshot at creation time. They never summarize on their own. Disable with `injectInSubagents: false`.

### Clean summarizer (V1 side session)

When `summarizerMode` is `"clean"` (the default), the plugin creates a separate side session via the OpenCode SDK API for each summarization task.

Why a separate session?

- **Instruction isolation** — The side session requests an assistant-generated response with only the summarizer system prompt — never the main session's instructions, custom commands, or project rules.
- **Clean chat** — Summarization prompts never appear in the main chat UI.
- **Host-resolved or explicit model** — By default summary calls omit a model override and use a fresh host-resolved model; this is not guaranteed to be the originating active-session model. Set `memoryModel` to a valid `provider/model` for an explicit, often cheaper override.
- **Auto cleanup** — Side sessions are deleted immediately after summarization completes so they don't clutter the session list.
