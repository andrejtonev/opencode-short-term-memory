# OpenCode Short-Term Memory Plugin

Automatically summarizes conversation context into structured session memory and injects it back into the system prompt — preserving user instructions, project context, decisions, and active references across long chats and compactions. Update and injection timing differ between OpenCode generations.

> **Unofficial plugin:** This is an independent project and is not affiliated with, endorsed by, or maintained by the opencode team.

## V1 / V2 support

- **V1:** Provides `/stm` commands, seven `stm_memory_*` tools and the legacy `short_term_memory` tool. Uses idle/pre-compaction updates, periodic injection and a separate side session in clean mode, as described below.
- **V2:** Automatically updates from new visible conversation text through the context hook, then injects stored memory into system context. Updates require an assistant message in the delta and respect checkpoints and reset boundaries. The compaction hook injects existing stored memory for preservation; it does **not** itself trigger an update. There is no V1-style idle timer, every-N-turn schedule, DCP-compress trigger or parent-memory snapshot inheritance.
- **V2 controls:** Implements native `/stm` (default status), `/stm status`, `show`, `logs`, `settings`, `update`, `setup` and `reset`, plus the seven `stm_memory_*` tools listed below. Every command requires the configured TUI companion to be connected, viewing the invoking session in the matching project/workspace, and admitted before any action runs. Without an available receiver, admission fails within three seconds and no action runs. Headless users can still use the tools. The legacy `short_term_memory` tool is not registered.
- **V2 model:** Uses the current session model, not `memoryModel` overrides. `summarizerMode: "clean"` uses direct text generation without a side session; `"active"` uses session generation.
- **Version scope:** The package pins the V1 plugin/SDK to `1.14.25` and the V2 plugin API to `2.0.8`; the V2 generation-probe fixture pins its CLI/plugin host to `2.0.12`. Staged built-package full-command live acceptance passes on `2.0.12` (all seven commands, 16 connected states and four headless refusals). Clean installed-artifact acceptance, final installed V1/minimum-V2 compatibility, a native committed multi-chunk update and release qualification remain pending. This does not establish published-release availability or support for every OpenCode 2.x version. See [RC Readiness](docs/RC-READINESS.md) for evidence and limits.

**V2 configuration:** The shared config files and defaults below are read by both generations, but the table's behavioral descriptions are V1-specific. V2 uses `enabled`, `summarizerMode`, `maxMemoryLength`, `maxUpdateInputLength`, `maxDeltaMessages` (per-chunk message bound) and `memoryDir`. `memoryModel`, `cleanFallbackToActiveSession`, `includeAgentsMdOnFirstUpdate`, `injectInSubagents`, `enableLegacyPeriodicSystemTransform`, `sideSessionRetries`, `remindEveryN`, `debounceMs`, `debug`, `logMaxLines` and `collapseAssistantBursts` are inactive in the V2 runtime. Use `stm_memory_settings` to distinguish resolved config from effective V2 behavior and inactive settings.

**V2 TUI loading:** On the pinned host, add the same package entry to both the server's `opencode.json` and the CLI/TUI's global `cli.json` `plugins` lists, preserving existing entries. For a minimal global configuration, put the following in each of `~/.config/opencode/opencode.json` and `~/.config/opencode/cli.json` (or the corresponding `$XDG_CONFIG_HOME/opencode/` paths):

```json
{
  "plugins": ["@atonev/opencode-short-term-memory"]
}
```

The packaged plugin supplies separate server, `/tui` and `/rpc` exports resolved by the host. A checkout source path alone is not a packaged TUI installation. V2 command results appear in per-action dialogs (`STM status`, `STM show`, etc.); action exceptions use an error dialog. Output is capped at 16,384 characters with an explicit truncation notice (a character limit, not a 16 KiB UTF-8 byte limit). Press `esc` to dismiss; delivery timeouts do not expire displayed dialogs. Dismiss the current STM dialog before running another command.

**V2 operational limits:** An action can continue after its 120-second completion timeout, cancellation or delivery failure; these do not abort or roll back mutations. Busy ownership remains until the action settles; inspect persisted state before retrying. Same-server RPC clients are trusted: request/session/receiver matching is routing correlation, not user authorization. Use a single-user/trusted server; multi-user isolation is not guaranteed.

**V2 reset:** `/stm reset confirm true` resets persisted memory/checkpoint and establishes a forward boundary through the last record of the latest settled durable history snapshot, read under the shared mutation lock, not at an invoking message. Empty, no-model, unfinished or malformed history is safely refused without persistence changes; an active update also causes refusal. The tool `stm_memory_reset` with `confirm: true` instead anchors at its invoking message. Later updates process only history after the anchor and pause if it is absent; reset followed by update does **not** replay full history. Reset is not semantic erasure: conversation history remains, and later messages can reintroduce earlier information.

## Installation

### V2

The [pinned authoritative CLI specification](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/cli/src/commands/commands.ts) defines `plugin add <package>` as installing a plugin and adding it to global configuration, with no `--global` flag. The following is a syntax example: replace `<candidate-version>` with the exact candidate version being qualified; it is not a claim that a V2 release is published.

```bash
opencode plugin add '@atonev/opencode-short-term-memory@<candidate-version>'
```

Verify both server and TUI configuration against [V2 TUI loading](#v1--v2-support) above, preserving existing entries. The CLI specification alone does not prove that this command configures both loaders correctly for this package; clean installed-artifact acceptance is still pending.

### V1

Use config-based installation; V1 CLI installation syntax is not verified here. Add the package to the singular `plugin` list in project `opencode.json` or global `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/opencode.json`), preserving existing entries:

```json
{
  "plugin": ["@atonev/opencode-short-term-memory"]
}
```

V1 installs configured npm plugins automatically using Bun at startup. Packages and their dependencies are cached in `~/.cache/opencode/node_modules/`. The singular key is also used by the repository's V1 host-load fixture; it is distinct from V2's `plugins` key.

### Post-install

Run `/stm setup` for confirmation guidance, then `/stm setup confirm true` to create a project-local `.opencode/stm.jsonc` example. In V2, first configure and connect the TUI companion above; unconfirmed setup only displays refusal/guidance and runs no setup action. Headless users can ask the agent to call `stm_memory_setup` with `confirm: true`. Both generations create the shared example only in the project, never write global config and refuse to overwrite an existing `stm.jsonc` or `stm.json`. In V2, check `/stm settings` or `stm_memory_settings` for effective settings rather than assuming all example keys apply. You can also copy `stm.example.jsonc` manually, then restart OpenCode.

## Configuration (V1 behavior)

All keys are optional. Place in `.opencode/stm.jsonc` (project) or a global config directory. Global → env → project merge with project taking precedence.

| Key                            | Type                 | Default              | Description                                                                                                                                                                                                    |
| ------------------------------ | -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                      | bool                 | `true`               | Enable/disable the plugin.                                                                                                                                                                                     |
| `summarizerMode`               | `"clean"` `"active"` | `"clean"`            | **`clean`** — creates a separate side session via the OpenCode SDK API as a pure summarizer. **`active`** — uses the current session model. Clean mode isolates the summarizer from main-session instructions. |
| `memoryModel`                  | string               | `""`                 | Empty inherits the active OpenCode session model by omitting the summary request override. Set a valid `provider/model` to explicitly override it.                                                             |
| `remindEveryN`                 | number               | `4`                  | Inject memory every N user turns. `1` = every turn. After `/stm reset` the counter restarts at 0 (injection on 4th, 8th, … turn).                                                                              |
| `injectInSubagents`            | bool                 | `true`               | Copy parent memory into sub-agent (fork) sessions. Sub-agents never run the summarizer; they inherit a snapshot. Set `false` to keep sub-agents memory-free.                                                   |
| `cleanFallbackToActiveSession` | bool                 | `false`              | If clean summarizer fails, fall back to the active session model.                                                                                                                                              |
| `includeAgentsMdOnFirstUpdate` | bool                 | `false`              | Include `AGENTS.md` content in the first memory update prompt.                                                                                                                                                 |
| `sideSessionRetries`           | number               | `1`                  | Retries for clean summarizer before giving up or falling back.                                                                                                                                                 |
| `maxMemoryLength`              | number               | `10000`              | Max characters stored in the memory file.                                                                                                                                                                      |
| `maxUpdateInputLength`         | number               | `20000`              | Max characters of conversation delta sent to the summarizer per chunk.                                                                                                                                         |
| `maxDeltaMessages`             | number               | `200`                | Max recent messages processed per update cycle. Caps look-back when a checkpoint is stale or lost. In V1, `/stm reset` then `/stm update` reprocesses available history subject to this cap.                   |
| `collapseAssistantBursts`      | bool                 | `false`              | When `true`, consecutive assistant messages between user turns are collapsed into the last visible assistant reply. When `false`, every assistant turn is kept (thinking/tool parts are still filtered).       |
| `debounceMs`                   | number               | `1200`               | Debounce before triggering an update after idle.                                                                                                                                                               |
| `debug`                        | bool                 | `false`              | Verbose logging. Set to `true` to enable debug output.                                                                                                                                                         |
| `logMaxLines`                  | number               | `300`                | Max lines kept in the log file.                                                                                                                                                                                |
| `memoryDir`                    | string               | `".opencode/memory"` | Directory for memory files, checkpoints, and logs (relative to project root). Keep identical across instances sharing sessions.                                                                                |

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

All V2 commands, including reads and unconfirmed guidance, require TUI receiver admission before execution. `/stm setup confirm true` and `/stm reset confirm true` require the exact literal `confirm true`; unconfirmed V2 setup/reset never invoke their actions. Read-only commands do not generate model output; `/stm update` can invoke the summarizer.

**Agent tools**

Agents should use `stm_memory_read` when prior instructions, decisions, or constraints may affect the current task. This pull-first workflow retrieves the current session's stored memory only when it is relevant.

| Tool                  | Description                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stm_memory_read`     | Read the current session memory. Use when prior instructions, decisions, or constraints may matter.                                                                                           |
| `stm_memory_status`   | Show the current session's runtime and status information.                                                                                                                                    |
| `stm_memory_update`   | V1: attempt an update and return memory. V2: update from fresh settled durable visible text; return outcome/reason and cumulative progress, not memory. Use `stm_memory_read` to read memory. |
| `stm_memory_reset`    | Requires `confirm: true`. V1: clear memory/checkpoint. V2: also establish a forward reset boundary; pause updates if its anchor is absent. See V2 reset above.                                |
| `stm_memory_logs`     | Show plugin logs. Logs may include sensitive content; do not disclose secrets or other sensitive information from them.                                                                       |
| `stm_memory_settings` | V1: show resolved configuration. V2: show resolved config, effective behavior and inactive settings.                                                                                          |
| `stm_memory_setup`    | Create a project-local shared example with `confirm: true`; never overwrite existing config. V1 gives guidance without confirmation; V2 refuses creation.                                     |
| `short_term_memory`   | V1 only: legacy compatibility tool. Accepts an `action` for the same operations, including `setup` with optional `confirm: true`.                                                             |

## How it works (V1)

- **Delta summarization** — Only new messages since the last checkpoint are sent to the summarizer. A message-ID checkpoint is saved after each successful update.
- **Injection** — Memory is compacted (placeholder lines and the outer `## Session Memory` header are stripped) and injected as a system message every N user turns.
- **Compaction-aware** — Before a session compacts, the plugin attempts a memory update and pushes stored memory into the compaction context so it survives compression. If an update remains in-flight after the drain timeout, it uses the memory on disk and logs a warning.
- **DCP compress** — When DCP's `compress` tool completes, a memory update is triggered automatically to keep memory in sync after conversation compression.
- **Sub-agents** — By default, sub-agent sessions inherit the parent's memory snapshot at creation time. They never summarize on their own. Disable with `injectInSubagents: false`.

### Clean summarizer (V1 side session)

When `summarizerMode` is `"clean"` (the default), the plugin creates a separate side session via the OpenCode SDK API for each summarization task.

Why a separate session?

- **Instruction isolation** — The side session requests an assistant-generated response with only the summarizer system prompt — never the main session's instructions, custom commands, or project rules.
- **Clean chat** — Summarization prompts never appear in the main chat UI.
- **Inherited or separate model** — By default summary calls omit a model override and inherit the active OpenCode session model. Set `memoryModel` to a valid `provider/model` for an explicit, often cheaper override.
- **Auto cleanup** — Side sessions are deleted immediately after summarization completes so they don't clutter the session list.
