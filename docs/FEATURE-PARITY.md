# V1 and V2 behavior

V1 and V2 provide the same core STM feature set. They use separate native APIs;
feature support does not promise identical timing, transcript output or error
handling. The [feature comparison](FEATURE-MATRIX.md) lists the common features.

## Differences that affect use

| Area                        | V1                                                                                                     | V2                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Installation                | `plugin` arrays in server `opencode.json` and UI `tui.json`; local or global installer.                | `plugins` arrays in global server `opencode.json` and UI `cli.json`; global installer.                                                |
| Configuration reload        | Cached for up to 60 seconds; restart after edits.                                                      | Reread during operations; restart is still a useful verification step.                                                                |
| Active summarization        | Uses the current conversation; prompt/reply can appear in history and current tool permissions remain. | Uses native auxiliary generation with tools removed; an explicit model override uses a captured active context in an owned session.   |
| Clean generation            | Fresh owned native session; STM rejects tool/permission execution.                                     | Fresh owned native session through auxiliary generation, retaining native tool definitions; it does not install V1's execution hooks. |
| Update eligibility          | Can summarize visible user-only conversation.                                                          | Selected delta must include a completed assistant reply; unfinished replies delay automatic updates.                                  |
| Time limits and retries     | Each clean attempt has a 90-second generation limit; active generation has no equivalent STM timer.    | Clean attempts/fallback share a 90-second chunk deadline; timeout/cancellation prevents another attempt.                              |
| Session-message display     | Native no-reply prompt presentation.                                                                   | Synthetic steering message may display only **Short-term session memory**.                                                            |
| Result reader               | Keyboard-paged dialog.                                                                                 | Native height-bounded scrolling dialog.                                                                                               |
| Child snapshot storage      | Runtime only; lost on plugin restart.                                                                  | Separate saved snapshot can be reused after reload.                                                                                   |
| Status                      | Runtime counters and delivery state.                                                                   | Runtime counters plus persistent checkpoint/reset state and updater ownership.                                                        |
| Compatibility wrapper reset | Legacy `short_term_memory` reset does not enforce confirmation.                                        | Wrapper reset requires literal `confirm: true`.                                                                                       |

Use the native menu or named `stm_memory_reset` tool for confirmed reset in
either generation. In V1, Status reports actual delivery mode; Settings can
report the legacy selector without accounting for active-mode message fallback.

## Common expectations

- Blank clean generation uses a fresh host default; blank active generation uses
  the session model. Valid `provider/model` overrides work in either mode.
- Primary reminders are session messages by default. System/context reminders
  require clean mode and the legacy transform selector; active always uses messages.
- Both skip child summarization and use a frozen parent-memory snapshot instead.
- Reset fences pending old results and persists a forward history boundary; it
  does not erase the conversation or already-injected context.
- Logs returns a server file path only. Native reads/reset/setup do not invoke
  the memory model; eligible Update does.

## Limits shared across hosts

Provider/model access, quotas and output quality remain external dependencies.
Memory length is a normalization target, and one oversized conversation record
is truncated rather than losslessly split. Successful chunks can remain after a
later failure. File coordination is within a process, not a crash-safe
multi-file transaction or a cross-process lock.

Clean mode isolates the summarizer's conversation history. Active mode includes
native active context and can still see earlier memory injections. Neither
provider caching nor universal exactly-once system reminder timing is promised.
V2 does not provide the same explicit clean-tool execution guard as V1; do not
infer that guarantee from shared feature support.

Native action routing assumes a trusted OpenCode server. Session/project matching
correlates results; it is not multi-user authentication. A timeout or dismissed
result does not guarantee that an admitted mutation stopped. Inspect persisted
state before retrying.

See [generation](MEMORY-GENERATION.md), [delivery](MEMORY-DELIVERY.md),
[controls](COMMANDS.md), [children](CHILD-SESSIONS.md) and
[files/reset](MEMORY-FILES.md) for detailed limits. Historical parity reviews and
exact release qualification are indexed separately in [Documentation](README.md).
