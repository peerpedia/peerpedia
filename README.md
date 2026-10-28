# Peerpedia 0.1.1

To a better academia

A small, public research-publishing application built with Django and PostgreSQL. Researchers write or upload Markdown, organize chapters, propose frozen changes, discuss passages, and preserve their publication history.

[Website](https://peerpedia.dev) · [Usage guide](https://peerpedia.dev/help/) · [Source](https://github.com/peerpedia/peerpedia)

[Download 0.1.1](https://github.com/peerpedia/peerpedia/releases/tag/v0.1.1) · [Install the CLI](cli/README.md) · [Release notes](CHANGELOG.md)

The software uses the [MIT license](LICENSE). Papers have their own author-selected licenses. Developer information is on the [About page](https://peerpedia.dev/about/).

## What is implemented

- Public paper list with title, authors, average rating, search, arXiv subject filtering, and latest-acceptance/rating sorting.
- One primary arXiv subject and optional cross-lists per new submission. Search recognizes category codes, names, and arXiv aliases.
- Separate metadata pages, Palatino-style HTML readers with a section outline that follows your reading position, and downloadable Markdown. Contents collapse on small screens; tables are centered and wide equations scroll within the page.
- Username or email sign-in, email verification, password changes, and emailed password-reset links.
- An online Markdown editor with autosave, chapter and section editing, equations, references, bibliography, and compiled TikZ diagrams. Uploads and local CLI editing are also supported.
- SHA-256 submission hashes, independent verification manifests, permanent source snapshots, and database triggers preventing updates/deletions of historical records.
- Whole-submission acceptance by the corresponding author only. Stale proposals require a new submission.
- Public accepted/rejected/withdrawn history, Markdown and metadata diffs, arbitrary accepted-version comparisons, and separate contribution credit.
- One editable rating-and-written-review per user per paper, including the paper's own author. Reviews sort by original posting time.
- PR conversations plus passage discussions with ratings, threaded replies, thumbs, preserved edits, and links to proposed fixes.
- Administrator content hiding/restoration and account disabling.
- Public usage guide with website workflows, local CLI/AI instructions, and links to the source and developer.

The website and an optional command-line client share the same publication rules. The CLI uses a versioned HTTPS API; it does not require a Git server.

## Run locally

Use Python 3.12–3.14 and Node 22 or newer. Python 3.13 is used by the production image.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
npm ci --prefix editor
npm run build --prefix editor
.venv/bin/python manage.py migrate
.venv/bin/python manage.py runserver 127.0.0.1:8000
```

Open http://127.0.0.1:8000. Local development uses SQLite unless `DATABASE_URL` is set. Production requires PostgreSQL; SQLite is not a deployment option and does not provide the PostgreSQL concurrent-acceptance guarantee.

BananaMark 0.1.0 renders Markdown, references and KaTeX on the server. The editor build copies the pinned package styles and fonts locally; readers need no math JavaScript or CDN requests. Node 22 or newer is required for local development.

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

The normal UI has no personal profile pages. The Account navigation link manages password changes and Google connections. Access tokens manages credentials for local tools.

### Google sign-in (optional)

Use a Google Auth Platform **Web application** OAuth client. Set the exact authorized
redirect URI to `https://YOUR_DOMAIN/accounts/google/login/callback/`. JavaScript
origins are not needed for this server-side flow. Configure the public homepage and
`/privacy/` page in Google branding, request only `openid email profile`, and use an
External audience. Switch from Testing to Production when ready for public sign-in.
Keep the client JSON outside the checkout. Set `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in the server's private `.env`, then recreate the web service.
Both values are required to display the button. No paid Google hosting or Identity
Platform subscription is required for this integration.

New users choose a public username once and their Google-verified email remains
private. Existing users sign in with their password, open **Account**, and confirm
their password to connect the Google account with the same email. Linking expires
after ten minutes. An email match never automatically grants access to an existing
account. Future sign-ins use Google's stable subject ID, not the email string.

Google-only users can **Add a password by email** from Account, using the existing
rate-limited password recovery flow. They must open the emailed link before setting
a password. A password is required for CLI token creation, disconnection, and staff
MFA enrollment. Add a password before granting a Google-only user staff status.
Staff Google logins still require Peerpedia's authenticator/recovery code.

Only our explicit Google entry/callback/signup/account routes are mounted; allauth's
parallel password, email editing, and token-login endpoints are not exposed. OAuth
starts require a CSRF-protected POST, use state and PKCE, and do not retain Google
access/refresh tokens. Tests replace only Google's token exchange; no real Google
credentials are needed in CI. Local testing should use a separate development OAuth
client and an exact localhost callback, not the production secret.

## Codex desktop plugin

The [Peerpedia plugin](plugins/peerpedia/README.md) finds papers, explains their
claims and readers' reactions, and proposes corrections based on selected feedback.
It uses the CLI below, keeps local work in `~/Documents/Peerpedia`, and submits only
when requested. Public reading needs no account; AI cannot comment, rate or vote.

## Local editing and command-line pushes

Install the standalone client with Python 3.12 or newer and [pipx](https://pipx.pypa.io/stable/installation/). No Git checkout or server setup is needed.

```sh
pipx install peerpedia-cli
peerpedia --version
```

See the [CLI guide](cli/README.md) for installation without pipx.

For repository development, `.venv/bin/python -m pip install -e ./cli` installs the editable client; activate that environment or use `.venv/bin/peerpedia`.

Search without login:

```sh
peerpedia search "Galois" --server https://peerpedia.dev --json
peerpedia search "" --subject math.NT --sort rating --server https://peerpedia.dev --json
```

Results include accepted metadata, abstracts, rating counts, snapshot hashes and
links. Search shares the website's rules and excludes hidden papers. It returns
25 results per page; pass the returned `next` offset with `--offset` to continue.
Use `prs --all` from a cloned paper to discover its PR conversations and
`snapshot SUBMISSION_ID --server ORIGIN --json` to read a verified frozen snapshot
without changing local files.

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

`paper.json` contains the strings `title`, `authors`, `abstract`, and `primary_category`, plus a `secondary_categories` list (which may be empty). For example, use `"primary_category": "cond-mat.str-el"` and `"secondary_categories": ["hep-th"]`. Run `peerpedia categories --server https://peerpedia.dev --json` to list the supported category codes and names. Use CLI 0.1.1 or newer for the current BananaMark bibliography format.

The taxonomy is pinned from [arXiv](https://arxiv.org/category_taxonomy) in `publishing/data/arxiv_categories.json` (retrieved 2026-10-18); there is no live dependency on arXiv. Classification follows the latest **accepted** submission, including cross-lists. It can be revised through the same proposal/acceptance workflow as other metadata. Existing unclassified submissions retain their v1 manifests and hashes; subject codes are included in v2 and later manifests. Current publications use v3 for single-file papers or v4 for chapters and shared bibliographies. No migration guesses subjects or rewrites historical content. All manifest formats remain verifiable. Once v2 submissions exist, the subject migration refuses a downgrade that would delete their hashed metadata.

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
| `GET /api/v1/papers/?q=TEXT&subject=CODE&sort=latest&offset=0` | Public | Search accepted papers (25 per page) |
| `GET /api/v1/papers/<id>/prs/` | Public | List public PR conversations (100 per page) |
| `GET /api/v1/me/` | Bearer token | Username, scopes, expiry |
| `GET /api/v1/papers/<uuid>/` | Public | Current accepted snapshot and metadata |
| `GET /api/v1/submissions/<uuid>/` | Public | Frozen snapshot and decision status |
| `POST /api/v1/push/` | Bearer token | Publish a new paper or propose a change |

Push requires `Content-Type: application/json`, `Authorization: Bearer TOKEN`, and a UUID `Idempotency-Key`. The JSON fields are `paper_id`, `base_hash`, `title`, `authors`, `abstract`, `markdown`, `explanation`, `primary_category` (code), and `secondary_categories` (list of codes). If an older client omits subject fields on a proposal, the server inherits them from the accepted base. New papers and revisions of unclassified papers must supply a valid primary subject. For new papers, set paper_id/base_hash to null; for proposals, supply the paper UUID and complete current submission hash. Normal browser cookies cannot authenticate this endpoint. Markdown restrictions and metadata validation are shared with website uploads. Responses contain the frozen `manifest`, `hash`, `markdown`, `status`, and submission `url`. Clients verify the manifest and source hashes before recording success.

Creation returns 201, an identical retry returns 200, and a stale base or changed payload reusing the same key returns 409. Other errors include 400 invalid input, 401 invalid/expired/revoked credentials, 403 insufficient scope, 404 missing/hidden content, 413 oversized input, and 429 rate limiting with Retry-After. Error responses use `{ "error": { "code": "...", "message": "...", "details": null } }`. API pushes are limited to 40 attempts per account per hour. Duplicate request IDs are scoped to the account and work across replacement tokens with sufficient permissions.

## Architecture

Peerpedia is a Django monolith with PostgreSQL. Caddy terminates HTTPS, Gunicorn
runs the application, and WhiteNoise serves locally bundled static assets. There
is no separate frontend server or Git hosting service. Browser pages and the CLI
share publication rules and frozen snapshots.

The application has three interfaces:

- Django templates and forms for browsing, accounts, publication, and administration.
- CodeMirror and browser JavaScript for autosave, preview, recovery, section editing,
  reader navigation, and passage discussions. Preview and publication use the same
  safe Markdown renderer and server-rendered KaTeX.
- A versioned JSON API for public reading and scoped CLI submissions. API tokens
  cannot accept proposals or write comments, ratings, votes, or inbox state.

The module boundaries are explicit:

| Module | Responsibility |
|---|---|
| `models.py` and migrations | Stored records, constraints, hashes, immutable-history protections |
| `services.py` | Transactional publication, proposal updates, and author decisions |
| `discussion_actions.py` | Verified-participant discussion mutations and preserved edit records |
| `queries.py`, `feedback_queries.py` | Shared visibility rules and paginated data retrieval |
| `comparisons.py`, `rendering.py`, `sections.py`, `passages.py` | Derived document representations and anchors |
| `artifacts.py`, `bananamark.py` | Durable reading copies and transport to the BananaMark renderer |
| `editor/render-document.mjs`, `editor/dialect.js` | Native BananaMark rendering and shared syntax configuration |
| `views.py`, `api.py`, `discussions.py`, `drafts.py` | HTTP authentication, request validation, and responses |
| `notifications.py` | Account-private grouped activity |

Feedback queries return ordinary data to browser and API handlers. The public API
passes an anonymous viewer explicitly; it does not rewrite the authenticated
request or invoke a browser HTTP handler. Passage statistics are aggregated in one
query, personal votes are fetched with the comments, and thread ranking happens
in SQL before pagination. Query-budget tests cover 100 annotations and 100 replies.

A `Paper` is a stable identity whose current pointer refers to an accepted
`Submission`. Each submission stores the entire Markdown document and a versioned
verification manifest. A `PullRequest` groups immutable snapshots; its head points
to the only snapshot that can receive a final decision. `Draft` records are private,
mutable working copies with revision checks. Passage anchors point to frozen source
versions, and comment revisions and tool attribution are separately preserved.

Acceptance locks the paper row in a PostgreSQL transaction, checks ownership and
the accepted base, records a decision, and advances the pointer atomically. Draft
submission revalidates the source and goes through the same publication services.
Full documents remain in PostgreSQL so source, decisions, and metadata can be
backed up and restored together.

Rendering never rewrites source bytes. Unsupported HTML tags, images and unsafe
URL schemes are rejected by the article validation path. KaTeX uses its untrusted
default configuration. Equations accept `$...$` and `\(...\)` inline, or
`$$...$$` and `\[...\]` in display blocks. Fenced `math` blocks are numbered;
`tikz` fences compile diagrams and `bibliography` fences define YAML references.
Other fenced code stays literal.

File-upload previews use expiring signatures bound to the submitting account and
target paper. Editor previews use owner-only saved drafts. Both confirmation paths
are idempotent and preserve existing immutable snapshots.

This is still a small-server architecture. Search constructs PostgreSQL text-search
expressions at request time and notification fan-out is synchronous. Published
renderings and indexes are stored in durable reading copies, and TikZ compilation
uses a shared cache. Capacity claims require representative load tests. Introduce
indexed search or a durable job queue when measurements justify them; those are
independent of the publication-history format.

## Content verification

Download a submission's verification manifest and complete source from its page.
For a chaptered or bibliography-bearing v4 snapshot, use its source ZIP:

```sh
python3 scripts/verify_submission.py submission.json source.zip
```

For a single-file v1–v3 snapshot, pass `submission.md` instead of the ZIP.

The versioned manifest (v1–v3 for single-file snapshots, v4 for chapters or a shared bibliography) includes the Markdown's SHA-256, source metadata, stable record identifiers, contributor identity at submission, base hash, explanation, and timestamp. The submission hash is SHA-256 of that manifest encoded as UTF-8 JSON with sorted keys, compact separators, and unescaped Unicode. Accepted status and subsequent conversations are outside this hash.

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
- Online-editor autosave, rendered preview, reload, immutable PR submission, two-tab conflicts, and recovery after failed saves.
- Sentence selection, passage rating, threaded replies, thumbs, edit history, and mobile discussion layout.
- Administration navigation, full frozen hashes, and responsive controls.

Install the browser dependencies into the application development environment, and use the optional `.test-tools` PostgreSQL helper described above:

```sh
.venv/bin/python -m pip install -r requirements-browser.txt
.venv/bin/python -m playwright install chromium
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
docker compose exec web python manage.py build_reading_copies
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

For an installation at `/opt/peerpedia`, install the supplied systemd timer with `sudo cp deploy/peerpedia-backup.{service,timer} /etc/systemd/system/`, then `sudo systemctl daemon-reload` and `sudo systemctl enable --now peerpedia-backup.timer`. It runs daily at 03:00 UTC (with up to 15 minutes of jitter), catches missed runs, and clears expired sessions. Without the optional Mac replication job below, these backups stay on the same server and are not automatically pruned. Configure off-server replication before relying on them for disaster recovery.

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

The reader's Edit link opens a private draft at the current section. The main navigation’s New note link opens a blank private editor for an initial paper or note. Add metadata under Paper details, then choose Review & publish to choose a license and confirm publication. My drafts also offers direct upload for finished Markdown files; Import Markdown loads a file into the editor for further work. Drafts autosave under My drafts and support Markdown import/download, a live preview using the BananaMark publication renderer, resizable panes, full-pane and mobile modes, and section-following scroll. Preview content is never published by saving or rendering it.

Draft access is owner-only, including for administrators through the application views. Saves compare a monotonically increasing revision while holding a row lock. A conflict never silently overwrites the other copy. Browser recovery uses per-user, per-draft, per-tab keys for unsaved changes; recovery remains subject to the browser's storage availability and can be removed by clearing site data. Successful saves remove that tab's recovery copy. One active draft per user, paper, and section scope is enforced by a database constraint. The full-paper draft has its own scope. New-paper drafts may be multiple.

Review binds the draft ID, owner, and saved revision in an expiring signed token. Submission locks the draft, revalidates permissions and the accepted base, creates a frozen snapshot, and clears the working contents. Repeat confirmation returns the existing submission. Another edit after preview invalidates that preview. Drafts never alter accepted documents or existing manifests.

A PullRequest groups immutable PullRequestCommit membership records. Existing revision submissions migrate to one-snapshot PRs without changing any submission, hash, decision, or comment. Update PR starts from its current head and appends a snapshot. Only the PR contributor can append, only the latest snapshot can receive a decision, and only the corresponding author can accept/reject. Comments from all snapshots appear in the common conversation, labeled with their source snapshot. The CLI creates new proposals by default; CLI 0.3 can append snapshots with an explicit PR ID and expected head hash. It does not read or write online drafts. PR membership is protected by database triggers; the grouping migration refuses downgrade once PRs or drafts exist to prevent accidental historical deletion.

To verify editor changes, run `python manage.py test publishing.test_drafts`; use the PostgreSQL test helper for real row-lock concurrency coverage. Preview rendering, autosave, recovery, conflict resolution, mobile layout, and the submission journey also require browser verification. Existing published hashes can be checked with `python manage.py verify_history`.

### Section editing

Each section/subsection heading in the latest accepted reader offers Edit. A section draft includes descendants up to the next heading of equal or higher level. The first H1 document title and headings inside quotations/lists are not section entry points. The whole-paper editor remains available for document structure and metadata. Section drafts permit heading renames and adding/removing subsections, but preserve the selected heading level and surrounding Markdown.

Drafts store only their selected source plus a range on the immutable base. Reviewed and submitted snapshots contain the complete paper. Markdown parsing determines boundaries, including fenced blocks and Setext headings. Reader links bind their source version so an old link cannot silently select a different section. Saves and recovery retain existing ownership and optimistic-concurrency protection.

On review, an unchanged section can advance onto the latest accepted paper while preserving unrelated source and metadata changes. A changed, deleted, or ambiguous section requires a comparison and explicit target selection. Rebase preserves the private text; users must incorporate the displayed accepted changes before confirming. Acceptance racing with final submission requires another review. An existing section PR resumes its proposed section and appends another immutable snapshot after review. Section scope is stored in the immutable PR membership record; historical submission hashes are unchanged. SQLite membership triggers are reinstalled after its table-rebuilding migration.

Tests: `python manage.py test publishing.test_sections publishing.test_drafts`; the PostgreSQL helper covers the full suite, migrations, concurrency, and restore checks. Passage discussions and CLI feedback are described in the later stages below.

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
hide or restore comments, with moderation audit records. CLI feedback reading and the notification inbox are implemented in stage 3 below.

Verification uses isolated Django test databases and the temporary PostgreSQL
runner. Browser checks use the separate local preview database on port 8011.
Nothing in this stage changes the deployed site.

### Feedback CLI and inbox (local stage 3)

CLI 0.3 provides public read-only commands. From a cloned paper directory:

- `peerpedia feedback --all --json` lists passage anchors, original quotes and full hashes, current mappings, ratings, and historical locations.
- `peerpedia discussion PASSAGE_ID --all --json` reads every root and reply for that location.
- `peerpedia replies THREAD_ID --all --json` reads replies alone.
- `peerpedia comment-history COMMENT_ID --all --json` reads public edit history.
- `peerpedia reviews --all --json` reads overall paper reviews.
- `peerpedia pr PR_ID --all --json` reads frozen snapshot membership and the current head hash.
- `peerpedia pr-comments PR_ID --all --json` reads the PR conversation.

Use `feedback --submission SUBMISSION_ID` for a particular snapshot. Outside a
project, supply `--server ORIGIN` and `--paper PAPER_ID` where applicable. Commands
return a numeric `next` offset unless `--all` exhausts the pages; `--offset N`
resumes a page. Reading sends no bearer credentials and writes no project files.
These endpoints accept GET only. Hidden papers and moderated comment histories
are excluded. Private drafts, inboxes, and moderation reports are not exported.

After reconciling the local files with the accepted base, submit a fix with
`peerpedia push -m "Explain the correction" --address THREAD_ID --ai-assisted`.
Repeat `--address` to address several top-level discussion IDs. Append another
snapshot using `--pr PR_ID --expected-head FULL_HEAD_HASH`. These writes create
paper proposals only; the tool cannot post comments, rate, vote, resolve threads,
or accept a PR. A stale head is rejected. Retrying a lost response reuses the exact
saved payload, attribution, links, and idempotency key.

Submissions retain the contributor's identity and show “via CLI”. The optional
AI-assisted declaration is append-only attribution stored separately from the
document manifest; existing hashes and manifest verification are unchanged.
The declaration is self-reported, not an AI detector.

The private website inbox groups activity by conversation/PR and event type.
It covers discussions, replies, edits, votes, linked fixes, PR activity/decisions,
and paper reviews. Report alerts go only to active staff. Own actions are excluded;
there are no notification emails. Opening an item marks only the displayed revision
read. Mark-all uses the page's load time, preserving newer arrivals. Hidden papers
are excluded from both the inbox and unread badge.

Migration 0009 adds notifications and immutable submission attribution. Attribution
has database update/delete guards; rollback refuses to discard populated attribution.
Test with the isolated PostgreSQL runner and `publishing.test_feedback`; the CLI
integration journey covers public reads, linked fixes, stale heads, snapshot updates,
and explicit reversion to the accepted base. The local preview remains separate
from the deployed pilot.


## Quality and release gates

Install development-only checks with `pip install -r requirements-dev.txt` and
`npm ci --ignore-scripts --prefix editor`. Run:

```sh
python -m ruff check accounts publishing config cli/peerpedia_cli cli_tests browser_tests scripts
python -m ruff format --check accounts publishing config cli/peerpedia_cli cli_tests browser_tests scripts
editor/node_modules/.bin/prettier --check 'editor/*.js' 'editor/*.mjs' 'static/*.js'
python -m unittest discover -s scripts -p 'test_*_unit.py'
```

Full CI runs `test`, `browser`, `quality`, and `security` on pushes, pull requests,
and manual runs. The daily scheduled run checks Python and npm dependency security
only, and appears in GitHub Actions as **Daily security scan**. It does not push
commits or deploy the website. Deployment still requires all four jobs to pass
on the exact main commit.

CI also checks that `requirements.lock` satisfies `requirements.txt`. Update both
when changing a dependency requirement, so tests exercise the proposed versions.
Dependabot groups Python minor and patch updates; major upgrades get separate PRs.
Docker runtime upgrades beyond Python 3.13 and Node 22 are deferred until their
application tests are updated too. Patch updates and daily security audits continue.

The hosted repository's
`main` branch requires a pull request, up-to-date passing checks, and resolved
conversations, including for administrators. Force pushes and branch deletion are
blocked. Forks must configure their own equivalent branch protection.

Use the release tool after a PR is merged and the **main push** workflow passes:

```sh
python scripts/deploy.py FULL_MAIN_COMMIT_SHA \
  --host admin@YOUR_SERVER \
  --identity ~/.ssh/YOUR_DEPLOY_KEY \
  --known-hosts ~/.ssh/YOUR_PINNED_HOSTS
```

`--check-only` validates the gate without connecting to the server. The tool refuses
any SHA other than current main, missing or unsuccessful runs, or a missing required
job. It checks again before deployment, archives that exact Git commit, validates
the archive checksum, takes and restores a predeployment backup, keeps the previous
image, applies migrations, and checks health and immutable history. It does not
upload a working directory or production secrets. Keep using reviewed migration
plans for changes that cannot safely be reversed.

## Automatic backup copies on a Mac

The existing daily server timer makes atomic PostgreSQL dumps with checksums.
A Mac with existing pinned SSH access can fetch the newest completed backup every
six hours while it is awake and online:

```sh
python scripts/install_mac_backup.py \
  --host admin@YOUR_SERVER \
  --identity ~/.ssh/YOUR_DEPLOY_KEY \
  --known-hosts ~/.ssh/YOUR_PINNED_HOSTS
```

The installer copies a standard-library-only runner into
`~/Library/Application Support/PeerpediaBackup/` and registers
`~/Library/LaunchAgents/dev.peerpedia.backup.plist`. It does not copy private keys
or require storing database credentials on the Mac. Files and configuration are
private to the local user. The runner uses strict host-key verification, restores
new backups into an isolated temporary database on the server, verifies the
transferred checksum, and only then writes an off-server receipt.

Status is recorded in `backups/status.json`; failures also appear in
`backup-errors.log` and the launchd job's exit status. A server backup older than
48 hours is a failure. An offline/sleeping Mac cannot receive backups. For continuous
coverage, use always-online external storage instead.

Retention keeps at least seven local copies and 30 days locally, and at least three
copies and seven days on the server. Pruning requires a valid receipt and never
removes backups newer than the latest acknowledged off-server copy. Legacy dumps
without managed checksum files remain untouched. Test files and unrelated files
are never candidates for pruning. Protect the Mac with full-disk encryption because
backups contain account information and drafts.

Inspect or stop the job with:

```sh
launchctl print gui/$(id -u)/dev.peerpedia.backup
launchctl bootout gui/$(id -u)/dev.peerpedia.backup
```

## Administrator security

Staff browser sessions require an authenticator code before accessing the website,
including administration, private drafts, and token management. After signing in,
open `/accounts/security/`, confirm your password, scan the QR code in an
RFC 6238-compatible authenticator, and enter its current code. Save the eight
single-use recovery codes in your password manager. The QR code is generated
locally; no secret is sent to a QR service. Setup expires after ten minutes.

This uses `django-otp` for verification, replay prevention, and increasing delays
between failed attempts. A second account-based limit allows at most 15 security
form submissions per 15 minutes. Successful verification rotates the session key
and limits that session to 12 hours. Password resets do not remove the authenticator.
Old staff sessions are gated immediately after deployment. The owner must complete
initial enrollment personally before two-factor protection is fully established.

A recovery code can verify a sign-in when the authenticator is lost. From Security,
confirm your password to replace the authenticator or generate new recovery codes.
Replacement invalidates the previous authenticator and all previous recovery codes.
Recovery codes are displayed once. Device secrets are excluded from administration.
If both factors and recovery codes are lost, the trusted server owner must verify
the person's identity and reset their OTP devices through server access; public
password recovery deliberately cannot do this. Treat database backups as sensitive:
they contain authenticator secrets as well as account information.

Password login limits apply independently to each IP and to each account, with
username and email aliases sharing a bucket across ordinary and admin login.
An account permits 20 attempts per 15 minutes, regardless of changing source IP.
Password-reset requests also have per-IP and per-account limits. These temporary
limits can delay a legitimate user during an attack; they are not permanent locks.
CLI bearer tokens retain their existing limited scopes and cannot perform browser
administration, comment, rate, or vote.

The Tests workflow scans pinned Python packages and editor dependencies on each
push/PR and daily. A successful `security` job is also required by the release tool.
Dependabot proposes weekly Python, editor, Docker, and Actions updates. Review and
test those PRs before deploying; updates are not automatically merged. Enable
Dependabot alerts/security updates and secret-scanning push protection in GitHub.
Operating-system automatic updates do not update already-running container images;
rebuild and deploy reviewed updates regularly.

For SSH, `deploy/ssh-hardening.conf` disables direct root/password login, reduces
unauthenticated connection limits, and disables agent/X11 forwarding. Only install
it after confirming non-root key-based sudo access. Validate with `sshd -t`, use a
rollback timer, reload SSH, and verify a separate new connection before closing the
old one. For fixed office/VPN egress addresses, additionally allowlist SSH sources
in the cloud firewall. Do not pin a travelling Mac to an unverified temporary IP.

Alibaba Anti-DDoS Basic is included for simple application servers. It addresses
network/transport floods, not HTTP floods, and may blackhole traffic above its
threshold. Confirm the actual instance threshold in the cloud console. A managed
HTTP filtering proxy requires separate account/DNS setup; do not describe the
application's login limits as full DDoS protection.

For repeated SSH guesses, install the distribution's `fail2ban` package and copy
`deploy/fail2ban-sshd.local` to `/etc/fail2ban/jail.d/peerpedia-sshd.local`.
Validate with `fail2ban-client -t` before enabling/restarting the service. The SSH
jail bans an address for one hour after five failures in ten minutes, while valid
key-based backup/deployment connections remain available from changing networks.

### Cloudflare proxy

The Caddy configuration accepts `CF-Connecting-IP` only from Cloudflare's published
IPv4/IPv6 networks and replaces `X-Real-IP` with the verified client address. Direct
requests cannot choose a rate-limit identity by forging headers. Review the range
list against https://www.cloudflare.com/ips/ when maintaining the proxy. The CI
proxy test exercises both trusted and untrusted connections using disposable
containers. Deployment validates and gracefully reloads Caddy before recording a
successful release.

To activate Cloudflare Free, import and compare the complete registrar DNS zone,
keep email CNAMEs DNS-only, proxy only the website, and use Full (strict) TLS with
the origin's valid certificate. Keep default caching; never cache authenticated
pages or API responses through a Cache Everything rule. Avoid blanket browser
challenges that prevent CLI access. Switch registrar nameservers only after the
records and settings are ready. After Cloudflare is active and public checks pass,
restrict origin HTTP/HTTPS ingress to Cloudflare networks at the cloud firewall.
Docker-published ports can bypass ordinary UFW rules, so UFW alone is insufficient.
Keep SSH available for trusted key-based administration and Mac backups. Ensure
certificate HTTP validation remains reachable through the proxy. DNS propagation
and origin firewall protection must be verified separately from deploying code.


## Content licenses and agreements

Authors choose one of six licenses, without a default: CC BY 4.0, CC BY-SA 4.0,
CC BY-NC-SA 4.0, CC BY-NC-ND 4.0, CC0 1.0, or Peerpedia non-exclusive license 1.0.
Every choice includes a separate limited permission for public on-platform PRs.
Revisions inherit the paper's fixed license. The corresponding author controls
acceptance; accepting a contribution does not transfer copyright.

The account holder must accept the versioned submission/discussion agreement at
`/agreements/` on the website. A bearer token cannot accept it. Missing agreement
returns `agreement_required`; an absent initial license returns `license_required`;
an incompatible PR license returns `license_mismatch`. CLI users run
`peerpedia licenses --server https://peerpedia.dev`, then put e.g.
`"license": "CC-BY-4.0"` in `paper.json` after choosing it. Clone includes the
paper's license. API discovery is `/api/v1/licenses/`; `/api/v1/me/` reports consent.
The website requires a rights confirmation on every publication/PR submission.

Single-file manifests use `peerpedia-submission-v3` and hash the license code and agreement
version, document hash, acceptance ID and time. v1/v2 hashes remain byte-for-byte
compatible. API and downloaded verification records include separate `licensing`
information; any later declaration is outside the original snapshot hash.
`AgreementAcceptance` and `PaperLicense` are append-only at both ORM and database
levels. Their admin screens are read-only. Never change an archived agreement's
text in place: add a new version, retain old routes and require fresh acceptance.

No data migration invents licenses or consent. With an owner's explicit authority,
operators can preview `declare_legacy_license --owner USER --license CC-BY-4.0
--authority 'Recorded authorization and scope'`, then add `--confirm-owner-rights`
to record dated grants. This covers only that owner's still-unlicensed papers and
lists exactly the existing hashes. It refuses papers with other contributors;
resolve their permissions separately. It never records website acceptance, edits
old hashes, or licenses other accounts' papers. Run `verify_history` afterwards.

Private copyright/withdrawal/privacy requests are stored through `/rights/` and
reviewed in administration under Rights requests. Do not publish request details
as public issues. Comments and reviews receive hosting/API permissions, not a
blanket Creative Commons license. Public history is normally preserved after
withdrawal; operators can restrict access for rights or privacy concerns.

Design references: [arXiv licensing](https://info.arxiv.org/help/license/index.html)
and [submission agreement](https://info.arxiv.org/help/policies/submission_agreement.html).
Peerpedia's terms are original and adapt to public PRs; they do not assert arXiv
affiliation or copy its jurisdiction and liability waivers. Content licensing is
separate from licensing of this application's source code.

### BananaMark rendering

Peerpedia uses pinned `bananamark`, `bananamark-codemirror` and `bananamark-tikz`
0.1.0 packages. The npm override selects `markdown-it` 15.0.3, which fixes
[the upstream parser denial-of-service advisory](https://github.com/advisories/GHSA-gfr2-rv44-r23c)
in BananaMark 0.1.0's pinned 15.0.2 dependency.
`editor/dialect.js` is the shared syntax configuration: native
bibliography and TikZ enabled, wiki links disabled. The editor uses the upstream
language, highlighting and completion; publication and preview share the server
renderer. Formula errors and missing or duplicate labels prevent publication;
incomplete drafts can still be saved. Only fenced `math` blocks are numbered.
Theorem-like environments share a chapter counter; equations have their own.

Write diagrams in a `tikz` fence, retaining explicit `\begin` and `\end`, or use
`tikzcd` / `tikzpicture` inside a formula. `bananamark-tikz` compiles SVG with its
native cache and bundled fonts. No TeX engine runs in the reader or editor.
Compilation is limited to 8 seconds per diagram and 20 seconds per rendering
request, with at most 32 diagrams and 32 KB of source per diagram. Correct errors
before publishing. Existing compiled diagrams share the package's cache.

Run `npm ci --prefix editor` and `npm run build --prefix editor` to install the
renderer and build local assets. Development uses a persistent Node child process.
Production sets `BANANAMARK_URL=http://renderer:8765` and uses the `renderer`
Compose service: Node 22, an internal network, no database credentials, a read-only
root filesystem and a writable cache volume. Docker provides process isolation.
The renderer returns native HTML/MathML/SVG; the browser retains its existing CSP.

Build with `docker compose build web renderer`, run migrations, then start
`renderer` and `web`. The old diagram queue and browser compiler are removed.
`static/bananamark.css` supplies Peerpedia's article theme; it does not redefine the
Markdown grammar. Passage annotations and source positions are added using the
rendered document and BananaMark's editor grammar. No old syntax compatibility
renderer is retained. Desktop packaging is a separate follow-up.

### Chapters, references, and reading progress

A paper can contain up to 64 ordered Markdown chapters and one shared UTF-8
`references.yaml`. The complete source and bibliography are limited to 1 MB.
Existing single-file papers continue to work. In the editor, **Add chapter**
converts the draft; a single PR publishes all chapter changes together. Readers
see one chapter at a time. Chapter IDs survive file renaming and reordering.

For chaptered papers in 0.1.1, `paper.json` includes:

```json
{
  "title": "A course",
  "authors": "Ada Example",
  "abstract": "An introduction with worked examples.",
  "primary_category": "math.GT",
  "secondary_categories": [],
  "license": "CC-BY-4.0",
  "chapters": [
    {"id": "intro", "title": "Introduction", "file": "chapters/intro.md"},
    {"id": "proofs", "title": "Proofs", "file": "chapters/proofs.md"}
  ],
  "bibliography": "references.yaml"
}
```

`clone`, `diff`, `push`, and `pull` include these files. `fetch` also places a
multi-file copy in `.peerpedia/incoming-<hash>/` for manual reconciliation.
Old clients cannot accidentally replace a chaptered paper with a single file.
Remote filenames are generated from validated IDs, never taken from arbitrary
server paths. Local chapter paths must stay inside the project without symlinks.

Use BananaMark's native syntax, for example:

````markdown
## Motivation {@sec:motivation}

::: theorem [Main result] {@thm:main}
Every example has an explanation.
:::

```math {@eq:energy}
E = mc^2
```

See @sec:motivation, @thm:main and @eq:energy. See [@einstein1905].

```bibliography
einstein1905:
  type: article
  author: Einstein, Albert
  title: Example article
  year: 1905
```
````

Bibliographies use native BananaMark YAML. They may appear as `bibliography`
blocks, or in the editor's shared bibliography, displayed at the end of the last
chapter. All chapters share the same labels and bibliography entries. Native
citations use author–year text. External Peerpedia references use frozen snapshot
URLs. The reference picker lists declared labels; `@` also offers completion.
There is no BibTeX parser or conversion layer.

Manifest v4 hashes ordered chapter IDs, titles and individual Markdown hashes,
as well as the exact bibliography hash and the existing canonical combined
Markdown. This combined field supports search and older read-only integrations;
chapter-aware clients verify every component. v1–v3 histories are unchanged.
The chapter migration refuses a rollback once v4 snapshots exist.

Reading completion and position are private account data. Visitors keep progress
in their browser. Completion retains the hash of the chapter read, allowing the
sidebar to indicate later changes without erasing the reader's achievement.
Cross-chapter passage mapping uses the existing exact, unambiguous quote rule;
uncertain matches remain historical.

### Browser rendering and durable reading copies

BananaMark parses and renders each review once. Editor previews render the selected
chapter with the book's shared labels and numbering; the browser permits one
preview request at a time and coalesces pending edits to the latest text.

Publication compiles and validates content before taking database row locks. The
short commit transaction rechecks the draft revision, accepted base and PR head,
and stores both the immutable submission and a separate `RenderedSubmission`.
The derived record contains HTML (including diagram SVG), headings, references
and passage indexes. Reading and discussion indexes use it without contacting BM.
Database backups include these reading copies.

Deployments run `python manage.py build_reading_copies` to backfill missing copies.
This command is idempotent and does not alter source snapshots or their hashes.
Current publications must render successfully. Historical snapshots that use
unsupported syntax are reported and skipped; renderer connection failures remain
fatal. No historical syntax conversion is performed.
Renderer upgrades retain existing copies until an explicit
`python manage.py build_reading_copies --refresh`; the renderer fingerprint covers
the locked dependencies, dialect and rendering adapter. Retain the existing font
assets when upgrading packages until the copies using them have been refreshed.

The renderer checks its disposable TikZ cache while idle, at most hourly. It uses
BM's native `prune()` to expire entries unused for seven days, shortening retention
when the cache exceeds its soft capacity budget (1 GiB by default; configure
`BANANAMARK_CACHE_BYTES` in the renderer environment). Usage and cleanup failures
are written to the renderer log. Persisted reading copies contain their SVG, so
pruning the compilation cache does not affect published articles.
