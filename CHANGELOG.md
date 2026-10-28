# Release notes

## 0.1.1

- Use BananaMark for Markdown, theorem blocks, references, bibliography, editor completion, and server-rendered KaTeX and TikZ.
- Adopt `{@label}` declarations and BananaMark YAML bibliographies. Wiki-style links remain disabled. Existing manuscripts must use the new grammar; BibTeX and the old syntax are no longer parsed.
- Save published HTML, diagrams, reference targets, and discussion indexes as durable reading copies. Current articles remain readable when the renderer is unavailable.
- Render only the selected chapter for editor previews, retain book-wide numbering and references, and avoid overlapping preview requests. Review renders the complete book once.
- Compile content before short publication transactions, with revision and accepted-base checks inside the transaction. Maintain the shared TikZ cache while the renderer is idle.
- Match formula sizes to surrounding text. Support multi-line `aligned` formulas, with one number per fenced `math` block.
- Use dated public paper and snapshot identifiers, open reading links at the accepted snapshot, and show actionable publication requirements and field errors.
- Write shared bibliographies to `references.yaml` in CLI working copies and source downloads. Verify downloaded source archives using their declared bibliography filename.
- Synchronize website, CLI, editor, and plugin versions; update setup, writing, architecture, verification, and release instructions.

Immutable source snapshots and their hashes are preserved. Reading-copy backfill
requires current articles to render, reports incompatible historical snapshots,
and leaves those historical sources unchanged.

## 0.1.0

The first public release brings the website, command-line client, editor, and
Peerpedia plugin under one version number.

- Write Markdown in the browser or upload files. Organize a longer work into chapters.
- Render mathematics, CD and TikZ diagrams, theorem blocks, tables, cross-references, and BibTeX citations.
- Propose changes through PRs with multiple immutable snapshots. Corresponding authors accept revisions.
- Discuss passages with threaded comments, ratings, and votes. AI tools can read feedback and propose revisions but cannot write feedback or vote.
- Search public papers by title, author, and arXiv subject.
- Use username/password or configured Google sign-in. Authors choose each paper's license.
- Install the standalone CLI from a wheel without cloning the server repository.
- Learn the website and CLI separately, with actual rendered writing examples.

The software uses the MIT license. Paper licenses are separate.

Earlier CLI numbers such as 0.5.0 and 0.6.0 were development labels.
This release starts the shared public version sequence at 0.1.0.
API paths, content hashes, database migration numbers, and document-format
versions keep their existing meanings.
