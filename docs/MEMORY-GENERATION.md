# Memory generation

STM maintains a compact Markdown memory for each primary conversation. The
memory model updates five sections: User Instructions, Long Horizon Context,
Decisions, Conclusions, and Active References. The prompt favors retaining
existing facts and explicit user constraints. Its output is an LLM summary;
inspect important instructions rather than assuming perfect retention.

Both OpenCode V1 and V2 support automatic updates, clean and active generation,
an explicit memory model, bounded conversation deltas, and clean-mode retries.
Their native generation APIs differ; the practical differences are listed below.

## When updates happen

Updates normally run in the background after a conversation becomes idle, with
a configurable debounce. Reading memory into an ordinary chat request does not
wait for a new summary. Newly generated memory is available for later injection;
an empty memory immediately after a reply can mean an update is still pending.

Use the STM menu's **Update** action to request an update yourself. This action
calls a model, unlike reading the saved memory or opening settings. V1 defers a
manual active-mode update requested through a tool until the conversation is idle.
V2 requires a delta containing a completed assistant reply; a user-only delta does
not produce memory. Automatic V2 updates also wait for unfinished replies to settle.

STM coordinates concurrent updates for the same session. It checkpoints each
successfully saved chunk, so a later failure can leave an earlier chunk saved.
Reset establishes a forward history boundary and invalidates pending writes;
subsequent updates use conversation records after that boundary. Resetting memory
does not delete the chat, and new messages can introduce old facts again.

## Choose a generation mode

Set these options in `stm.json` or `stm.jsonc`:

```json
{
  "summarizerMode": "clean",
  "memoryModel": "",
  "sideSessionRetries": 1,
  "cleanFallbackToActiveSession": false
}
```

**Clean** is the default. Each attempt uses a fresh temporary OpenCode session,
with the saved memory and selected conversation delta supplied in the prompt.
The source conversation and its injected memory messages are not imported as
chat history. V2 preserves OpenCode's native agent identity and excludes later
project system instructions. STM removes temporary sessions after use; interrupted
or failed cleanup can leave an internal session behind.

**Active** uses the current conversation's context. In V1, the summarization
prompt and response use the current session and may appear in its history. V2
uses native auxiliary generation; with an explicit model override it captures the
active request and generates in an owned temporary session. Choose clean mode
when you want to avoid bringing the active chat context into summarization.

STM excludes its injection messages, owned V1 summarization prompts/replies, and
recognized generated summaries from the conversation delta. Active mode still
has the native active context, which can include already-injected memory; delta
filtering is not a promise to remove that context.

## Choose a model

With `memoryModel: ""`, clean mode leaves model selection to OpenCode. This need
not be the model used by the originating chat. Blank active mode uses the current
session model. To choose a separate model, set `memoryModel` to `"provider/model"`;
both generations support overrides in both modes. V2 explicit overrides do not
inherit a chat model's variant or provider-specific request options.

The model and credentials must already be usable in OpenCode. STM does not grant
free-tier access or bypass provider limits. Authentication failures, model
restrictions, rate limits, and unsupported model options can prevent memory
generation while ordinary chat or STM's read-only actions still work.

## History and size limits

| Option                         | Default | Effect                                                                          |
| ------------------------------ | ------- | ------------------------------------------------------------------------------- |
| `debounceMs`                   | `1200`  | Delay after idle before an automatic update.                                    |
| `maxDeltaMessages`             | `200`   | Recent raw history window, before filtering.                                    |
| `maxUpdateInputLength`         | `20000` | Conversation characters per summary chunk.                                      |
| `maxMemoryLength`              | `10000` | Target used to normalize the saved memory.                                      |
| `collapseAssistantBursts`      | `false` | Keep only the last of adjacent visible assistant replies when enabled.          |
| `includeAgentsMdOnFirstUpdate` | `false` | Include the project/location `AGENTS.md` as reference data on the first update. |

Updates normally start after the saved checkpoint. If it is no longer in the
recent window, STM processes that recent window again. A reset boundary is
located before applying the window, so older conversation is not replayed simply
because the anchor fell outside the limit.

The delta contains visible user and assistant text. Thinking, tool output,
STM injection, and recognized synthetic/internal content are excluded.
This deliberately omits facts present only in tool output. The history window
counts excluded records too, so it is not a guarantee of 200 visible messages.

Large deltas require multiple model requests. One oversized message is truncated
with a marker and checkpointed once; its omitted tail is not summarized later.
The conversation limit excludes the existing memory and prompt instructions, so
it is not a total token or request-size limit. Memory normalization keeps whole
lines and adds metadata; `maxMemoryLength` is not a strict file-size ceiling.

## Retries, isolation, and failures

`sideSessionRetries` is the number of additional clean attempts per chunk
(default one). Active mode makes one attempt. Enabling
`cleanFallbackToActiveSession` permits one active attempt after eligible clean
failures; it is disabled by default because active context has different behavior.
Classified permanent provider failures do not retry or trigger active fallback.

V1 bounds each clean generation attempt to 90 seconds. V2 gives a chunk's clean
attempts and possible fallback one shared 90-second deadline; cancellation or an
expired deadline prevents another attempt. These limits exclude some setup and
cleanup work. Active V1 generation has no corresponding STM 90-second timer.

Clean requests retain native tool definitions where needed for OpenCode model
access. V1 rejects execution of tools and permissions in its owned clean sessions.
V2 uses native auxiliary generation, rather than adding V1's execution hooks;
V2 active requests explicitly remove tool definitions. Active V1 keeps the user's
session permissions. Every mode asks the model to summarize supplied data without
calling tools, reading files, or delegating work.

On failure, inspect **Status** and use **Logs** to find the log file path. Enable
`debug` for generation counts and outcomes. Failed generation does not advance its
chunk checkpoint; successful earlier chunks can remain. An explicit memory edit
or reset during generation prevents the stale result from overwriting it.
