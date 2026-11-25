# Peerpedia for Obsidian

Write research papers locally with BananaMark completion, syntax highlighting, shared references and the same article preview used by [Peerpedia](https://peerpedia.dev).

## Install

Open the [official Obsidian directory entry](https://community.obsidian.md/plugins/peerpedia) and choose **Add to Obsidian**, then **Install** and **Enable**. You can also search for **Peerpedia** under **Settings → Community plugins → Browse**.

Requires **Obsidian Desktop 1.15.1 or newer on an Apple silicon Mac**. Windows, Linux, Intel Macs and mobile are not supported at runtime. The official directory lists the plugin; its automated scorecard also reports warnings and is not a security certification.

For manual installation or upgrading an older package, see the [installation guide](obsidian/docs/installation.md). [Download 0.1.3](https://github.com/peerpedia/peerpedia/releases/tag/0.1.3).

## Write and publish

1. Open the command palette (**⌘P**) and choose **Peerpedia: Create paper** or **Peerpedia: Import paper**.
2. Write in Obsidian’s **Source mode**. Enable the desired writing folders in **Settings → Peerpedia** for completion and syntax assistance.
3. Run **Peerpedia: Open paper preview** for equations, theorem blocks, TikZ diagrams and references. Obsidian’s built-in reading mode does not render the full BananaMark syntax.
4. Use **Manage paper** for chapters, paper details and the shared YAML bibliography. Import, compare remote changes and publish only when you choose.

Writing and preview work offline without an account. Publication requires a Peerpedia account and access token. Use **https://peerpedia.dev** when connecting. See the [complete usage guide](https://peerpedia.dev/help/obsidian/) and [formatting guide](https://peerpedia.dev/help/writing/).

## Privacy and files

Explicit import, comparison and submission contact the Peerpedia site you select. There is no client-side telemetry. Tokens use Obsidian secret storage; when it is unavailable, the connection lasts only for the session. Server requests follow the site’s [privacy policy](https://peerpedia.dev/privacy/). The plugin requires no payment.

The plugin accesses manuscript files in the selected vault and uses a small native macOS component for safe file transactions. It temporarily writes that embedded component outside the vault, loads it, then removes the temporary directory. It does not download or install runtime dependencies. The renderer, fonts and diagram engine are bundled for offline use. Large plugin files may exceed the Obsidian Sync Standard per-file limit; install the plugin separately on each supported Mac if needed.

## Development

The plugin lives in [obsidian/](obsidian/). The [renderer](packages/peerpedia-renderer/) and [theme](packages/peerpedia-theme/) are shared with the website. Run `npm run build` from the repository root with Node.js 22.13+ (22.x) or 24+ to produce `main.js`, `manifest.json` and `styles.css`. Packaging works on Linux and macOS; running the plugin still requires the supported Mac. See [build and native-component verification](obsidian/docs/installation.md#build).

[Report an issue](https://github.com/peerpedia/peerpedia/issues) · [Release notes](CHANGELOG.md) · [Website and CLI development](docs/website.md)

Peerpedia code is [MIT licensed](LICENSE). Third-party renderer and font notices accompany the plugin in `styles.css`. Papers have their own author-selected licenses.
