# Memory files and reset

STM saves a separate Markdown memory for each OpenCode session. V1 and V2 use
the same memory format and checkpoint filenames. Both support reading memory,
incremental updates and a confirmed reset that starts future updates after the
reset point.

## Find and read memory

Open the native `/stm` menu and choose **Show memory** to read the current
session's saved memory. **Status** shows its memory path and checkpoint;
**Logs** returns the absolute log-file path. These actions do not generate a
summary or create a missing memory file. The `stm_memory_read` tool also reads
the invoking session's memory.

The default storage directory is `.opencode/memory`. A relative `memoryDir`
setting resolves from the OpenCode server process's working directory, not
from the directory containing `stm.json`. An absolute path avoids ambiguity
when starting OpenCode from different directories. Instances that share a
session must use the same storage location to see the same saved memory.

Inside that directory:

| File                                           | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `session_<session-id>.md`                      | The readable memory for one session.                        |
| `checkpoints/<session-id>.last-message-id.txt` | The last conversation record successfully processed.        |
| `v1-reset-boundaries/<session-id>.json`        | V1's saved reset point.                                     |
| `reset-boundaries/<session-id>.json`           | V2's saved reset point.                                     |
| `task-children/<session-id>.json`              | V2's saved parent-memory snapshot for a task child.         |
| `side-sessions.json`                           | V1's tracking of temporary summarizer sessions for cleanup. |
| `session-memory.log`                           | Shared diagnostic log for sessions using this directory.    |

Files appear when their corresponding operation needs them; installing the
plugin does not pre-create every session file. Existing memory files, including
empty files, are preserved during initialization.

Keep these files private as appropriate for your conversations. Memory is
plain text on disk, not an encrypted store. Ignore the memory directory in Git
if its contents should not be committed. STM's temporary-file ignore rules do
not ignore the saved memory itself.

## Memory format and size

New memory starts with this template:

```markdown
<!-- stm:v1 -->

## Session Memory

### User Instructions

- None captured yet.

### Long Horizon Context

- None captured yet.

### Decisions

- None captured yet.

### Conclusions

- None captured yet.

### Active References

- None captured yet.
```

The `stm:v1` marker identifies the file format; it does not mean the file is
restricted to OpenCode V1. Both host generations use it.

The model is asked to preserve instructions and useful prior facts while
updating these sections. Summaries can omit or misstate information; inspect
important instructions rather than treating memory as a complete transcript.
`maxMemoryLength` defaults to 10,000 characters and guides normalization. It
is not a strict file-size limit: normalization keeps the line that crosses the
target, and manually edited files are not automatically shortened on read.

## Incremental updates

An update supplies the existing saved memory plus conversation after the
checkpoint. Successful chunks save both the revised memory and their
checkpoint. Later updates normally continue from there. Large deltas can need
several model requests; an error can leave earlier successful chunks saved.

`maxDeltaMessages` limits the retained recent-history window. Within that
window, `maxUpdateInputLength` bounds individual chunks. Both V1 and V2 truncate
an oversized single message with a marker and checkpoint that record, so its
omitted tail is not processed in a later chunk. See
[Memory generation](MEMORY-GENERATION.md) for filtering, model selection and
update triggers.

If an ordinary checkpoint disappears from available history, STM can resume
from the retained recent window. A saved reset boundary is stricter: STM first
locates that boundary and only then limits newer history. If the boundary is
missing, unreadable or invalid, generation pauses rather than replaying older
conversation.

## Reset starts a new memory period

Choose **Reset** in the native menu and confirm, or invoke `stm_memory_reset`
with `confirm: true`. Reset reads fresh durable conversation history. It
replaces saved memory with the empty template, clears the checkpoint and saves
the latest eligible history record as the reset boundary. A verified empty
conversation also supports reset and accepts later messages.

Both versions reject late results from generation invalidated by reset. The
saved boundary survives restarting OpenCode, and future updates use only
records after it. If history cannot be safely read, reset is refused. If its
saved anchor later becomes unavailable, updates pause; inspect Status and the
log rather than deleting the boundary to force a retry.

Reset does not erase the OpenCode conversation, previously injected messages,
diagnostic logs or separate child-session memories. The chat model can still
see older conversation, and later messages can repeat or refer to old facts
that then enter memory again. For a new conversation context, start a new
OpenCode session. The compatibility `short_term_memory` wrapper has different
confirmation behavior in V1; see [Commands and tools](COMMANDS.md).

## Editing, retention and cleanup

You can inspect or edit the Markdown file directly. Preserve its headings for
predictable subsequent updates. Stop OpenCode before editing for the safest
workflow: both implementations detect some concurrent changes, but writes are
not coordinated across editors or separate OpenCode processes. Checkpoint and
reset-boundary files are STM's bookkeeping, not user-editable settings.

STM stages individual writes before replacing their destination and coordinates
operations within a process. Reset attempts to restore previous files if an
operation fails. These measures are not a guarantee that several files change
together across a crash, power loss or competing external writer. A failed
reset or rollback should be inspected before retrying.

There is no age-based expiry for saved memory. Deleting a session through
OpenCode's session lifecycle removes its memory, checkpoint and reset boundary,
and cleans associated child state known to STM. Cleanup depends on the host
delivering the deletion event and filesystem access succeeding. Shared logs
and unrelated session files remain; deleting the memory directory manually
does not delete OpenCode's conversation history.

`logMaxLines` retains the newest shared log entries (300 by default), not 300
entries per session. Temporary replacement files live under `.stm-tmp` beside
their destination and normally disappear after the operation finishes.
