# RC13 local acceptance

`1.4.0-rc.13` is a local candidate. No Git push or npm publication is included.

## Change and reproduction

V2 clean memory generation used UUID-derived session IDs and replaced the native agent system instruction. OpenCode accepted those IDs locally, but its free-model service rejected the summary with HTTP 429 while ordinary DeepSeek chat worked.

The controlled RC12 reproduction required both native-format IDs and native system instructions: changing either alone still failed; changing both returned HTTP 200 and saved the diagnostic memory. Those temporary installed-package experiments were restored afterward. They are diagnostic evidence, not acceptance of RC13 bytes.

RC13 generates IDs in OpenCode's timestamp/counter/base62 format before session creation, preserving the existing ownership fence. Clean generation keeps the first native agent system part and removes implicit project system parts and conversation history. The supplied summary prompt still contains the memory, conversation delta, rules and optional explicit AGENTS.md context. Native `session.generate` does not execute tools.

Regression coverage checks native ID format and timestamp, uniqueness, ownership before creation, exact native agent preservation, project instruction exclusion and isolation from unrelated requests. The native acceptance runner also checks the agent prefix in captured V2 HTTP requests. That wire check is scoped to OpenCode 2.0.32, which combines agent and initial model/project parts into one system message.

## Frozen archive

- Archive: `.opencode/rc13/atonev-opencode-short-term-memory-1.4.0-rc.13.tgz`
- SHA-256: `dcfa5fb9f7e64818dcfc6f13b152a33546e8ff9910525d0a2ab8c45f39046385`
- npm SHA-1: `b5e4501cf53b007e6dfa80c5e2f0d30099acd2ba`
- Size: 262,897 bytes; 102 regular packaged files.

All packaged files match the checkout. The archive is read-only. Final source commit and source-suite counts are recorded in `.opencode/rc13/artifact.json` after the required commit hook completes. Repository docs and acceptance scripts are not included in the npm archive.

## Verified workflows

Build and focused generation/acceptance regressions passed: 12 tests, zero failures. The commit hook requires typecheck and the full isolated source suite. A fresh production consumer installed the exact archive and passed public imports and strict published declaration checks.

The native Windows acceptance runner installed the exact archive through OpenCode's CLI from an isolated loopback registry, with empty private caches and no pre-created STM config or generated memory:

| Native host | Delivery        | Installation  | Result |
| ----------- | --------------- | ------------- | ------ |
| V1 1.18.35  | Session message | Global        | PASS   |
| V1 1.18.35  | System/context  | Project-local | PASS   |
| V2 2.0.32   | Session message | Global        | PASS   |
| V2 2.0.32   | System/context  | Global        | PASS   |

Each run proved automatic memory creation after ordinary terminal chat, generated memory in the next provider request, exclusion of injected memory from the summary delta, typed native `/stm` results, long-result navigation, Logs returning its path, commands without inference, pending-provider reset fencing and generation from the post-reset boundary. Cleanup passed. V2 captured requests additionally passed native agent preservation checks.

Receipts are retained under `.opencode/rc13/`: `consumer-evidence.json`, the four `v1/v2-message/system-evidence.json` files, and `artifact.json`.

## Live-provider limitation

The fresh RC13 profile's ordinary DeepSeek free chat returned HTTP 429 before any memory generation. A native control with STM removed also returned `provider.quota` with the same “Free usage limit reached” error. One bounded check of Big Pickle also failed on ordinary chat before STM generation. No repeated summary loop was observed in these blocked runs.

Therefore the current machine's free-provider access blocks live acceptance of RC13. The passing offline/native checks do not establish that the production fix restores DeepSeek access. Retry live acceptance when ordinary native chat works again; verify automatic saved memory and delivery into the next chat against this exact archive. Do not substitute the earlier modified-RC12 result for that qualification.

Provider controls are retained in `native-free-control.json`, `deepseek-blocked-evidence.json`, `deepseek-blocked-requests.jsonl`, `live-evidence.json` and `live-requests.jsonl`. No paid model was used. Active summarizer overrides, provider cache-hit behavior, Ubuntu/Lima and external DCP-package compatibility remain outside this acceptance scope.
