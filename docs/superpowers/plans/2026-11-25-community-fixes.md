# Community release corrections

Approved scope: fix build verification, plugin introduction and Help first, then host adaptation and package size. Preserve offline rendering, shared website renderer/theme, explicit publication, and safe file transactions. Do not replace the published 0.1.3 artifacts. Any subsequent release needs a new version.

Architecture: package a checked-in native component with source and binary digests; macOS CI rebuilds and compares it, while all hosts assemble the identical plugin without requiring Xcode. This permits independent bundle verification but does not claim Linux compiles Darwin source. Keep this limitation explicit. Root README serves plugin users; website development docs move under docs. Optimize embedded resources without runtime downloads.

## Tasks
- [x] 1. Cross-platform deterministic packaging. Test tampered/stale native inputs fail closed; verify macOS native rebuild; run a clean Linux build and compare outputs. Files: scripts/build-obsidian.mjs, obsidian/scripts/{native-files,package-plugin}.ts, native inputs, CI.
- [x] 2. Plugin README and official-install Help. Preserve manual upgrade/recovery guidance; correct obsolete listing statements and links; render Help with existing tests.
- [x] 3. Host adaptations. Protect custom vault config directories; replace subprocess file opening with host facilities; adopt searchable settings where supported; fix genuine window compatibility and small lint issues. Regression tests for custom config protection and relevant existing host acceptance.
- [x] 4. Package-size analysis and reduction. Measure resources; reduce duplication/encoding overhead while preserving complete offline TeX and fonts. Verify fresh offline and publication host tests and compare package bytes.
- [x] 5. Full relevant checks and independent review; resolve material findings. Prepare reviewable PR with real evidence. Preserve published release and production until replacement passes gates.

Interfaces: nativeFiles(): string remains a base64 component; consumers need no transaction changes. buildBrowserRenderer() and embeddedTheme() retain their runtime contracts. Host configuration excludes configDir in addition to existing reserved paths. All new/changed functions and callbacks have explicit argument and return types.

Review focus: stale native blob vs source; reproducibility across OS; changed config directory scanning; safe window/file navigation; missing fonts or TikZ assets after compression. Existing file-race and publication-retry tests remain required.

## Validation evidence

- Local plugin suite: 260 passed, 2 opt-in Django tests skipped; the separate Django journey runs in CI. Type checking and explicit function typing pass. Community lint: 0 errors, 34 warnings (not a claim that the official scorecard has been rerun).
- Shared theme tests and Help rendering pass. All 140 converted diagram fonts retain their glyph counts. Actual Obsidian 1.15.1 offline and publication acceptance pass, including the separate settings window, worker disposal, bibliography editing and idempotent publication.
- Linux and macOS artifacts from Actions run [45524869597](https://github.com/peerpedia/peerpedia/actions/runs/45524869597) compare byte-for-byte after normalizing gzip metadata. That run exposed an acceptance-test locator which assumed Settings stayed in the main window; the locator is corrected and verified locally.
- Native rebuild with pinned clang, SDK, linker and Node-API headers is byte-identical to the checked-in component. Independent review found and resolved the missing custom configuration directory argument in native-conflict recovery and the previously unpinned native toolchain. Both have regression coverage.
- Main bundle: 20,153,797 → 16,969,084 bytes (19.22 → 16.18 MiB, 15.8% reduction). This remains above the Sync Standard 5 MB per-file limit. No font subsets, rendering features or offline capability were removed.
- The final branch CI checks Linux packaging, native rebuild, real host acceptance and cross-platform byte comparison. The PR checks are the gate for merging; production and published 0.1.3 assets remain untouched.
