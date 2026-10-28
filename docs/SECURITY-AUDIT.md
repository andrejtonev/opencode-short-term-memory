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

## Open findings

### P2: unclassified error text can leak provider-supplied credentials

`generationErrorMessage` returns the original message for unclassified errors. A synthetic credential embedded in a plain `Error` survives this conversion; classified HTTP 401 errors correctly replace the remote message with safe guidance. V1 and V2 use this helper for memory diagnostics, including persistent logs, tool results and status.

No actual credential was found in Git or the package. The reproduced failure is the diagnostic boundary: an SDK/provider that includes a credential in an unclassified error can expose it through STM. A follow-up should retain useful operation/error codes while redacting credential fields and avoiding arbitrary remote response text. Other raw-error logging sites should use the same policy.

### Dependency advisories require qualification and updates

`bun audit --json` reports 26 advisory entries across nine package groups in the current lockfile. Entries can repeat across affected version ranges. Eight groups are reachable through production SDK dependency declarations; esbuild is development-only. Presence in an installed dependency graph does not prove STM executes the vulnerable API.

| Package              | Locked versions | Highest severity | Dependency/exposure boundary                                                                                                                                                          |
| -------------------- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| seroval              | 1.5.6           | Critical         | Solid/OpenTUI dependencies; no direct STM `fromJSON` usage found. [Deserialization advisory](https://github.com/advisories/GHSA-p6vx-979v-rg4c).                                      |
| undici               | 8.10.2, 6.28.1  | High             | V2 SDK/util/platform and dependency tooling; TLS, redirect/cache and denial-of-service advisories. [TLS advisory](https://github.com/advisories/GHSA-2m5v-pch6-74hx).                 |
| toml                 | 4.1.1           | High             | Effect dependencies; prototype pollution and parser denial of service. STM config uses JSON/JSONC. [Prototype-pollution advisory](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j). |
| http-cache-semantics | 4.2.0           | High             | V2 SDK utility npm-fetch/cache dependency chain. [Cross-user cache advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).                                                      |
| zod                  | 4.4.3, 4.1.8    | High             | Both plugin SDKs expose validation dependencies; oversized collection validation can exhaust memory. [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).                   |
| ip-address           | 10.7.2          | Moderate         | SDK dependency-install proxy tooling. [Parser advisory](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5).                                                                           |
| @opentelemetry/core  | 2.6.1           | Moderate         | V2 SDK telemetry dependencies. [Baggage advisory](https://github.com/advisories/GHSA-8988-4f7v-96qf).                                                                                 |
| @babel/core          | 7.28.0          | Low              | OpenTUI compiler dependency; crafted source-map comment file read. [Advisory](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8).                                                     |
| esbuild              | 0.27.7          | Low              | Development server on Windows; STM builds do not start that server. [Advisory](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).                                                    |

No dependency upgrade, provider request or vulnerability exploitation was performed. Updates must preserve the supported native host/API versions and be qualified against a new frozen candidate. Existing published archives are immutable and need a later release for runtime fixes.

Redacted machine-readable receipts and the rewrite mapping are retained locally under `.opencode/security-audit/`, which is excluded from Git.
