# OpenCode Short-Term Memory

Automatically updates structured memory for each conversation and brings useful
saved context back into later requests. OpenCode V1 and V2 support the same core
features through their native server and terminal UI integrations.

> Unofficial plugin; not affiliated with or maintained by the OpenCode team.

## What it does

- Summarizes visible conversation into **User Instructions**, **Long Horizon
  Context**, **Decisions**, **Conclusions** and **Active References**.
- Updates in the background after idle and attempts a refresh before compaction.
- Uses a separate clean summarizer session by default, or the active conversation
  when configured. An explicit memory model works in either mode.
- Delivers saved memory as a session message without requesting a reply by
  default. Optional system/context transformation is available in clean mode.
- Gives task sub-agents a frozen snapshot of their parent's saved memory.
- Provides a native `/stm` menu with scrolling results and agent-facing tools.
- Saves readable Markdown locally. Reset clears saved memory and starts future
  updates after a persistent history boundary without deleting the conversation.

Memory is an LLM summary, not a complete transcript or guaranteed instruction
store. Provider credentials, model compatibility and quotas are managed by
OpenCode; STM generation consumes that model's usage allowance.

## Install

These guides describe the 1.4 feature set. Choose an available 1.4-compatible
package version from the [changelog](CHANGELOG.md), or use a prepared local
package archive. Replace `<version>` below; the default npm version can have an
older feature set.

**OpenCode V1:** run from your project for a local installation:

```sh
opencode plugin '@atonev/opencode-short-term-memory@<version>' --force
# Or install globally:
opencode plugin '@atonev/opencode-short-term-memory@<version>' --global --force
```

Enable the same package in the singular `plugin` arrays of server
`opencode.json` and terminal UI `tui.json`.

**OpenCode V2:** the installation command is global:

```sh
opencode plugin add '@atonev/opencode-short-term-memory@<version>'
```

Enable the same package in the plural `plugins` arrays of global server
`opencode.json` and terminal UI `cli.json`. Keep server and UI versions aligned;
server tools alone do not establish that the terminal menu is loaded.

See [installation and configuration](docs/CONFIGURATION.md) for config examples,
paths, automatic setup and supported installation routes.

## Use it

Open a conversation and select **`/stm` from native autocomplete** to open the
picker. Use the bare menu; `/stm show` and `/stm-cmd` are not current command
formats.

| Action                | Result                                                                |
| --------------------- | --------------------------------------------------------------------- |
| Show memory           | Current session's saved Markdown.                                     |
| Logs                  | Absolute log-file path on the OpenCode server.                        |
| Settings              | Effective options and configuration paths.                            |
| Status                | Memory path/size, model and live diagnostic counters.                 |
| Update                | Requests an eligible memory update; uses the memory model.            |
| Reset                 | Confirms before clearing saved memory and setting a history boundary. |
| Create example config | Optional customization; preserves existing STM config.                |

Menu actions run without asking the chat model to select a tool or explain the
result. Update alone can call the memory model. Use Up/Down, PgUp/PgDn and
Home/End to navigate results, and Esc to close. Logs returns a path only: inspect
that file yourself on the server.

Both versions also expose seven dedicated `stm_memory_*` tools and the
`short_term_memory` compatibility wrapper. Asking the chat agent to use them
can involve the main model. See [commands and tools](docs/COMMANDS.md).

## Configure

Supported native installations create a minimal `stm.json` on first activation,
without replacing existing `stm.json` or `stm.jsonc`. Optional example creation
is not a prerequisite. If the installation origin cannot be verified, Settings
explains why automatic creation was skipped.

All settings are optional. For a separate memory model and reminders every four
eligible user turns:

```jsonc
{
  "summarizerMode": "clean",
  "memoryModel": "your-provider/your-model",
  "remindEveryN": 4,
  "enableLegacyPeriodicSystemTransform": false,
}
```

Leave `memoryModel` blank to use OpenCode's fresh-session default in clean mode,
or the session model in active mode. Configure authentication and provider
options in OpenCode first.

Set `enableLegacyPeriodicSystemTransform: true` for primary system/context
reminders in clean mode. Active mode always uses session-message delivery.
Message delivery avoids rewriting the system prefix; actual provider cache
reuse and billing remain provider-dependent. In V2, the transcript may show
only a **Short-term session memory** label; Show reads the saved text.

See the [full settings reference](docs/CONFIGURATION.md),
[generation guide](docs/MEMORY-GENERATION.md) and
[delivery guide](docs/MEMORY-DELIVERY.md).

## Local files and limits

Memory defaults to `.opencode/memory`, relative to the server's working
directory. Use Status to find the actual file. Keep memory private and ignore it
in Git where appropriate: stored summaries are plain text and can contain
conversation details.

Reset does not erase chat history, previous injection messages or existing child
snapshots. New conversation can reintroduce old facts. Updates checkpoint
successful chunks; a later failure can leave earlier progress saved.

Diagnostic logs omit prompt/memory dumps and redact recognized credentials.
Redaction is best effort; memory, model inputs and older logs are not scrubbed.
Inspect files before sharing them.

[Memory files and reset](docs/MEMORY-FILES.md) explains storage and cleanup.
[Child sessions and compression](docs/CHILD-SESSIONS.md) covers snapshot timing
and the completed-`compress` bridge. The [feature comparison](docs/FEATURE-MATRIX.md)
and [V1/V2 differences](docs/FEATURE-PARITY.md) describe host-specific limits.

See the [documentation index](docs/README.md) for all guides. Release history,
fixes and acceptance records are separate from these current-feature guides.
