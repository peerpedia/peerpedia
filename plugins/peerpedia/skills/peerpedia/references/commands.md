# CLI reference

Use the executable from check_setup.py. Examples use `peerpedia` for readability.
Arguments in uppercase are placeholders for verified identifiers, not literal values.
Quote user-supplied queries and paths safely, or invoke with an argument array.
Use `--server https://peerpedia.dev` explicitly for public commands outside a copy.

## Discover and read

```sh
peerpedia search "Galois" --server https://peerpedia.dev --json
peerpedia search "" --subject math.NT --sort rating --server https://peerpedia.dev --json
peerpedia categories --server https://peerpedia.dev --json
peerpedia clone PAPER_UUID "$HOME/Documents/Peerpedia/PAPER_UUID" --server https://peerpedia.dev --json
```

Search returns up to 25 accepted papers, abstracts, subject codes, corresponding
username, rating averages/counts, accepted timestamp and immutable snapshot IDs/hashes.
Default sort is newest acceptance, not relevance. Choose candidates using their
actual content. `next` is the offset for another page; use `--offset N` with the same
query/filters. No results means no match in the current query, not no related research.
Subject filters also accept `group:Mathematics`, archive filters from the site's
subject selector, and `unclassified`. API URLs are relative to the selected origin.

Inside a cloned paper folder:

```sh
peerpedia status --json
peerpedia diff --json
peerpedia reviews --all --json
peerpedia feedback --all --json
peerpedia discussion PASSAGE_UUID --all --json
peerpedia prs --all --json
peerpedia pr PR_UUID --all --json
peerpedia pr-comments PR_UUID --all --json
peerpedia feedback --submission SNAPSHOT_UUID --all --json
peerpedia comment-history COMMENT_UUID --all --json
```

`--all` follows pagination; discussion also fetches all nested replies. Public
reads send no token. `feedback` returns anchors, original hashes and current mappings;
read discussion details rather than relying on excerpts. `prs` returns contributor,
head and status for pending and decided PRs. `pr` lists all immutable snapshots.
To read a specific full snapshot without changing the working copy:

```sh
peerpedia snapshot SNAPSHOT_UUID --server https://peerpedia.dev --json
```

The CLI verifies its content hash. Preserve both Markdown and metadata when using
this record to resume a PR. Check the manifest's paper ID matches the chosen paper.
Never replace `.peerpedia/base.json` with a pending PR snapshot.

## Prepare and submit

```sh
peerpedia init "$HOME/Documents/Peerpedia/draft-UNIQUE_ID" --server https://peerpedia.dev --json
peerpedia licenses --server https://peerpedia.dev --json
```

Edit `paper.md` and `paper.json`. Metadata fields are `title`, `authors` (names
separated by newlines), `abstract`, `primary_category`, `secondary_categories`
(list), and `license`. A new paper requires the author's chosen license; revisions
inherit it. Library draft folder names must be unique and not overwrite existing work.
After publication retain that folder and its `.peerpedia` state; find it by the
receipt's paper ID before creating another copy.

For chaptered papers, `paper.json` lists ordered `chapters` with `id`, `title`,
and `file` fields, plus a `bibliography` path, normally `references.yaml`.
Edit those files; `clone`, `diff`, `push`, and `pull` include them together.
`fetch` writes a chaptered incoming copy into `.peerpedia/incoming-<hash>/`.

Use BananaMark syntax: `{@thm:main}` declares a label and `@thm:main` references
it. Theorem blocks use `::: theorem [Title] {@thm:main}` with a closing `:::`.
Only fenced `math` blocks are automatically numbered; `$$` displays are not.
Bibliographies use BananaMark YAML entries and `[@key]` citations, not BibTeX.
Keep explicit `\begin` and `\end` environments in `tikz` fences. Correct formula
errors and missing or duplicate labels before pushing. The website writing guide
contains complete examples: https://peerpedia.dev/help/writing/.

After explicit submission authorization, from the working copy:

```sh
peerpedia diff --json
peerpedia push -m "Explain the correction and any uncertainty" --ai-assisted --address THREAD_UUID --json
peerpedia push -m "Continue the selected PR" --ai-assisted --pr PR_UUID --expected-head FULL_HEAD_HASH --address THREAD_UUID --json
```

For initial publication use `push -m "Initial publication" --ai-assisted --json`.
New papers publish immediately. Revision pushes create pending proposals. Repeat
`--address` for multiple top-level passage threads; omit it if none applies.
There is no CLI acceptance, voting, commenting, or private website-draft command.

## Conflict or interrupted request

```sh
peerpedia fetch --json
# Compare .peerpedia/incoming.md and incoming-metadata.json with local files.
# Discuss and reconcile changes before acknowledging.
peerpedia rebase --acknowledge --json
peerpedia diff --json
```

`fetch` preserves working files. `pull` refuses to overwrite local edits. `stale_pr`
requires re-reading the PR head and reconciling; never just substitute a new hash.
`stale_base` requires checking upstream accepted changes. If the server is unavailable,
`diff` still works offline; `status` may fail because it also checks the server.

On the user's request to retry an unknown-outcome push:

```sh
peerpedia push --retry --json
```

Do not add `--ai-assisted` or PR flags to retry: the CLI reuses the saved exact
payload, which already includes attribution. A retry may publish an earlier saved
version even if local files have since changed; explain that before retrying.
