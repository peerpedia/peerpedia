# Compact writing workspace

Open a chapter, then use **Peerpedia: Manage paper** and **Open preview**. Keep the
native editor and paper preview side by side; the **Manuscript** sidebar follows the
paper you are editing. BananaMark source colors use the shared website syntax theme.

- Click a chapter title to open it. Drag to reorder; use its `…` menu or right-click
  for rename, file rename and removal. Removing membership keeps the source file.
- **References** opens the shared bibliography in a dedicated dialog. Search entries
  and use **Edit YAML source** to add, edit or remove references. Saving checks YAML
  structure; preview checks citation and publication rules. Use the **Rename citation
  key** button beside an entry to find and update its citations across the paper.
  Direct YAML edits do not automatically rewrite citations.
- The paper title switches papers. Its `…` menu contains creation, import, details
  and the Peerpedia account connection.
- **Publish** reviews a new paper or public proposal using the existing publishing
  rules. Confirm only after reviewing the rendered manuscript, disclosure and exact
  source. Local editing never uploads automatically.
- **Versions and remote changes** opens explicit remote checks and comparisons.
  Interrupted imports, merges and submissions remain visible in the sidebar.

# Write and publish a paper in Obsidian

## Create and edit

Run **Peerpedia: Create paper**, enter a new folder name within your vault and choose **Single file** or **Multiple chapters**. For a second chapter, open **Manage paper → Add chapter**. You can attach an existing Markdown file or name a new file. In **Manage paper**, arrange chapters, edit their titles and use **Paper details** to set authors, abstract, subjects and license. A chapter’s first heading supplies its published title. Keep shared references in the paper’s YAML bibliography.

The paper folder uses the Peerpedia CLI content format. Keep `paper.json`, the Markdown files and bibliography together. An external editor may change these same files. If an external write races an unsaved Obsidian edit, review the original, editor and disk versions through the conflict notice or **Manage paper → View recovery files**.

## Write and preview offline

In **Settings → Peerpedia**, enable writing assistance for the paper folder or selected Markdown files. File rules take priority over folder rules. Use Obsidian's **Source mode** for BananaMark completions, diagnostics and reference navigation. Run **Go to BananaMark reference definition** on a reference to jump to its source.

From a manuscript chapter, press **⌘P** and run **Peerpedia: Open paper preview**. Obsidian’s own reading mode does not render the complete BananaMark format. **Open preview** is in the Peerpedia **Manuscript** panel, opened with **Peerpedia: Manage paper**; it is not in the built-in **Outline** panel. The shared website renderer lays out the whole paper, including cross-chapter references, KaTeX, bibliography and TikZ. Scrolling in the preview keeps your source position. Use **Go to source** to return to the corresponding passage. On a render error the previous successful preview stays visible while you correct the manuscript. Preview supports up to 64 chapters, 1 MiB of combined manuscript and bibliography, and 32 TikZ diagrams of up to 32 KiB each. A render times out after 40 seconds.

## Import a public paper or check a revision

Run **Import paper from Peerpedia**. Choose the HTTPS site, paste its paper, snapshot or version reading link and enter a new destination folder under an existing parent. Paper links open the current accepted version. Version links let you work from the selected historical snapshot. Reading a public paper requires no account.

Continue editing the same local files after import or publication. **Manage paper → Versions and remote changes → Check remote version** reads the current accepted version and linked proposal status. Opening, typing and local preview leave the site alone. **Compare accepted version** or **Compare open proposal** opens a comparison. Review the common, local, remote and merged documents. Resolve each conflict with **Use local**, **Use remote**, or **Edit result → Use edited result**. **Confirm merge** rechecks the versions before writing. If the manuscript or site changed in the meantime, reopen the comparison. **Review and recover merge** can complete a locally interrupted merge.

## Connect and submit

1. On the Peerpedia website, accept the publishing agreement and create a token with the permission you need. Initial publication requires permission to publish new papers. Proposals require proposal permission.
2. Run **Connect or disconnect a Peerpedia account**, enter the site's HTTPS origin and token, and select **Connect and verify account**. Check the account, scope, expiry and agreement status. The plugin uses Obsidian secret storage for this vault; its own settings contain only a secret reference. If secret storage is unavailable, the token lasts for this session. Reconnect after restarting. When upgrading from an older Keychain-based installation, re-enter your token once; the old Keychain entry is not automatically read or removed.
3. In **Manage paper**, choose **Publish**. Consult **Available subjects and licenses** if you need the site's current codes. Set manuscript metadata in **Paper details**. Revisions retain the existing paper license.
4. Choose the submission type and state your explanation and whether AI assisted you. **Publish a new paper** makes a public accepted paper. **Create a new proposal** submits a public revision for the corresponding author to consider. For your linked, open proposal, **Add a snapshot to the open proposal** is the default. You can choose a separate proposal.
5. Select **Review submission** and inspect the destination, account, metadata, license, explanation, AI choice, chapter sources, rendered manuscript and any changes. **Confirm submission** sends the reviewed version. If the manuscript changes, review and confirm the refreshed preview. The result links to the public snapshot.
6. After a website acceptance, use **Check remote version**, **Compare accepted version** and **Confirm merge**. Edits made since the accepted submission remain available in the local manuscript. A later submission can propose them.

If a connection drops after confirmation, open **Resume submission**. **Retry saved submission** reuses the exact earlier submission, including its original content, even if you have edited the file since. A verified receipt can be finished offline with **Finish from saved receipt**. After a rate limit, wait and retry manually. For an expired token, reconnect the original site and username. Check the remote version and compare after a stale-version message.

The plugin stores its local binding and recovery data in each paper’s `.peerpedia-obsidian/`. Back it up with the manuscript. The CLI uses separate state. Coordinate submissions if you work on the same paper with both clients. Website decisions, discussion and reviews remain on the website.
