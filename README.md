# Peerpedia

A small, public research-publishing application built with Django and PostgreSQL. Researchers upload a complete Markdown document, propose frozen changes, review papers, and preserve their publication history.

[Website](https://peerpedia.dev) · [Usage guide](https://peerpedia.dev/help/) · [Source](https://github.com/peerpedia/peerpedia)

Developed by [Chenqi Meng](https://github.com/Chenqitrg).

## What is implemented

- Public paper list with title, authors, average rating, search, arXiv subject filtering, and latest-acceptance/rating sorting.
- One primary arXiv subject and optional cross-lists per new submission. Search recognizes category codes, names, and arXiv aliases.
- Separate metadata pages, Palatino-style HTML readers with a section outline that follows your reading position, and downloadable Markdown. Contents collapse on small screens; tables are centered and wide equations scroll within the page.
- Username or email sign-in, email verification, password changes, and emailed password-reset links.
- Upload → preview → publish. One UTF-8 Markdown document per submission, with file upload or an online editor; no images.
- SHA-256 submission hashes, independent verification manifests, permanent source snapshots, and database triggers preventing updates/deletions of historical records.
- Whole-submission acceptance by the corresponding author only. Stale proposals require a new submission.
- Public accepted/rejected/withdrawn history, Markdown and metadata diffs, arbitrary accepted-version comparisons, and separate contribution credit.
- One editable rating-and-written-review per user per paper, including the paper's own author. Reviews sort by original posting time.
- Flat submission conversations, without replies, thumbs, or inline discussions.
- Administrator content hiding/restoration and account disabling.
- Public usage guide with website workflows, local CLI/AI instructions, and links to the source and developer.

The website and an optional command-line client share the same publication rules. The CLI uses a versioned HTTPS API; it does not require a Git server.

## Run locally

Use Python 3.12–3.14. Python 3.13 is used by the production image.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python scripts/fetch_mathjax.py
.venv/bin/python manage.py migrate
.venv/bin/python manage.py runserver 127.0.0.1:8000
```

Open http://127.0.0.1:8000. Local development uses SQLite unless `DATABASE_URL` is set. Production requires PostgreSQL; SQLite is not a deployment option and does not provide the PostgreSQL concurrent-acceptance guarantee.

MathJax is downloaded once from the official npm registry, verified against a pinned SHA-512 digest, and served locally. Reading a paper does not fetch scripts or fonts from a CDN.

### Optional demonstration content

```sh
.venv/bin/python manage.py seed_demo
```

This only operates in development mode and on a database with no existing papers. The examples are labelled demonstrations and their accounts cannot sign in. They are not copied into a fresh production database.

### Accounts and local email

Create an account through the website. In local development, outgoing messages are printed in the server terminal instead of sent: open the verification URL printed there, then confirm it. Password-recovery URLs appear in the same terminal. Treat those URLs as credentials; do not share them.

To create your administrator account:

```sh
.venv/bin/python manage.py createsuperuser
```

Sign in at `/admin/`. In development, you can mark your own account's email as verified there. For the online pilot, use the actual email-verification flow. Administrator status alone does not grant permission to accept other researchers' submissions.

The normal UI has no personal profile pages. The Password navigation link changes the current account's password. Access tokens manages credentials for local tools.

## Local editing and command-line pushes

Install the standalone client (Python 3.12 or newer; no runtime dependencies):

```sh
python3 -m pip install ./cli
```

For repository development, `.venv/bin/python -m pip install -e ./cli` installs the editable client; activate that environment or use `.venv/bin/peerpedia`.

Sign in to the website with a verified account, open **Access tokens**, confirm your password, and create a token. Tokens expire after 30 or 90 days and are shown only once. They permit proposals by default. Check **Also allow publishing new papers** only when that tool should create papers with you as the corresponding author. Tokens never grant acceptance, browser sign-in, or administrative permissions. Revoke a token on the same page to disable it immediately. The server stores only its SHA-256 digest and display prefix.

```sh
# Remote after deployment; for local testing use http://127.0.0.1:8000.
peerpedia login https://peerpedia.dev
# Paste the token at the hidden prompt, not as a command-line argument.

peerpedia clone PAPER_UUID my-paper
cd my-paper
# Edit paper.md and paper.json in your own editor or with a local AI.
peerpedia diff
peerpedia push -m "Correct the proof of Proposition 2"
peerpedia status --json
```

The paper UUID is in its metadata-page URL: `/papers/PAPER_UUID/`. Reading and cloning are public; you can clone without login by adding `--server https://peerpedia.dev`.

For a new paper:

```sh
peerpedia init my-new-paper --server https://peerpedia.dev
cd my-new-paper
# Replace paper.md with your completed Markdown file.
# Fill in title, authors, abstract, and primary_category in paper.json.
# Optionally add secondary_categories, e.g. ["hep-th"].
peerpedia diff
peerpedia push -m "Initial publication"
```

`paper.json` contains the strings `title`, `authors`, `abstract`, and `primary_category`, plus a `secondary_categories` list (which may be empty). For example, use `"primary_category": "cond-mat.str-el"` and `"secondary_categories": ["hep-th"]`. Run `peerpedia categories --server https://peerpedia.dev --json` to list the supported category codes and names. Upgrade the CLI to 0.2 or newer before working with classified submissions.

The taxonomy is pinned from [arXiv](https://arxiv.org/category_taxonomy) in `publishing/data/arxiv_categories.json` (retrieved 2026-10-18); there is no live dependency on arXiv. Classification follows the latest **accepted** submission, including cross-lists. It can be revised through the same proposal/acceptance workflow as other metadata. Existing unclassified submissions retain their v1 manifests and hashes; new submissions use v2, which includes subject codes in the hash. No migration guesses subjects or rewrites historical content. Both manifest formats remain verifiable. Once v2 submissions exist, the subject migration refuses a downgrade that would delete their hashed metadata.

Separate author names with `\n` inside the authors string. `paper.md` preserves UTF-8 bytes and original line endings. Existing directories are never overwritten by init/clone. `.peerpedia/` stores the verified base, server, paper ID, and local receipts; it is automatically ignored by Git. Keep this directory when moving a working copy. It contains document snapshots but never login tokens.

An initial push publishes a new paper immediately, matching the website's initial-publication behavior. Later pushes create **public, frozen proposals**, including when the corresponding author submits them. Review and accept proposals on the website. Push prints the submission URL and full hash. There is no CLI acceptance command or automatic acceptance.

### Updating and resolving conflicts

```sh
peerpedia pull
```

Pull downloads the latest accepted version only when working files are unchanged, or already match that accepted version. It refuses to overwrite local edits. A pending proposal does not become the local base until it has been accepted and pulled.

If somebody accepts another version while you are editing, push fails with `stale_base`. Reconcile both document and metadata explicitly:

```sh
peerpedia fetch
# Compare .peerpedia/incoming.md and incoming-metadata.json with your files.
# Edit paper.md and paper.json to retain the upstream corrections and your work.
peerpedia rebase --acknowledge
peerpedia diff
peerpedia push -m "Incorporate the latest correction and extend the proof"
```

Fetch only updates the incoming snapshots. Rebase does not merge or overwrite your working files; it records that you have reconciled them against the fetched version. It refuses if that version is no longer current. This is an explicit local operation, not Git rebase.

### Retries, AI tools, and credentials

Every push saves an exact request and a random idempotency key before contacting the server. If the connection fails or authentication needs renewal:

```sh
peerpedia push --retry --json
```

Retry sends the **saved payload**, even if you edited your files afterward. The server returns the same immutable submission instead of publishing a duplicate. Definite validation/stale-base rejections clear the pending request so you can correct it; unknown outcomes retain it. Resolve a pending retry before another push, pull, or rebase. Repeating a successfully completed, identical proposal command also reuses its receipt.

Every command accepts `--json`; operational failures return an `error` object and exit with code 1, while successes exit with code 0. Argument syntax errors use argparse's exit code 2. `diff` runs locally, while `status` also checks the remote current version and last submission. Commands never invoke a shell, execute Markdown, or run repository hooks.

Credentials are stored outside paper directories in `~/.config/peerpedia/credentials.json`, with mode 0600 on POSIX. They are not encrypted at rest; protect your local user account. `peerpedia logout` forgets the local copy but does not revoke other copies. Use the website to revoke the token. HTTP is allowed only for loopback development; remote origins require HTTPS. Redirects are refused so bearer tokens cannot be forwarded to a different server.

For an AI runner, inject `PEERPEDIA_TOKEN` through its secret-management mechanism **and** set `PEERPEDIA_SERVER` to the matching server origin. A project state file cannot redirect that injected token to another origin. `login --token-stdin` is also available for secret injection without shell-history arguments. `PEERPEDIA_CONFIG_DIR` selects a separate credential directory, for example in isolated tests. Grant the AI only the token scope and local-folder access it needs.

### API v1

| Endpoint | Authentication | Purpose |
|---|---|---|
| `GET /api/v1/categories/` | Public | Pinned arXiv codes, names, and groups |
| `GET /api/v1/me/` | Bearer token | Username, scopes, expiry |
| `GET /api/v1/papers/<uuid>/` | Public | Current accepted snapshot and metadata |
| `GET /api/v1/submissions/<uuid>/` | Public | Frozen snapshot and decision status |
| `POST /api/v1/push/` | Bearer token | Publish a new paper or propose a change |

Push requires `Content-Type: application/json`, `Authorization: Bearer TOKEN`, and a UUID `Idempotency-Key`. The JSON fields are `paper_id`, `base_hash`, `title`, `authors`, `abstract`, `markdown`, `explanation`, `primary_category` (code), and `secondary_categories` (list of codes). If an older client omits subject fields on a proposal, the server inherits them from the accepted base. New papers and revisions of unclassified papers must supply a valid primary subject. For new papers, set paper_id/base_hash to null; for proposals, supply the paper UUID and complete current submission hash. Normal browser cookies cannot authenticate this endpoint. Markdown restrictions and metadata validation are shared with website uploads. Responses contain the frozen `manifest`, `hash`, `markdown`, `status`, and submission `url`. Clients verify the manifest and source hashes before recording success.

Creation returns 201, an identical retry returns 200, and a stale base or changed payload reusing the same key returns 409. Other errors include 400 invalid input, 401 invalid/expired/revoked credentials, 403 insufficient scope, 404 missing/hidden content, 413 oversized input, and 429 rate limiting with Retry-After. Error responses use `{ "error": { "code": "...", "message": "...", "details": null } }`. API pushes are limited to 40 attempts per account per hour. Duplicate request IDs are scoped to the account and work across replacement tokens with sufficient permissions.

## Architecture

One Django application, with `accounts` and `publishing` modules. Ordinary server-rendered forms handle navigation and mutations. The only application JavaScript initializes local equation rendering.

- `Paper`: stable identity, corresponding author, visibility, latest acceptance time, and current submission pointer.
- `Submission`: frozen source, metadata, base version, contributor snapshot, explanation, timestamp, and hash. An accepted submission is a published version; there is no duplicate version store.
- `Decision`: one permanent accepted/rejected/withdrawn decision for a submission.
- `Review`: one score and required text per account per paper; edits preserve the original posting timestamp.
- `Comment`: flat text discussion of a submission.
- `ModerationEvent`: immutable audit record of hiding or restoring content.

Markdown source is stored directly in the database, preserving its UTF-8 bytes, including original line endings. Source diffs also expose missing final newlines and carriage returns. Rendering is derived and does not modify the source. Images are rejected; embedded HTML is displayed as text. Unsafe URL schemes are not converted into links. MathJax's HTML and dynamic-require extensions are disabled.

Equations accept `$...$` and `\(...\)` inline, or `$$...$$` and `\[...\]` as display blocks. Fenced code stays literal. Markdown tables are supported.

Preview content is carried in a signed, expiring form value in the browser, bound to the submitting account and target paper. This file-upload preview is not persisted as a private draft. The online editor uses separate private working copies. Confirmation is idempotent: retrying the same preview cannot create duplicate papers or submissions.

Acceptance locks the paper row in a PostgreSQL transaction, verifies ownership and the current base, then records the decision and changes the current pointer atomically. Two proposals based on the same version cannot both be accepted.

## Content verification

Download a submission's Markdown and verification manifest from its page, then run:

```sh
python3 scripts/verify_submission.py submission.json submission.md
```

The versioned manifest (`peerpedia-submission-v1` for old snapshots, `peerpedia-submission-v2` for new ones) includes the Markdown's SHA-256, source metadata, stable record identifiers, contributor identity at submission, base hash, explanation, and timestamp. The submission hash is SHA-256 of that manifest encoded as UTF-8 JSON with sorted keys, compact separators, and unescaped Unicode. Accepted status and subsequent conversations are outside this hash.

Check the complete database with:

```sh
.venv/bin/python manage.py verify_history
```

Database triggers protect source snapshots, decisions, and moderation events against ordinary updates and deletions, including direct ORM bulk updates. A server/database owner can deliberately disable database protections; hashes are content-verification tools, not an external timestamp authority or proof of authorship. Retained downloads and independent backups provide additional evidence.

## Tests

```sh
.venv/bin/python manage.py test
.venv/bin/python manage.py makemigrations --check --dry-run
.venv/bin/python manage.py check
```

PostgreSQL-only concurrency and live CLI integration tests are skipped under SQLite. Set `DATABASE_URL` to an isolated PostgreSQL database with permission to create a test database to run them. Never point a development or CI test run at the only copy of your production data.

For optional local PostgreSQL testing on a supported Python 3.12 platform, without installing a system database service:

```sh
python3.12 -m venv .test-tools
.test-tools/bin/python -m pip install pgserver==0.1.4
.test-tools/bin/python scripts/test_postgres.py
```

The helper launches a temporary PostgreSQL instance, runs the entire suite, migrates and seeds a test database, creates a backup, restores into a separate database, and checks all hashes. The temporary instance is stopped afterward. `pgserver` is a development-only helper and is not a production dependency. CI runs the suite against PostgreSQL 18.

### Real-browser tests

The browser suite is separate from the backend/API/CLI tests. It uses Playwright Chromium to exercise real HTML forms, CSRF, sessions, CSS and JavaScript against Django and PostgreSQL. It covers:

- Upload → preview without publication → publish → reader → Markdown download.
- Contributor proposal → collapsed source diff → conversation → corresponding-author acceptance, with the hash and old version preserved.
- Required review text, ratings, editing a single review, and the browse-page rating.
- Signup, email verification, participation restrictions, logout, password recovery, and reset-link reuse rejection.
- Mobile-width search, empty results, metadata/reader navigation, browser back, equation rendering, code blocks, and expandable diffs.
- Access-token creation, one-time display, scope, and revocation.

Install the browser dependencies into the application development environment, and use the optional `.test-tools` PostgreSQL helper described above:

```sh
.venv/bin/python -m pip install -r requirements-browser.txt
.venv/bin/python -m playwright install chromium
.venv/bin/python scripts/fetch_mathjax.py
.test-tools/bin/python scripts/test_browser.py --python .venv/bin/python
```

Each run starts a temporary PostgreSQL instance and a loopback web server on an available port. Django creates a uniquely named test database, resets its data between tests, and destroys it afterward. Every test uses a fresh browser context, with no shared cookies or local storage. Emails remain in memory, uploads/static output use a temporary directory, and browser requests outside the test server are blocked and fail the test. The ordinary `DATABASE_URL` and SMTP settings are not used. The local preview database and port 8000 are not used. Browser binaries are cached separately by Playwright.

In CI, a separate browser job supplies `BROWSER_TEST_DATABASE_URL` pointing to its disposable PostgreSQL service, then runs `python scripts/test_browser.py`. This explicit override requires a test-only database service with permission to create databases; never supply a production service. The backend and browser jobs do not share databases. Browser packages are not production dependencies.

Failures save a screenshot and Playwright trace under `.browser-test-results/` (ignored by Git). Open a trace with `.venv/bin/python -m playwright show-trace /absolute/path/to/trace.zip`. CI retains failure evidence for seven days.

These are Chromium integration tests, not exhaustive visual, accessibility, cross-browser, load or penetration tests. Mobile coverage changes the viewport; it does not emulate a physical phone. Real SMTP delivery, Caddy/HTTPS, and the deployed Docker stack still need staging verification.

## Deploy on one server

Required: a Linux server with Docker Engine and the Compose plugin, a domain pointing to it, and an SMTP account able to deliver email from your chosen address. Keep deployment notes, credentials, database files, and backups private; they are not part of the published source.

1. Copy the project to the server. Copy `.env.example` to `.env` and fill in your domain, SMTP details, and unique secrets. Use different hex secrets for `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` so they are safe in connection URLs. Generate each secret separately with `python3 -c 'import secrets; print(secrets.token_hex(32))'`. Keep `.env` private (mode 0600) and outside version control.
2. Leave `DEBUG=0`. Set `SITE_URL` to the canonical HTTPS origin and `ALLOWED_HOSTS` to your domain plus `localhost,127.0.0.1` for internal health checks. These settings are explicitly configured; `.env` is read by Compose, not automatically by standalone Django commands.
3. Build, initialize the database, and start the application:

```sh
docker compose build
docker compose up -d db
docker compose run --rm migrate
docker compose run --rm web python manage.py createsuperuser
docker compose up -d
docker compose exec web python manage.py check --deploy
docker compose exec web python manage.py verify_history
```

Caddy exposes ports 80 and 443 and manages HTTPS. Django and PostgreSQL have no host ports exposed. Keep the database volume: do not use `docker compose down -v` on a live installation. Caddy replaces `X-Real-IP`; Django trusts it only in production for rate limiting. Do not expose Gunicorn directly to the public internet.

The web process uses the non-owner `peerpedia_app` database role, with ordinary data permissions but no schema creation, table ownership, trigger disabling, or truncation privileges. Database-owner credentials are only supplied to the database and the one-off `migrate` service, not the web container. Run schema changes with `docker compose run --rm migrate`. The initialization script applies only to a new database volume; existing installations need an explicit role/permission migration before switching web credentials. Keep `APP_DB_PASSWORD` consistent with the database role; changing `.env` alone does not rotate an existing role's password.

The deployment check can warn about optional HSTS subdomain coverage and browser preload registration; neither is enabled by default because the operator has not selected a domain/subdomain policy. HTTPS, secure cookies, CSRF protection, HSTS for the configured origin, and a content security policy are enabled in production.

Before inviting colleagues, verify real email delivery, register and recover a test account, publish a sample paper, make a proposal with a second account, and accept it with the corresponding author. Validate a restore as described below. The initial pilot has a single-server availability limit.

### Backups and recovery

All original research content and account/review data are in PostgreSQL. Keep your deployment secrets separately in a secure location.

```sh
sh scripts/backup.sh
sh scripts/restore-check.sh backups/peerpedia-TIMESTAMP.dump
```

The restore check creates a separate temporary database, restores the dump, and verifies its history before dropping that temporary database. It never overwrites the live database. A successful `pg_dump` alone is not a tested restore.

Schedule backups daily on the server and copy them to storage outside that server. The scripts do not silently configure a scheduler or an external storage account. Treat backups as private: they include account emails, password hashes, and active sessions. Also run `docker compose exec -T web python manage.py clearsessions` periodically.

For an installation at `/opt/peerpedia`, install the supplied systemd timer with `sudo cp deploy/peerpedia-backup.{service,timer} /etc/systemd/system/`, then `sudo systemctl daemon-reload` and `sudo systemctl enable --now peerpedia-backup.timer`. It runs daily at 03:00 UTC (with up to 15 minutes of jitter), catches missed runs, and clears expired sessions. These backups stay on the same server and are not automatically pruned; monitor disk use and arrange an off-server copy before relying on them for disaster recovery.

For actual disaster recovery, stop writes and restore the chosen backup into a **new** database, verify it, then point the application to that database. Retain the old database until recovery has been confirmed.

### Current limits

- One Markdown document, up to 1 MB per submission; no figures, file bundles, or PDF/LaTeX uploads.
- Search is PostgreSQL full-text search with substring matching for titles, names, and content. It is not semantic search or Google-scale ranking.
- Ratings are the ordinary arithmetic mean of visible reviews, with review count shown. Self-reviews are permitted as requested.
- SMTP failures are logged; users can request another verification/reset message. There is no email queue yet.
- No Git hosting, notifications feed, nested discussion, profile pages, or automated AI generation.
- Self-hosted installations require verified domain and SMTP configuration, an administrator account, system security updates, and off-server backups.


### Online editor and private drafts

Build the pinned, self-hosted CodeMirror bundle before running the site:

```sh
npm ci --ignore-scripts --prefix editor
npm run build --prefix editor
python manage.py migrate
```

Node is a build dependency only. Docker uses a separate asset build stage. The bundle and third-party license notices are generated under `static/vendor/editor/`; production browsers make no CDN requests.

The reader's Edit link opens a private draft at the current section. New papers can also be written online from the upload page. Drafts autosave under My drafts and support Markdown import/download, a live preview using the publication renderer and MathJax, resizable panes, full-pane and mobile modes, and section-following scroll. Preview content is never published by saving or rendering it.

Draft access is owner-only, including for administrators through the application views. Saves compare a monotonically increasing revision while holding a row lock. A conflict never silently overwrites the other copy. Browser recovery uses per-user, per-draft, per-tab keys for unsaved changes; recovery remains subject to the browser's storage availability and can be removed by clearing site data. Successful saves remove that tab's recovery copy. One active draft per user, paper, and section scope is enforced by a database constraint. The full-paper draft has its own scope. New-paper drafts may be multiple.

Review binds the draft ID, owner, and saved revision in an expiring signed token. Submission locks the draft, revalidates permissions and the accepted base, creates a frozen snapshot, and clears the working contents. Repeat confirmation returns the existing submission. Another edit after preview invalidates that preview. Drafts never alter accepted documents or existing manifests.

A PullRequest groups immutable PullRequestCommit membership records. Existing revision submissions migrate to one-snapshot PRs without changing any submission, hash, decision, or comment. Update PR starts from its current head and appends a snapshot. Only the PR contributor can append, only the latest snapshot can receive a decision, and only the corresponding author can accept/reject. Comments from all snapshots appear in the common conversation, labeled with their source snapshot. The CLI continues to create separate proposals; it does not read or write online drafts in this release. PR membership is protected by database triggers; the grouping migration refuses downgrade once PRs or drafts exist to prevent accidental historical deletion.

To verify editor changes, run `python manage.py test publishing.test_drafts`; use the PostgreSQL test helper for real row-lock concurrency coverage. Preview rendering, autosave, recovery, conflict resolution, mobile layout, and the submission journey also require browser verification. Existing published hashes can be checked with `python manage.py verify_history`.

### Section editing

Each section/subsection heading in the latest accepted reader offers Edit. A section draft includes descendants up to the next heading of equal or higher level. The first H1 document title and headings inside quotations/lists are not section entry points. The whole-paper editor remains available for document structure and metadata. Section drafts permit heading renames and adding/removing subsections, but preserve the selected heading level and surrounding Markdown.

Drafts store only their selected source plus a range on the immutable base. Reviewed and submitted snapshots contain the complete paper. Markdown parsing determines boundaries, including fenced blocks and Setext headings. Reader links bind their source version so an old link cannot silently select a different section. Saves and recovery retain existing ownership and optimistic-concurrency protection.

On review, an unchanged section can advance onto the latest accepted paper while preserving unrelated source and metadata changes. A changed, deleted, or ambiguous section requires a comparison and explicit target selection. Rebase preserves the private text; users must incorporate the displayed accepted changes before confirming. Acceptance racing with final submission requires another review. An existing section PR resumes its proposed section and appends another immutable snapshot after review. Section scope is stored in the immutable PR membership record; historical submission hashes are unchanged. SQLite membership triggers are reinstalled after its table-rebuilding migration.

Tests: `python manage.py test publishing.test_sections publishing.test_drafts`; the PostgreSQL helper covers the full suite, migrations, concurrency, and restore checks. This stage does not yet implement passage discussions, ratings, notifications, or CLI feedback access.

### Passage discussions (local stage 2)

The reader supports text-range discussions, whole-equation/table/code discussions,
1–5 passage ratings, nested replies, reversible helpfulness votes, and comment edit
history. These ratings are separate from overall paper reviews. Browser writes
require a verified session and CSRF; bearer credentials cannot write feedback.

Anchors store canonical quoted text and the immutable source version. Only exact,
unambiguous matches in accepted ancestry or earlier snapshots of the same PR carry
discussions forward. Changed or ambiguous passages retain historical links and
do not inherit scores. Deleted/hidden comments leave placeholders with replies;
public history excludes unavailable comments. Database triggers protect original
anchors and comment revisions. Migration 0008 refuses rollback while passage
history exists.

Commenters resolve their own threads. PR contributors can link proposed fixes;
accepted changes await the commenter's review. Administrators review reports and
hide or restore comments, with moderation audit records. CLI feedback reading and
notification inbox are reserved for stage 3.

Verification uses isolated Django test databases and the temporary PostgreSQL
runner. Browser checks use the separate local preview database on port 8011.
Nothing in this stage changes the deployed site.
