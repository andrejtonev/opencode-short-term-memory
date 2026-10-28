# Repository security audit — 2026-10-28

## Scope and removal

The personal Windows V1/V2 manual setup files, their helpers/tests and their dedicated documentation are removed from repository history. Release-acceptance runners remain maintained. Private copies are outside Git; the existing npm RC14 archive contains none of these setup files.

The rewrite covers local branches, tags and stashes. Remote branch and tag references do not contain the removed files and are preserved. Reflogs and unreachable objects are purged after the rewrite; stash entries are preserved separately during that operation. Historical source hashes in frozen acceptance records retain their original meaning and can be mapped through the local rewrite receipt.

## Credential checks

- GitLeaks 8.30.1 scanned 175 commits, including branches, tags and reflogs, before removal: no detected secrets. The downloaded scanner was checked against the official release SHA-256 digest.
- Exact credential matching checked all 6,094 Git blobs, including unreachable objects: no matches for the available Azure environment credential, Windows Credential Manager credential or npm credential. Credentials were compared in memory and never included in reports.
- The downloaded public RC14 archive passed secret scanning. It matches the previously frozen archive; this cleanup does not republish or alter npm packages.
- Tracked-file and rewritten-history scans are repeated after cleanup. These checks establish the stated scope; they cannot prove that every possible secret format is recognizable.

Personal Azure resource and credential-store setup details were in the removed manual documentation. Older acceptance documents still contain local user/temp paths and synthetic conversation evidence; those are personal metadata rather than credentials. Do not treat such evidence as automatically safe for public sharing.

## Diagnostic hardening (2026-10-28)

The follow-up changes only diagnostic presentation and two transitive lockfile patches. Generation prompts, model requests, retry/permanence classification, memory contents, checkpoints, lifecycle and command actions are unchanged.

- New diagnostic text redacts credential fields, Authorization schemes, common credential-token formats, URL userinfo/SAS signatures and exact inherited credential values. Credentials are read only from the existing process environment; no authentication retrieval or credential persistence is added. Oversized remote diagnostics are omitted whole rather than retaining a potentially secret-bearing fragment.
- Persistent JSON diagnostic logs redact credential fields and raw provider request/response body/header dumps, including nested fields, without mutating the input. Ordinary operation names, error codes, IDs and counts remain available.
- V1 debug logs no longer store summarizer prompts or injected memory content; completion and malformed-output events no longer store memory previews. Actual prompts and saved memory remain unchanged.
- Generation-error output, runtime status, command/dialog errors and the Windows Azure acceptance runner's final console output use the same presentation protection (the runner also retains its known-secret redactor).

Redaction is defense in depth, not proof that arbitrary private data is recognizable. An unknown opaque credential without a field name, recognizable format or inherited value can still occur in remote text. Existing logs and public RC14 are not rewritten. Saved conversation/memory and intentionally retained acceptance request evidence still require care before sharing.

## Remaining findings

### P2: unclassified provider error text needs a diagnostic boundary (mitigated)

The original `generationErrorMessage` returned the original message for unclassified errors. A synthetic credential embedded in a plain `Error` survived this conversion; classified HTTP 401 errors correctly replaced the remote message with safe guidance. V1 and V2 use this helper for memory diagnostics, including persistent logs, tool results and status. The new shared diagnostic boundary redacts the reproduced credential cases and raw provider dumps; classification still examines the original error.

No actual credential was found in Git or the package. Regression tests exercise unclassified inherited credentials, credential fields/tokens, nested provider dumps, real persistent log output, unchanged ordinary diagnostics and unchanged permanent/retryable classification.

### Dependency advisories require qualification and updates

The original `bun audit --json` reported 26 advisory entries across nine package groups. After the compatible lockfile-only patches below it reports 24 entries across eight groups. Entries can repeat across affected version ranges. Seven remaining groups are reachable through production SDK dependency declarations; esbuild is development-only. Presence in an installed dependency graph does not prove STM executes the vulnerable API.

| Package              | Locked versions | Highest severity | Dependency/exposure boundary                                                                                                                                                                      |
| -------------------- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| seroval              | 1.5.6           | Critical         | Solid/OpenTUI dependencies; no direct STM `fromJSON` usage found. [Deserialization advisory](https://github.com/advisories/GHSA-p6vx-979v-rg4c).                                                  |
| undici               | 8.10.2, 6.28.1  | High             | V2 SDK/util/platform and dependency tooling; TLS, redirect/cache and denial-of-service advisories. [TLS advisory](https://github.com/advisories/GHSA-2m5v-pch6-74hx).                             |
| toml                 | 4.1.2           | High             | Prototype-pollution advisory patched; parser denial of service remains. Effect dependencies; STM config uses JSON/JSONC. [Recursion advisory](https://github.com/advisories/GHSA-82x6-q7mm-w9cf). |
| http-cache-semantics | 4.2.0           | High             | V2 SDK utility npm-fetch/cache dependency chain. [Cross-user cache advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).                                                                  |
| zod                  | 4.4.3, 4.1.8    | High             | Both plugin SDKs expose validation dependencies; oversized collection validation can exhaust memory. [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).                               |
| @opentelemetry/core  | 2.6.1           | Moderate         | V2 SDK telemetry dependencies. [Baggage advisory](https://github.com/advisories/GHSA-8988-4f7v-96qf).                                                                                             |
| @babel/core          | 7.28.0          | Low              | OpenTUI compiler dependency; crafted source-map comment file read. [Advisory](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8).                                                                 |
| esbuild              | 0.27.7          | Low              | Development server on Windows; STM builds do not start that server. [Advisory](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).                                                                |

`ip-address` 10.7.2 → 10.7.5 removes its parser advisory; `toml` 4.1.1 → 4.1.2 removes the prototype-pollution advisory. These are same-minor patch updates permitted by the existing parents' semver declarations, with registry integrity metadata retained locally. `bun install --frozen-lockfile --ignore-scripts` installed only these two changed packages. No direct dependency declarations, SDK/host/API versions or overrides changed. These lockfile choices qualify the checkout; consumers resolving their own dependency graph are not pinned by this repository's lockfile.

Broader updates remain outside this behavior-preserving change: Solid 1.9.17 would require violating OpenTUI 0.5.10's exact Solid 1.9.12 peer to reach patched Seroval; patched Undici, TOML parser, Zod, OpenTelemetry, Babel, cache-semantics and esbuild versions require minor/major changes or pinned SDK dependency changes. No forced override was added. No provider request or vulnerability exploitation was performed. A later frozen candidate must qualify runtime changes before publication; published RC14 remains immutable.

Redacted machine-readable receipts and the rewrite mapping are retained locally under `.opencode/security-audit/`, which is excluded from Git.

## Hardening validation

- Eight new security tests exercise the diagnostic boundaries; the focused diagnostics/provider suite passes 19 tests.
- Final source suite: 1,401 passed, four Windows platform skips, zero failures across 89 files.
- Typecheck, build/declarations, changed-file Prettier check and `git diff --check` passed.
- Frozen-lock installation verified the two compatible patches; the refreshed dependency audit still reports the 24 advisory entries described above.

No new native host/live-provider qualification or publication was performed. These checks qualify the current source checkout, not the immutable RC14 archive.
