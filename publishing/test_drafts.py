from publishing.test_support import consenting_user
import json
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import DatabaseError, transaction
from django.test import TestCase, Client, override_settings
from django.urls import reverse
from accounts.models import User
from .models import Draft, Submission, Comment, PullRequestCommit
from .services import publish, propose, decide
from .tests import document
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from django.db import connection, connections
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class DraftTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = consenting_user(
            "writer", "writer@example.org", "test-password", email_verified=True
        )
        cls.other = consenting_user(
            "reader", "reader@example.org", "test-password", email_verified=True
        )
        cls.paper = publish(cls.owner, document())

    def setUp(self):
        self.client.force_login(self.owner)

    def begin(self, paper=True):
        response = self.client.post(
            reverse("edit_paper", args=[self.paper.pk]) if paper else reverse("write")
        )
        self.assertEqual(response.status_code, 302)
        return Draft.objects.get(pk=response.url.split("/")[2])

    def save(self, draft, **changes):
        body = {"revision": draft.revision, "data": draft.data, "markdown": draft.markdown}
        body.update(changes)
        return self.client.post(
            reverse("draft_save", args=[draft.pk]),
            json.dumps(body),
            content_type="application/json",
        )

    def reviewed(self, draft):
        response = self.client.post(
            reverse("draft_review", args=[draft.pk]), {"revision": draft.revision}
        )
        self.assertEqual(response.status_code, 200)
        return response.context["token"]

    def prepared(self, paper=True):
        draft = self.begin(paper)
        changes = document(markdown="# Corrected\n\nA new proof. $x^2$")
        response = self.save(
            draft,
            data={k: v for k, v in changes.items() if k != "markdown"},
            markdown=changes["markdown"],
        )
        self.assertEqual(response.status_code, 200, response.content)
        draft.refresh_from_db()
        return draft

    def test_get_does_not_create_and_start_is_idempotent_for_paper(self):
        self.assertEqual(
            self.client.get(reverse("edit_paper", args=[self.paper.pk])).status_code, 200
        )
        self.assertFalse(Draft.objects.exists())
        first = self.begin()
        second = self.begin()
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(first.markdown, self.paper.current.markdown)
        self.assertFalse(
            self.client.get(reverse("editor", args=[first.pk]))
            .context["form"]["explanation"]
            .is_hidden
        )
        self.assertEqual(
            self.client.get(
                reverse("edit_paper", args=[self.paper.pk]) + "?section=section-proof"
            ).url,
            reverse("editor", args=[first.pk]) + "?section=section-proof",
        )

    def test_drafts_are_private_in_every_route_including_admin(self):
        draft = self.prepared()
        for user in [self.other]:
            user.is_staff = True
            user.is_superuser = True
            user.save()
            self.client.force_login(user)
            from django_otp.oath import totp
            from django_otp.plugins.otp_totp.models import TOTPDevice

            device = TOTPDevice.objects.create(user=user, name="Test authenticator")
            self.client.post(
                reverse("staff_mfa"), {"action": "verify", "code": f"{totp(device.bin_key):06d}"}
            )
            for route in ["editor", "draft_rebase"]:
                self.assertEqual(self.client.get(reverse(route, args=[draft.pk])).status_code, 404)
            for route in ["draft_save", "draft_preview", "draft_review", "draft_discard"]:
                response = self.client.post(
                    reverse(route, args=[draft.pk]),
                    json.dumps({"revision": 1, "markdown": "secret", "data": {}}),
                    content_type="application/json",
                )
                self.assertEqual(response.status_code, 404, (route, response.content))
            self.assertNotContains(self.client.get(reverse("drafts")), "Corrected")
        self.client.logout()
        self.assertEqual(self.client.get(reverse("editor", args=[draft.pk])).status_code, 302)
        self.assertNotContains(self.client.get(reverse("browse")), "Corrected")

    def test_unverified_and_csrf_protected(self):
        draft = self.begin()
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.force_login(self.owner)
        self.assertEqual(
            csrf_client.post(reverse("draft_save", args=[draft.pk]), {}).status_code, 403
        )
        self.owner.email_verified = False
        self.owner.save()
        self.assertEqual(self.save(draft).status_code, 302)

    def test_saves_preserve_unicode_whitespace_and_conflicts(self):
        draft = self.begin()
        source = "\n# 数学\n\n  $x$\n"
        result = self.save(draft, markdown=source)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result["Cache-Control"], "no-store, private")
        conflict = self.save(draft, markdown="overwrite")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["draft"]["markdown"], source)
        draft.refresh_from_db()
        self.assertEqual(draft.markdown, source)
        self.assertEqual(self.paper.current.markdown, document()["markdown"])

    def test_invalid_and_oversized_data(self):
        draft = self.begin()
        for changes in [
            {"markdown": "x" * (1024 * 1024 + 1)},
            {"markdown": "![x](https://example.org/x.png)"},
            {"markdown": "\x00"},
            {"markdown": "\ud800"},
            {"data": {"title": "\ud800"}},
            {"data": {"title": "x" * 251}},
            {"data": {"authors": []}},
        ]:
            self.assertEqual(self.save(draft, **changes).status_code, 400)
        self.assertEqual(
            self.client.post(
                reverse("draft_save", args=[draft.pk]), "[]", content_type="application/json"
            ).status_code,
            400,
        )

    def test_preview_safely_renders_without_saving(self):
        draft = self.begin()
        source = "# Heading\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n$x$"
        response = self.client.post(
            reverse("draft_preview", args=[draft.pk]),
            json.dumps({"revision": 1, "markdown": source}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("<script>", response.json()["html"])
        self.assertNotIn('href="javascript:', response.json()["html"])
        self.assertIn('data-source-line="1"', response.json()["html"])
        draft.refresh_from_db()
        self.assertEqual(draft.revision, 1)

    def test_submission_review_is_bound_to_revision_and_retry_is_idempotent(self):
        draft = self.prepared()
        token = self.reviewed(draft)
        self.assertEqual(self.save(draft, markdown="A later change").status_code, 200)
        response = self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": token, "license": "CC-BY-4.0", "rights_confirmed": "on"},
        )
        self.assertEqual(response.url, reverse("editor", args=[draft.pk]))
        self.assertEqual(Submission.objects.count(), 1)
        draft.refresh_from_db()
        token = self.reviewed(draft)
        first = self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": token, "license": "CC-BY-4.0", "rights_confirmed": "on"},
        )
        again = self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": token, "license": "CC-BY-4.0", "rights_confirmed": "on"},
        )
        self.assertEqual(first.url, again.url)
        self.assertEqual(Submission.objects.count(), 2)
        draft.refresh_from_db()
        self.assertEqual(draft.submitted.status, "pending")
        self.assertEqual(draft.markdown, "")
        self.assertNotContains(self.client.get(reverse("drafts")), "A test paper")
        self.assertEqual(self.save(draft, markdown="post-publication change").status_code, 409)
        self.assertEqual(draft.submitted.hash, draft.submitted.calculate_hash())

    def test_new_paper_is_accepted_and_owner_revision_needs_acceptance(self):
        draft = self.prepared(False)
        token = self.reviewed(draft)
        self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": token, "license": "CC-BY-4.0", "rights_confirmed": "on"},
        )
        draft.refresh_from_db()
        self.assertEqual(draft.submitted.status, "accepted")
        self.assertEqual(draft.submitted.paper.owner, self.owner)

    def test_stale_draft_rebase_preserves_text_and_blocks_old_preview(self):
        draft = self.prepared()
        token = self.reviewed(draft)
        old = draft.markdown
        update = propose(
            self.other,
            self.paper.pk,
            self.paper.current_id,
            document(markdown="Accepted elsewhere"),
        )
        decide(self.owner, update.pk, "accepted")
        self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": token, "license": "CC-BY-4.0", "rights_confirmed": "on"},
        )
        draft.refresh_from_db()
        self.assertIsNone(draft.submitted_id)
        review = self.client.post(
            reverse("draft_review", args=[draft.pk]), {"revision": draft.revision}
        )
        self.assertEqual(review.status_code, 302)
        rebase = self.client.post(
            reverse("draft_rebase", args=[draft.pk]),
            json.dumps({"revision": draft.revision, "latest": str(update.pk)}),
            content_type="application/json",
        )
        self.assertEqual(rebase.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.base_id, update.pk)
        self.assertEqual(draft.markdown, old)
        token = self.reviewed(draft)
        self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": token, "license": "CC-BY-4.0", "rights_confirmed": "on"},
        )
        draft.refresh_from_db()
        self.assertEqual(draft.submitted.base_id, update.pk)

    def test_missing_revision_description_has_actionable_editor_errors(self):
        draft = self.begin()
        response = self.client.post(
            reverse("draft_review", args=[draft.pk]), {"revision": draft.revision}, follow=True
        )
        issues = response.context["initial"]["publication_issues"]
        issue = next(item for item in issues if item["field"] == "explanation")
        self.assertEqual(issue["label"], "What changed?")
        self.assertIn("For example", issue["message"])
        self.assertContains(response, "publication-problems")
        draft.refresh_from_db()
        self.assertIsNone(draft.submitted_id)

    def test_failed_confirmation_keeps_license_choice_on_review_page(self):
        draft = self.prepared(paper=False)
        token = self.reviewed(draft)
        response = self.client.post(
            reverse("draft_submit", args=[draft.pk]), {"token": token, "license": "CC0-1.0"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "publishing/draft_review.html")
        self.assertEqual(response.context["consent_form"]["license"].value(), "CC0-1.0")
        self.assertIn("rights_confirmed", response.context["consent_form"].errors)
        draft.refresh_from_db()
        self.assertIsNone(draft.submitted_id)

    def test_discard_json_preserves_newer_draft_and_accepts_current_revision(self):
        draft = self.begin()
        self.save(draft, markdown="Private changes")
        response = self.client.post(
            reverse("draft_discard", args=[draft.pk]),
            {"revision": 1},
            HTTP_ACCEPT="application/json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertTrue(Draft.objects.filter(pk=draft.pk).exists())
        draft.refresh_from_db()
        response = self.client.post(
            reverse("draft_discard", args=[draft.pk]),
            {"revision": draft.revision},
            HTTP_ACCEPT="application/json",
        )
        self.assertEqual(response.json()["url"], reverse("drafts"))
        self.assertFalse(Draft.objects.filter(pk=draft.pk).exists())
        self.assertTrue(Submission.objects.filter(pk=self.paper.current_id).exists())

    def test_old_rebase_and_discard_cannot_overwrite_newer_save(self):
        draft = self.begin()
        self.save(draft, markdown="Keep this")
        response = self.client.post(reverse("draft_discard", args=[draft.pk]), {"revision": 1})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(Draft.objects.filter(pk=draft.pk).exists())
        self.assertEqual(
            self.client.post(
                reverse("draft_rebase", args=[draft.pk]),
                json.dumps({"revision": 1, "latest": str(self.paper.current_id)}),
                content_type="application/json",
            ).status_code,
            409,
        )

    def test_hidden_paper_blocks_draft_access(self):
        draft = self.begin()
        self.paper.is_hidden = True
        self.paper.save()
        self.assertEqual(self.client.get(reverse("editor", args=[draft.pk])).status_code, 404)
        self.assertEqual(self.save(draft).status_code, 404)
        self.assertNotContains(self.client.get(reverse("drafts")), self.paper.current.title)

    def test_multi_snapshot_pr_preserves_hashes_and_conversation(self):
        first = propose(
            self.owner,
            self.paper.pk,
            self.paper.current_id,
            document(markdown="First proposed text"),
        )
        original_hash = first.hash
        pr = first.pr_commit.request
        Comment.objects.create(submission=first, user=self.other, text="Please expand the proof.")
        response = self.client.post(reverse("edit_pr", args=[pr.pk]))
        draft = Draft.objects.get(pk=response.url.split("/")[2])
        self.assertEqual(draft.markdown, "First proposed text")
        self.save(
            draft,
            data={**draft.data, "explanation": "Expanded proof"},
            markdown="Second proposed text",
        )
        draft.refresh_from_db()
        token = self.reviewed(draft)
        self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": token, "license": "CC-BY-4.0", "rights_confirmed": "on"},
        )
        draft.refresh_from_db()
        pr.refresh_from_db()
        first.refresh_from_db()
        self.assertEqual(pr.head_id, draft.submitted_id)
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

    def test_only_contributor_can_append_and_expected_head_required(self):
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


@skipUnless(connection.vendor == "postgresql", "Concurrent draft and PR writes require PostgreSQL")
@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class DraftConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.owner = consenting_user("concurrent-writer", email_verified=True)
        self.paper = publish(self.owner, document())

    def test_concurrent_saves_keep_one_copy_and_return_conflict(self):
        clients = [Client(), Client()]
        for client in clients:
            client.force_login(self.owner)
        draft = Draft.objects.create(
            owner=self.owner, paper=self.paper, base=self.paper.current, data=document()
        )
        barrier = Barrier(2)

        def write(index):
            connections.close_all()
            try:
                barrier.wait(timeout=10)
                return (
                    clients[index]
                    .post(
                        reverse("draft_save", args=[draft.pk]),
                        json.dumps(
                            {"revision": 1, "data": document(), "markdown": f"copy {index}"}
                        ),
                        content_type="application/json",
                    )
                    .status_code
                )
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write, range(2)))
        self.assertEqual(sorted(results), [200, 409])
        draft.refresh_from_db()
        self.assertEqual(draft.revision, 2)

    def test_concurrent_pr_updates_cannot_fork_head(self):
        first = propose(self.owner, self.paper.pk, self.paper.current_id, document())
        pr = first.pr_commit.request
        barrier = Barrier(2)

        def append(index):
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
    def test_populated_history_is_grouped_without_rehashing(self):
        before = [("publishing", "0004_submission_subjects")]
        after = MigrationExecutor(connection).loader.graph.leaf_nodes("publishing")
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
