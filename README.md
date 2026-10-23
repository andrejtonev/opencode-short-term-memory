# OpenCode Short-Term Memory Plugin

Automatically summarizes conversation context into structured session memory and supports injecting it back into the system prompt — aiming to preserve user instructions, project context, decisions, and active references across long chats and compactions, without guaranteeing semantic preservation. The published testing release is `1.4.0-rc.8`, available under the npm `rc` tag. Update and injection timing differ between OpenCode generations; V2 system injection is opt-in and disabled by default, independently of automatic memory updates.

> **Unofficial plugin:** This is an independent project and is not affiliated with, endorsed by, or maintained by the opencode team.

## V1 / V2 support

See the [feature matrix](https://github.com/andrejtonev/opencode-short-term-memory/blob/dev/docs/FEATURE-MATRIX.md) for the repository's feature, configuration and validation comparison, including historical evidence and its version scope. This feature-matrix document is not included in the npm package; this README is shipped.

- **Version scope:** **`1.4.0-rc.8` was published on 2026-10-23 under `rc`**, with `latest` left at `1.3.0`. The registry tarball matched the qualified frozen archive byte for byte. Provider APIs remain pinned to V1 plugin/SDK `1.14.25` and V2 plugin `2.0.8`. Exact archive and native qualification are recorded separately in repository [RC Readiness](https://github.com/andrejtonev/opencode-short-term-memory/blob/dev/docs/RC-READINESS.md), which is not included in the npm package.
- **V1:** Provides the native `/stm` menu and eight tools: seven `stm_memory_*` tools plus legacy `short_term_memory`. Uses idle/pre-compaction updates, periodic injection and a separate side session in clean mode, as described below.
- **RC6 V1 fixes:** Filters the plugin's own generated prompt messages and assistant replies to those prompts from update input. Automatic unchanged-input fingerprint suppression, real-user busy-turn idle waiting and internal temporary-session skipping remain in place; these process-local fences do not ban manual retries.
- **RC8 fixes:** V1 clean summaries keep tool definitions visible for OpenCode free-model access while rejecting tool execution before it runs. First activation creates `stm.json` in the native installation scope, and read dialogs show local files without model output. Provider failures remain visible and failed manual updates no longer display old memory as refreshed. RC7 lifecycle fencing, cleanup recovery, idle deferral and native V2 retry bounds are retained. Recorded V2 active-summary tool requests and long-log dialog visibility failures remain unresolved.
- **V1 delivery behavior:** Preserves the no-reply delivery path, originating agent/model routing, and all existing memory tools. Native bus lifecycle and child snapshot fixes are prior RC5 behavior, not new RC6 features. DCP handling preserves the originating agent and skips reinjection when origin metadata is missing or stale; memory updates remain allowed, avoiding an unintended default-agent reinjection.
- **V2 updates:** Native execution terminal events schedule an idle update after `debounceMs`, reading fresh settled durable history; the context hook also catches up from new visible conversation text. Updates require an assistant message in the delta and respect checkpoints and forward reset boundaries. Execution start, deletion, move and shutdown invalidate scheduled idle work. There is no DCP-compress trigger.
- **V2 injection (introduced in RC3; also in published RC5):** Native context/system transform injection is supported but disabled by default. Set `enableLegacyPeriodicSystemTransform: true` to enable primary-session, task-child and compaction memory injection. When opted in, primary sessions inject on literally every N admitted user turns (`remindEveryN`), retaining that turn's eligibility across tool continuations. Cadence is process-local and bounded, not reconstructed from old history; restart or eviction can restart counting. Compaction attempts a refresh from settled durable history independently of injection opt-in; when opted in, it injects stored memory as fallback even if refresh skips, fails or is busy. Compaction injection bypasses reminder cadence and does not wait for an already-running update to drain.
- **V2 task children:** With system injection opted in and `injectInSubagents: true`, a task child freezes and persists a parent-memory snapshot on its first eligible context read. This is not creation-time capture or fork inheritance; later parent updates do not change a frozen snapshot. Task children never summarize, and a child reset boundary suppresses snapshot injection. Unavailable lineage metadata or invalid snapshot state fails closed.
- **V2 controls:** Implements native `/stm` (default status), `/stm status`, `show`, `logs`, `settings`, `update`, `setup` and `reset`, plus eight tools: seven `stm_memory_*` tools and legacy `short_term_memory`. Every command requires the configured TUI companion to be connected, viewing the invoking session in the matching project/workspace, and admitted before any action runs. Without an available receiver, admission fails within three seconds and no action runs. Headless users can still use the tools; legacy reset/setup use the same literal confirmation rules.
- **V2 model/retries:** `summarizerMode: "clean"` uses isolated direct text generation with the summarizer prompt, without a side session or main-session instructions, using the current model unless `memoryModel` supplies a valid `provider/model` override. `"active"` uses session generation; an explicit override is unsupported. `sideSessionRetries` bounds retries of settled transient or malformed output, including native `Generate.UnavailableError`, within one per-chunk deadline. Opt-in `cleanFallbackToActiveSession` allows one active fallback only after those settled failures and only without an explicit override. Timeout/cancellation is not retried or followed by fallback; the underlying operation may continue, retaining its generation reservation until it settles.
- **V2 prompt/log options:** `includeAgentsMdOnFirstUpdate` adds bounded project-root `AGENTS.md` reference data to the first chunk of an eligible update with no checkpoint, not as instructions. `collapseAssistantBursts` retains the last consecutive visible assistant reply in the delta. `debug` adds generation/injection metadata (models, counts, sizes and outcomes, not prompt/response bodies); logs append with `logMaxLines` retention. Existing operational logs can still contain sensitive details.

**Prior runtime evidence:** Four deterministic keyboard journeys (V1 clean/active and V2 default-off/opt-in) passed on native hosts `1.19.3` and `2.0.32` using development archive SHA-256 `e5590eeb71683a1712346093fd936ed61e1c8f33fcb27fc21ef27562e64c6826`. Its manifest still identified RC5 local development bytes, not published RC5 or the new RC6 README/version bytes. The earlier full 12-scenario keyboard/manual workflow, including pending-delta compaction refresh, and five mutation fault checks remain historical evidence for the earlier RC4 artifact (digest prefix `b4a4cf`), not a current RC6 PASS. These bounded checks do not establish minimum or universal host compatibility, every activation path, provider abort behavior or semantic quality; deletion/cancellation checks established persistence fencing while the host continued generation. See the feature matrix for per-capability limits.

**Test readiness:** The source gate at `1577d4f` passed 1,139 tests and 5,774 assertions, not RC6 artifact qualification. The paid V1 legacy sweep `stm-paid-e2e-cNWSEN` remains historically **50/51**, not a fully passing paid suite; no paid rerun and no 51/51 result is claimed. Neither deterministic acceptance nor that paid result guarantees semantic memory quality. Source checks do not qualify the new RC6 tarball; consult exact-artifact results in RC Readiness before drawing broader release conclusions.

**V2 configuration:** Both generations read the shared config files and defaults below, but the table's behavioral descriptions remain V1-specific. The current candidate applies the options described above, along with `enabled`, `maxMemoryLength`, `maxUpdateInputLength`, `maxDeltaMessages` (per-chunk message bound) and `memoryDir`. Native injection is opt-in and defaults to `false`; this behavior originated in RC3 and is also present in published RC5. Set `enableLegacyPeriodicSystemTransform: true` in the shared STM config to opt into all V2 system memory injection, including compaction. Automatic memory updates remain enabled independently when `enabled: true`. Use `stm_memory_settings` to inspect effective behavior in the installed version; these V2 behaviors are not new RC6 features.

**V2 TUI loading:** On the pinned V2 host, add the same package entry to both the server's `opencode.json` and the CLI/TUI's global `cli.json` `plugins` lists, preserving existing entries. For a minimal global configuration, put the following in each of `~/.config/opencode/opencode.json` and `~/.config/opencode/cli.json` (or the corresponding `$XDG_CONFIG_HOME/opencode/` paths):

```json
{
  "plugins": ["@atonev/opencode-short-term-memory@1.4.0-rc.8"]
}
```

The packaged plugin supplies separate server, `/tui` and `/rpc` exports resolved by the host. A checkout source path alone is not a packaged TUI installation. V2 command results appear in per-action dialogs (`STM status`, `STM show`, etc.); action exceptions use an error dialog. In development after RC8, results use a height-bounded scroll area with Up/Down, PgUp/PgDn and Home/End navigation; the title and Esc hint remain outside the scrolling body. Short results use only the height they need. Output is capped at 16,384 characters with an explicit truncation notice (a character limit, not a 16 KiB UTF-8 byte limit). Press `esc` to dismiss; delivery timeouts do not expire displayed dialogs. Dismiss the current STM dialog before running another command.

**V2 operational limits:** An action can continue after its 120-second completion timeout, cancellation or delivery failure; these do not abort or roll back mutations. Busy ownership remains until the action settles; inspect persisted state before retrying. Same-server RPC clients are trusted: request/session/receiver matching is routing correlation, not user authorization. Use a single-user/trusted server; multi-user isolation is not guaranteed.

**V2 reset:** `/stm reset confirm true` resets persisted memory/checkpoint and establishes a forward boundary through the last record of the latest settled durable history snapshot, read under the shared mutation lock, not at an invoking message. Empty, no-model, unfinished or malformed history is safely refused without persistence changes; an active update also causes refusal. The tool `stm_memory_reset` with `confirm: true` instead anchors at its invoking message. Later updates process only history after the anchor and pause if it is absent; reset followed by update does **not** replay full history. Reset is not semantic erasure: conversation history remains, and later messages can reintroduce earlier information.

## Installation

### V2

The [pinned authoritative CLI specification](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/cli/src/commands/commands.ts) defines `plugin add <package>` as installing a plugin and adding it to global configuration, with no `--global` flag. Install the published RC8 release explicitly:

```bash
opencode plugin add '@atonev/opencode-short-term-memory@1.4.0-rc.8'
```

Verify both server and TUI configuration against [V2 TUI loading](#v1--v2-support) above, preserving existing entries. Keep their package versions aligned.

### V1

The [V1 CLI documentation](https://opencode.ai/docs/cli/#plugin) and hosts `1.14.25`, `1.18.23`, and `1.18.35` support a local install by default and `--global` for a user-wide install. Run the local command from the project:

```bash
opencode plugin '@atonev/opencode-short-term-memory@1.4.0-rc.8' --force
# Or install globally:
opencode plugin '@atonev/opencode-short-term-memory@1.4.0-rc.8' --global --force
```

Local installation writes OpenCode configuration under `<git-worktree>/.opencode/`, or `<directory>/.opencode/` outside Git. Global installation uses OpenCode's global configuration directory, normally `~/.config/opencode/`, respecting XDG configuration. `--force` replaces the plugin version; it does not reset STM memory or overwrite STM configuration. V2's `plugin add` syntax is a different command.

For manual V1 configuration, add the published prerelease to the singular `plugin` list in project `opencode.json` or global `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/opencode.json`), preserving existing entries:

```json
{
  "plugin": ["@atonev/opencode-short-term-memory@1.4.0-rc.8"]
}
```

V1 installs configured npm plugins automatically at startup. Package-cache layout varies by host version; use `opencode debug paths` and inspect the installed package version rather than assuming a cached package is the active plugin. The singular key is also used by the repository's V1 host-load fixture; it is distinct from V2's `plugins` key.

For OpenCode Console authentication, use `opencode console login` and complete browser/device authorization. Older hosts that require a URL accept `opencode console login https://opencode.ai/console`. A Console account is separate from a legacy API key in `auth.json`; successful login must be followed by a real model request. The known free-tier rejection of tool-disabled clean summaries can remain after normal model access succeeds.

RC8 keeps OpenCode's normal tool definitions visible in V1 clean side sessions, with approval permissions. STM rejects every tool invocation from its owned or title-identified summarizer sessions in the native pre-execution hook. This permits free-tier generation without filesystem, shell, plugin or MCP tool execution. Standalone runtimes without the execution guard continue to disable tools in the request. No environment variable or setup step is required. Published RC7 does not include this fix.

### Post-install

In RC8 V1, the first plugin activation creates a minimal `stm.json` beside the host configuration that installed STM: project `.opencode/stm.json` for local installs, or the OpenCode global config directory for global installs. Existing `stm.json` and `stm.jsonc` files are preserved, including invalid files. No setup command is required. This runs on activation, not when the installer exits; unknown installation provenance is reported without guessing a destination. Settings diagnostics show the searched and selected paths.

Published RC7 still requires manual config creation or `/stm setup confirm true`. The optional setup command creates a project-local `.opencode/stm.jsonc` example and refuses to overwrite existing config. V2 does not expose installation provenance, so it still uses manual configuration or confirmed setup with its connected TUI companion. Headless users can call `stm_memory_setup` with `confirm: true`.

Restart OpenCode after setup or configuration edits before checking settings or testing behavior. V1 caches resolved configuration for up to 60 seconds, so an immediate check without restarting can still show the previous settings.

### Native V1 controls (development after RC8)

Enable the same STM package in the singular `plugin` array in `tui.json`, as well as the server's `opencode.json`. Select `/stm` from autocomplete to open one native menu: Show memory, Logs, Settings, Status, Update, Reset, and optional example-config creation. Results come from the attached server without adding chat messages or requesting a main-model response. Status includes live counters; reads do not create missing memory files. The reader supports Up/Down, PgUp/PgDn and Home/End; Esc closes it. Logs returns only the absolute log file path on the attached server. Inspect the file there with `cat` (Linux/macOS) or `Get-Content` (PowerShell); log contents are not read or sent to the model.

**These menu improvements are in development after RC8.** Published RC8 still exposes `/stm-show`, `/stm-logs`, `/stm-settings`, `/stm-status` for local reads and legacy `/stm <action>` server commands. The development version registers only the native `/stm` menu. Remove any manually configured `command.stm` from `opencode.json`; its legacy server hook now refuses execution before a model response. Enable both server and TUI companions and restart OpenCode. V2 retains its existing command syntax; development results now use native scrollable dialogs. Path-only Logs is also a development change for V2 and the agent tools; published RC8 still returns log contents.

## Configuration (V1 behavior)

All keys are optional. Place in `.opencode/stm.jsonc` (project) or a global config directory. Global → env → project merge with project taking precedence.

RC6 accepts JSONC comments and trailing commas, but rejects the whole source file if parsing reports errors rather than using a recovered partial object. Resolution can then use a valid same-directory `stm.json` sibling, lower configuration layers or defaults; an invalid file does not necessarily disable STM.

| Key                                   | Type                 | Default              | Description                                                                                                                                                                                                                                              |
| ------------------------------------- | -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                             | bool                 | `true`               | Enable/disable the plugin.                                                                                                                                                                                                                               |
| `summarizerMode`                      | `"clean"` `"active"` | `"clean"`            | **V1 `clean`** — creates a separate side session via the OpenCode SDK API as a pure summarizer. **V1 `active`** — uses session generation. V2 mode behavior is described above.                                                                          |
| `memoryModel`                         | string               | `""`                 | V1 clean mode: empty omits the override and uses the fresh host default; V1 active mode supports a valid `provider/model` explicit override. V2 clean mode uses the current model when empty and supports an explicit override; V2 active mode does not. |
| `remindEveryN`                        | number               | `4`                  | Inject memory every N user turns. `1` = every turn. After resetting memory the counter restarts at 0 (injection on 4th, 8th, … turn).                                                                                                                    |
| `injectInSubagents`                   | bool                 | `true`               | Copy parent memory into sub-agent (fork) sessions. Sub-agents never run the summarizer; they inherit a snapshot. Set `false` to keep sub-agents memory-free.                                                                                             |
| `enableLegacyPeriodicSystemTransform` | bool                 | `false`              | V1: optional legacy system-transform delivery selector; the default delivery uses a no-reply user-context message. V2: enables native system injection, including compaction injection, independently of automatic updates.                              |
| `cleanFallbackToActiveSession`        | bool                 | `false`              | If clean summarizer fails, fall back to the active session model.                                                                                                                                                                                        |
| `includeAgentsMdOnFirstUpdate`        | bool                 | `false`              | Include `AGENTS.md` content in the first memory update prompt.                                                                                                                                                                                           |
| `sideSessionRetries`                  | number               | `1`                  | Retries for clean summarizer before giving up or falling back.                                                                                                                                                                                           |
| `maxMemoryLength`                     | number               | `10000`              | Target length used when normalizing stored memory. It is not a strict file-size limit: a complete line plus metadata can cross the target.                                                                                                               |
| `maxUpdateInputLength`                | number               | `20000`              | Max characters of conversation delta sent to the summarizer per chunk.                                                                                                                                                                                   |
| `maxDeltaMessages`                    | number               | `200`                | Max recent messages processed per update cycle. Caps look-back when a checkpoint is stale or lost. In V1, Reset then Update in the `/stm` menu reprocesses available history subject to this cap.                                                        |
| `collapseAssistantBursts`             | bool                 | `false`              | When `true`, consecutive assistant messages between user turns are collapsed into the last visible assistant reply. When `false`, every assistant turn is kept (thinking/tool parts are still filtered).                                                 |
| `debounceMs`                          | number               | `1200`               | Debounce before triggering an update after idle.                                                                                                                                                                                                         |
| `debug`                               | bool                 | `false`              | Verbose logging. Set to `true` to enable debug output.                                                                                                                                                                                                   |
| `logMaxLines`                         | number               | `300`                | Max lines kept in the log file.                                                                                                                                                                                                                          |
| `memoryDir`                           | string               | `".opencode/memory"` | Directory for memory files, checkpoints, and logs (relative to the current working directory). Keep identical across instances sharing sessions.                                                                                                         |

## Usage

In V1, memory summarization and injection is fully automated — the plugin watches the conversation, updates memory on idle and before compactions, and injects it every N turns. The commands below are exposed for manual control. For V2 timing and controls, see [V1 / V2 support](#v1--v2-support).

Clean generation receives saved memory in `<existing_memory>` and filtered conversation in `<conversation_update>`. Injected `[MEMORY_SYSTEM]` chat messages are excluded from that conversation delta, so the injected copy is not summarized again. Active mode also excludes STM's own generation prompts and replies from the delta, but runs in the original session: earlier injected memory can remain in the host model's session context.

**V1 native `/stm` menu (development after RC8)**

| Menu action                    | Behavior                                                                                                                                | Invokes memory model?         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Show memory                    | Read saved memory without creating a file.                                                                                              | No                            |
| Show log file path             | Return the absolute log file path on the attached server.                                                                               | No                            |
| Show settings                  | Display resolved configuration and config paths.                                                                                        | No                            |
| Show status                    | Display server session, model selection, paths and live counters.                                                                       | No                            |
| Update memory                  | Attempt summarization and display saved memory or the failure/deferred reason.                                                          | Yes, when an update is needed |
| Reset saved memory             | Confirm, then clear saved memory/checkpoint. V1 can summarize prior history again on the next update.                                   | No                            |
| Create optional example config | Confirm, then create a project `.opencode/stm.jsonc` example only if no STM config exists. Installation already creates minimal config. | No                            |

Only Update invokes the memory model. Native menu results require no main-model echo. Selecting an STM tool through an agent can still involve the main model to choose the tool and discuss its result; the tool implementation invokes the memory model only for Update. All eight model-facing tools remain available, including the compatibility `short_term_memory` wrapper.

**V2 user commands**

| Command                   | Behavior                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `/stm` or `/stm status`   | Authoritative session, configured/effective model, paths and updater state.                        |
| `/stm show`               | Read current session memory.                                                                       |
| `/stm logs`               | Return the absolute log file path on the attached server.                                          |
| `/stm settings`           | Resolved config, effective behavior and inactive settings.                                         |
| `/stm update`             | Same outcome/reason and cumulative progress as `stm_memory_update`; use Show to read saved memory. |
| `/stm reset`              | Display confirmation guidance only.                                                                |
| `/stm reset confirm true` | Reset through the latest settled durable snapshot boundary, subject to the safe refusals above.    |
| `/stm setup`              | Display optional example-config confirmation guidance only.                                        |
| `/stm setup confirm true` | Create `.opencode/stm.jsonc` without overwriting existing config.                                  |

All V2 commands, including reads and unconfirmed guidance, require TUI receiver admission before execution. `/stm setup confirm true` and `/stm reset confirm true` require the exact literal `confirm true`; unconfirmed V2 setup/reset never invoke their actions. V2 read-only commands do not generate model output; `/stm update` can invoke the summarizer.

**Agent tools**

Agents should use `stm_memory_read` when prior instructions, decisions, or constraints may affect the current task. This pull-first workflow retrieves the current session's stored memory only when it is relevant.

| Tool                  | Description                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stm_memory_read`     | Read the current session memory. Use when prior instructions, decisions, or constraints may matter.                                                                                                                                                                                                                |
| `stm_memory_status`   | Show the current session's runtime and status information.                                                                                                                                                                                                                                                         |
| `stm_memory_update`   | V1: attempt an update and return memory. V2: update from fresh settled durable visible text; return outcome/reason and cumulative progress, not memory. Use `stm_memory_read` to read memory.                                                                                                                      |
| `stm_memory_reset`    | Requires `confirm: true`. V1: clear memory/checkpoint. V2: also establish a forward reset boundary; pause updates if its anchor is absent. See V2 reset above.                                                                                                                                                     |
| `stm_memory_logs`     | Return the absolute log file path on the OpenCode server without reading its contents.                                                                                                                                                                                                                             |
| `stm_memory_settings` | V1: show resolved configuration. V2: show resolved config, effective behavior and inactive settings.                                                                                                                                                                                                               |
| `stm_memory_setup`    | Create a project-local shared example with `confirm: true`; never overwrite existing config. V1 gives guidance without confirmation; V2 refuses creation.                                                                                                                                                          |
| `short_term_memory`   | Legacy compatibility tool in V1 and RC6 candidate V2 (introduced in RC3): `action` selects show/status/update/reset/logs/settings/setup. V1 reset runs without confirmation; V1 setup requires `confirm: true`. V2 reset and setup both require literal `confirm: true`; V2 reset anchors at the invoking message. |

## How it works (V1)

- **Delta summarization** — Only new messages since the last checkpoint are sent to the summarizer. A message-ID checkpoint is saved after each successful update.
- **Injection** — By default, compacted memory (with placeholder lines and the outer `## Session Memory` header stripped) is delivered as a no-reply user-context message every N eligible user turns. Set `enableLegacyPeriodicSystemTransform: true` to select the optional legacy system-transform delivery instead.
- **Compaction-aware** — Before a session compacts, the plugin attempts a memory update and pushes stored memory into the compaction context so it survives compression. If an update remains in-flight after the drain timeout, it uses the memory on disk and logs a warning.
- **DCP compress** — When DCP's `compress` tool completes, a memory update is triggered automatically to keep memory in sync after conversation compression.
- **Sub-agents** — By default, V1 sub-agent sessions inherit the parent's memory snapshot at creation time. They never summarize on their own. Disable with `injectInSubagents: false`.

### Clean summarizer (V1 side session)

When `summarizerMode` is `"clean"` (the default), the plugin creates a separate side session via the OpenCode SDK API for each summarization task.

Why a separate session?

- **Summary-only request** — The side session receives the summarizer system prompt and the selected memory inputs. It shares the host's project instance, so other plugins and host-provided instructions can still apply.
- **No tools** — Clean summary prompts disable all tools, including plugin and MCP tools, using V1's wildcard session permission. STM ignores its own side-session events rather than creating or injecting memory for them. Plugins remain loaded at the host-instance level.
- **Clean chat** — Summarization prompts never appear in the main chat UI.
- **Host-resolved or explicit model** — By default summary calls omit a model override and use a fresh host-resolved model; this is not guaranteed to be the originating active-session model. Set `memoryModel` to a valid `provider/model` for an explicit, often cheaper override.
- **Auto cleanup** — Side sessions are deleted immediately after summarization completes so they don't clutter the session list.
