# Install Peerpedia for Obsidian

This package is for Apple Silicon Macs. It was tested with Obsidian Desktop 1.15.1 on macOS 15.6.1. The ZIP includes the website renderer, local fonts, TikZ assets, Node.js 22.22.3 and a macOS Keychain helper. You can write and preview a paper offline immediately after installation.

## Install in a vault you choose

1. Keep the ZIP and its accompanying `.sha256` file together. From their directory, run `shasum -a 256 -c peerpedia-obsidian-0.1.3-darwin-arm64.zip.sha256`. Continue when the ZIP reports `OK`.
2. Extract the ZIP with Finder. The resulting `peerpedia` folder contains `manifest.json`, `main.js`, `styles.css`, `native/`, `renderer/`, and the user guide `USAGE.md`. Keep the entire folder together with its executable permissions.
3. Choose the vault to use. For a first trial, create a new vault in Obsidian. Open the vault folder in Finder and press **⌘⇧.** to show hidden files. Locate `.obsidian/plugins/`, or the `plugins/` folder under your custom configuration directory.
4. **If Peerpedia is already installed**, disable it in **Settings → Community plugins**. Move the entire existing `plugins/peerpedia/` folder to a backup location outside `plugins/`. Keep its settings file (`data.json`, if present) with it. Back up your paper folders, including their hidden `.peerpedia-obsidian/` state, and check that you can open the backups.
5. Once the destination `plugins/peerpedia/` is free, copy the newly extracted `peerpedia` folder into `plugins/`. Create the parent `plugins/` folder if needed.
6. For an upgrade, copy the backed-up `data.json` into the new plugin folder to retain your settings. Keep the original backup. Reopen the vault, allow community plugins and enable **Peerpedia**. Run **Peerpedia: Create paper** from the command palette. Choose **Multiple chapters** to start a chaptered manuscript. The installed `USAGE.md` walks through writing, preview, import and publication.

The file `package-manifest.json` lists SHA-256 checksums relative to the plugin folder. In that folder, `shasum -a 256 main.js` checks the plugin entry point. The renderer's `renderer/provenance.json` records the source commit and the runtime it includes.

## Disable, roll back or remove

To remove a saved account from this Mac, first run **Connect or disconnect a Peerpedia account** and choose **Disconnect and remove local credentials**. You can also revoke the token on the website. If a submission is awaiting a receipt, keep its paper folder and resolve it before switching versions.

Disable Peerpedia in **Settings → Community plugins** and move its entire folder out of `plugins/`. To roll back, restore your previous plugin folder in its place and re-enable it. Your manuscripts, bibliographies and each paper's hidden `.peerpedia-obsidian/` folder stay in the vault. Keep these together to preserve the binding, recovery records and any pending submission. Removing a plugin does not retract previously published website content. The local diagram cache at `~/Library/Caches/Peerpedia/Obsidian/tikz/` may be deleted and rebuilt.

## Build the package

On an Apple Silicon Mac, use Xcode Command Line Tools and Node.js 22.13 or later in the 22.x series, or Node.js 24 or later. Dependency installation and the initial signed Node runtime download need network access or an existing cache. From the repository root run:

```sh
npm --prefix obsidian ci
npm --prefix obsidian run package -- dist/personal-trial/peerpedia
```

Choose a fresh output directory. To install the result, follow the folder placement steps above. The packaged runtime requires no separate Node.js, Python or TeX installation.
