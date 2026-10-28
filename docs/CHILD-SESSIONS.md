# Child sessions and compression

STM gives task sub-agents a frozen snapshot of their parent's stored memory.
This feature is available on both OpenCode V1 and V2. Children use the snapshot
as context; they do not generate or continuously refresh their own memory.

## Enable or disable inheritance

Inheritance is enabled by default. To disable it, set this in your STM config:

```json
{
  "injectInSubagents": false
}
```

With inheritance disabled, STM does not inject a parent snapshot into child
system context or child compaction context. Children still skip summarization.
This setting controls STM memory, not other context OpenCode gives a sub-agent.

## What a child receives

When STM observes a child creation event with a parent session ID, it reads the
parent's memory as it exists on disk during that initialization. It does not
wait for a new parent summary or summarize the parent's full conversation.
The snapshot is limited by `maxMemoryLength` when injected.

For example, if the stored parent memory says “Use PostgreSQL,” a new child
receives that context. A later parent update to “Use SQLite” does not change
the existing child's snapshot. A subsequently created child can receive the
updated memory.

The same applies to a parent reset: an already captured child snapshot is not
replaced by resetting the parent's memory. Reset the child too if you need STM
to stop delivering its inherited context. Resetting STM does not erase context
that has already entered the conversation or OpenCode's own session history.

An empty or not-yet-updated parent memory cannot provide useful inherited facts.
If a task needs the latest decisions, update the parent's memory before starting
the task and check that the update completed.

## Delivery and visibility

Children receive their snapshot through system context at startup, independently
of the primary session's message-versus-system injection choice. It is not a
periodic visible memory message in the child's transcript. STM also adds the
same snapshot to the child's compaction context.

Reading memory with the menu's **Show memory** action or `stm_memory_read` reads
the current session's ordinary persisted memory file. In a child, that file can
be empty or contain the default placeholder even when inherited context was
injected successfully. The inherited snapshot is separate from that file.

Manual **Update memory** does not make a task child summarize: child updates
are skipped. For editable, independently generated STM memory, use a primary
session rather than a task sub-agent.

## V1 and V2 details

| Behavior                                               | V1                       | V2                                            |
| ------------------------------------------------------ | ------------------------ | --------------------------------------------- |
| Capture parent memory at observed child creation       | Yes                      | Yes                                           |
| Skip child summarization                               | Yes                      | Yes                                           |
| Inject the frozen snapshot at startup and compaction   | Yes                      | Yes                                           |
| Store the inherited snapshot                           | In plugin runtime memory | In `memoryDir/task-children/<sessionID>.json` |
| Suppress future inheritance after resetting that child | Yes                      | Yes                                           |

V1 needs the observed child creation and its runtime snapshot; that snapshot is
not durable across a plugin restart. V2 can reuse a saved snapshot after reload.
If V2 has no saved snapshot and did not observe creation, it skips inheritance
rather than taking a later, potentially different parent snapshot. Invalid
lineage metadata or invalid snapshot files also prevent V2 inheritance.

STM identifies task children from OpenCode's parent-session relationship. A
separately forked V2 conversation without `parentID` is a primary session and
can summarize normally; a fork record alone does not make it a task child.
The snapshot comes from the immediate parent's persisted memory. STM does not
walk an ancestor chain to find another inherited snapshot for nested tasks.

## Completed `compress` tools

STM reacts when the host reports a completed tool named `compress`. It does not
run or install the compression tool itself. This bridge is intended to work
with Dynamic Context Pruning (DCP), but the tool name alone does not identify
which package produced the event.

- **Primary session:** STM requests a memory refresh and attempts to deliver
  stored memory after compression. Duplicate completions are debounced, and
  work is coordinated with updates already in progress.
- **Task child:** STM does not summarize. It marks the frozen snapshot for one
  additional system-context delivery after compression. Parent updates still
  do not replace that snapshot.

Refresh and delivery are conditional on usable host metadata, available settled
history and a valid session. They can be skipped or fail; compression completion
does not guarantee a successful model call. In V2, the follow-up is a native
synthetic message with no resume request, so STM does not explicitly start
another assistant turn to deliver it.

V1 observes completed tool parts; V2 uses the native after-tool hook. If that
optional V2 hook is unavailable, the compression bridge is unavailable while
ordinary STM features continue to run. Support for these events does not certify
every external DCP version on every OpenCode host. Check your installed DCP
package's own compatibility and use STM status/logs to investigate a missed
refresh.

OpenCode's normal session compaction is handled separately from the `compress`
tool bridge: primary sessions attempt a memory update before compaction, while
children keep using their frozen snapshot.
