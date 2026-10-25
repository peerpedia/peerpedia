from publishing.test_support import consenting_user
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest import skipUnless
from unittest.mock import patch
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.db import connection
from django.test import SimpleTestCase, override_settings
from accounts.tokens import issue_token
from cli.peerpedia_cli import main as client
from publishing.models import Paper, Submission
from publishing.services import decide, propose, publish
from publishing.tests import document


class ClientSafetyTests(SimpleTestCase):
    def test_search_does_not_send_credentials(self):
        import contextlib
        import io

        with (
            patch.dict(os.environ, {"PEERPEDIA_TOKEN": "never-send-me"}),
            patch.object(client, "request", return_value={"papers": [], "next": None}) as read,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            client.main(["search", "a & 中文?", "--server", "https://example.org", "--json"])
        self.assertEqual(read.call_args.args[0], "https://example.org")
        self.assertEqual(read.call_args.kwargs, {})
        self.assertIn("q=a+%26+%E4%B8%AD%E6%96%87%3F", read.call_args.args[1])

    def test_remote_requires_https_and_credentials_cannot_be_embedded_in_url(self):
        for server in [
            "http://example.org",
            "https://user:pass@example.org",
            "https://example.org/path",
            "https://example.org/?token=x",
        ]:
            with self.assertRaises(client.ClientError):
                client.origin(server)
        self.assertEqual(client.origin("http://127.0.0.1:8000/"), "http://127.0.0.1:8000")

    def test_injected_token_is_bound_to_explicit_origin(self):
        with patch.dict(
            os.environ,
            {"PEERPEDIA_TOKEN": "pp_test", "PEERPEDIA_SERVER": "https://trusted.example"},
        ):
            self.assertEqual(client.token_for("https://trusted.example"), "pp_test")
            with self.assertRaises(client.ClientError):
                client.token_for("https://untrusted.example")

    def test_paper_url_stays_on_selected_server(self):
        with self.assertRaises(client.ClientError):
            client.paper_reference(
                "https://other.example/papers/2610.123456789abc/", "https://peerpedia.dev"
            )
        for value in ["2613.123456789abc", "../../private", "2610.short"]:
            with self.assertRaises(client.ClientError):
                client.paper_reference(value, "https://peerpedia.dev")

    def test_manifest_tampering_is_detected(self):
        record = {
            "manifest": {
                "format": "peerpedia-submission-v1",
                "paper_id": "00000000-0000-0000-0000-000000000001",
                "submission_id": "00000000-0000-0000-0000-000000000002",
                "title": "Title",
                "authors": "Ada",
                "abstract": "Abstract",
                "markdown_sha256": hashlib.sha256(b"Original").hexdigest(),
            },
            "markdown": "Original",
        }
        record["hash"] = hashlib.sha256(
            json.dumps(
                record["manifest"], sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
        ).hexdigest()
        client.verify(record)
        record["markdown"] = "Changed"
        with self.assertRaises(client.ClientError):
            client.verify(record)

    def test_bearer_credentials_are_not_forwarded_on_redirect(self):
        self.assertIsNone(
            client.NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://untrusted.example"
            )
        )

    def test_project_lock_prevents_simultaneous_mutations(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".peerpedia").mkdir()
            with client.locked(root):
                with self.assertRaises(client.ClientError):
                    with client.locked(root):
                        self.fail("Second process acquired lock")
            self.assertFalse((root / ".peerpedia/lock").exists())


@skipUnless(connection.vendor == "postgresql", "Live CLI integration uses isolated PostgreSQL")
@override_settings(DEBUG=True, PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class CLIJourneys(StaticLiveServerTestCase):
    host = "127.0.0.1"

    def setUp(self):
        self.owner = consenting_user("owner", "owner@example.org", "password", email_verified=True)
        self.other = consenting_user("other", "other@example.org", "password", email_verified=True)
        _, self.owner_token = issue_token(self.owner, "Publisher", can_publish=True)
        _, self.other_token = issue_token(self.other, "Contributor")
        self.temporary = tempfile.TemporaryDirectory(prefix="peerpedia-cli-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = {
            key: value for key, value in os.environ.items() if not key.startswith("PEERPEDIA_")
        }
        self.env.update(
            PEERPEDIA_CONFIG_DIR=str(self.root / "credentials"),
            PYTHONPATH=str(Path(__file__).resolve().parents[1] / "cli"),
            NO_PROXY="127.0.0.1,localhost",
            no_proxy="127.0.0.1,localhost",
        )

    def command(self, *args, folder=None, token=None, failure=None):
        result = subprocess.run(
            [sys.executable, "-m", "peerpedia_cli", *args, "--json"],
            cwd=folder or self.root,
            env=self.env,
            input=token,
            text=True,
            capture_output=True,
            timeout=40,
        )
        self.assertEqual(result.returncode, 1 if failure else 0, result.stdout + result.stderr)
        data = json.loads(result.stdout)
        if failure:
            self.assertEqual(data["error"]["code"], failure, data)
        for raw in (self.owner_token, self.other_token):
            self.assertNotIn(raw, result.stdout + result.stderr)
        return data

    def login(self, raw):
        return self.command("login", self.live_server_url, "--token-stdin", token=raw + "\n")

    def fixture_paper(self):
        return publish(self.owner, document())

    def test_read_feedback_and_push_linked_multi_snapshot_pr(self):
        from publishing.models import Passage, PassageComment, PassageCommentRevision
        from publishing.passages import validate

        paper = self.fixture_paper()
        spans, quote, key = validate(
            paper.current.markdown, [{"block": "b1", "start": 0, "end": 11}]
        )
        anchor = Passage.objects.create(submission=paper.current, spans=spans, quote=quote, key=key)
        thread = PassageComment.objects.create(
            passage=anchor, user=self.owner, score=3, text="Explain the equation."
        )
        PassageCommentRevision.objects.create(comment=thread, number=1, text=thread.text, score=3)
        for i in range(33):
            PassageComment.objects.create(
                passage=anchor,
                user=self.owner,
                parent=thread,
                root=thread,
                depth=1,
                text=f"Follow-up {i}",
            )
        # Public reads work before logging in, without writing local project state.
        found = self.command("search", "Ada", "--server", self.live_server_url)
        self.assertEqual(found["papers"][0]["paper_id"], str(paper.pk))
        self.assertEqual(found["papers"][0]["rating_count"], 0)
        self.assertEqual(
            self.command("search", "absent & ? 中文", "--server", self.live_server_url)["papers"],
            [],
        )
        self.command(
            "search", "x" * 201, "--server", self.live_server_url, failure="invalid_arguments"
        )
        self.command(
            "search",
            "--subject",
            "invalid",
            "--server",
            self.live_server_url,
            failure="invalid_request",
        )
        self.assertFalse((self.root / "credentials").exists())
        feedback = self.command(
            "feedback", "--server", self.live_server_url, "--paper", str(paper.pk), "--all"
        )
        self.assertEqual(feedback["passages"][0]["original_hash"], paper.current.hash)
        detail = self.command(
            "discussion", str(anchor.pk), "--server", self.live_server_url, "--all"
        )
        self.assertEqual(len(detail["threads"][0]["replies"]), 33)
        history = self.command(
            "comment-history", str(thread.pk), "--server", self.live_server_url, "--all"
        )
        self.assertEqual(history["revisions"][0]["text"], thread.text)
        self.login(self.other_token)
        self.command("clone", str(paper.pk), "feedback-work")
        work = self.root / "feedback-work"
        self.assertEqual(self.command("feedback", folder=work)["paper_id"], str(paper.pk))
        (work / "paper.md").write_text("# A test paper\n\nA clearer equation.\n", encoding="utf-8")
        first = self.command(
            "push",
            "-m",
            "Explain the equation.",
            "--address",
            str(thread.pk),
            "--ai-assisted",
            folder=work,
        )
        self.assertTrue(first["ai_assisted"])
        pr_id = first["pull_request"]["id"]
        prs = self.command("prs", "--all", folder=work)
        self.assertEqual(prs["prs"][0]["id"], pr_id)
        self.assertEqual(prs["prs"][0]["contributor"], "other")
        saved_markdown = (work / "paper.md").read_bytes()
        snapshot = self.command(
            "snapshot", first["submission_id"], "--server", self.live_server_url
        )
        self.assertEqual(snapshot["hash"], first["hash"])
        self.assertEqual(snapshot["markdown"].encode(), saved_markdown)
        self.assertEqual((work / "paper.md").read_bytes(), saved_markdown)
        pr = self.command("pr", pr_id, folder=work)
        self.assertEqual(pr["head_hash"], first["hash"])
        self.assertEqual(pr["discussion_ids"], [str(thread.pk)])
        (work / "paper.md").write_text(
            "# A test paper\n\nA complete explanation.\n", encoding="utf-8"
        )
        second = self.command(
            "push",
            "-m",
            "Expand the explanation.",
            "--pr",
            pr_id,
            "--expected-head",
            first["hash"],
            "--address",
            str(thread.pk),
            "--ai-assisted",
            folder=work,
        )
        self.assertEqual(second["pull_request"]["snapshot"], 2)
        self.command(
            "push",
            "-m",
            "A stale update.",
            "--pr",
            pr_id,
            "--expected-head",
            first["hash"],
            folder=work,
            failure="stale_pr",
        )
        self.assertFalse((work / ".peerpedia/pending.json").exists())
        self.assertEqual(len(self.command("pr", pr_id, "--all", folder=work)["snapshots"]), 2)
        self.command(
            "push",
            "-m",
            "Missing concurrency check.",
            "--pr",
            pr_id,
            folder=work,
            failure="invalid_arguments",
        )
        # A PR can explicitly return to its accepted base without silently becoming a no-op.
        (work / "paper.md").write_text(paper.current.markdown, encoding="utf-8")
        reverted = self.command(
            "push",
            "-m",
            "Reconsider the proposed rewrite.",
            "--pr",
            pr_id,
            "--expected-head",
            second["hash"],
            folder=work,
        )
        self.assertEqual(reverted["pull_request"]["snapshot"], 3)

    def test_clone_public_number_and_url(self):
        paper = self.fixture_paper()
        for name, value in [
            ("number", paper.public_id),
            ("url", self.live_server_url + paper.read_url),
        ]:
            result = self.command("clone", value, name, "--server", self.live_server_url)
            self.assertEqual(result["paper_id"], str(paper.pk))
            self.assertEqual(result["base_hash"], paper.current.hash)
        self.command("reviews", "--paper", paper.public_id, "--server", self.live_server_url)

    def test_new_publication_clone_proposal_retry_accept_and_pull(self):
        self.login(self.owner_token)
        self.command("init", "original")
        root = self.root / "original"
        data = document()
        (root / "paper.md").write_bytes(data["markdown"].encode())
        client.write_json(
            root / "paper.json",
            {
                key: data[key]
                for key in (
                    "license",
                    "title",
                    "authors",
                    "abstract",
                    "primary_category",
                    "secondary_categories",
                )
            },
        )
        first = self.command("push", "-m", "Initial publication.", folder=root)
        self.assertEqual(first["status"], "accepted")
        paper = Paper.objects.get()
        self.login(self.other_token)
        self.command("clone", str(paper.pk), "contribution")
        work = self.root / "contribution"
        updated = b"# A test paper\r\n\r\nA corrected proof.\r\n"
        (work / "paper.md").write_bytes(updated)
        self.assertTrue(self.command("diff", folder=work)["changed"])
        proposal = self.command("push", "-m", "Correct the proof.", folder=work)
        repeated = self.command("push", "-m", "Correct the proof.", folder=work)
        self.assertEqual(proposal["hash"], repeated["hash"])
        self.assertEqual(Submission.objects.count(), 2)
        self.assertEqual(
            self.command("status", folder=work)["last_submission"]["status"], "pending"
        )
        decide(self.owner, proposal["submission_id"], "accepted")
        self.command("pull", folder=work)
        self.assertEqual((work / "paper.md").read_bytes(), updated)
        self.assertFalse(self.command("status", folder=work)["local_changes"])
        self.assertFalse(self.command("diff", folder=work)["changed"])
        if os.name == "posix":
            self.assertEqual(
                (self.root / "credentials/credentials.json").stat().st_mode & 0o777, 0o600
            )
        self.command("logout")
        (work / "paper.md").write_text("Another edit", encoding="utf-8")
        self.command("push", "-m", "Edit", folder=work, failure="login_required")

    def test_stale_push_dirty_pull_and_explicit_reconciliation(self):
        paper = self.fixture_paper()
        self.login(self.other_token)
        self.command("clone", str(paper.pk), "work")
        root = self.root / "work"
        (root / "paper.md").write_text("My local improvement\n", encoding="utf-8")
        remote = propose(
            self.owner, paper.pk, paper.current_id, document(markdown="Someone else's correction\n")
        )
        decide(self.owner, remote.pk, "accepted")
        self.command("push", "-m", "My improvement", folder=root, failure="stale_base")
        self.assertFalse((root / ".peerpedia/pending.json").exists())
        self.command("pull", folder=root, failure="local_changes")
        self.assertEqual((root / "paper.md").read_text(), "My local improvement\n")
        self.command("fetch", folder=root)
        self.assertEqual((root / ".peerpedia/incoming.md").read_text(), remote.markdown)
        self.command("rebase", folder=root, failure="reconciliation_required")
        (root / "paper.md").write_text(remote.markdown + "My local improvement\n", encoding="utf-8")
        self.command("rebase", "--acknowledge", folder=root)
        result = self.command("push", "-m", "Combine both improvements", folder=root)
        self.assertEqual(Submission.objects.get(pk=result["submission_id"]).base_id, remote.pk)

    def test_lost_response_retries_saved_payload_even_after_local_edit(self):
        paper = self.fixture_paper()
        self.login(self.other_token)
        self.command("clone", str(paper.pk), "work")
        root = self.root / "work"
        (root / "paper.md").write_text("Frozen first edit", encoding="utf-8")
        code = """from peerpedia_cli import main as cli
real_request = cli.request
def lose_response(*args, **kwargs):
    result = real_request(*args, **kwargs)
    if args[1] == "/api/v1/push/":
        raise cli.ClientError("network_error", "Simulated lost response")
    return result
cli.request = lose_response
cli.main(["push", "-m", "Correct proof", "--json"])
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=root,
            env=self.env,
            text=True,
            capture_output=True,
            timeout=40,
        )
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(Submission.objects.count(), 2)
        (root / "paper.md").write_text("A later unsent edit", encoding="utf-8")
        self.command("push", "-m", "Other", folder=root, failure="pending_push")
        receipt = self.command("push", "--retry", folder=root)
        self.assertEqual(Submission.objects.count(), 2)
        self.assertEqual(
            Submission.objects.get(pk=receipt["submission_id"]).markdown, "Frozen first edit"
        )
        self.assertEqual((root / "paper.md").read_text(), "A later unsent edit")

    def test_subject_only_revision_and_public_taxonomy(self):
        paper = self.fixture_paper()
        result = self.command("categories", "--server", self.live_server_url)
        self.assertEqual(len(result["categories"]), 155)
        self.login(self.other_token)
        self.command("clone", str(paper.pk), "subjects")
        root = self.root / "subjects"
        data = client.read_json(root / "paper.json")
        self.assertEqual(data["primary_category"], "math.NT")
        data.update(primary_category="math.GR", secondary_categories=["math.NT", "math.HO"])
        client.write_json(root / "paper.json", data)
        diff = self.command("diff", folder=root)
        self.assertIn("primary_category", diff["diffs"])
        self.assertIn("secondary_categories", diff["diffs"])
        receipt = self.command("push", "-m", "Improve classification", folder=root)
        revision = Submission.objects.get(pk=receipt["submission_id"])
        self.assertEqual(revision.secondary_categories, ["math.HO", "math.NT"])
        decide(self.owner, revision.pk, "accepted")
        self.command("pull", folder=root)
        self.assertFalse(self.command("status", folder=root)["local_changes"])
        self.assertEqual(
            client.local_document(root)["secondary_categories"], ["math.HO", "math.NT"]
        )

    def test_multichapter_clone_rename_push_accept_pull(self):
        from publishing.test_chapters import course

        paper = publish(self.owner, course())
        self.login(self.owner_token)
        self.command("clone", str(paper.pk), "course")
        root = self.root / "course"
        info = client.read_json(root / "paper.json")
        original = root / info["chapters"][0]["file"]
        renamed = root / "opening.md"
        original.rename(renamed)
        info["chapters"][0]["file"] = "opening.md"
        client.write_json(root / "paper.json", info)
        self.assertFalse(self.command("diff", folder=root)["changed"])
        renamed.write_text(renamed.read_text() + "\nAn additional exercise.\n")
        proposal = self.command("push", "-m", "Add exercise", folder=root)
        self.assertEqual(proposal["status"], "pending")
        self.assertEqual(
            Submission.objects.get(pk=proposal["submission_id"]).chapters[0]["id"], "intro"
        )
        decide(self.owner, proposal["submission_id"], "accepted")
        self.command("pull", folder=root)
        self.assertFalse(self.command("diff", folder=root)["changed"])
        self.assertEqual(client.read_json(root / "paper.json")["chapters"][0]["file"], "opening.md")
        self.command("fetch", folder=root)
        self.assertTrue(
            (root / ".peerpedia" / ("incoming-" + proposal["hash"]) / "references.bib").exists()
        )


class ChapterClientTests(SimpleTestCase):
    def test_local_chapter_files_bibliography_and_renames(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            info = {
                "title": "Course",
                "authors": "Ada",
                "abstract": "Notes",
                "chapters": [{"id": "one", "title": "One", "file": "one.md"}],
                "bibliography": "references.bib",
            }
            (root / "one.md").write_bytes(b"# One\r\n")
            (root / "references.bib").write_bytes(b"@misc{one,title={One}}\r\n")
            client.write_json(root / "paper.json", info)
            first = client.local_document(root)
            self.assertEqual(first["chapters"][0]["markdown"], "# One\r\n")
            (root / "one.md").rename(root / "renamed.md")
            info["chapters"][0]["file"] = "renamed.md"
            client.write_json(root / "paper.json", info)
            self.assertEqual(first, client.local_document(root))
            info["chapters"][0]["file"] = "../outside.md"
            client.write_json(root / "paper.json", info)
            with self.assertRaises(client.ClientError):
                client.local_document(root)

    def test_chapter_manifest_detects_tampering(self):
        import copy

        source = "# One"
        chapters = [{"id": "one", "title": "One", "markdown": source}]
        manifest = {
            "format": "peerpedia-submission-v4",
            "paper_id": "00000000-0000-0000-0000-000000000001",
            "submission_id": "00000000-0000-0000-0000-000000000002",
            "title": "Title",
            "authors": "Ada",
            "abstract": "Abstract",
            "primary_category": "math.NT",
            "secondary_categories": [],
            "license": "CC-BY-4.0",
            "agreement": {"version": "test", "sha256": "a" * 64},
            "markdown_sha256": hashlib.sha256(source.encode()).hexdigest(),
            "chapters": [
                {
                    "id": "one",
                    "title": "One",
                    "markdown_sha256": hashlib.sha256(source.encode()).hexdigest(),
                }
            ],
            "bibliography_sha256": hashlib.sha256(b"").hexdigest(),
        }
        record = {
            "manifest": manifest,
            "markdown": source,
            "chapters": chapters,
            "bibliography": "",
        }
        record["hash"] = hashlib.sha256(
            json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
        client.verify(record)
        for key, value in [
            ("bibliography", "changed"),
            ("chapters", [{**chapters[0], "title": "Changed"}]),
        ]:
            changed = copy.deepcopy(record)
            changed[key] = value
            with self.assertRaises(client.ClientError):
                client.verify(changed)
