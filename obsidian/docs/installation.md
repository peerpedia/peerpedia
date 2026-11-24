# Install Peerpedia for Obsidian

This checkout builds the standard three Obsidian plugin files. It is a community-channel candidate; it has not yet been submitted to or accepted into the official directory. The current supported target is Apple Silicon macOS with Obsidian Desktop 1.15.1 or newer.

The plugin contains the shared website renderer, theme, fonts and TikZ engine. Writing and preview work offline. No separate Node.js, Python, TeX or credential helper is required at runtime. A small embedded native component still protects publication and recovery file transactions; its acceptance by the official directory remains unresolved.

## Download and install

Download [Peerpedia 0.1.4 for Apple silicon Macs](https://github.com/peerpedia/peerpedia/releases/download/v0.1.4/peerpedia-obsidian-0.1.4-darwin-arm64.zip) and its [SHA-256 checksum](https://github.com/peerpedia/peerpedia/releases/download/v0.1.4/peerpedia-obsidian-0.1.4-darwin-arm64.zip.sha256). With both in the same folder, run `shasum -a 256 -c peerpedia-obsidian-0.1.4-darwin-arm64.zip.sha256`; the result should say `OK`.

1. Extract the archive. The `peerpedia` folder contains exactly `main.js`, `manifest.json` and `styles.css`. To build from source instead, use the commands below.
2. Open your vault folder. In Finder, press **⌘⇧.** to show hidden folders and locate `.obsidian/plugins/` (or your custom configuration directory).
3. If Peerpedia is already installed, disable it and back up its entire plugin folder and your paper folders, including hidden `.peerpedia-obsidian/` state. Preserve `data.json`.
4. Place the three new files in `plugins/peerpedia/`. For an upgrade, retain your previous `data.json`. The old `native/` and `renderer/` directories are no longer used; leave their backed-up copies intact for rollback.
5. Enable community plugins and **Peerpedia**. Open a manuscript and run **Peerpedia: Open paper preview** from **⌘P**. See [Usage](usage.md) for project creation, import and publication.

Older account bindings are retained. Re-enter the token once through **Connect or disconnect a Peerpedia account** to save it in Obsidian secret storage. This version does not read or delete old macOS Keychain entries. Do not copy a token into `data.json`.

## Disable, roll back or remove

Use **Disconnect and remove local credentials** to remove this version's saved Obsidian token. You can also revoke it on Peerpedia. Older macOS Keychain entries are unchanged.

Disable the plugin before replacing its files. For rollback, restore the previous plugin folder and settings from your backup. Your manuscripts, bibliography, binding and recovery records remain in the vault; keep them together. Removing the plugin does not retract published content. Resolve any pending submission before changing versions.

## Build

Use an Apple Silicon Mac, Xcode Command Line Tools, and Node.js 22.13+ in the 22.x series or Node.js 24+. From the repository root:

```sh
npm ci --prefix packages/peerpedia-renderer --ignore-scripts
npm run prepare:browser --prefix packages/peerpedia-renderer
npm ci --prefix packages/peerpedia-theme --ignore-scripts
npm ci --prefix editor --ignore-scripts
npm ci --prefix obsidian
npm run package --prefix obsidian -- /absolute/path/to/new-output/peerpedia
```

Choose a new output directory; the packager refuses to overwrite an existing destination. Installation needs only the three output files. Third-party notices are included in `styles.css` so they remain available after standard installation. The two pinned dependency compatibility patches live in `packages/peerpedia-renderer/patches/`; applying them does not download a runtime.

## Validate a candidate in an isolated vault

These commands launch the supplied Obsidian application with a disposable profile,
Home and vault. They do not install into your working vault. Use Python 3.12 for
`pgserver` compatibility when also running the Django integration test.

```sh
python3.12 -m venv .test-tools/obsidian-ci
.test-tools/obsidian-ci/bin/pip install -r requirements.lock -r requirements-browser.txt pgserver==0.1.4
.test-tools/obsidian-ci/bin/python obsidian/scripts/validate-offline-host.py /Applications/Obsidian.app /absolute/path/to/new-output/peerpedia obsidian/tests/fixtures/render-paper.json /absolute/path/to/offline-evidence
.test-tools/obsidian-ci/bin/python obsidian/scripts/validate-publication-host.py /Applications/Obsidian.app /absolute/path/to/new-output/peerpedia /absolute/path/to/publication-evidence
PEERPEDIA_TEST_PYTHON="$PWD/.test-tools/obsidian-ci/bin/python" npm run test:django --prefix obsidian
```

Publication validation uses a synthetic account and a local HTTPS fixture server.
Django validation starts a separate temporary database and service. Neither sends
requests to the production Peerpedia site. See the migration results document in
`docs/superpowers/plans` for limitations of the host file API comparison.
