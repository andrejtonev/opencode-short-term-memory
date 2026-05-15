# OpenCode Short-Term Memory Plugin

Automatically summarizes conversation context into structured session memory and injects it back into the system prompt every few turns — preserving user instructions, project context, decisions, and active references across long chats and compactions.

## Installation

Install the plugin globally using the OpenCode CLI:

```bash
opencode plugin @atonev/opencode-short-term-memory@latest --global
```

OpenCode installs npm plugins automatically using Bun at startup. Packages and their dependencies are cached in `~/.cache/opencode/node_modules/`.

### Post-install

Create `.opencode/stm.jsonc` in your project (or copy from `stm.example.jsonc`), then restart OpenCode.

## Configuration

All keys are optional. Place in `.opencode/stm.jsonc` (project) or a global config directory. Global → env → project merge with project taking precedence.

| Key                            | Type                 | Default                        | Description                                                                                                                                                                                                    |
| ------------------------------ | -------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                      | bool                 | `true`                         | Enable/disable the plugin.                                                                                                                                                                                     |
| `summarizerMode`               | `"clean"` `"active"` | `"clean"`                      | **`clean`** — creates a separate side session via the OpenCode SDK API as a pure summarizer. **`active`** — uses the current session model. Clean mode isolates the summarizer from main-session instructions. |
| `memoryModel`                  | string               | `"opencode/minimax-m2.5-free"` | Model for summarization (`provider/model`).                                                                                                                                                                    |
| `remindEveryN`                 | number               | `4`                            | Inject memory every N user turns. `1` = every turn. After `/stm reset` the counter restarts at 0 (injection on 4th, 8th, … turn).                                                                              |
| `injectInSubagents`            | bool                 | `true`                         | Copy parent memory into sub-agent (fork) sessions. Sub-agents never run the summarizer; they inherit a snapshot. Set `false` to keep sub-agents memory-free.                                                   |
| `cleanFallbackToActiveSession` | bool                 | `false`                        | If clean summarizer fails, fall back to the active session model.                                                                                                                                              |
| `includeAgentsMdOnFirstUpdate` | bool                 | `false`                        | Include `AGENTS.md` content in the first memory update prompt.                                                                                                                                                 |
| `sideSessionRetries`           | number               | `1`                            | Retries for clean summarizer before giving up or falling back.                                                                                                                                                 |
| `maxMemoryLength`              | number               | `10000`                        | Max characters stored in the memory file.                                                                                                                                                                      |
| `maxUpdateInputLength`         | number               | `20000`                        | Max characters of conversation delta sent to the summarizer per chunk.                                                                                                                                         |
| `maxDeltaMessages`             | number               | `200`                          | Max recent messages processed per update cycle. Caps look-back when a checkpoint is stale or lost. To rebuild from full history, run `/stm reset` then `/stm update`.                                          |
| `collapseAssistantBursts`      | bool                 | `false`                        | When `true`, consecutive assistant messages between user turns are collapsed into the last visible assistant reply. When `false`, every assistant turn is kept (thinking/tool parts are still filtered).       |
| `debounceMs`                   | number               | `1200`                         | Debounce before triggering an update after idle.                                                                                                                                                               |
| `debug`                        | bool                 | `false`                        | Verbose logging. Set to `true` to enable debug output.                                                                                                                                                         |
| `logMaxLines`                  | number               | `300`                          | Max lines kept in the log file.                                                                                                                                                                                |
| `memoryDir`                    | string               | `".opencode/memory"`           | Directory for memory files, checkpoints, and logs (relative to project root). Keep identical across instances sharing sessions.                                                                                |

## Usage

Memory summarization and injection is fully automated — the plugin watches the conversation, updates memory on idle and before compactions, and injects it every N turns. The commands below are exposed for manual control.

**User commands (`/stm ...`)**

| Command         | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `/stm`          | Show plugin status (enabled state, counters, paths, mode).    |
| `/stm show`     | Print the current session memory content.                     |
| `/stm update`   | Force an immediate memory summarization from recent messages. |
| `/stm reset`    | Clear memory and checkpoint for the current session.          |
| `/stm logs`     | Print the last ~120 log entries.                              |
| `/stm settings` | Dump the resolved config as JSON.                             |

**Agent tool**

| Tool                | Description                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `short_term_memory` | Full control interface — accepts the same actions as the `/stm` command (`show`, `status`, `update`, `reset`, `logs`, `settings`). |

## How it works

- **Delta summarization** — Only new messages since the last checkpoint are sent to the summarizer. A message-ID checkpoint is saved after each successful update.
- **Injection** — Memory is compacted (placeholder lines and the outer `## Session Memory` header are stripped) and injected as a system message every N user turns.
- **Compaction-aware** — Before a session compacts, the plugin updates memory and pushes it into the compaction context so it survives compression. If the update is still in-flight when the timeout fires, the push is skipped to avoid stale memory.
- **DCP compress** — When DCP's `compress` tool completes, a memory update is triggered automatically to keep memory in sync after conversation compression.
- **Sub-agents** — By default, sub-agent sessions inherit the parent's memory snapshot at creation time. They never summarize on their own. Disable with `injectInSubagents: false`.

### Clean summarizer (side session)

When `summarizerMode` is `"clean"` (the default), the plugin creates a separate side session via the OpenCode SDK API for each summarization task.

Why a separate session?

- **Instruction isolation** — The side session runs with `noReply: true` and only the summarizer system prompt — never the main session's instructions, custom commands, or project rules.
- **Clean chat** — Summarization prompts never appear in the main chat UI.
- **Separate model** — The side session can use a different (often cheaper) model via `memoryModel`, keeping summarization costs low without affecting the main session's model choice.
- **Auto cleanup** — Side sessions are deleted immediately after summarization completes so they don't clutter the session list.
