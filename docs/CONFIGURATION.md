# Installation and configuration

STM provides the same memory features for OpenCode V1 and V2 through separate
native server and terminal UI entrypoints. Installation syntax and configuration
keys differ between the hosts. The package exports the server, `/tui` and `/rpc`
companions; keep their package versions aligned.

## Install for your OpenCode generation

Choose an available 1.4-compatible build from the [changelog](../CHANGELOG.md),
or a prepared local package archive. Replace `<version>` in the examples below;
an unversioned npm install can select an older feature set.

For V1, run the local command from your project, or choose the global command:

```sh
opencode plugin '@atonev/opencode-short-term-memory@<version>' --force
opencode plugin '@atonev/opencode-short-term-memory@<version>' --global --force
```

V1 uses the singular `plugin` array in `opencode.json`. Enable the same package
in `tui.json` to load the native `/stm` menu. Preserve other plugins in both files:

```json
{
  "plugin": ["@atonev/opencode-short-term-memory@<version>"]
}
```

The V1 installer uses the Git worktree's `.opencode` directory for local installs,
or the current directory's `.opencode` outside Git. Global installs use the host's
global configuration directory. `--force` replaces the installed plugin version;
it does not reset memory or overwrite STM settings.

For V2, the native command installs globally and has no `--global` option:

```sh
opencode plugin add '@atonev/opencode-short-term-memory@<version>'
```

V2 uses the plural `plugins` array. Verify the same package is enabled in both
global server `opencode.json` and terminal UI `cli.json`, preserving other entries:

```json
{
  "plugins": ["@atonev/opencode-short-term-memory@<version>"]
}
```

The normal global directory is `~/.config/opencode`, or
`$XDG_CONFIG_HOME/opencode` when XDG configuration is set. `OPENCODE_CONFIG_DIR`
can select a custom host configuration directory. Use the host's configuration
paths for your installation rather than assuming Windows uses AppData. On V1,
`opencode debug paths` reports those paths. Server-only installation can expose
memory tools without providing the terminal menu.

Use an explicit package version when you need reproducible installation; release
and prerelease versions are listed in the [changelog](../CHANGELOG.md).

## Where STM settings live

On first plugin activation, STM creates a minimal `stm.json` containing `{}` at
the supported native installation scope: global configuration directory for a
global install, or the declaring project's `.opencode` directory for a local
install. This inherits defaults and lower configuration layers. Creation happens
when OpenCode loads STM, rather than when npm or the installer finishes.

Existing `stm.json` and `stm.jsonc` files are preserved, including malformed
files. No setup command is required. The optional **Create example config** menu
action confirms before creating project `.opencode/stm.jsonc`, and refuses to
overwrite either filename. It remains useful when automatic creation was skipped.

Automatic creation requires a verifiable static npm installation declaration.
V1 uses native installation-origin metadata. V2 reconstructs supported file-backed
declarations and conservatively skips ambiguous, dynamic, virtual, explicitly
overridden or symlinked origins. A skipped creation does not prevent existing
settings or defaults from working. **Settings** reports searched files, selected
files and the installation result.

Both generations merge STM settings in this order, with later values winning:

1. `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when XDG is unset.
2. `~/.opencode`.
3. `OPENCODE_CONFIG_DIR`, when set.
4. The nearest `.opencode` directory at or above the host project directory;
   if none exists, `<project>/.opencode` is searched.

Within each directory, the first valid `stm.jsonc` is preferred to `stm.json`.
JSON comments and trailing commas are accepted in either filename. A malformed
or non-object file is ignored as a whole; a valid sibling, lower layer or defaults
can still apply. Project settings are selected from one nearest directory, rather
than merged from every ancestor. These STM rules are separate from OpenCode's
own native configuration discovery.

Restart OpenCode after editing configuration to check the new effective settings.
V1 caches configuration for up to 60 seconds; V2 rereads it during operations.

## Settings reference

All 17 settings are optional and supported in both generations. Only override
values you need. The package's [example](../stm.example.jsonc) is JSONC.

| Setting                               | Type    | Default              | Effect and limits                                                                                                                                                               |
| ------------------------------------- | ------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                             | boolean | `true`               | Enables automatic memory work and delivery. Manual inspection remains available.                                                                                                |
| `memoryModel`                         | string  | `""`                 | Optional `provider/model` override in either summarizer mode. Blank clean mode uses a fresh host default; blank active mode uses the current session model.                     |
| `summarizerMode`                      | string  | `"clean"`            | `clean` uses a fresh owned summary session. `active` uses the current session context; see model selection below.                                                               |
| `cleanFallbackToActiveSession`        | boolean | `false`              | Allows an eligible exhausted clean failure to fall back to active generation. Classified permanent provider failures do not fall back.                                          |
| `includeAgentsMdOnFirstUpdate`        | boolean | `false`              | Includes project `AGENTS.md` as reference data on the first update without a checkpoint. V2 reads at most 20,000 bytes, additionally bounded by `maxUpdateInputLength`.         |
| `injectInSubagents`                   | boolean | `true`               | Makes a parent-memory snapshot available to eligible task children. Snapshot timing follows the native host lifecycle.                                                          |
| `enableLegacyPeriodicSystemTransform` | boolean | `false`              | Selects system/context transformation in clean mode. Otherwise, session-message delivery is used; active mode always uses session-message delivery.                             |
| `sideSessionRetries`                  | integer | `1`                  | Additional clean-generation attempts, clamped to 0–10. Active generation does not use this retry loop. V2 shares one chunk deadline across retries and fallback.                |
| `remindEveryN`                        | integer | `4`                  | Delivery cadence in eligible user turns, clamped to 1–1,000. Empty memory is not delivered.                                                                                     |
| `maxMemoryLength`                     | integer | `10000`              | Stored-memory text target in characters, clamped to 200–50,000. Complete lines and metadata can exceed the target; it is not a strict file-size limit.                          |
| `maxUpdateInputLength`                | integer | `20000`              | Conversation-text budget per update chunk in characters, clamped to 500–200,000. Existing memory, instructions and prompt formatting are additional overhead.                   |
| `maxDeltaMessages`                    | integer | `200`                | Recent-history look-back limit before checkpoint filtering, clamped to 20–10,000. A checkpoint outside that window causes a rebase onto retained history.                       |
| `collapseAssistantBursts`             | boolean | `false`              | Keeps only the last consecutive visible assistant reply between user turns. Reasoning and internal parts are filtered independently of this setting.                            |
| `debounceMs`                          | integer | `1200`               | Debounce for scheduled updates in milliseconds, clamped to 100–120,000. It is not a provider timeout.                                                                           |
| `debug`                               | boolean | `false`              | Adds diagnostic metadata. Prompts, conversation text and generated memory are excluded from diagnostic dumps.                                                                   |
| `logMaxLines`                         | integer | `300`                | Rolling JSONL log retention, clamped to 20–20,000 lines.                                                                                                                        |
| `memoryDir`                           | string  | `".opencode/memory"` | Memory, checkpoint, reset-boundary, side-session tracking and log directory. Relative paths resolve from the server process's current working directory, not the settings file. |

Numeric strings are accepted, finite numbers are truncated to integers and then
clamped. Booleans also accept case-insensitive `"true"` and `"false"` strings.
Other invalid types use defaults. Strings are trimmed; empty `memoryDir` uses its
default. `summarizerMode` accepts case-insensitive `active`; other values use
`clean`. An invalid value in a higher layer replaces the inherited value before
normalization, so it can select a default rather than preserve the lower layer.

## Model selection and delivery

Configure provider credentials and model options in OpenCode, rather than STM.
`memoryModel` selects an already configured provider/model; it does not configure
authentication, deployments, endpoints or reasoning options. For example:

```jsonc
{
  "memoryModel": "your-provider/your-model",
  "summarizerMode": "clean",
  "remindEveryN": 4,
}
```

A blank clean override does **not** guarantee the chat model is used: both hosts
resolve a fresh-session default. Set an explicit override when that distinction
matters. V2 active generation with an override captures the exact active request
context into an owned session using the requested model; without an override it
generates against the active session. V1 active generation is delivered into the
active session and may appear in chat.

Both hosts support session-message delivery and system/context transformation.
The default appends a memory message without requesting a model reply. Clean
mode with `enableLegacyPeriodicSystemTransform: true` uses system/context
transformation. Active mode uses message delivery even with that selector set,
to avoid injecting into its own summarizer request. System-prefix changes can
invalidate provider prompt caches; exact cache behavior is provider-dependent.

Memory generation sends existing memory and selected conversation to the model.
V1 rejects tool/permission execution in its owned clean summarizer sessions;
V2 uses native auxiliary generation without V1's execution hooks. These calls
still use the provider account and may consume its quota; STM cannot guarantee
free access or bypass model restrictions. **Status** and **Settings** expose the
selected mode/model and diagnostic state; a provider error is not evidence that
memory generation or delivery is disabled.

## Local data and diagnostics

Memory and checkpoint files remain on the OpenCode server machine. **Logs**
returns the absolute server log path without reading its contents or asking the
model to interpret it. Inspect that file locally with `cat` or PowerShell's
`Get-Content`.

Diagnostic presentation redacts common credential formats, sensitive field names
and recognized inherited secrets, and omits raw provider request/response bodies.
It does not redact stored memory or change model inputs. Memory files, model
responses and older logs can contain private conversation data; review files
before sharing them, and keep credentials out of conversation and STM settings.
