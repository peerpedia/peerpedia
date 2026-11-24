# Offline authoring acceptance

> Historical record of the earlier personal package. The current three-file candidate uses browser Workers and Obsidian SecretStorage; the old Node renderer and Swift credential helper have been removed from source. Current reproduction steps are in [installation](installation.md), and current results are in [the migration report](../../docs/superpowers/plans/2026-11-25-obsidian-community-migration-results.md).


The combined personal package, its digest, the tested platform and the remote workflow are recorded in [manual publishing acceptance](remote-acceptance.md). This record covers the local authoring checks and how to repeat them.

## Relocated package in Obsidian

The host probe copies a complete extracted package into a fresh vault under a Unicode path. The final ZIP from source `20cb7a4` was exercised through this path. The probe opens Obsidian 1.15.1 with its own profile, verifies installed file checksums and renders a two-chapter manuscript from the native source editor. The test uses an offline Chromium context, records HTTP(S) attempts and runs the plugin's renderer child with macOS network access denied. Obsidian itself can attempt an application update during startup.

| Activity | Observed behavior |
| --- | --- |
| First enable | Writing assistance starts off. Folder rules and individual file overrides persist. A chapter with assistance disabled remains editable and previewable. |
| Read and edit | KaTeX, TikZ, commutative diagrams, bundled fonts, shared references and cross-chapter numbering work. The preview follows source edits. Scrolling or switching chapters in the preview preserves the source position until the explicit source-location action. |
| Renderer error or timeout | Invalid math and a deliberately paused renderer keep the last successful preview visible with an error. Source navigation from stale output is disabled. A later valid edit renders successfully. |
| Disable and remove | Preview panes close, the plugin's commands disappear, and the renderer stops. Source files, edits and bibliography remain readable after uninstalling the test copy. |
| Native completion in the final publication check | The source-mode editor offered the theorem completion, inserted its template and reverted it with one undo. Opening a manuscript that named a reserved bibliography path showed a source error. |
| Conflicting writes in the final native-host check | Independent writes to an open chapter before autosave preserve the original, editor draft and external version, including an empty initial chapter and a chapter with assistance disabled. Recovery survives restart. Ordinary saves, unlisted notes and confirmed chapter-title edits do not create spurious conflicts. |

## Earlier local authoring checks

The same host version was also exercised during development with multiple source editors, Live Preview, file and folder rules, multiple cursors, undo, two separate manuscripts and system Pinyin composition. Reference navigation selected exact cross-chapter and bibliography ranges with CRLF and emoji. Bibliography tests covered preserving comments and CRLF, duplicate keys, shared-key renaming and invalid YAML recovery. The format tests checked 64 chapters and the diagnostic for a 65th. The packaged host sample uses two chapters.

Chapter-file renames can reopen the source pane and clear its undo history. Multiple files can briefly show intermediate states during a transaction. The plugin checks source revisions and retains recovery copies when an external writer interrupts an edit.

## Repeat the host checks

From the repository root, with the test Python environment containing Playwright, set the application to a dedicated Obsidian test copy and the package to a freshly extracted folder. Both scripts create and remove disposable vaults and profiles.

```sh
"$TEST_PYTHON" obsidian/scripts/validate-offline-host.py \
  "$TEST_APP" "$PACKAGE" obsidian/tests/fixtures/render-paper.json "$EVIDENCE/offline"
"$TEST_PYTHON" obsidian/scripts/validate-native-conflicts.py \
  "$TEST_APP" "$PACKAGE" obsidian/tests/fixtures/render-paper.json "$EVIDENCE/native"
```

The offline probe writes its host log and a rendered-preview screenshot to the evidence folder. The [installation guide](installation.md) and [usage guide](usage.md) describe the corresponding English commands.
