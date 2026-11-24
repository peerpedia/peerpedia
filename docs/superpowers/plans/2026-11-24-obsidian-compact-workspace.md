# Compact Obsidian Workspace Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the installed plugin's UI consistently with approved demo A and restore detailed BananaMark highlighting.

**Architecture:** Retain native Obsidian Markdown editing, existing project transactions and remote controllers. Apply one scoped UI vocabulary across the chapter outline, preview toolbar and all plugin dialogs. Reuse upstream syntax classes and shared theme output; follow the active manuscript without background remote requests.

**Tech Stack:** TypeScript, native Obsidian UI, host CodeMirror decorations, BananaMark, shared Peerpedia theme.

**Spec:** `obsidian/demos/workspace/README.md`, variant A, approved by the user on 2026-11-24.

## Global Constraints

- All added/changed functions and callbacks have parameter and return types.
- English plugin UI; native source editor and website renderer remain authoritative.
- No publication, merge, credential changes, or manuscript edits during installation/verification.
- One current-paper context; remote operations remain explicit and existing validation/recovery stays intact.
- Scope styles to plugin surfaces; support Obsidian light/dark appearance.
- Apply the complete update to the installed vault after checks, with a reversible plugin backup.
- User already authorized execution and requested no review pipeline; execute natively without a separate approval/reviewer round.

## Review Focus

- Imported chapters retain full TeX token colors, including CRLF and Unicode offsets.
- Fast switching between manuscripts cannot let a slow old read select the wrong paper.
- Non-manuscript notes never retarget a paper or trigger remote actions.
- Pending submission/merge/import recovery remains visible and actionable.
- Collapsed source details never remove exact immutable payload review before submission.

### Task 1: Shared syntax fidelity

Files: language/index.ts, language/analysis.ts, host/decorations.ts, host/editor-extension.ts, theme build/export, plugin build/package, language tests.

- [x] Add failing assertions for distinct upstream classes on TeX commands, delimiters, environment names and references; verify native-coordinate mapping with CRLF/Unicode.
- [x] Carry upstream highlightTree classes through the existing worker/decorations without replacing the host syntax tree.
- [x] Generate a scoped syntax stylesheet from the existing shared theme and include it in the plugin distribution.
- [x] Run targeted language tests, theme tests and typecheck.

### Task 2: Coherent compact workspace

Files: main.ts, ui/project-panel.ts, ui/preview-view.ts, ui/paper-form.ts, ui/bibliography-panel.ts, ui/connection-modal.ts, ui/submit-modal.ts, ui/merge-view.ts, ui/conflict-modal.ts, styles.css; small ui/workspace-context.ts coordinator.

Interfaces: context coordinator `follow(path: string): Promise<void>` resolves and activates only the latest request; project panel `followFile(root: string, path: string): Promise<void>`; preview `selectRoot(root: string): Promise<void>` resets paper-specific state before loading.

- [x] Add failing async context test for out-of-order root resolution and unrelated notes; add preview reset/cancellation test.
- [x] Replace chapter action lists with native menus and clickable chapter rows; move bibliography/details/version actions into dedicated dialogs.
- [x] Follow the active manuscript in the outline and existing preview; keep all network checks manual.
- [x] Unify dialog/preview spacing, labels and primary actions, preserving recovery and immutable submission review.
- [x] Run targeted behavior tests and native UI checks; cosmetic changes use visual verification rather than implementation-mirroring tests.

### Task 3: Verify and install as one update

- [x] Run complete plugin tests, typecheck, explicit-type lint, theme tests and production build.
- [x] Back up installed plugin assets; deploy the complete built plugin/styles/shared assets without changing account data or manuscripts.
- [x] Reload plugin in native Obsidian; verify two-paper context switching, source highlighting, compact outline, bibliography and publication entry (no submission).
- [x] Leave native source and preview side by side with the compact right outline; verify manuscript bytes remain unchanged.
