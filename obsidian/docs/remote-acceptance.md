# Manual publishing acceptance

> Historical record of the earlier personal package. The current three-file candidate uses browser Workers and Obsidian SecretStorage; the old Node renderer and Swift credential helper have been removed from source. Current reproduction steps are in [installation](installation.md), and current results are in [the migration report](../../docs/superpowers/plans/2026-11-25-obsidian-community-migration-results.md).


The Peerpedia 0.1.0 personal package was tested on November 24, 2026 with macOS 15.6.1 on Apple Silicon, Obsidian Desktop 1.15.1, Electron 43.8.9 and host Node.js 24.22.1. The package includes Node.js 22.22.3 for offline rendering. The trial covers Obsidian desktop source-mode authoring on this Mac.

## Installable artifact

| Item | Verified value |
| --- | --- |
| ZIP in the local build output | `obsidian/dist/personal-trial/peerpedia-0.1.0-darwin-arm64.zip` |
| Size | 66,112,904 bytes |
| ZIP SHA-256 | `3f5bfb1b6a975ef229008befde5eabd3d7ef820117dc8ae1f934b0a3bd55360f` |
| Package source commit in `renderer/provenance.json` | `20cb7a4ba139885babe08858331ec431c094acf2` |
| SHA-256 of `package-manifest.json` | `c8f96238a29cbd8a33b92d60f1d55defe013f6876c0b45d6e48cbdee6db0d1d2` |

The archive contains 8,245 files, including 8,244 entries covered by the package manifest and the manifest itself. All 9,259 file and directory entries, file digests and Unix permissions matched after extraction to a path containing spaces and Chinese characters. Both the renderer runtime and the Keychain helper retained mode 0755. The ZIP includes the English installation and usage guides.

Compared with the prior package from commit `6acb988`, 8,241 files are byte-identical. The four changed files are `main.js`, `styles.css`, `renderer/provenance.json` and `package-manifest.json`. The installation guide includes backup and rollback steps. [Installation and rollback](installation.md) · [Usage](usage.md) · [Offline acceptance](local-acceptance.md)

## Tests and observations

| Environment | What passed |
| --- | --- |
| Local fault server with real plugin controllers, disk store and shared renderer | Created a two-chapter paper, rendered an external Unicode edit and math offline, published it, proposed a revision and appended to that proposal. The server stored the append and dropped its response. A reopened store retried the exact bytes with the same request ID, then incorporated the accepted revision while retaining subsequent local edits. The next submission opened a separate proposal. Final counts were one paper, two proposals and four snapshots. No site calls occurred during local actions. |
| Actual Django 5.2.18 API and PostgreSQL 16.2 | Repeated the publication, proposal, append, owner acceptance, manual check, merge and resubmission with the same TypeScript client over HTTP on loopback. The service created four independently verified v4 snapshots. Retrying the last request returned HTTP 200 without an additional snapshot. After a second proposal snapshot existed, the client imported its predecessor and observed the new head. A legacy binding also identified the proposal before and after acceptance. Manual checks changed only the check timestamp. The tests checked the full predecessor, proposal identity and ordinal, normalized metadata, license, and retention of edits. A bad token returned 401, an unknown paper 404, and stale base and changed-content idempotency conflicts 409. |
| Earlier Django single-file and historical contracts | A single-file publication returned manifest v3, preserved Unicode and CRLF, and passed independent CLI hash verification. A changed license returned 409 `license_mismatch`, a stale proposal head returned 409 `stale_pr`, and both left record counts intact. Fresh ORM fixtures for manifests v1–v4 matched the decoded responses in the existing examples and passed the CLI verifier. |
| Final ZIP in Obsidian, synthetic HTTPS site | A changed manuscript required a new confirmation. Its frozen preview showed the reviewed chapter, a visible fraction rule, hidden accessibility MathML and a three-column tagged diagram. A lost response led to an exact retry and one stored snapshot. A subsequent proposal and append showed readable chapter changes and sent the reviewed predecessor. The form named a missing explanation and explained closed or other-owned proposals. |
| Local status and manual checks | Ordinary chapter paths matched the recorded working content. Edits showed “Changed” and a missing chapter showed an unavailable status. An imported historical proposal retained snapshot 1 while a manual check identified snapshot 2. Opening a manifest that named a reserved directory produced an actionable error. Native theorem completion and undo worked in the imported paper. |
| Credentials and network | The final installation displayed session-only storage for a refused or missing helper. The network guards recorded zero off-origin Node HTTPS, other Node HTTP and Chromium HTTP(S) attempts across the tested actions. The renderer child ran with network access denied. Obsidian's separate startup updater attempted to connect. |
| Earlier isolated host evidence | The previous acceptance run covered historical import with a subsequent 404, conflict resolution and cancellation, and explicit offline completion of an interrupted merge. The byte-identical native helper created, read and removed a unique synthetic item in the macOS Keychain. |
| Regression suite | 252 tests passed in 31 files. The two opt-in cases ran separately against Django and Obsidian. Coverage includes manual-only 429 retry, replacement credentials for the same account, rejection of a validly hashed receipt for different content, receipt recovery after a local write failure, historical input and conflicting external edits. TypeScript, explicit type annotations and the production build passed. |

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
