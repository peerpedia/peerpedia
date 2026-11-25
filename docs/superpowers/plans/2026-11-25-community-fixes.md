# Community release corrections

Approved scope: fix build verification, plugin introduction and Help first, then host adaptation and package size. Preserve offline rendering, shared website renderer/theme, explicit publication, and safe file transactions. Do not replace the published 0.1.3 artifacts. Any subsequent release needs a new version.

Architecture: package a checked-in native component with source and binary digests; macOS CI rebuilds and compares it, while all hosts assemble the identical plugin without requiring Xcode. This permits independent bundle verification but does not claim Linux compiles Darwin source. Keep this limitation explicit. Root README serves plugin users; website development docs move under docs. Optimize embedded resources without runtime downloads.

## Tasks
- [ ] 1. Cross-platform deterministic packaging. Test tampered/stale native inputs fail closed; verify macOS native rebuild; run a clean Linux build and compare outputs. Files: scripts/build-obsidian.mjs, obsidian/scripts/{native-files,package-plugin}.ts, native inputs, CI.
- [ ] 2. Plugin README and official-install Help. Preserve manual upgrade/recovery guidance; correct obsolete listing statements and links; render Help with existing tests.
- [ ] 3. Host adaptations. Protect custom vault config directories; replace subprocess file opening with host facilities; adopt searchable settings where supported; fix genuine window compatibility and small lint issues. Regression tests for custom config protection and relevant existing host acceptance.
- [ ] 4. Package-size analysis and reduction. Measure resources; reduce duplication/encoding overhead while preserving complete offline TeX and fonts. Verify fresh offline and publication host tests and compare package bytes.
- [ ] 5. Full relevant checks and independent review; resolve material findings. Prepare reviewable PR with real evidence. Preserve published release and production until replacement passes gates.

Interfaces: nativeFiles(): string remains a base64 component; consumers need no transaction changes. buildBrowserRenderer() and embeddedTheme() retain their runtime contracts. Host configuration excludes configDir in addition to existing reserved paths. All new/changed functions and callbacks have explicit argument and return types.

Review focus: stale native blob vs source; reproducibility across OS; changed config directory scanning; safe window/file navigation; missing fonts or TikZ assets after compression. Existing file-race and publication-retry tests remain required.
