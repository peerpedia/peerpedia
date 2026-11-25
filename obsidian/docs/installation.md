# Install Peerpedia for Obsidian

Requires Obsidian Desktop 1.15.1 or newer on an Apple silicon Mac. Writing and preview work offline; Node.js, Python and TeX are not required at runtime.

## Official directory

Open [Peerpedia in the official directory](https://community.obsidian.md/plugins/peerpedia), choose **Add to Obsidian**, then **Install** and **Enable**. Alternatively, search for **Peerpedia** in **Settings → Community plugins → Browse**. Use the same settings page to check for updates.

The listing is available for installation. Its automated review includes warnings, so listing does not mean every check passed or that the plugin is security-certified.

## Manual installation

Download [Peerpedia 0.1.3 for Apple silicon Macs](https://github.com/peerpedia/peerpedia/releases/download/0.1.3/peerpedia-obsidian-0.1.3-darwin-arm64.zip) and its [SHA-256 checksum](https://github.com/peerpedia/peerpedia/releases/download/0.1.3/peerpedia-obsidian-0.1.3-darwin-arm64.zip.sha256). With both in the same folder, run `shasum -a 256 -c peerpedia-obsidian-0.1.3-darwin-arm64.zip.sha256`; the result should say `OK`.

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

Use Node.js 22.13+ in the 22.x series or Node.js 24+ on Linux or macOS. From the repository root, `npm run build` installs locked dependencies and produces the three plugin files. To choose a new output directory instead:

```sh
npm ci --prefix packages/peerpedia-renderer --ignore-scripts
npm run prepare:browser --prefix packages/peerpedia-renderer
npm ci --prefix packages/peerpedia-theme --ignore-scripts
npm ci --prefix editor --ignore-scripts
npm ci --prefix obsidian
npm run package --prefix obsidian -- /absolute/path/to/new-output/peerpedia
```

Choose a new output directory; the packager refuses to overwrite an existing destination. Installation needs only the three output files. Third-party notices are included in `styles.css` so they remain available after standard installation. The two pinned dependency compatibility patches live in `packages/peerpedia-renderer/patches/`; applying them does not download a runtime.

### Native component provenance

`obsidian/native/anchored.node` is a checked-in macOS binary built from the adjacent `anchored.c`. Packaging verifies both the source and binary SHA-256 against `anchored.json` and refuses stale or altered inputs. macOS CI independently compiles the component using Xcode and compares its bytes. Linux builds reuse the verified binary; they do not compile Darwin source. This boundary is explicit so bundle reproducibility is not confused with independent compilation of native code.

To verify a rebuild on macOS, run `cd obsidian && node_modules/.bin/tsx scripts/native-files.ts`. After an intentional native source change, use the same command with `--write`, review the source, binary and digest changes together, and run the file-transaction tests. Never edit a digest solely to silence a failed check.

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
