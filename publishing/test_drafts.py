import io
import json
import zipfile
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless

from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection, connections, DatabaseError, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice

from accounts.models import User
from .models import Draft, Submission, Comment, PullRequestCommit
from .services import publish, propose, decide
from .test_support import consenting_user
from .tests import document


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ArchiveTests(TestCase):
    @classmethod
    def setUpTestData(cls: type["ArchiveTests"]) -> None:
        cls.owner = consenting_user("writer", email_verified=True)
        cls.other = consenting_user("reader", email_verified=True)
        cls.paper = publish(cls.owner, document())

    def setUp(self: "ArchiveTests") -> None:
        self.client.force_login(self.owner)

    def test_scoped_draft_exports_saved_text_without_requiring_valid_markdown(
        self: "ArchiveTests",
    ) -> None:
        draft = Draft.objects.create(
            owner=self.owner,
            paper=self.paper,
            base=self.paper.current,
            scope_key="intro:proof",
            section={"chapter": "intro", "label": "Proof"},
            data={"title": "Unfinished proof", "explanation": "Rework the boundary case."},
            markdown="  ## 证明\r\n\n```math\nx",
            bibliography="unfinished: [",
        )
        old_url = f"/drafts/{draft.pk}/"
        self.assertRedirects(self.client.get(old_url), reverse("drafts"))
        listing = self.client.get(reverse("drafts"))
        self.assertContains(listing, draft.title)
        self.assertContains(listing, f"peerpedia:draft:{self.owner.pk}:{draft.pk}:")
        result = self.client.get(reverse("draft_export", args=[draft.pk]))
        self.assertEqual(result.status_code, 200)
        self.assertIn("private", result["Cache-Control"])
        with zipfile.ZipFile(io.BytesIO(result.content)) as bundle:
            self.assertEqual(bundle.read("paper.md"), draft.markdown.encode())
            self.assertEqual(bundle.read("references.yaml"), draft.bibliography.encode())
            details = json.loads(bundle.read("draft.json"))
        self.assertEqual(details["data"], draft.data)
        self.assertEqual(details["section"], draft.section)
        self.assertEqual(details["base"], str(draft.base_id))
        self.assertEqual(details["scope_key"], draft.scope_key)

    def test_chapter_export_includes_all_saved_sources_and_metadata(self: "ArchiveTests") -> None:
        draft = Draft.objects.create(
            owner=self.owner,
            chapters=[
                {"id": "first", "markdown": "Unfinished…"},
                {"id": "second", "title": "", "markdown": ""},
            ],
            markdown="Original saved Markdown",
            bibliography="alpha:",
            data={"authors": "A\nB"},
        )
        result = self.client.get(reverse("draft_export", args=[draft.pk]))
        with zipfile.ZipFile(io.BytesIO(result.content)) as bundle:
            self.assertEqual(bundle.read("paper.md").decode(), draft.markdown)
            self.assertEqual(bundle.read("chapters/first.md").decode(), "Unfinished…")
            self.assertEqual(bundle.read("chapters/second.md"), b"")
            self.assertEqual(bundle.read("references.yaml"), b"alpha:")
            self.assertEqual(json.loads(bundle.read("paper.json"))["authors"], "A\nB")

    def test_archive_is_private_read_only_and_respects_hidden_papers(self: "ArchiveTests") -> None:
        draft = Draft.objects.create(
            owner=self.owner, paper=self.paper, data={"title": "Private draft"}
        )
        export = reverse("draft_export", args=[draft.pk])
        self.assertEqual(self.client.post(export).status_code, 405)
        for action in ("save", "preview", "review", "submit", "rebase", "discard"):
            self.assertEqual(self.client.post(f"/drafts/{draft.pk}/{action}/").status_code, 404)
        self.other.is_superuser = self.other.is_staff = True
        self.other.save()
        self.client.force_login(self.other)
        device = TOTPDevice.objects.create(user=self.other, name="Staff verification")
        self.client.post(
            reverse("staff_mfa"), {"action": "verify", "code": f"{totp(device.bin_key):06d}"}
        )
        self.assertNotContains(self.client.get(reverse("drafts")), draft.title)
        self.assertEqual(self.client.get(export).status_code, 404)
        self.assertEqual(self.client.get(f"/drafts/{draft.pk}/").status_code, 404)
        self.client.force_login(self.owner)
        self.paper.is_hidden = True
        self.paper.save(update_fields=["is_hidden"])
        self.assertNotContains(self.client.get(reverse("drafts")), draft.title)
        self.assertEqual(self.client.get(export).status_code, 404)
        self.client.logout()
        self.assertEqual(self.client.get(export).status_code, 302)

    def test_old_edit_links_lead_to_upload_or_existing_pr(self: "ArchiveTests") -> None:
        first = propose(self.other, self.paper.pk, self.paper.current_id, document())
        for old, target in (
            ("/write/", reverse("publish")),
            (
                f"/papers/{self.paper.pk}/edit/?scope=proof",
                reverse("propose", args=[self.paper.pk]),
            ),
            (
                f"/prs/{first.pr_commit.request_id}/edit/",
                reverse("pull_request", args=[first.pr_commit.request_id]),
            ),
        ):
            self.assertRedirects(self.client.get(old), target, fetch_redirect_response=False)
            self.assertRedirects(self.client.post(old), target, fetch_redirect_response=False)
        self.assertFalse(Draft.objects.exists())

    def test_file_upload_prefills_revision_and_rejects_multiple_files(self: "ArchiveTests") -> None:
        revision = reverse("propose", args=[self.paper.pk])
        page = self.client.get(revision)
        self.assertContains(page, 'enctype="multipart/form-data"')
        self.assertEqual(page.context["form"]["authors"].value(), self.paper.current.authors)
        self.assertEqual(page.context["form"]["base"].value(), str(self.paper.current_id))
        files = [SimpleUploadedFile("a.md", b"A"), SimpleUploadedFile("b.md", b"B")]
        result = self.client.post(
            revision, {**document(), "base": self.paper.current_id, "file": files}
        )
        self.assertContains(result, "Upload one Markdown file")
        self.assertNotIn("token", result.context)
        empty = self.client.post(reverse("publish"), {})
        self.assertIn("file", empty.context["form"].errors)

    def test_shared_bibliography_requires_cli_even_without_chapters(self: "ArchiveTests") -> None:
        paper = publish(
            self.owner,
            document(
                bibliography="item:\n  type: book\n  author: Doe\n  title: Example\n  year: 2000\n"
            ),
        )
        url = reverse("propose", args=[paper.pk])
        page = self.client.get(url)
        self.assertContains(page, paper.current.download_url)
        self.assertContains(page, reverse("help_cli"))
        self.assertNotContains(page, 'type="file"')
        forced = self.client.post(
            url,
            {
                **document(),
                "base": paper.current_id,
                "file": SimpleUploadedFile("paper.md", b"Replacement"),
            },
        )
        self.assertEqual(forced.status_code, 409)
        self.assertEqual(paper.submissions.count(), 1)

    def test_multi_snapshot_pr_preserves_hashes_and_conversation(self: "ArchiveTests") -> None:
        first = propose(
            self.owner,
            self.paper.pk,
            self.paper.current_id,
            document(markdown="First proposed text"),
        )
        original_hash = first.hash
        pr = first.pr_commit.request
        Comment.objects.create(submission=first, user=self.other, text="Please expand the proof.")
        second = propose(
            self.owner,
            self.paper.pk,
            self.paper.current_id,
            document(markdown="Second proposed text", explanation="Expanded proof"),
            pull_request_id=pr.pk,
            expected_head=first.pk,
        )
        pr.refresh_from_db()
        first.refresh_from_db()
        self.assertEqual(pr.head_id, second.pk)
        self.assertEqual(first.status, "superseded")
        self.assertEqual(first.hash, original_hash)
        self.assertEqual(list(pr.commits.values_list("number", flat=True)), [1, 2])
        self.assertContains(
            self.client.get(reverse("pull_request", args=[pr.pk])), "Please expand the proof."
        )
        with self.assertRaises(ValidationError):
            decide(self.owner, first.pk, "accepted")
        with self.assertRaises(PermissionDenied):
            decide(self.other, pr.head_id, "accepted")
        decide(self.owner, pr.head_id, "accepted")
        with self.assertRaises(ValidationError):
            propose(
                self.owner,
                self.paper.pk,
                pr.head_id,
                document(),
                pull_request_id=pr.pk,
                expected_head=pr.head_id,
            )
        with self.assertRaises(DatabaseError), transaction.atomic():
            PullRequestCommit.objects.filter(submission=first).update(number=9)

    def test_only_contributor_can_append_and_expected_head_required(self: "ArchiveTests") -> None:
        first = propose(self.owner, self.paper.pk, self.paper.current_id, document())
        pr = first.pr_commit.request
        with self.assertRaises(PermissionDenied):
            propose(
                self.other,
                self.paper.pk,
                self.paper.current_id,
                document(),
                pull_request_id=pr.pk,
                expected_head=first.pk,
            )
        second = propose(
            self.owner,
            self.paper.pk,
            self.paper.current_id,
            document(),
            pull_request_id=pr.pk,
            expected_head=first.pk,
        )
        with self.assertRaises(ValidationError):
            propose(
                self.owner,
                self.paper.pk,
                self.paper.current_id,
                document(),
                pull_request_id=pr.pk,
                expected_head=first.pk,
            )
        self.assertEqual(second.status, "pending")


@skipUnless(connection.vendor == "postgresql", "Concurrent PR writes require PostgreSQL")
@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class PRConcurrencyTests(TransactionTestCase):
    def setUp(self: "PRConcurrencyTests") -> None:
        self.owner = consenting_user("concurrent-writer", email_verified=True)
        self.paper = publish(self.owner, document())

    def test_concurrent_pr_updates_cannot_fork_head(self: "PRConcurrencyTests") -> None:
        first = propose(self.owner, self.paper.pk, self.paper.current_id, document())
        pr = first.pr_commit.request
        barrier = Barrier(2)

        def append(index: int) -> str:
            connections.close_all()
            try:
                user = User.objects.get(pk=self.owner.pk)
                barrier.wait(timeout=10)
                try:
                    propose(
                        user,
                        self.paper.pk,
                        self.paper.current_id,
                        document(markdown=str(index)),
                        pull_request_id=pr.pk,
                        expected_head=first.pk,
                    )
                    return "created"
                except ValidationError:
                    return "conflict"
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(append, range(2)))
        self.assertEqual(sorted(results), ["conflict", "created"])
        self.assertEqual(pr.commits.count(), 2)


@skipUnless(connection.vendor == "postgresql", "Schema migration test uses isolated PostgreSQL")
class PRMigrationTests(TransactionTestCase):
    def test_populated_history_is_grouped_without_rehashing(self: "PRMigrationTests") -> None:
        before = [("publishing", "0004_submission_subjects"), ("accounts", "0002_accesstoken")]
        after = MigrationExecutor(connection).loader.graph.leaf_nodes()
        MigrationExecutor(connection).migrate(before)
        try:
            apps = MigrationExecutor(connection).loader.project_state(before).apps
            owner = apps.get_model("accounts", "User").objects.create(
                username="legacy-author", email_verified=True
            )
            OldPaper = apps.get_model("publishing", "Paper")
            OldSubmission = apps.get_model("publishing", "Submission")
            paper = OldPaper.objects.create(owner_id=owner.pk)
            data = document()
            data.pop("license")
            from django.utils import timezone

            now = timezone.now()
            base = Submission(
                paper_id=paper.pk,
                contributor_id=owner.pk,
                contributor_name=owner.username,
                created_at=now,
                **data,
            )
            original = OldSubmission.objects.create(
                id=base.pk,
                paper_id=paper.pk,
                contributor_id=owner.pk,
                contributor_name=owner.username,
                created_at=now,
                hash=base.calculate_hash(),
                **data,
            )
            paper.current_id = original.pk
            paper.save()
            apps.get_model("publishing", "Decision").objects.create(
                submission_id=original.pk, actor_id=owner.pk, action="accepted"
            )
            runtime = Submission(
                paper_id=paper.pk,
                contributor_id=owner.pk,
                contributor_name=owner.username,
                base=base,
                created_at=now,
                **data,
            )
            base.hash = original.hash
            old = OldSubmission.objects.create(
                id=runtime.pk,
                paper_id=paper.pk,
                contributor_id=owner.pk,
                contributor_name=owner.username,
                base_id=original.pk,
                created_at=now,
                hash=runtime.calculate_hash(),
                **data,
            )
            digest = old.hash
            apps.get_model("publishing", "Comment").objects.create(
                submission_id=old.pk, user_id=owner.pk, text="Legacy conversation"
            )
        finally:
            MigrationExecutor(connection).migrate(after)
        old = Submission.objects.get(pk=old.pk)
        self.assertEqual(old.hash, digest)
        self.assertEqual(old.hash, old.calculate_hash())
        self.assertEqual(old.pr_commit.request.head_id, old.pk)
        self.assertEqual(old.comments.get().text, "Legacy conversation")
        from django.db.migrations.exceptions import IrreversibleError

        try:
            with self.assertRaises(IrreversibleError):
                MigrationExecutor(connection).migrate(before)
        finally:
            MigrationExecutor(connection).migrate(after)
