# Feature comparison

This is the 1.4 feature snapshot, not a declaration that every OpenCode version
or provider has been qualified. Both V1 and V2 support the core features below.
Their native APIs, timing and persistence differ; see
[V1/V2 behavior](FEATURE-PARITY.md) for the practical distinctions.

| Feature                                                  | V1  | V2                                   | Guide                              |
| -------------------------------------------------------- | --- | ------------------------------------ | ---------------------------------- |
| Automatic idle updates                                   | Yes | Yes                                  | [Generation](MEMORY-GENERATION.md) |
| Pre-compaction refresh and saved context                 | Yes | Yes                                  | [Delivery](MEMORY-DELIVERY.md)     |
| Clean and active summarization                           | Yes | Yes                                  | [Generation](MEMORY-GENERATION.md) |
| Explicit memory model in either mode                     | Yes | Yes                                  | [Configuration](CONFIGURATION.md)  |
| Incremental checkpoints, bounded delta and clean retries | Yes | Yes                                  | [Generation](MEMORY-GENERATION.md) |
| Optional initial AGENTS.md reference                     | Yes | Yes                                  | [Configuration](CONFIGURATION.md)  |
| Session-message delivery without a reply                 | Yes | Yes                                  | [Delivery](MEMORY-DELIVERY.md)     |
| Clean-mode system/context reminders                      | Yes | Yes                                  | [Delivery](MEMORY-DELIVERY.md)     |
| Configurable reminder cadence                            | Yes | Yes                                  | [Delivery](MEMORY-DELIVERY.md)     |
| Frozen parent memory for observed task children          | Yes | Yes                                  | [Children](CHILD-SESSIONS.md)      |
| Completed compress bridge                                | Yes | When native hook is available        | [Compression](CHILD-SESSIONS.md)   |
| Native seven-action menu and navigable results           | Yes | Yes                                  | [Controls](COMMANDS.md)            |
| Seven named tools and compatibility wrapper              | Yes | Yes                                  | [Controls](COMMANDS.md)            |
| Read existing memory and return log path only            | Yes | Yes                                  | [Controls](COMMANDS.md)            |
| Confirmed menu/named-tool reset with persistent boundary | Yes | Yes                                  | [Files and reset](MEMORY-FILES.md) |
| Automatic minimal config on verified installation        | Yes | Yes, with conservative origin checks | [Configuration](CONFIGURATION.md)  |
| Optional example config without overwriting settings     | Yes | Yes                                  | [Configuration](CONFIGURATION.md)  |
| Local Markdown memory and rolling diagnostic log         | Yes | Yes                                  | [Files](MEMORY-FILES.md)           |

An available feature can still be skipped or fail because of missing history,
unavailable host hooks, provider access, filesystem errors or an unfinished
update. Child snapshots require observed creation; a later read does not rebuild
an unobserved parent's historical snapshot. Size settings are conversation/text
limits, not exact token budgets or strict memory-file size ceilings.

Release-specific test evidence is kept in release records, rather than used as
a blanket compatibility claim. See the [documentation index](README.md).
