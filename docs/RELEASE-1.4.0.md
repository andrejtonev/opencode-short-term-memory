# 1.4.0 release verification

The stable release uses RC15's runtime implementation (`f3f780b`), fast-forwarded
from `dev` into `main`. Plugin source files, dependency declarations, lockfile and build
configuration are unchanged. Release changes set version `1.4.0`, select npm's
`latest` tag, finalize the changelog and pin installation examples to `1.4.0`.

## Frozen archive

- Archive: `atonev-opencode-short-term-memory-1.4.0.tgz`.
- Size: 295,334 bytes; 118 files.
- SHA-256: `914088ac8dd3528136162bd7b09b9a8218042fb550d7db6396d3a023b0001b88`.
- Local identity and source commit: `.opencode/1.4.0/artifact.json`.

Every packaged file matches the checkout. All three executable JavaScript
bundles are byte-identical to the published RC15 archive. Other differences are
release metadata/documentation and Windows line endings, including source-map
embedded source text. All 118 files were compared; the retained receipt is
`.opencode/1.4.0/rc15-comparison.json`.

## Checks and scope

The packaged guides contain 56 valid relative links, and private manual launchers
are excluded. Fresh-consumer installation, four public imports and strict
published declaration checks are recorded in `.opencode/1.4.0/consumer-evidence.json`.
Archive secret-scan evidence is retained as `gitleaks-archive.json` in the same
directory. Full typechecking and source tests are required by the release commit
hook; its receipt is `.opencode/1.4.0/release-commit.log`.

The first release commit check exposed an LF-only script delimiter in a Windows
cleanup test after Git checked scripts out with CRLF. The test now normalizes
line endings before extracting the same finalization block; all eight targeted
harness tests passed. This test-only change does not affect the archive. The
initial full-suite receipt is retained as `release-commit-first.log`.

A subsequent sweep stalled in a fixture that allowed only 1 ms for generation to
start and then awaited a start signal. The fixture now uses the per-update 250 ms
test deadline and awaits the bounded result directly, while still asserting one
started call and late-rejection handling. All 76 V2 updater tests passed, with two
platform skips. The stopped sweep's log is retained as `release-commit-stalled.log`;
neither harness correction changes packaged runtime code.

RC15's earlier source suite passed 1,401 tests with four platform skips and zero
failures. Its native V1 1.18.35/V2 2.0.32 setup-only installations and user-reported
RC14 manual testing remain separate historical evidence. The stable preparation
does not rerun live providers, interactive native UI, Ubuntu/Lima, cache behavior
or external DCP compatibility.

## Publication

Publish the exact frozen archive under `latest`; retain RC15 under `rc`.
Publication is complete only after checking registry version/tags/integrity and
comparing downloaded tarball bytes. The resulting receipt is retained locally as
`.opencode/1.4.0/publication.json`. This record describes verification scope and
does not itself establish registry availability.
