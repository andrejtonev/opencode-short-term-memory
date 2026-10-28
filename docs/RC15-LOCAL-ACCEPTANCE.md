# RC15 local acceptance

`1.4.0-rc.15` contains diagnostic security hardening and two compatible lockfile patches. The security change is committed as `6cdc105`. It changes diagnostic presentation, not prompts, generation classification, retries, memory contents, delivery, checkpointing or command actions.

Six feature owners verified the generation, delivery, configuration, commands, child/compression and storage/reset implementations against current V1/V2 source. A separate final editor reviewed the resulting guides and README as a 1.4 release snapshot. Shared feature support is distinguished from exact host behavior; documented timing, validation and compatibility limits remain.

## Source and archive checks

The security commit passed 1,401 source tests with four platform skips and zero failures, plus typechecking and build/declarations. New security tests verify redaction and unchanged actual prompt/storage content and counters. Dependency audit entries decreased from 26 across nine groups to 24 across eight; broader dependency upgrades remain deferred under the behavior-preservation constraint.

The frozen archive is `atonev-opencode-short-term-memory-1.4.0-rc.15.tgz`: 293,814 bytes, 118 files, SHA-256 `b06ad69cc4d1e474270ef8c7350abd86070ac547835cd809b647768c86eb2e6d`. Its source commit and byte comparison are retained locally in `.opencode/rc15/artifact.json`. Every packaged file matches the checkout. All 56 relative links across the eleven packaged Markdown files resolve to packaged files. User guides and the changelog are included; private launchers, maintainer audits and release records are excluded.

The fresh production-consumer gate passed installation, all four public imports and strict published declaration checks for server and UI consumers. Its retained receipt is copied to `.opencode/rc15/consumer-evidence.json`. This gate does not activate native host hooks or call a provider. GitLeaks 8.30.1 scanned the extracted final archive and found no detected secrets; its redacted report is retained as `.opencode/rc15/gitleaks-archive.json`.

## Manual setup

Ignored `scripts/start-isolated-v1.ps1` and `scripts/start-isolated-v2.ps1` use the frozen version selected by `package.json`, with default profiles `C:\stm-manual\v1-rc15` and `C:\stm-manual\v2-rc15`. Both default to Azure Luna for chat and memory and session-message injection. RC14 profiles and archives remain unchanged.

Both launchers completed setup-only installation of the exact final archive: native V1 1.18.35 and V2 2.0.32. Profile receipts match the archive hash and package version, and configuration checks confirm `azure-luna/gpt-6-luna` for chat and memory with system transformation disabled. Receipts are retained locally in `.opencode/rc15/manual-v1-setup-receipt.json` and `manual-v2-setup-receipt.json`. Preliminary profiles used before the final changelog-link correction are preserved separately; the default RC15 profiles use only the final archive. No inference or interactive UI checks were performed during this setup.

The user reported successful RC14 manual testing on V1 and V2 on 2026-10-28. No exact provider/host/settings matrix was supplied with that report. This does not requalify RC15 native generation, live provider access, semantic memory quality, cache reuse, Ubuntu/Lima or external DCP compatibility. Setup-only commands make no model requests.

This preparation does not publish RC15 to npm or push Git commits/tags. Historical source hashes in frozen receipts refer to their original histories; the local history-rewrite mapping remains available separately.
