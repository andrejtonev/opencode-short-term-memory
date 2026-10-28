# Memory delivery

STM updates a saved memory file and delivers its useful contents to the model.
Updating and delivering memory are separate operations: a successful update does
not necessarily insert a message immediately. The next eligible user turn reads
the saved memory.

Both OpenCode V1 and V2 support session-message delivery, optional system-context
delivery, and memory in the compaction context. Their native APIs and display
formats differ.

## Choose a delivery mode

These settings belong in your `stm.json` or `stm.jsonc`:

```json
{
  "enabled": true,
  "summarizerMode": "clean",
  "enableLegacyPeriodicSystemTransform": false,
  "remindEveryN": 4,
  "maxMemoryLength": 10000
}
```

| Setting combination                                      | Primary-session delivery in V1 and V2      |
| -------------------------------------------------------- | ------------------------------------------ |
| Legacy transform disabled; clean or active summarization | Session message                            |
| Legacy transform enabled; clean summarization            | System/context transform                   |
| Legacy transform enabled; active summarization           | Session message                            |
| `enabled: false`                                         | No automatic memory generation or delivery |

The default is clean summarization with session-message delivery every four
eligible user turns. `summarizerMode` selects how memory is generated; it does
not independently select the delivery mode. Active summarization uses message
delivery even with the legacy flag enabled, so summary requests do not consume
the primary user-turn reminder cadence.

### Session messages

STM adds tagged memory to the session without requesting a separate assistant
reply. V1 uses a no-reply prompt; V2 uses a synthetic steering message without
resuming execution. In V2, the transcript may show only the compact
**Short-term session memory** label rather than the full memory text. Use the
native `/stm` menu's **Show** action to read the saved memory.

This mode leaves the system prompt unchanged by periodic STM reminders. It
avoids the system-prefix change caused by system-transform delivery, but does
not guarantee KV-cache hits, a particular token bill, or provider cache reuse.
OpenCode and the selected provider determine the final request and caching
behavior.

### System/context transforms

With clean summarization and `enableLegacyPeriodicSystemTransform: true`, STM
adds tagged memory to the model's system/context input on eligible turns. It
does not add a primary-session memory message for those periodic reminders.
Changing system-prefix content can affect provider prompt caching.

Task-child startup snapshots and pre-compaction memory use separate delivery
policies; the primary delivery selector does not disable them.

## Reminder cadence

`remindEveryN` counts eligible user turns, not assistant responses or tool calls.
Set it to `1` to remind on every eligible turn. With `4`, reminders occur on
turns 4, 8, 12, and so on. Identified duplicate callbacks do not consume another
turn; STM's own memory messages and summary prompts are excluded.

Resetting memory restarts the cadence at zero. Changing between the message and
system transports also starts a fresh cadence. The counter is runtime state;
it is not a durable count of every historical turn across restarts. System
transforms depend on the turn identity supplied by the host, whereas message
delivery uses the native user-message identity.

Empty memory produces no reminder. STM removes empty placeholder sections, the
outer `Session Memory` heading and its format marker from ordinary reminders,
then clips the remaining memory to `maxMemoryLength` characters. The delivery
tag and explanatory preamble are additional characters; this setting is not a
token budget.

## Before compaction

Both variants attempt to update primary-session memory before compaction, then
include saved memory in the compaction context regardless of the periodic
delivery selector or reminder cadence.

The refresh has a bounded wait. If an update is slow or fails, compaction can
proceed using the memory already on disk. A pending update may complete later;
STM does not guarantee that the compaction context contains the latest turn.
V2 also skips the refresh when the durable history cannot be read safely or has
an unfinished message prefix. The host's compaction hook determines how this
context participates in compression; STM does not guarantee verbatim retention
in the host's resulting summary.

For task children, compaction uses the inherited startup snapshot when child
injection is enabled, rather than generating a new independent child memory.

## When saved memory is not delivered

Check these conditions before changing the model:

- STM is enabled and the next eligible turn has reached `remindEveryN`.
- Saved memory contains useful text rather than only empty template sections.
- You are looking for the selected transport: a session message or system
  context, not necessarily both.
- The session is a primary conversation. Task children follow their snapshot
  policy, and STM's temporary summary sessions do not receive ordinary reminders.
- The session has not been reset or deleted while delivery was pending.

Memory generation can fail because of provider access, quotas or output errors;
delivery reads saved memory and does not itself call a model to summarize it.
Use the native `/stm` menu's **Status**, **Show** and **Logs** actions to inspect
the current state and log-file location.
