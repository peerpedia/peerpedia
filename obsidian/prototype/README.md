# Three-file community distribution prototype

This private experiment tests whether Peerpedia's shared renderer, theme, TeX
resources and existing macOS file-safety helper can run from exactly `main.js`,
`manifest.json` and `styles.css`. It is **not the production plugin**, an official
submission, or a complete editing/publishing migration. Do not install it in a
working vault: its safety probe deliberately mutates disposable fixtures.

## Reproduce

Run from the repository root on macOS, with Node matching `obsidian/package.json`,
Xcode command-line tools and Obsidian at `/Applications/Obsidian.app`:

```sh
npm ci --ignore-scripts --prefix packages/peerpedia-renderer
npm run prepare:browser --prefix packages/peerpedia-renderer
npm ci --prefix editor
npm ci --prefix obsidian
npm ci --prefix packages/peerpedia-theme
npm ci --prefix obsidian/prototype
npm run build --prefix obsidian/prototype
npm run typecheck --prefix obsidian/prototype
npm run check:types --prefix obsidian
python3 -m venv .test-tools/prototype-venv
.test-tools/prototype-venv/bin/pip install playwright==1.64.0
.test-tools/prototype-venv/bin/python obsidian/prototype/validate.py
node obsidian/prototype/compare.mjs
npm test --prefix obsidian
```

The Python harness connects to the installed Obsidian executable, so a separate
Playwright browser download is unnecessary. It creates and removes its own vault,
profile and home directory. It neither reads real credentials nor changes the
user's plugin installation. The SecretStorage probe uses a disposable dummy value.

Release-shaped assets are in `dist/plugin/` only. Debug bundles and source hashes
live outside that directory in `dist/`. Validation output, a preview screenshot,
and website/browser comparison results are under `.preview/official-channel/`.
A successful complete host run writes `"complete": true` to
`prototype-result.json`; intermediate output alone is not a passing result.

## Shared source and prototype boundaries

- `worker.ts` now imports `packages/peerpedia-renderer/browser/entry.ts`, the same
  browser entry used by the production plugin. It retains full-book semantics.
- Theme and font data come from `packages/peerpedia-theme`.
- `build.ts` calls the shared browser builder. The original prototype's two
  build-time transformations have been replaced by explicit version-pinned
  compatibility patches maintained in the shared renderer package. See its
  README for API ownership and reproduction; these are not upstream releases.
- Preview content goes through the existing `articleFragment` sanitizer and a
  script-disabled iframe. The browser-network test blocks HTTP and HTTPS during
  plugin execution and asserts that no requests were attempted.
- The unchanged `AnchoredFiles` native helper is embedded in `main.js` and
  extracted for loading. Three-file delivery works technically; this **does not
  establish that the official directory accepts this native-code approach**.
  The current helper and validation target macOS only.
- Build evidence records bundle input hashes, not a complete license inventory. This is a local repository build, not yet a portable
  standalone plugin repository.

## Original prototype observations — 2026-11-24

Tested in Obsidian 1.15.1 on macOS, using its Electron 43.8.9 / Node 24.22.1 host.

| Check | Result |
| --- | --- |
| Installation input | Exactly three files; 17,939,544 bytes total |
| Offline rendering | Two chapters, equations, theorem numbering, references, bibliography, TikZ and tikz-cd |
| Website equivalence | Canonical DOM, headings and document targets match the same fixture |
| Embedded fonts | KaTeX and TikZ fonts load |
| Invalid TikZ | Rejected with a compilation error |
| Infinite-loop TikZ | Stopped by the existing approximately 8-second deadline |
| Recovery | A changed diagram recompiles after the timeout |
| Unload | No prototype-owned Workers remain |
| File safety | Atomic swap, old-descriptor late write preservation and directory replacement rejection pass |
| Credentials | Dummy SecretStorage round trip passes |
| Network / page errors | No attempted HTTP(S) requests; no uncaught page errors |

The existing plugin suite also completed with 257 tests passing and 2 optional
integration tests skipped. Prototype TypeScript, explicit function-type lint,
Python lint and formatting checks passed. These checks do not replace the
unfinished full Django/production-package CI acceptance.

The successful recorded run rendered the two-chapter fixture in 1.847 seconds and
timed out the looping diagram in 8.054 seconds. These are single-run observations,
**not a performance benchmark**. Peak memory, large manuscripts, prolonged edits,
consumer-specific cancellation, full synchronization and migration of existing
vaults/credentials remain outside this experiment. The comparison covers this
fixture, not every possible document.

The renderer bundle is 11,492,037 bytes and the embedded theme/font payload is
6,274,742 bytes. Most payload is bundled assets; no separate Node installation or
runtime download is needed. The official directory's acceptance and the native
helper boundary remain unresolved.

## Before production migration

1. Resolve the native-helper submission policy or prove a host-API replacement
   against the existing safety guarantees; do not silently weaken those guarantees.
2. Replace build-time upstream rewrites with supported browser/resource interfaces
   and export shared renderer/theme packages from a reproducible public build.
3. Carry cancellation, recovery, incremental rendering and native editor integration
   from the quality plan into the actual plugin; test full workflows and upgrades.
4. Complete third-party license/resource notices and provenance. In particular,
   inspect the transitive TeX/dvi2html and font terms before publishing; this
   experiment does not settle redistribution or license compatibility.
5. Complete release CI, root repository metadata, English help and screenshots,
   then perform official preflight and submission. The earlier CI draft is still
   unfinished and must not be presented as a release-ready pipeline.

See the [distribution research](../../docs/superpowers/plans/2026-11-24-obsidian-community-distribution-research.md)
and [quality/reuse plan](../../docs/superpowers/plans/2026-11-24-obsidian-quality-and-reuse.md).

## Production migration follow-up

The production packager now also creates three installation files, using the same
shared renderer and embedded theme. Its separate isolated host acceptance covers
native editing, rendering, unloading and official SecretStorage. Production
license notices are assembled by `obsidian/scripts/bundle-notices.ts`. The
prototype remains a destructive disposable-fixture test harness, not an installer.
The historical size above is not the current production artifact size.
