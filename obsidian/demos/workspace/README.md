# Obsidian workspace studies

Three disposable interaction prototypes for selecting a consistent plugin UX.
No application or vault files are modified. All editable sample content lives in
browser memory; reloading restores the sample. Publishing, remote checks, reference
forms, import, and change counts are explicitly illustrative. This is not a new web
writing product.

Run from the repository root:

```sh
node obsidian/demos/workspace/build.mjs
node obsidian/demos/workspace/serve.mjs
```

Open <http://127.0.0.1:43127/>. The server binds only to loopback and serves the demo
and shared theme; it does not read manuscripts, access credentials, or contact
Peerpedia. Its render endpoint calls the existing website renderer with sample
content. Use the three buttons at the top to compare:

- **A — Compact split:** source and preview side by side, compact chapter outline on
  the right. Chapter actions appear in a contextual menu. Publication is a sheet.
- **B — Focus:** a centered source editor, with chapters and references opened on
  demand. Preview can replace or accompany the source. Publication is a sheet.
- **C — Task workspace:** a left task rail switches between writing, bibliography,
  and publication. Each gets a complete surface, rather than sharing one crowded
  sidebar. The chapter outline sits beside writing only.

## Consistency contract for the selected implementation

- Native Obsidian editing remains native. Standalone CodeMirror here is only a
  browser demonstration of BananaMark's actual grammar, completion and highlighting;
  it is not authorization to embed a replacement editor in Obsidian.
- Reuse BananaMark's token classification and the website's shared article theme.
  The preview uses `editor/render-document.mjs` and `packages/peerpedia-theme/dist`.
- One active paper context follows the current manuscript; outline, preview and
  publication must never silently address different papers.
- One publication entry; save state and remote publication state remain distinct.
- Chapter actions, bibliography actions and remote diagnostics use progressive
  disclosure. Common controls, spacing, type sizes and state labels are shared.
- Apply the selected design to management, preview chrome, paper/details forms,
  bibliography, connection/import, submission, merge and recovery as one coherent
  change. Do not globally restyle unrelated Obsidian UI.
- Preserve the established local project format, native editing, manual remote
  actions, immutable submission review, conflict/recovery safeguards and credentials.
- Implement equivalent light/dark presentation using host theme variables.

## Findings in the installed version

On 24 November 2026 the actual Source-mode editor showed environments and whole
formulas in one accent color. The adapter currently emits only four coarse mark
kinds (environment, formula, reference, label), so upstream TeX/token-level syntax
classes are not being carried through. This is incomplete highlighting integration,
not evidence of missing manuscript text. Upstream's real syntax classes are visible
in this demo.

The management panel rendered five buttons per chapter and remote operations above
the manuscript. During inspection it still showed Peerpedia Demo while the editor
and preview showed Vertex Operator Algebras. The selected design must address both
information hierarchy and active-paper context.

## Scope of the prototype

Working: source editing with syntax highlighting and completions, local render,
chapter selection, adding/renaming/reordering/removing sample chapters, layout
switching, bibliography search, paper-title editing, and opening the illustrated
publication/import/connection-independent workflows. Reference editing and publishing
are simulated. Source text is temporary and never saved to a vault.
