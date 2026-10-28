# OpenCode Short-Term Memory Plugin

Automatically summarizes conversation context into structured session memory and delivers saved memory back into the conversation. RC14 (`1.4.0-rc.14`) includes V2 runtime diagnostics, lifecycle cleanup and the reviewed V1/V2 memory features. It preserves native OpenCode request identity for clean memory generation. Memory quality and provider access still depend on the model and account.

> **Unofficial plugin:** This project is not affiliated with or maintained by the OpenCode team.

## V1 / V2 support

Both generations support automatic idle and pre-compaction updates, clean and active summarization, model overrides, reset boundaries, child memory snapshots, and one native `/stm` menu with seven actions. Configuration, prompts, templates and storage are shared; session APIs and TUI integration differ.

- **Primary injection:** By default, saved memory is appended as a no-reply session message every `remindEveryN` eligible user turns. Set `enableLegacyPeriodicSystemTransform: true` to select system/context injection in clean mode. Active mode uses message delivery, matching V1's request-identity fallback. Message delivery avoids rewriting the system prompt; actual provider cache reuse is unmeasured.
- **Clean generation:** Uses an owned temporary native session, excluding injected STM memory and preventing recursive updates. Tool definitions remain available for native provider attribution; V1 rejects execution before it runs, while V2's native generation operation does not execute tools. Cleanup is bounded and failed removals remain fenced.
- **Model selection:** Blank clean settings use host model resolution; blank active settings use the session model. A valid `memoryModel: "provider/model"` override works in both modes. V2 active overrides capture context before dispatch and generate in an owned session with the requested model. Provider/account restrictions still apply.
- **Updates and retries:** Idle terminal events schedule updates after `debounceMs`. Primary context hooks read saved memory without waiting for summarization. Clean mode retries settled nonpermanent failures within `sideSessionRetries`; active mode makes one attempt. Cancellation or deadlines prevent overlapping retries. Compaction has a bounded refresh wait and can use stored memory as fallback.
- **History limits:** `maxDeltaMessages` bounds the recent history window for the whole update, before visible-text filtering. Reset locates its durable boundary first. Oversized entries are truncated with a marker rather than split into repeated generations.
- **Children and compression:** Observed child creation freezes a parent-memory snapshot; children never summarize. Completed `compress` events schedule a primary refresh or arm child snapshot delivery. This does not qualify the external DCP package on every host.
- **Controls:** One native `/stm` picker offers Show, Logs, Settings, Status, Update, Reset and optional example Setup. Read results use native scrolling; only Update can invoke the memory model. Eight agent-facing tools remain available. V2 commands require the companion connected to the matching session and project, with admission before actions run.

See [feature parity](https://github.com/andrejtonev/opencode-short-term-memory/blob/dev/docs/FEATURE-PARITY.md) for implementation details and qualification limits, [RC Readiness](https://github.com/andrejtonev/opencode-short-term-memory/blob/dev/docs/RC-READINESS.md) for exact archive results, and the [feature matrix](https://github.com/andrejtonev/opencode-short-term-memory/blob/dev/docs/FEATURE-MATRIX.md) for the historical RC11 comparison. Repository documents are not included in the npm archive. This is a release candidate; registry publication and live-provider qualification are recorded separately from source checks.

**V2 TUI loading:** On the pinned V2 host, add the same package entry to both the server's `opencode.json` and the CLI/TUI's global `cli.json` `plugins` lists, preserving existing entries. For a minimal global configuration, put the following in each of `~/.config/opencode/opencode.json` and `~/.config/opencode/cli.json` (or the corresponding `$XDG_CONFIG_HOME/opencode/` paths):

```json
{
  "plugins": ["@atonev/opencode-short-term-memory@1.4.0-rc.14"]
}
```

The packaged plugin supplies separate server, `/tui` and `/rpc` exports resolved by the host. A checkout source path alone is not a packaged TUI installation. V2 command results appear in per-action dialogs (`STM status`, `STM show`, etc.); action exceptions use an error dialog. In RC9, results use a height-bounded scroll area with Up/Down, PgUp/PgDn and Home/End navigation; the title and Esc hint remain outside the scrolling body. Short results use only the height they need. Output is capped at 16,384 characters with an explicit truncation notice (a character limit, not a 16 KiB UTF-8 byte limit). Press `esc` to dismiss; delivery timeouts do not expire displayed dialogs. Dismiss the current STM dialog before running another command.

**V2 operational limits:** An action can continue after its 120-second completion timeout, cancellation or delivery failure; these do not abort or roll back mutations. Busy ownership remains until the action settles; inspect persisted state before retrying. Same-server RPC clients are trusted: request/session/receiver matching is routing correlation, not user authorization. Use a single-user/trusted server; multi-user isolation is not guaranteed.

**Reset in both generations:** Select Reset in the native menu and confirm, or call `stm_memory_reset` with `confirm: true`. Reset reads a fresh durable-history anchor, including a verified empty-history boundary, and revokes outstanding generation. Late results cannot restore the old memory. Later updates process only records after that boundary and pause if the anchor is unavailable. Reset preserves conversation history, so new messages may reintroduce earlier facts.

**RC10 V1 reset:** V1 also establishes a persistent forward boundary, through the latest validated durable record after excluding STM's own generation prompts and replies. Empty history creates an empty boundary that admits future records; unavailable or malformed history refuses reset before erasing memory. After reset, updates read full history to locate the boundary, then apply `maxDeltaMessages` to newer records. This costs more history retrieval than ordinary updates. Missing anchors or invalid boundary files pause summarization rather than replaying older history. Boundary files live under `<memoryDir>/v1-reset-boundaries/<session>.json`, separately from V2's format. Existing RC9 resets are not migrated automatically; reset again after upgrading to establish a boundary. This preserves conversation history, and new messages can reintroduce old facts. Published RC9 V1 still clears memory/checkpoint without a forward boundary and can replay earlier history.

## Installation

### V2

The [pinned authoritative CLI specification](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/cli/src/commands/commands.ts) defines `plugin add <package>` as installing a plugin and adding it to global configuration, with no `--global` flag. Install this testing version explicitly:

```bash
opencode plugin add '@atonev/opencode-short-term-memory@1.4.0-rc.14'
```

Verify both server and TUI configuration against [V2 TUI loading](#v1--v2-support) above, preserving existing entries. Keep their package versions aligned.

### V1

The [V1 CLI documentation](https://opencode.ai/docs/cli/#plugin) and hosts `1.14.25`, `1.18.23`, and `1.18.35` support a local install by default and `--global` for a user-wide install. Run the local command from the project:

```bash
opencode plugin '@atonev/opencode-short-term-memory@1.4.0-rc.14' --force
# Or install globally:
opencode plugin '@atonev/opencode-short-term-memory@1.4.0-rc.14' --global --force
```

Local installation writes OpenCode configuration under `<git-worktree>/.opencode/`, or `<directory>/.opencode/` outside Git. Global installation uses OpenCode's global configuration directory, normally `~/.config/opencode/`, respecting XDG configuration. `--force` replaces the plugin version; it does not reset STM memory or overwrite STM configuration. V2's `plugin add` syntax is a different command.

For manual V1 configuration, add the published prerelease to the singular `plugin` list in project `opencode.json` or global `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/opencode.json`), preserving existing entries:

```json
{
  "plugin": ["@atonev/opencode-short-term-memory@1.4.0-rc.14"]
}
```

V1 installs configured npm plugins automatically at startup. Package-cache layout varies by host version; use `opencode debug paths` and inspect the installed package version rather than assuming a cached package is the active plugin. The singular key is also used by the repository's V1 host-load fixture; it is distinct from V2's `plugins` key.

For OpenCode Console authentication, use `opencode console login` and complete browser/device authorization. Older hosts that require a URL accept `opencode console login https://opencode.ai/console`. A Console account is separate from a legacy API key in `auth.json`; successful login must be followed by a real model request. The known free-tier rejection of tool-disabled clean summaries can remain after normal model access succeeds.

RC8 keeps OpenCode's normal tool definitions visible in V1 clean side sessions, with approval permissions. STM rejects every tool invocation from its owned or title-identified summarizer sessions in the native pre-execution hook. This permits free-tier generation without filesystem, shell, plugin or MCP tool execution. Standalone runtimes without the execution guard continue to disable tools in the request. No environment variable or setup step is required. Published RC7 does not include this fix.

### Post-install

In RC8 V1, the first plugin activation creates a minimal `stm.json` beside the host configuration that installed STM: project `.opencode/stm.json` for local installs, or the OpenCode global config directory for global installs. Existing `stm.json` and `stm.jsonc` files are preserved, including invalid files. No setup command is required. This runs on activation, not when the installer exits; unknown installation provenance is reported without guessing a destination. Settings diagnostics show the searched and selected paths.

Both generations create a sparse `stm.json` on first activation for supported static npm declarations in the native global or local installation scope. Setup is optional: its confirmed action creates a project-local `.opencode/stm.jsonc` example only when no STM config exists. Unknown, dynamic, virtual or ambiguous origins skip creation rather than guessing a path; Settings reports searched paths and the reason. Existing JSON/JSONC files are preserved.

Restart OpenCode after setup or configuration edits before checking settings or testing behavior. V1 caches resolved configuration for up to 60 seconds, so an immediate check without restarting can still show the previous settings.

### Native controls

Enable the same STM package in the singular `plugin` array in `tui.json`, as well as the server's `opencode.json`. Select `/stm` from autocomplete to open one native menu: Show memory, Logs, Settings, Status, Update, Reset, and optional example-config creation. Results come from the attached server without adding chat messages or requesting a main-model response. Status includes live counters; reads do not create missing memory files. The reader supports Up/Down, PgUp/PgDn and Home/End; Esc closes it. Logs returns only the absolute log file path on the attached server. Inspect the file there with `cat` (Linux/macOS) or `Get-Content` (PowerShell); log contents are not read or sent to the model.

**Both generations register one native `/stm` menu.** Remove obsolete manually configured `command.stm` entries and restart with both server and TUI companions enabled. Older `/stm show` and `/stm-cmd` server command formats are replaced by menu actions. Logs returns only the server log file path.

V1 results are capped at 16,384 characters with a truncation notice. Paging shows the delivered text; inspect the saved file to read anything beyond the cap. A waiting result times out after 120 seconds. Dismissing the dialog or changing sessions abandons display but does not cancel an admitted server action; inspect persisted state before retrying. Displayed results remain readable until dismissed.

On the current `dev` checkout, V1 and V2 diagnostics retain operation metadata and character counts rather than summarizer prompts, memory previews or injected content, including with `debug: true`. Credential fields and recognizable or inherited credentials are redacted from new diagnostic logs and errors. This hardening requires a future release: published RC14 and older packages/logs are unchanged, so review their logs before sharing. Saved memory and conversation content remain unchanged and may contain information you intentionally supplied.

## Configuration

All keys are optional. Place in `.opencode/stm.jsonc` (project) or a global config directory. Global â†’ env â†’ project merge with project taking precedence.

RC6 accepts JSONC comments and trailing commas, but rejects the whole source file if parsing reports errors rather than using a recovered partial object. Resolution can then use a valid same-directory `stm.json` sibling, lower configuration layers or defaults; an invalid file does not necessarily disable STM.

| Key                                   | Type                 | Default              | Description                                                                                                                                                                                              |
| ------------------------------------- | -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                             | bool                 | `true`               | Enable/disable the plugin.                                                                                                                                                                               |
| `summarizerMode`                      | `"clean"` `"active"` | `"clean"`            | **V1 `clean`** â€” creates a separate side session via the OpenCode SDK API as a pure summarizer. **V1 `active`** â€” uses session generation. V2 mode behavior is described above.                      |
| `memoryModel`                         | string               | `""`                 | Blank clean settings use the host default; blank active settings use the session model. Valid `provider/model` overrides work in both generations and modes.                                             |
| `remindEveryN`                        | number               | `4`                  | Inject memory every N user turns. `1` = every turn. After resetting memory the counter restarts at 0 (injection on 4th, 8th, â€¦ turn).                                                                  |
| `injectInSubagents`                   | bool                 | `true`               | Copy parent memory into sub-agent (fork) sessions. Sub-agents never run the summarizer; they inherit a snapshot. Set `false` to keep sub-agents memory-free.                                             |
| `enableLegacyPeriodicSystemTransform` | bool                 | `false`              | Select system/context injection in clean mode. When false, or in active mode, use no-reply session-message delivery. Child and compaction context policies are separate.                                 |
| `cleanFallbackToActiveSession`        | bool                 | `false`              | Allow active fallback after exhausted settled clean failures, excluding permanent provider errors, cancellation and deadlines.                                                                           |
| `includeAgentsMdOnFirstUpdate`        | bool                 | `false`              | Include `AGENTS.md` content in the first memory update prompt.                                                                                                                                           |
| `sideSessionRetries`                  | number               | `1`                  | Additional clean attempts for settled nonpermanent failures; active mode makes one attempt.                                                                                                              |
| `maxMemoryLength`                     | number               | `10000`              | Target length used when normalizing stored memory. It is not a strict file-size limit: a complete line plus metadata can cross the target.                                                               |
| `maxUpdateInputLength`                | number               | `20000`              | Max characters of conversation delta sent to the summarizer per chunk.                                                                                                                                   |
| `maxDeltaMessages`                    | number               | `200`                | Recent-history look-back cap for the whole update; reset boundaries apply it after locating the anchor.                                                                                                  |
| `collapseAssistantBursts`             | bool                 | `false`              | When `true`, consecutive assistant messages between user turns are collapsed into the last visible assistant reply. When `false`, every assistant turn is kept (thinking/tool parts are still filtered). |
| `debounceMs`                          | number               | `1200`               | Debounce before triggering an update after idle.                                                                                                                                                         |
| `debug`                               | bool                 | `false`              | Verbose logging. Set to `true` to enable debug output.                                                                                                                                                   |
| `logMaxLines`                         | number               | `300`                | Max lines kept in the log file.                                                                                                                                                                          |
| `memoryDir`                           | string               | `".opencode/memory"` | Directory for memory files, checkpoints, and logs (relative to the current working directory). Keep identical across instances sharing sessions.                                                         |

## Usage

In V1, memory summarization and injection is fully automated â€” the plugin watches the conversation, updates memory on idle and before compactions, and injects it every N turns. The commands below are exposed for manual control. For V2 timing and controls, see [V1 / V2 support](#v1--v2-support).

Clean generation receives saved memory in `<existing_memory>` and filtered conversation in `<conversation_update>`. Injected `[MEMORY_SYSTEM]` chat messages are excluded from that conversation delta, so the injected copy is not summarized again. Active mode also excludes STM's own generation prompts and replies from the delta, but runs in the original session: earlier injected memory can remain in the host model's session context.

**Native `/stm` menu in both generations**

| Menu action                    | Behavior                                                                                                                                | Invokes memory model?         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Show memory                    | Read saved memory without creating a file.                                                                                              | No                            |
| Show log file path             | Return the absolute log file path on the attached server.                                                                               | No                            |
| Show settings                  | Display resolved configuration and config paths.                                                                                        | No                            |
| Show status                    | Display server session, model selection, paths and live counters.                                                                       | No                            |
| Update memory                  | Attempt summarization and display saved memory or the failure/deferred reason.                                                          | Yes, when an update is needed |
| Reset saved memory             | Confirm, then reset saved memory/checkpoint and establish a forward history boundary.                                                   | No                            |
| Create optional example config | Confirm, then create a project `.opencode/stm.jsonc` example only if no STM config exists. Installation already creates minimal config. | No                            |

Only Update invokes the memory model. Native menu results require no main-model echo. Selecting an STM tool through an agent can still involve the main model to choose the tool and discuss its result; the tool implementation invokes the memory model only for Update. All eight model-facing tools remain available, including the compatibility `short_term_memory` wrapper.

The same menu and native confirmations are available in V2. V2 read actions require receiver admission and do not generate model output. Headless callers can use the agent tools.

**Agent tools**

Agents should use `stm_memory_read` when prior instructions, decisions, or constraints may affect the current task. This pull-first workflow retrieves the current session's stored memory only when it is relevant.

| Tool                  | Description                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stm_memory_read`     | Read current session memory, creating a template if missing. The V1 native Show menu reads without creating a missing file. Use when prior instructions, decisions, or constraints may matter.             |
| `stm_memory_status`   | Show the current session's runtime and status information.                                                                                                                                                 |
| `stm_memory_update`   | Attempt an update and return saved memory when completed, or a failure/deferred reason.                                                                                                                    |
| `stm_memory_reset`    | Requires `confirm: true`. V1 and V2 establish forward reset boundaries; published RC9 V1 only clears memory/checkpoint. Missing anchors pause updates. See reset behavior above.                           |
| `stm_memory_logs`     | Return the absolute log file path on the OpenCode server without reading its contents.                                                                                                                     |
| `stm_memory_settings` | V1: show resolved configuration. V2: show resolved config, effective behavior and inactive settings.                                                                                                       |
| `stm_memory_setup`    | Create a project-local shared example with `confirm: true`; never overwrite existing config. V1 gives guidance without confirmation; V2 refuses creation.                                                  |
| `short_term_memory`   | Legacy wrapper: `action` selects show/status/update/reset/logs/settings/setup; missing action defaults to Status. V1 legacy reset remains unconfirmed; V2 reset and setup require literal `confirm: true`. |

## How it works (V1)

- **Delta summarization** â€” Only new messages since the last checkpoint are sent to the summarizer. A message-ID checkpoint is saved after each successful update.
- **Injection** â€” By default, compacted memory (with placeholder lines and the outer `## Session Memory` header stripped) is delivered as a no-reply user-context message every N eligible user turns. Set `enableLegacyPeriodicSystemTransform: true` to select the optional legacy system-transform delivery in clean mode. In active mode, V1 uses the primary message's ID-aware no-reply path so active-summary requests do not consume user-turn cadence.
- **Compaction-aware** â€” Before a session compacts, the plugin attempts a memory update and pushes stored memory into the compaction context so it survives compression. If an update remains in-flight after the drain timeout, it uses the memory on disk and logs a warning.
- **DCP compress** â€” When DCP's `compress` tool completes, a memory update is triggered automatically to keep memory in sync after conversation compression.
- **Sub-agents** â€” By default, V1 sub-agent sessions inherit the parent's memory snapshot at creation time. They never summarize on their own. Disable with `injectInSubagents: false`.

### Clean summarizer (V1 side session)

When `summarizerMode` is `"clean"` (the default), the plugin creates a separate side session via the OpenCode SDK API for each summarization task.

Why a separate session?

- **Summary-only request** â€” The side session receives the summarizer system prompt and the selected memory inputs. It shares the host's project instance, so other plugins and host-provided instructions can still apply.
- **Tool execution blocked** â€” Native V1 keeps tool definitions visible with approval permissions for free-model access, then rejects every tool invocation from STM summarizer sessions before execution. Standalone runtimes without the execution guard disable all tools in the request. STM skips memory creation, injection and updates for its own side sessions. Other plugins remain loaded at the host-instance level.
- **Clean chat** â€” Summarization prompts never appear in the main chat UI.
- **Host-resolved or explicit model** â€” By default summary calls omit a model override and use a fresh host-resolved model; this is not guaranteed to be the originating active-session model. Set `memoryModel` to a valid `provider/model` for an explicit, often cheaper override.
- **Cleanup and recovery** â€” STM attempts side-session deletion immediately after summarization. Failed deletions remain tracked for later startup cleanup; immediate removal is not guaranteed. RC11 V1 changes bound the caller's cleanup wait to five seconds and retain ownership of late deletion, so a stalled cleanup cannot block a completed summary indefinitely.
