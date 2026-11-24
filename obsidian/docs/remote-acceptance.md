# Manual publishing acceptance

The Peerpedia 0.1.0 personal package was tested on November 24, 2026 with macOS 15.6.1 on Apple Silicon, Obsidian Desktop 1.15.1, Electron 43.8.9 and host Node.js 24.22.1. The package includes Node.js 22.22.3 for offline rendering. The trial covers Obsidian desktop source-mode authoring on this Mac.

## Installable artifact

| Item | Verified value |
| --- | --- |
| ZIP in the local build output | `obsidian/dist/manual-publication-reviewed/peerpedia-0.1.0-darwin-arm64.zip` |
| Size | 66,016,345 bytes |
| ZIP SHA-256 | `326311ad109603d2e32b736cd27307e69c8d82403f42223ad504a25cac588dc6` |
| Package source commit in `renderer/provenance.json` | `6acb9885a3ac8415a825348f581434d5f6ab5915` |
| SHA-256 of `package-manifest.json` | `c0e5d9f2f58d61c246ab1e302e3316cf4efdc43806ef157062767e884856589e` |

The archive contains 8,245 files, including 8,244 entries covered by the package manifest and the manifest itself. All 9,259 file and directory entries, file digests and Unix permissions matched after extraction to a path containing spaces and Chinese characters. Both the renderer runtime and the Keychain helper retained mode 0755. The ZIP includes the English installation and usage guides.

The installation guide was revised after the full acceptance run to put backup steps before copying the new plugin. Direct comparison with the fully tested package at commit `62c81c9` found 8,242 byte-identical files. The three revised files are `INSTALLATION.md`, `renderer/provenance.json` and `package-manifest.json`. The revised extraction was loaded into a fresh Obsidian test vault for the publication and retry check. [Installation and rollback](installation.md) · [Usage](usage.md) · [Offline acceptance](local-acceptance.md)

## Tests and observations

| Environment | What passed |
| --- | --- |
| Local fault server with real plugin controllers, disk store and shared renderer | Created a two-chapter paper, rendered an external Unicode edit and math offline, published it, proposed a revision and appended to that proposal. The server stored the append and dropped its response. A reopened store retried the exact bytes with the same request ID, then incorporated the accepted revision while retaining subsequent local edits. The next submission opened a separate proposal. Final counts were one paper, two proposals and four snapshots. No site calls occurred during local actions. |
| Actual Django 5.2.18 API and PostgreSQL 16.2 | Repeated the publication, proposal, append, owner acceptance, manual check, merge and resubmission with the same TypeScript client over HTTP on loopback. The service created four independently verified v4 snapshots. Retrying the last request returned HTTP 200 without an additional snapshot. The tests checked the full predecessor, proposal identity and ordinal, normalized metadata, license, and retention of edits. A bad token returned 401, an unknown paper 404, and stale base and changed-content idempotency conflicts 409. |
| Actual Django single-file and historical contracts | A single-file publication returned manifest v3, preserved Unicode and CRLF, and passed independent CLI hash verification. A changed license returned 409 `license_mismatch`, a stale proposal head returned 409 `stale_pr`, and both left record counts intact. Fresh ORM fixtures for manifests v1–v4 matched the decoded responses in the existing examples and passed the CLI verifier. |
| Real Obsidian app with a synthetic HTTPS service | Verified account errors, session-only storage, import of historical source, version checks, 404 handling, two chapter conflicts, cancel, edited/remote choices and offline completion after an interrupted local merge. A changed manuscript required a second review before publication. A lost response led to a manual retry with identical bytes and one stored snapshot. A subsequent proposal and append showed the correct prior manuscript, readable chapter changes and a proposal link, then sent the reviewed predecessor. |
| Credentials and network limits | The installed plugin displayed session-only storage when a test helper returned the native refusal response and when the executable was missing. The extracted native helper separately created, read and removed a unique test item in the real macOS Keychain. Transport guards admitted the exact loopback site only. Chromium was offline for host-local work and the renderer child ran with network access denied. The app's own startup updater recorded failed network attempts. |
| Regression suite | 249 tests passed in 31 files. The two opt-in cases ran separately against Django and Obsidian. Coverage includes manual-only 429 retry, replacement credentials for the same account, rejection of a validly hashed receipt for different content, receipt recovery after a local write failure, historical input and conflicting external edits. TypeScript, explicit type annotations and the production build passed. |

The owner decision used the real website service function in the disposable database. Obsidian’s remote dialogs were exercised using controlled TLS responses so interruptions and recovery could be reproduced. All publication tests used temporary accounts, databases and vaults. The package was installed only into test vaults. Choosing a personal vault and issuing a real public submission are separate user actions.

## Repeat the checks

From the repository root, start with the [build prerequisites](installation.md). The Django contract needs the website's Python dependencies, the editor's Node dependencies, and a Python environment with `pgserver`. The repository's existing test setup uses separate Python interpreters. Set their paths explicitly when they differ.

```sh
npm --prefix obsidian test -- tests/remote-journey.test.ts
PEERPEDIA_PG_PYTHON="$PG_PYTHON" PEERPEDIA_TEST_PYTHON="$APP_PYTHON" \
  npm --prefix obsidian run test:django
npm --prefix obsidian test
npm --prefix obsidian run typecheck
npm --prefix obsidian run check:types
npm --prefix obsidian run build
npm --prefix obsidian run package -- dist/new-trial/peerpedia
```

The Django launcher creates a temporary PostgreSQL cluster and test token for each run, listens only on loopback and removes the cluster afterward. For the packaged publication UI check, use a dedicated Obsidian app and a test Python interpreter with Playwright. The test creates and removes its own profile, vault and TLS service. The local and native-edit checks are listed in [offline acceptance](local-acceptance.md).

```sh
"$TEST_PYTHON" obsidian/scripts/validate-publication-host.py \
  "$TEST_APP" "$EXTRACTED_PACKAGE" "$EVIDENCE/submission"
```
