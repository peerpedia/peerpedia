"""Dependency-free client. Every push is a full frozen document, not a Git push."""

import argparse
from contextlib import contextmanager
import difflib
import getpass
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

from . import __version__


class ClientError(Exception):
    def __init__(self, code, message, details=None):
        self.code, self.message, self.details = code, message, details


def read_json(path):
    return json.loads(path.read_bytes().decode("utf-8"))


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def origin(value):
    parts = urlsplit(value)
    if (
        parts.scheme not in {"https", "http"}
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
    ):
        raise ClientError(
            "invalid_server",
            "Use a server origin such as https://peerpedia.dev (no path or credentials).",
        )
    if parts.scheme == "http" and parts.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ClientError(
            "https_required",
            "Remote servers require HTTPS. HTTP is only permitted on loopback for development.",
        )
    return f"{parts.scheme}://{parts.netloc.lower()}"


def config_path():
    directory = Path(os.environ.get("PEERPEDIA_CONFIG_DIR", Path.home() / ".config" / "peerpedia"))
    return directory / "credentials.json"


def credentials():
    path = config_path()
    if not path.exists():
        return {"servers": {}}
    if os.name == "posix" and path.stat().st_mode & 0o077:
        raise ClientError(
            "unsafe_credentials", f"Restrict credential-file permissions: chmod 600 {path}"
        )
    return read_json(path)


def save_credentials(data):
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_json(path, data)  # Atomic replacement with a mode-0600 temporary file.


def server_for(args):
    value = args.server or os.environ.get("PEERPEDIA_SERVER") or credentials().get("default_server")
    if not value:
        raise ClientError("server_required", "Use --server or run peerpedia login SERVER first.")
    return origin(value)


def token_for(server):
    raw = os.environ.get("PEERPEDIA_TOKEN")
    if raw:
        # Bind injected credentials to an explicit origin, never to an untrusted
        # project's state file alone.
        configured = os.environ.get("PEERPEDIA_SERVER")
        if not configured or origin(configured) != server:
            raise ClientError(
                "token_origin_mismatch",
                "Set PEERPEDIA_SERVER to the token's server when using PEERPEDIA_TOKEN.",
            )
        return raw
    raw = credentials().get("servers", {}).get(server)
    if not raw:
        raise ClientError("login_required", f"Run peerpedia login {server} first.")
    return raw


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(server, route, token=None, payload=None, key=None):
    headers = {"Accept": "application/json", "User-Agent": f"peerpedia-cli/{__version__}"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        headers["Idempotency-Key"] = key
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = Request(server + route, data=data, headers=headers)
    try:
        with build_opener(NoRedirect()).open(req, timeout=30) as response:
            body = response.read(12 * 1024 * 1024 + 1)
        if len(body) > 12 * 1024 * 1024:
            raise ClientError("invalid_response", "Server response exceeds the size limit.")
        return json.loads(body)
    except HTTPError as error:
        try:
            detail = json.loads(error.read(65536))["error"]
            raise ClientError(detail["code"], detail["message"], detail.get("details"))
        except (ValueError, KeyError, TypeError):
            raise ClientError(
                "http_error", f"Server returned HTTP {error.code}. Redirects are not followed."
            )
    except (URLError, TimeoutError, ConnectionError):
        raise ClientError(
            "network_error",
            "Could not complete the request. A pending push can be retried with push --retry.",
        )
    except (ValueError, UnicodeError):
        raise ClientError("invalid_response", "Server did not return valid JSON.")


def verify(record):
    try:
        manifest = record["manifest"]
        if manifest["format"] not in {
            "peerpedia-submission-v1",
            "peerpedia-submission-v2",
            "peerpedia-submission-v3",
            "peerpedia-submission-v4",
        }:
            raise ValueError()
        if manifest["format"] in {
            "peerpedia-submission-v2",
            "peerpedia-submission-v3",
            "peerpedia-submission-v4",
        }:
            if (
                not isinstance(manifest["primary_category"], str)
                or not manifest["primary_category"]
            ):
                raise ValueError()
            if not isinstance(manifest["secondary_categories"], list) or not all(
                isinstance(code, str) for code in manifest["secondary_categories"]
            ):
                raise ValueError()
        if manifest["format"] in {"peerpedia-submission-v3", "peerpedia-submission-v4"}:
            if not isinstance(manifest["license"], str) or not manifest["license"]:
                raise ValueError()
            if (
                not isinstance(manifest["agreement"]["version"], str)
                or len(manifest["agreement"]["sha256"]) != 64
            ):
                raise ValueError()
        if manifest["format"] == "peerpedia-submission-v4":
            import re

            chapters = record["chapters"]
            if not isinstance(chapters, list) or len(chapters) > 64:
                raise ValueError()
            seen = set()
            checks = []
            for page in chapters:
                if set(page) != {"id", "title", "markdown"} or not all(
                    isinstance(v, str) for v in page.values()
                ):
                    raise ValueError()
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", page["id"]) or page["id"] in seen:
                    raise ValueError()
                seen.add(page["id"])
                checks.append(
                    {
                        "id": page["id"],
                        "title": page["title"],
                        "markdown_sha256": hashlib.sha256(page["markdown"].encode()).hexdigest(),
                    }
                )
            if checks != manifest["chapters"] or (
                chapters and record["markdown"] != "\n\n".join(p["markdown"] for p in chapters)
            ):
                raise ValueError()
            if (
                hashlib.sha256(record["bibliography"].encode()).hexdigest()
                != manifest["bibliography_sha256"]
            ):
                raise ValueError()
        if record.get("snapshot_identifier"):
            from datetime import datetime, timezone

            label = record["snapshot_identifier"]
            date, prefix = label.split(".")
            submitted = datetime.fromisoformat(manifest["submitted_at"])
            if (
                submitted.tzinfo is None
                or date != submitted.astimezone(timezone.utc).strftime("%y%m%d")
                or not 12 <= len(prefix) <= 64
                or not record["hash"].startswith(prefix)
            ):
                raise ValueError()
        uuid.UUID(manifest["paper_id"])
        uuid.UUID(manifest["submission_id"])
        source = record["markdown"].encode("utf-8")
        canonical = json.dumps(
            manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        if (
            hashlib.sha256(source).hexdigest() != manifest["markdown_sha256"]
            or hashlib.sha256(canonical).hexdigest() != record["hash"]
        ):
            raise ValueError()
        if not all(isinstance(manifest[k], str) for k in ("title", "authors", "abstract")):
            raise ValueError()
    except (KeyError, TypeError, ValueError, AttributeError, UnicodeError):
        raise ClientError(
            "verification_failed", "Document or manifest does not match its submission hash."
        )
    return record


def metadata(record):
    return {
        **{key: record["manifest"][key] for key in ("title", "authors", "abstract")},
        "license": record["manifest"].get("license", (record.get("licensing") or {}).get("code"))
        or "",
        "primary_category": record["manifest"].get("primary_category", ""),
        "secondary_categories": record["manifest"].get("secondary_categories", []),
    }


def safe_file(root, name):
    if (
        not isinstance(name, str)
        or not name
        or Path(name).is_absolute()
        or ".." in Path(name).parts
        or "\\" in name
    ):
        raise ClientError("invalid_path", "Document files must stay inside the paper folder.")
    target = root / name
    if not target.resolve().is_relative_to(root.resolve()) or any(
        p.is_symlink() for p in [target, *target.parents] if p != root and p.is_relative_to(root)
    ):
        raise ClientError("invalid_path", "Do not use symlinks for document files.")
    return target


def record_document(record):
    data = {**metadata(record), "markdown": record["markdown"]}
    if record["manifest"]["format"] == "peerpedia-submission-v4":
        data.update(chapters=record["chapters"], bibliography=record["bibliography"])
    return data


def local_document(root):
    data = read_json(root / "paper.json")
    required = {"title", "authors", "abstract"}
    optional = {"primary_category", "secondary_categories", "license", "chapters", "bibliography"}
    if (
        not isinstance(data, dict)
        or not required <= set(data)
        or set(data) - required - optional
        or not all(isinstance(data[k], str) for k in required)
    ):
        raise ClientError(
            "invalid_metadata",
            "paper.json requires title, authors, abstract, and supports primary_category and secondary_categories.",
        )
    data.setdefault("license", "")
    if not isinstance(data["license"], str):
        raise ClientError(
            "invalid_metadata", "license must be a license code from the licenses command."
        )
    data.setdefault("primary_category", "")
    data.setdefault("secondary_categories", [])
    if (
        not isinstance(data["primary_category"], str)
        or not isinstance(data["secondary_categories"], list)
        or not all(isinstance(code, str) for code in data["secondary_categories"])
    ):
        raise ClientError(
            "invalid_metadata",
            "primary_category must be a subject code; secondary_categories must be a list of subject codes.",
        )
    data["secondary_categories"] = sorted(data["secondary_categories"])
    chapter_specs = data.pop("chapters", None)
    bib_path = data.pop("bibliography", None)
    extra = {}
    if chapter_specs is not None or bib_path is not None:
        import re

        if not isinstance(chapter_specs or [], list) or len(chapter_specs or []) > 64:
            raise ClientError("invalid_chapters", "Use a list of up to 64 chapters.")
        chapters, seen, paths = [], set(), set()
        for item in chapter_specs or []:
            if (
                not isinstance(item, dict)
                or set(item) != {"id", "title", "file"}
                or not all(isinstance(v, str) for v in item.values())
            ):
                raise ClientError("invalid_chapters", "Each chapter needs id, title, and file.")
            if (
                not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", item["id"])
                or item["id"] in seen
                or not item["title"].strip()
            ):
                raise ClientError("invalid_chapters", "Use unique chapter IDs and nonempty titles.")
            path = safe_file(root, item["file"])
            if path.resolve() in paths or path.suffix.lower() != ".md":
                raise ClientError(
                    "invalid_chapters", "Each chapter needs a separate Markdown file."
                )
            paths.add(path.resolve())
            seen.add(item["id"])
            if path.stat().st_size > 1024 * 1024:
                raise ClientError("too_large", "The complete paper must be at most 1 MB.")
            chapters.append(
                {
                    "id": item["id"],
                    "title": item["title"],
                    "markdown": path.read_bytes().decode("utf-8"),
                }
            )
        bib = safe_file(root, bib_path).read_bytes().decode("utf-8") if bib_path else ""
        extra.update(chapters=chapters, bibliography=bib)
        source = (
            "\n\n".join(p["markdown"] for p in chapters).encode("utf-8")
            if chapters
            else safe_file(root, "paper.md").read_bytes()
        )
    else:
        source = safe_file(root, "paper.md").read_bytes()
    if len(source) + len(extra.get("bibliography", "").encode()) > 1024 * 1024:
        raise ClientError("too_large", "The complete paper and bibliography must be at most 1 MB.")
    return {**data, "markdown": source.decode("utf-8"), **extra}


def project():
    for directory in (Path.cwd(), *Path.cwd().parents):
        if (directory / ".peerpedia/state.json").is_file():
            state = read_json(directory / ".peerpedia/state.json")
            state["server"] = origin(state["server"])
            if state["paper_id"]:
                uuid.UUID(state["paper_id"])
            if state.get("last_submission"):
                uuid.UUID(state["last_submission"])
            return directory, state
    raise ClientError(
        "not_a_project", "Run this inside a Peerpedia directory created by clone or init."
    )


@contextmanager
def locked(root):
    lock = root / ".peerpedia/lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ClientError(
            "project_busy",
            "Another command owns .peerpedia/lock. If it crashed, remove the lock only after confirming it has stopped.",
        )
    os.close(fd)
    try:
        yield
    finally:
        lock.unlink()


def base_record(root):
    path = root / ".peerpedia/base.json"
    return verify(read_json(path)) if path.exists() else None


def changed(root, base):
    return not base or local_document(root) != record_document(base)


def write_working(root, record):
    info = metadata(record)
    if record["manifest"]["format"] == "peerpedia-submission-v4":
        info.update(chapters=[], bibliography="references.yaml")
        # Preserve local filenames for matching chapter IDs when pulling.
        existing_info = read_json(root / "paper.json") if (root / "paper.json").exists() else {}
        filenames = {p["id"]: p["file"] for p in existing_info.get("chapters", [])}
        bib_filename = existing_info.get("bibliography") or "references.yaml"
        info["bibliography"] = bib_filename
        bib_target = safe_file(root, bib_filename)
        if bib_target.exists() and not existing_info.get("bibliography"):
            raise ClientError(
                "local_changes", "A bibliography would overwrite an untracked file. Move it first."
            )
        targets = []
        for page in record["chapters"]:
            filename = filenames.get(page["id"], f"chapters/{page['id']}.md")
            target = safe_file(root, filename)
            if target.exists() and page["id"] not in filenames:
                raise ClientError(
                    "local_changes",
                    f"A new chapter would overwrite {filename}. Move that file first.",
                )
            targets.append((target, page["markdown"]))
            info["chapters"].append({"id": page["id"], "title": page["title"], "file": filename})
        if not record["chapters"]:
            targets.append((safe_file(root, "paper.md"), record["markdown"]))
        targets.append((bib_target, record["bibliography"]))
        for target, text in targets:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
    else:
        safe_file(root, "paper.md").write_bytes(record["markdown"].encode("utf-8"))
    write_json(root / "paper.json", info)


def save_base(root, state, record, replace_working=False):
    verify(record)
    if state["paper_id"] and state["paper_id"] != record["manifest"]["paper_id"]:
        raise ClientError("wrong_paper", "Remote document belongs to a different paper.")
    if replace_working:
        write_working(root, record)
    write_json(root / ".peerpedia/base.json", record)
    state.update(paper_id=record["manifest"]["paper_id"], base_hash=record["hash"])
    write_json(root / ".peerpedia/state.json", state)


def remote_current(state):
    if not state["paper_id"]:
        raise ClientError("unpublished", "Push this new paper first.")
    record = verify(request(state["server"], f"/api/v1/papers/{state['paper_id']}/")["current"])
    if record["manifest"]["paper_id"] != state["paper_id"]:
        raise ClientError("wrong_paper", "Remote returned a different paper.")
    return record


def login(args):
    server = origin(args.server)
    raw = (
        sys.stdin.readline().strip()
        if args.token_stdin
        else getpass.getpass("Access token: ").strip()
    )
    identity = request(server, "/api/v1/me/", token=raw)
    data = credentials()
    data["servers"][server] = raw
    data["default_server"] = server
    save_credentials(data)
    return {"server": server, **identity}


def public_reference(value, server, kind):
    """Accept a dated label, internal UUID, or URL on the selected server."""
    import re
    from datetime import datetime

    if "://" in value:
        parts = urlsplit(value)
        if origin(f"{parts.scheme}://{parts.netloc}") != server:
            raise ClientError("wrong_server", "The URL must use the selected server.")
        match = re.fullmatch(r"/" + kind + r"/([^/]+)/(?:read/)?", parts.path)
        if not match:
            raise ClientError("invalid_reference", "Use a details or reader URL for this command.")
        value = match[1]
    if re.fullmatch(r"[0-9]{6}\.[0-9a-f]{12,64}", value):
        try:
            datetime(2000 + int(value[:2]), int(value[2:4]), int(value[4:6]))
            return value
        except ValueError:
            pass
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise ClientError("invalid_reference", "Use a YYMMDD.hash label, UUID, or URL.")


def paper_reference(value, server):
    return public_reference(value, server, "papers")


def snapshot_reference(value, server):
    return public_reference(value, server, "submissions")


def resolve_paper(server, reference):
    reference = paper_reference(reference, server)
    result = request(server, f"/api/v1/papers/{reference}/")
    record = verify(result["current"])
    expected = reference
    if "." in reference:
        if result.get("paper_identifier") != reference:
            raise ClientError("wrong_paper", "Remote returned a different paper number.")
        expected = result.get("paper_id")
    if record["manifest"]["paper_id"] != expected:
        raise ClientError("wrong_paper", "Remote returned a different paper.")
    return record


def resolve_snapshot(server, reference):
    target = snapshot_reference(reference, server)
    record = verify(request(server, f"/api/v1/submissions/{target}/"))
    actual = (
        record.get("snapshot_identifier") if "." in target else record["manifest"]["submission_id"]
    )
    if actual != target:
        raise ClientError("wrong_snapshot", "Remote returned a different snapshot.")
    return record


def initialize(args):
    server = server_for(args)
    record = None
    if args.command == "clone":
        if "://" in args.paper_id and urlsplit(args.paper_id).path.startswith("/submissions/"):
            record = resolve_snapshot(server, args.paper_id)
            paper_id = record["manifest"]["paper_id"]
        else:
            paper_id = paper_reference(args.paper_id, server)
            record = resolve_paper(server, paper_id)
    root = Path(args.directory or ("paper-" + paper_id)).absolute()
    # Never overwrite an existing folder, even if it looks empty.
    root.mkdir()
    (root / ".peerpedia").mkdir()
    state = {"server": server, "paper_id": None, "base_hash": None}
    if record:
        save_base(root, state, record, replace_working=True)
    else:
        (root / "paper.md").write_text("# Your paper\n", encoding="utf-8")
        write_json(
            root / "paper.json",
            {
                "title": "",
                "authors": "",
                "abstract": "",
                "primary_category": "",
                "secondary_categories": [],
                "license": "",
            },
        )
        write_json(root / ".peerpedia/state.json", state)
    (root / ".gitignore").write_text(".peerpedia/\n", encoding="utf-8")
    return {
        "directory": str(root),
        "server": server,
        "paper_id": state["paper_id"],
        "base_hash": state["base_hash"],
    }


def push(root, state, args):
    pr_id = getattr(args, "pr", None)
    expected_head = getattr(args, "expected_head", None)
    discussion_ids = getattr(args, "address", []) or []
    ai_assisted = getattr(args, "ai_assisted", False)
    if args.retry and (pr_id or expected_head or discussion_ids or ai_assisted):
        raise ClientError(
            "invalid_arguments",
            "Retry reuses the saved request. Do not add PR, discussion, or AI flags.",
        )
    if bool(pr_id) != bool(expected_head):
        raise ClientError(
            "invalid_arguments",
            "Updating a PR needs both --pr and --expected-head (the current full hash).",
        )
    pending_path = root / ".peerpedia/pending.json"
    pending = read_json(pending_path) if pending_path.exists() else None
    if args.retry:
        if not pending:
            raise ClientError("no_pending_push", "There is no interrupted push to retry.")
        if pending["server"] != state["server"]:
            raise ClientError("server_changed", "Restore the original server before retrying.")
    else:
        if not args.message or not args.message.strip():
            raise ClientError("message_required", "Describe the change using -m.")
        if pending:
            raise ClientError(
                "pending_push",
                "Resolve the previous push with push --retry before starting another.",
            )
        base = base_record(root)
        if base and base["hash"] != state["base_hash"]:
            raise ClientError("invalid_state", "Stored base and state do not agree.")
        if not changed(root, base) and not pr_id:
            return {"status": "unchanged", "message": "No local changes to push."}
        if not state["paper_id"] and not local_document(root)["license"]:
            raise ClientError(
                "license_required",
                "Choose a license in paper.json. Run peerpedia licenses to compare choices; accept the agreement on the website first.",
            )
        pending = {
            "server": state["server"],
            "key": str(uuid.uuid4()),
            "payload": {
                "paper_id": state["paper_id"],
                "base_hash": state["base_hash"],
                **local_document(root),
                "explanation": args.message,
            },
        }
        if state["paper_id"] and not pending["payload"].get("license"):
            pending["payload"].pop("license", None)
        if pr_id:
            pending["payload"].update(
                pull_request_id=str(uuid.UUID(pr_id)), expected_head=expected_head
            )
        if discussion_ids:
            pending["payload"]["discussion_ids"] = [
                str(uuid.UUID(value)) for value in discussion_ids
            ]
        if ai_assisted:
            pending["payload"]["ai_assisted"] = True
        previous_path = root / ".peerpedia/last-push.json"
        if previous_path.exists():
            previous = read_json(previous_path)
            if (
                previous["request"]["server"] == state["server"]
                and previous["request"]["payload"] == pending["payload"]
            ):
                # Reuse the server's idempotency receipt even after a successful
                # local completion. A repeated command must not create a copy.
                pending = previous["request"]
        # Save the exact payload before sending: lost responses cannot turn a
        # retry into another publication, even if the user edits files meanwhile.
        write_json(pending_path, pending)
    try:
        record = verify(
            request(
                state["server"],
                "/api/v1/push/",
                token=token_for(state["server"]),
                payload=pending["payload"],
                key=pending["key"],
            )
        )
    except ClientError as error:
        if error.code in {
            "stale_base",
            "invalid_document",
            "invalid_request",
            "too_large",
            "insufficient_scope",
            "not_found",
            "stale_pr",
            "invalid_discussion",
            "forbidden",
            "agreement_required",
            "license_required",
            "license_mismatch",
        }:
            pending_path.unlink()  # Definitive rejection: safe to fix and submit anew.
        raise
    submitted = pending["payload"]
    if (
        record["markdown"] != submitted["markdown"]
        or (submitted["paper_id"] and record["manifest"]["paper_id"] != submitted["paper_id"])
        or record["manifest"]["base_hash"] != submitted["base_hash"]
        or any(
            record["manifest"][field] != submitted[field].strip()
            for field in ("title", "authors", "abstract", "explanation")
        )
    ):
        raise ClientError(
            "verification_failed", "Server receipt does not match the pushed document or base."
        )
    for field in ("primary_category", "secondary_categories", "license"):
        if field in submitted and record["manifest"].get(field) != submitted[field]:
            raise ClientError(
                "verification_failed", "Server receipt does not match the pushed subjects."
            )
    for field in ("chapters", "bibliography"):
        if field in submitted and record.get(field) != submitted[field]:
            raise ClientError(
                "verification_failed",
                "Server receipt does not match the pushed chapters or bibliography.",
            )
    state["paper_id"] = record["manifest"]["paper_id"]
    state["last_submission"] = record["manifest"]["submission_id"]
    write_json(root / ".peerpedia/last-push.json", {"request": pending, "receipt": record})
    if submitted["paper_id"] is None:
        save_base(root, state, record)
    else:
        write_json(root / ".peerpedia/state.json", state)
    pending_path.unlink()
    return {
        "pull_request": record.get("pull_request"),
        "via_cli": record.get("via_cli", True),
        "ai_assisted": record.get("ai_assisted", False),
        "submission_id": record["manifest"]["submission_id"],
        "hash": record["hash"],
        "status": record["status"],
        "url": state["server"] + record["url"],
        "snapshot_identifier": record.get("snapshot_identifier"),
    }


READ_COMMANDS = {
    "feedback",
    "discussion",
    "replies",
    "comment-history",
    "reviews",
    "prs",
    "pr",
    "pr-comments",
}


def read_feedback(args):
    if args.server:
        server = server_for(args)
        paper_id = getattr(args, "paper", None)
    else:
        _, state = project()
        server, paper_id = state["server"], getattr(args, "paper", None) or state["paper_id"]
    if args.offset < 0:
        raise ClientError("invalid_arguments", "Offset must be nonnegative.")

    def uid(value):
        if not value:
            raise ClientError(
                "paper_required",
                "Use --paper with --server, or run inside a published paper directory.",
            )
        return str(uuid.UUID(value))

    if paper_id and args.command in {"feedback", "reviews", "prs"}:
        reference = paper_reference(paper_id, server)
        paper_id = (
            resolve_paper(server, reference)["manifest"]["paper_id"]
            if "." in reference
            else reference
        )

    if args.command == "feedback":
        submission_id = getattr(args, "submission", None)
        if submission_id:
            target = snapshot_reference(submission_id, server)
            submission_id = (
                resolve_snapshot(server, target)["manifest"]["submission_id"]
                if "." in target
                else target
            )
        path = (
            f"/api/v1/submissions/{uid(submission_id)}/feedback/"
            if submission_id
            else f"/api/v1/papers/{uid(paper_id)}/feedback/"
        )
        key = "passages"
    elif args.command in {"reviews", "prs"}:
        path, key = f"/api/v1/papers/{uid(paper_id)}/{args.command}/", args.command
    else:
        target = uid(args.target)
        path, key = {
            "discussion": (f"/api/v1/passages/{target}/", "threads"),
            "replies": (f"/api/v1/discussion-comments/{target}/replies/", "replies"),
            "comment-history": (f"/api/v1/discussion-comments/{target}/history/", "revisions"),
            "pr": (f"/api/v1/prs/{target}/", "snapshots"),
            "pr-comments": (f"/api/v1/prs/{target}/comments/", "comments"),
        }[args.command]

    def pages(path, key, offset=0):
        result = request(server, path + "?offset=" + str(offset))
        seen = {offset}
        while args.all and result.get("next") is not None:
            at = result["next"]
            if type(at) is not int or at <= offset or at in seen:
                raise ClientError("invalid_response", "The server returned an invalid page cursor.")
            seen.add(at)
            offset = at
            page = request(server, path + "?offset=" + str(at))
            result[key].extend(page[key])
            result["next"] = page.get("next")
        return result

    result = pages(path, key, args.offset)
    if args.all and args.command == "discussion":
        for thread in result["threads"]:
            if thread["next_replies"] is not None:
                extra = pages(
                    f"/api/v1/discussion-comments/{uid(thread['id'])}/replies/",
                    "replies",
                    thread["next_replies"],
                )
                thread["replies"].extend(extra["replies"])
                thread["next_replies"] = None
    return result


def run(args):
    if args.command == "search":
        if args.offset < 0 or len(args.query.strip()) > 200:
            raise ClientError(
                "invalid_arguments", "Use a nonnegative offset and a query up to 200 characters."
            )
        query = urlencode(
            {
                "q": args.query.strip(),
                "subject": args.subject,
                "sort": args.sort,
                "offset": args.offset,
            }
        )
        return request(server_for(args), "/api/v1/papers/?" + query)
    if args.command == "snapshot":
        return resolve_snapshot(server_for(args), args.target)
    if args.command in READ_COMMANDS:
        return read_feedback(args)
    if args.command in {"categories", "licenses"}:
        return request(server_for(args), f"/api/v1/{args.command}/")
    if args.command == "login":
        return login(args)
    if args.command == "logout":
        server = server_for(args)
        data = credentials()
        data["servers"].pop(server, None)
        if data.get("default_server") == server:
            data.pop("default_server")
        save_credentials(data)
        return {
            "message": "Local credential removed. Revoke the token on the website to disable other copies."
        }
    if args.command in {"init", "clone"}:
        return initialize(args)
    root, state = project()
    with locked(root):
        if args.command == "push":
            return push(root, state, args)
        base = base_record(root)
        if args.command == "diff":
            data = local_document(root)
            before = record_document(base) if base else dict.fromkeys(data, "")

            def lines(value):
                return (
                    json.dumps(value, ensure_ascii=False, indent=2) + "\n"
                    if isinstance(value, list)
                    else value
                ).splitlines(keepends=True)

            diffs = {
                key: "".join(
                    difflib.unified_diff(
                        lines(before.get(key, "")),
                        lines(value),
                        fromfile="base/" + key,
                        tofile="local/" + key,
                    )
                )
                for key, value in data.items()
                if before.get(key, "") != value
            }
            return {"changed": bool(diffs), "diffs": diffs}
        if args.command == "status":
            remote = remote_current(state) if state["paper_id"] else None
            last = (
                request(state["server"], f"/api/v1/submissions/{state['last_submission']}/")
                if state.get("last_submission")
                else None
            )
            return {
                "paper_id": state["paper_id"],
                "base_hash": state["base_hash"],
                "local_changes": changed(root, base),
                "remote_hash": remote["hash"] if remote else None,
                "remote_changed": bool(remote and remote["hash"] != state["base_hash"]),
                "pending_retry": (root / ".peerpedia/pending.json").exists(),
                "last_submission": {
                    "id": state["last_submission"],
                    "status": last["status"],
                    "hash": last["hash"],
                }
                if last
                else None,
            }
        if (root / ".peerpedia/pending.json").exists():
            raise ClientError("pending_push", "Resolve the previous push with push --retry first.")
        if args.command == "fetch":
            remote = remote_current(state)
            write_json(root / ".peerpedia/incoming.json", remote)
            (root / ".peerpedia/incoming.md").write_bytes(remote["markdown"].encode("utf-8"))
            write_json(root / ".peerpedia/incoming-metadata.json", metadata(remote))
            if remote["manifest"]["format"] == "peerpedia-submission-v4":
                incoming_dir = root / ".peerpedia" / ("incoming-" + remote["hash"])
                if not incoming_dir.exists():
                    incoming_dir.mkdir()
                    write_working(incoming_dir, remote)
            return {
                "hash": remote["hash"],
                "message": "Fetched into .peerpedia/incoming.md and incoming-metadata.json. Working files are unchanged. Reconcile them, then run rebase --acknowledge.",
            }
        if args.command == "rebase":
            if not args.acknowledge:
                raise ClientError(
                    "reconciliation_required",
                    "Reconcile your document and metadata with the fetched version, then run rebase --acknowledge.",
                )
            incoming = verify(read_json(root / ".peerpedia/incoming.json"))
            latest = remote_current(state)
            if incoming["hash"] != latest["hash"]:
                raise ClientError(
                    "stale_base", "Another version was accepted. Fetch and reconcile again."
                )
            save_base(root, state, incoming)
            return {
                "base_hash": incoming["hash"],
                "message": "Base updated; working files preserved. Inspect diff before pushing.",
            }
        if args.command == "pull":
            remote = remote_current(state)
            data = local_document(root)
            matches_remote = data == record_document(remote)
            if changed(root, base) and not matches_remote:
                raise ClientError(
                    "local_changes",
                    "Pull would overwrite local work. Use fetch, reconcile the files, then rebase --acknowledge.",
                )
            save_base(root, state, remote, replace_working=not matches_remote)
            return {
                "base_hash": remote["hash"],
                "message": "Local base is now the latest accepted version.",
            }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Machine-readable output")
    parser.add_argument("--version", action="version", version=f"peerpedia {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in (
        "login",
        "logout",
        "init",
        "clone",
        "diff",
        "status",
        "push",
        "pull",
        "fetch",
        "rebase",
        "categories",
        "licenses",
        "search",
        "snapshot",
        *sorted(READ_COMMANDS),
    ):
        child = commands.add_parser(command)
        child.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        if command == "login":
            child.add_argument("server")
            child.add_argument("--token-stdin", action="store_true")
        if command in {"init", "clone", "logout", "categories", "licenses", "search", "snapshot"}:
            child.add_argument("--server")
        if command == "search":
            child.add_argument("query", nargs="?", default="")
            child.add_argument("--subject", default="")
            child.add_argument("--sort", choices=["latest", "rating"], default="latest")
            child.add_argument("--offset", type=int, default=0)
        if command == "snapshot":
            child.add_argument("target", help="Immutable submission UUID")
        if command == "clone":
            child.add_argument("paper_id", help="Paper number, UUID, or paper URL")
            child.add_argument("directory", nargs="?")
        if command == "init":
            child.add_argument("directory")
        if command in READ_COMMANDS:
            child.add_argument("--server")
            child.add_argument("--offset", type=int, default=0)
            child.add_argument(
                "--all",
                action="store_true",
                help="Read all pages; discussion also includes all replies",
            )
            if command in {"feedback", "reviews", "prs"}:
                targets = child.add_mutually_exclusive_group()
                targets.add_argument("--paper")
                if command == "feedback":
                    targets.add_argument("--submission")
            else:
                child.add_argument("target", help="Passage, comment, or PR UUID")
        if command == "push":
            child.add_argument("--pr", help="Append an immutable snapshot to your existing PR")
            child.add_argument("--expected-head", help="Full hash currently at the PR head")
            child.add_argument(
                "--address",
                action="append",
                default=[],
                metavar="THREAD_ID",
                help="Link a top-level discussion; repeat for several",
            )
            child.add_argument(
                "--ai-assisted", action="store_true", help="Declare AI assistance on this snapshot"
            )
            child.add_argument("-m", "--message")
            child.add_argument("--retry", action="store_true")
        if command == "rebase":
            child.add_argument("--acknowledge", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = run(args)
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        elif args.command == "diff":
            print("\n".join(result["diffs"].values()) or "No local changes.")
        else:
            for key, value in result.items():
                print(f"{key}: {value}")
    except (ClientError, OSError, ValueError, KeyError, TypeError) as error:
        if not isinstance(error, ClientError):
            error = ClientError(
                "local_error", "Check the local files and command arguments: " + str(error)
            )
        if args.json:
            print(
                json.dumps(
                    {
                        "error": {
                            "code": error.code,
                            "message": error.message,
                            "details": error.details,
                        }
                    }
                )
            )
        else:
            print(f"{error.code}: {error.message}", file=sys.stderr)
            if error.details:
                print(json.dumps(error.details), file=sys.stderr)
        raise SystemExit(1)
