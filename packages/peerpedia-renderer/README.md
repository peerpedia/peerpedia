# Peerpedia shared renderer

This private workspace package owns Peerpedia document rendering. The website's
`editor/render-document.mjs` is a compatibility export of `node.mjs`; Obsidian
uses `browser/entry.ts`. Both call `createDocumentRenderer` in `core.mjs` with the
same BananaMark compiler, document options and TikZ preamble. Theme assets remain
owned by `packages/peerpedia-theme`.

## Platform boundaries

- `core.mjs`: full-document compilation, chapter selection, numbering, references,
  diagnostics and bounded per-instance caches. It receives hashing and diagram
  compilation capabilities instead of importing a filesystem or Node globals.
- `node.mjs`: Node hashing, the existing diagram compiler and disk-cache path.
- `browser/entry.ts`: browser hashing and the same diagram compiler through small
  Worker, resource-loading and DOM adapters. No server request is required.
- `build-browser.ts`: bundles an entry point and returns its source and input
  hashes. TeX engine, core dump and resource filesystem are embedded at build time.
  Resource reads at runtime are restricted to those embedded files. Input hashes
  are build evidence, not a complete software supply-chain attestation.

The plugin owns the outer render queue, cancellation, deadline and idle disposal
in `obsidian/src/preview/browser-renderer-client.ts`. The shared package does not
own Obsidian views, account storage or publication transactions.

## Browser diagram cache

The browser adapter preserves `bananamark-tikz`'s JSON cache format and keys
(compiler recipe, preamble, source, mode and display options). Its filesystem
adapter accesses only a reserved virtual cache path; it never reads or writes
user files. Browser hosts must route the `peerpedia-diagram-cache` request/reply
messages, as the production client and retained prototype do.

The plugin owns a memory-only LRU cache limited to 128 diagrams and 8 MiB of
UTF-16 string payload. Successful SVG results survive both workers' idle
shutdown and are cleared on plugin unload; they do not survive app restart.
Changed diagrams miss the cache and use the complete embedded TeX engine offline.
No package, library or font is omitted. The working WASM memory still requires
68.75 MiB; sparse snapshots remove redundant stored zeros, not the engine's
address space.

## Reproduce

From the repository root:

```sh
npm ci --ignore-scripts --prefix packages/peerpedia-renderer
npm run prepare:browser --prefix packages/peerpedia-renderer
npm run typecheck --prefix packages/peerpedia-renderer
npm test --prefix packages/peerpedia-renderer
npm test --prefix editor
```

The browser build deliberately fails if its required engine API is absent.
The production plugin installation and host-validation commands are documented
in `obsidian/docs/installation.md`. The retained prototype exercises invalid
TikZ, timeout/recovery and canonical website/browser fixture comparison.

## Explicit compatibility patches

The lockfile pins these dependencies, and `patch-package --error-on-fail` applies
reviewable patches. These are **local compatibility APIs**, not APIs released by
the upstream projects:

1. `node-tikzjax@1.0.5`: exports `setAssetLoader` for embedded core/WASM/resources.
   The original disk loader remains the Node default. Loading new assets after
   engine initialization is rejected. The browser core snapshot stores only nonzero
   64 KiB pages. Every job clears and restores one reusable working memory; the
   compiled WASM module is reused with a fresh instance to reset mutable globals.
   Virtual files are cleared in `finally`, including execution failures. The engine
   remains serial and SVG conversion is unchanged.
2. `bananamark-tikz@0.1.0`: calls the timer's Node-specific `unref` only when present.
   Diagram source, compiler options and timeout behavior are retained.

There are no build-time string replacements of upstream source. A dependency
upgrade must deliberately refresh patches and pass browser/server equivalence,
invalid-input and recovery checks. No upstream patch submission has been made.

## Distribution and limits

The production packager embeds renderer resources, theme and font assets in the
three standard plugin files. It generates dependency/license notices in
`styles.css`; missing dependency license text stops the build. The exact legacy
`boolbase@1.0.0` license is supplied under `obsidian/licenses` with provenance.
This inventory does not establish official directory approval or resolve every
license interpretation.

The plugin still contains its macOS file-transaction helper. Host `Vault.process`
and Adapter probes passed ordinary writes but did not preserve the existing
old-descriptor and directory-identity guarantees, so replacing that helper is
not justified by those probes. Official acceptance of this native boundary
remains unresolved. This package is not published independently to npm.
