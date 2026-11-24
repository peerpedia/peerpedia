# Install Peerpedia for Obsidian

This personal trial package is for Apple Silicon Macs. It was tested with Obsidian Desktop 1.15.1 on macOS 15.6.1. The ZIP includes the website renderer, local fonts, TikZ assets, Node.js 22.22.3 and a macOS Keychain helper. You can write and preview a paper offline immediately after installation.

## Install in a vault you choose

1. Keep the ZIP and its accompanying `.sha256` file together. From their directory, run `shasum -a 256 -c peerpedia-0.1.0-darwin-arm64.zip.sha256`. Continue when the ZIP reports `OK`.
2. Extract the ZIP with Finder. The resulting `peerpedia` folder contains `manifest.json`, `main.js`, `styles.css`, `native/`, `renderer/`, and the user guide `USAGE.md`. Keep the entire folder together with its executable permissions.
3. Choose a vault. For a first trial, create a new vault in Obsidian. Open its folder in Finder and press **⌘⇧.** to show hidden files. Place `peerpedia` inside `.obsidian/plugins/`. If you use a custom configuration directory, use its `plugins/` folder. Create the plugins folder if needed.
4. If Peerpedia is already installed, disable it in **Settings → Community plugins** and move its entire existing plugin folder to a backup location outside `plugins/` before installing this version. Keep a backup of your paper folders, including hidden files, for rollback.
5. Reopen the vault, allow community plugins and enable **Peerpedia**. Run **Peerpedia: Create paper** from the command palette. Choose **Multiple chapters** to start a chaptered manuscript. The installed `USAGE.md` walks through writing, preview, import and publication.

The file `package-manifest.json` lists SHA-256 checksums relative to the plugin folder. In that folder, `shasum -a 256 main.js` checks the plugin entry point. The renderer's `renderer/provenance.json` records the source commit and the runtime it includes.

## Disable, roll back or remove

To remove a saved account from this Mac, first run **Connect or disconnect a Peerpedia account** and choose **Disconnect and remove local credentials**. You can also revoke the token on the website. If a submission is awaiting a receipt, keep its paper folder and resolve it before switching versions.

Disable Peerpedia in **Settings → Community plugins** and move its entire folder out of `plugins/`. To roll back, restore your previous plugin folder in its place and re-enable it. Your manuscripts, bibliographies and each paper's hidden `.peerpedia-obsidian/` folder stay in the vault. Keep these together to preserve the binding, recovery records and any pending submission. Removing a plugin does not retract previously published website content. The local diagram cache at `~/Library/Caches/Peerpedia/Obsidian/tikz/` may be deleted and rebuilt.

## Build the personal package

On an Apple Silicon Mac, use Xcode Command Line Tools and Node.js 22.13 or later in the 22.x series, or Node.js 24 or later. Dependency installation and the initial signed Node runtime download need network access or an existing cache. From the repository root run:

```sh
npm --prefix obsidian ci
npm --prefix obsidian run package -- dist/personal-trial/peerpedia
```

Choose a fresh output directory. To install the result, follow the folder placement steps above. The packaged runtime requires no separate Node.js, Python or TeX installation.
