# RC14 acceptance

`1.4.0-rc.14` packages the reviewed V1/V2 diagnostics, lifecycle and acceptance improvements, plus the isolated Azure Luna manual launchers. Registry publication is tracked separately from source and archive qualification.

## Archive identity

- Archive: `.opencode/rc14/atonev-opencode-short-term-memory-1.4.0-rc.14.tgz`
- SHA-256: `8dc3f0901b83679b5f45edd84570811dacaf5d7d51684d62b3b3396303e61642`
- npm SHA-1: `1111e35247c1dd6e182ec99d0856b729b6065332`
- Size: 265,801 bytes; 106 packaged files.

The archive is read-only. All packaged files match the checkout; source and release identities are retained in `.opencode/rc14/artifact.json`. Repository launchers and acceptance records are not included in the npm archive.

## Qualification

The review-fix commit passed 1,393 source tests with four platform skips and zero failures. Build and public declarations passed. A fresh production consumer installed the exact RC14 archive and passed public imports and strict declaration checks.

Native Windows workflows passed against these exact bytes using the maintained deterministic-provider gate:

| Host         | Injection | Install scope | Functional checks | Cleanup |
| ------------ | --------- | ------------- | ----------------- | ------- |
| V1 `1.18.35` | message   | global        | 10 passed         | PASS    |
| V1 `1.18.35` | system    | local         | 10 passed         | PASS    |
| V2 `2.0.32`  | message   | global        | 11 passed         | PASS    |
| V2 `2.0.32`  | system    | global        | 11 passed         | PASS    |

These checks cover native installation and first-use config creation, automatic generation and selected injection, exclusion of injected memory from summaries, native commands without inference, long-result keyboard navigation, pending-generation reset fencing and post-reset recovery. V2 also verifies native agent identity without implicit project instructions. The first V1 message attempt exceeded the installer's four-minute deadline before any functional checks; its isolated retry passed. Both attempts retain their separate receipts.

The scripts default to Azure Luna, reading the inherited credential or the same Windows Credential Manager entry used by the VS Code launcher. V1 and V2 use generation-specific Azure settings, including supported reasoning-effort and output-limit parameters. Both fresh setup-only launches passed and installed the exact archive, with Azure Luna selected for chat and memory generation and message injection enabled. Default profiles are `C:\stm-manual\v1-rc14` and `C:\stm-manual\v2-rc14`; RC13 profiles are preserved. Setup-only verification sends no model prompts.

These checks do not establish live-provider access, semantic memory quality, actual cache reuse, Ubuntu/Lima behavior or external DCP-package compatibility. Previous RC13 receipts remain scoped to the frozen RC13 archive.
