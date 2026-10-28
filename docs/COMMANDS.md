# Memory controls

Open a conversation, select **`/stm` from native autocomplete**, and choose an
action. OpenCode V1 and V2 provide the same seven-action picker. Its actions run
on the attached OpenCode server without asking the main chat model to choose a
tool or explain the result. **Update** uses the configured memory model.

The server plugin and terminal UI companion must both be enabled, with matching
package versions. See [Installation and configuration](CONFIGURATION.md).

## Menu actions

| Action                             | What it does                                                                                                             | Uses the memory model? |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| **Show memory**                    | Reads the current session's saved Markdown memory. Missing memory is reported without creating it.                       | No                     |
| **Show log file path**             | Returns the absolute path to the shared STM log file on the attached server.                                             | No                     |
| **Show settings and config paths** | Shows resolved settings, searched/selected configuration files and installation diagnostics.                             | No                     |
| **Show status and live counters**  | Shows memory size, selected model and runtime diagnostics for the session.                                               | No                     |
| **Update memory**                  | Requests an update and returns saved memory on success, or a deferred, busy, skipped or failed result.                   | Yes, when eligible     |
| **Reset saved memory**             | Confirms before clearing saved memory and establishing a forward update boundary. Conversation history remains.          | No                     |
| **Create optional example config** | Confirms before creating a project-local `.opencode/stm.jsonc` example. Existing `stm.json` or `stm.jsonc` is preserved. | No                     |

Setup is optional. Supported native installations create a minimal configuration
on first plugin activation; the example action is for customization, rather than
a prerequisite for memory. Settings explains when an installation origin cannot
be resolved. Reset details and limits are described in
[Memory files and reset](MEMORY-FILES.md).

Read actions do not regenerate memory. They also do not add conversation messages.
Background memory updates remain independent of the menu: an idle event can
trigger generation while you inspect a result.

## Reading results

Results appear in an STM dialog, rather than as a chat-model response. Use:

- **Up/Down** to move one line.
- **PgUp/PgDn** to move one page.
- **Home/End** to reach the first or last line.
- **Esc** to close the dialog.

V1 displays a keyboard-paged reader; V2 displays a height-bounded scroll area.
Both resize with the terminal and keep navigation scoped to the active result.
The native result display is capped at **16,384 characters**, with an explicit
truncation notice. This is a display limit, separate from `maxMemoryLength`.
For complete memory, use the `memoryPath` shown by Status and read that file on
the server. Ordinary OpenCode tool-output expansion is controlled by the host UI.

Logs deliberately returns a **path only**. It does not read log contents or send
them to the model. Run a command on the machine hosting OpenCode to inspect it:

```sh
cat '/path/reported/by/STM/logs'
```

```powershell
Get-Content -LiteralPath 'C:\path\reported\by\STM\logs'
```

The path is shared by STM sessions using the same `memoryDir`, and a returned
path does not imply the log file already exists. Memory and logs can contain
private conversation information; inspect them before sharing.

## Update results

Update applies the same summarization settings and eligibility rules as automatic
generation. It is not an unconditional provider request. Disabled STM, no eligible
new conversation or an unavailable reset anchor can prevent generation.

In V1, an active-session update requested while that session is busy is deferred
until idle. The deferred result means the invocation has not refreshed memory.
V2 reports an in-flight update as busy; inspect Status or retry after it settles.
Failures may occur after earlier chunks were saved. A failure result is not a
guarantee that every file is unchanged. See
[Memory generation](MEMORY-GENERATION.md) for model selection and input limits.

## Status and Settings

**Settings** reports the resolved configuration and its source paths. Edit the
selected configuration file to change behavior; the menu is not a settings editor.
**Status** reads saved memory and reports runtime state:

- Selected memory model, summarizer mode and memory path/size.
- Update, injection and compaction counters, with recent timestamps and errors.
- V1 delivery state and pending injection indicators.
- V2 checkpoint/reset-boundary state and whether an updater is busy.

Counters cover the current plugin runtime and can include multiple sessions. They
reset when that runtime restarts; they are not a persistent usage ledger. V2
identifies this as `counterScope: plugin-runtime`. Use Status for V1's actual
delivery mode, particularly when active summarization is selected.

## Agent-facing tools

Both generations expose these seven dedicated tools and a compatibility wrapper.
If you ask the chat agent to use a tool, the main model can participate in choosing
the tool and discussing its output. This differs from the native `/stm` picker.
Only the Update implementation invokes the memory model.

| Tool                  | Action/input                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `stm_memory_read`     | Show; no arguments.                                                                                                                            |
| `stm_memory_status`   | Status; no arguments.                                                                                                                          |
| `stm_memory_logs`     | Log file path only; no arguments.                                                                                                              |
| `stm_memory_settings` | Settings; no arguments.                                                                                                                        |
| `stm_memory_update`   | Update; no arguments.                                                                                                                          |
| `stm_memory_reset`    | Reset; requires literal `confirm: true`.                                                                                                       |
| `stm_memory_setup`    | Optional example configuration; requires literal `confirm: true`.                                                                              |
| `short_term_memory`   | Compatibility wrapper: `action` selects `show`, `status`, `logs`, `settings`, `update`, `reset` or `setup`; missing action defaults to Status. |

Prefer the dedicated tools. The V1 compatibility wrapper retains an unconfirmed
Reset action; the V2 wrapper requires `confirm: true` for Reset. Setup requires
confirmation in both wrappers. Native menu Reset confirms in both generations.
STM does not provide memory import/export tools or a separate context-editing tool.

## Connection and timeout limits

Native results come from the attached server, including when its files are remote.
An action targets the captured session and project; changing routes can suppress
its result. V2 requires a matching connected TUI receiver before running an action.
Dismiss an existing V2 STM result before requesting another action.

Both native interfaces allow about two minutes for an action result. V2 also has
short admission and output-delivery deadlines. A timeout, disconnected receiver or
dismissed waiting dialog does **not** guarantee an admitted update/reset stopped.
Inspect Show and Status before retrying; STM does not automatically rerun a timed
out menu mutation. A displayed result remains available until you dismiss it.

## If `/stm` invokes the chat model

Use the bare native picker. `/stm show` and `/stm-cmd` are not current STM command
formats. Remove obsolete manually configured `command.stm` entries, enable both
companions, and restart OpenCode. V1 explicitly rejects its retired server command.
If autocomplete does not show the picker, check the installation configuration
for your OpenCode generation rather than asking the model to emulate the menu.
