from io import StringIO
from unittest.mock import patch
from typing import Any
from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.db import connection
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from . import bananamark
from .artifacts import load
from .models import RenderedSubmission
from .references import ReferenceDocument
from .services import publish, propose
from .test_support import consenting_user
from .test_chapters import course


class DocumentRenderTests(SimpleTestCase):
    def test_reading_multiple_chapters_renders_book_once(self: "DocumentRenderTests") -> None:
        pages = [
            {"id": str(i), "title": str(i), "markdown": f"# Chapter {i}\n\n$x={i}$"}
            for i in range(7)
        ]
        with patch("publishing.references.request", wraps=bananamark.request) as render:
            book = ReferenceDocument(pages)
            for page in pages:
                self.assertIn("katex", book.render(page["id"])[0])
            self.assertEqual(render.call_count, 1)
            self.assertEqual(len(book.result["pages"]), 7)


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ReadingCopyTests(TestCase):
    def setUp(self):
        self.user = consenting_user("writer", "writer@example.org", "test", email_verified=True)
        self.paper = publish(self.user, course())

    def test_native_reading_copy_and_chapter_links_work_without_renderer(
        self: "ReadingCopyTests",
    ) -> None:
        snapshot = self.paper.current
        page = load(snapshot)["pages"][0]
        self.assertEqual(set(page), {"id", "title", "html", "headings"})
        self.assertNotIn("snapshot_links", page)
        with patch(
            "publishing.bananamark.request", side_effect=AssertionError("Unexpected render")
        ):
            response = self.client.get(snapshot.read_url)
            self.assertEqual(response.context["body"], page["html"])
            self.assertContains(response, 'href="?chapter=proof#eq:one"')
            self.assertContains(response, 'aria-label="Copy reference to Motivation"')
            self.assertContains(response, 'data-reference="@sec:motivation"')
            self.assertContains(
                response, f'data-reference-url="{snapshot.read_url}?chapter=intro#motivation"'
            )

    def test_explicit_refresh_reselects_a_cached_renderer_version(
        self: "ReadingCopyTests",
    ) -> None:
        snapshot = self.paper.current
        current = load(snapshot)
        archived = {**current, "warnings": ["Older build"]}
        RenderedSubmission.objects.create(
            submission=snapshot,
            source_hash=snapshot.hash,
            renderer_version="a" * 64,
            result=archived,
        )
        with patch(
            "publishing.bananamark.request", side_effect=AssertionError("Unexpected render")
        ):
            self.assertEqual(load(snapshot), archived)
            self.assertEqual(load(snapshot, refresh=True), current)
            self.assertEqual(load(snapshot), current)
        self.assertEqual(RenderedSubmission.objects.filter(submission=snapshot).count(), 2)

    def test_existing_snapshot_with_bound_links_keeps_its_frozen_body(
        self: "ReadingCopyTests",
    ) -> None:
        snapshot = self.paper.current
        artifact = RenderedSubmission.objects.get(submission=snapshot)
        page = artifact.result["pages"][0]
        page["html"] = (
            f'<p data-passage="b0"><a href="{snapshot.read_url}?chapter=proof#eq:one">Old proof</a></p>'
        )
        page["blocks"] = [{"id": "b0", "text": "Old proof", "chapter": "intro"}]
        artifact.save(update_fields=["result"])
        with patch(
            "publishing.bananamark.request", side_effect=AssertionError("Unexpected render")
        ):
            response = self.client.get(reverse("read_submission", args=[snapshot.pk]))
            self.assertContains(response, page["html"])
            self.assertEqual(response.context["body"], page["html"])

    def test_missing_copy_gets_retryable_response_during_outage(self):
        RenderedSubmission.objects.all().delete()
        with patch("publishing.bananamark._request", side_effect=ValidationError("Unavailable")):
            response = self.client.get(self.paper.current.read_url)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response["Retry-After"], "30")

    def test_backfill_is_idempotent_and_does_not_change_source(self):
        original = self.paper.current.hash
        RenderedSubmission.objects.all().delete()
        call_command("build_reading_copies", stdout=StringIO())
        with patch("publishing.bananamark._request", side_effect=AssertionError("Already built")):
            call_command("build_reading_copies", stdout=StringIO())
        self.assertEqual(RenderedSubmission.objects.count(), 1)
        self.paper.current.refresh_from_db()
        self.assertEqual(self.paper.current.hash, original)

    def legacy_snapshot(self):
        from .models import Submission
        from .tests import document

        data = document(markdown="# Historical heading {#old}\n\nOld test syntax.")
        data.pop("license", None)
        return Submission.objects.create(
            paper=self.paper, contributor=self.user, contributor_name=self.user.username, **data
        )

    def test_backfill_skips_unrenderable_history_without_rewriting_it(self):
        old = self.legacy_snapshot()
        original_hash = old.hash
        diagnostics = StringIO()
        call_command("build_reading_copies", stdout=StringIO(), stderr=diagnostics)
        self.assertIn("Skipped historical snapshot " + old.public_id, diagnostics.getvalue())
        old.refresh_from_db()
        self.assertEqual(old.hash, original_hash)
        self.assertFalse(RenderedSubmission.objects.filter(submission=old).exists())
        self.assertTrue(RenderedSubmission.objects.filter(submission=self.paper.current).exists())

    def test_backfill_requires_current_versions_and_does_not_hide_outages(self):
        from django.core.management.base import CommandError

        with patch(
            "publishing.management.commands.build_reading_copies.load",
            side_effect=ValidationError("Invalid", code="katex"),
        ):
            with self.assertRaises(CommandError):
                call_command("build_reading_copies", stdout=StringIO())
        self.legacy_snapshot()
        with patch(
            "publishing.bananamark._request", side_effect=ValidationError("Renderer unavailable")
        ):
            with self.assertRaises(CommandError):
                call_command("build_reading_copies", stdout=StringIO())

    def test_renderer_upgrade_keeps_existing_reading_copy_until_explicit_refresh(self):
        with patch("publishing.artifacts.renderer_version", return_value="f" * 64):
            with patch(
                "publishing.bananamark._request",
                side_effect=AssertionError("Read must not rebuild"),
            ):
                self.assertEqual(self.client.get(self.paper.current.read_url).status_code, 200)
            call_command("build_reading_copies", refresh=True, stdout=StringIO())
        self.assertEqual(RenderedSubmission.objects.count(), 2)


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class RenderTransactionTests(TransactionTestCase):
    def setUp(self):
        self.user = consenting_user("writer", "writer@example.org", "test", email_verified=True)
        self.client.force_login(self.user)
        self.paper = publish(self.user, course())

    def test_publication_and_proposal_render_outside_transactions(self):
        with patch("publishing.bananamark.request", wraps=bananamark.request) as render:
            # Capture the original function before patching to avoid recursion.
            original = render._mock_wraps

            def checked(**kwargs):
                self.assertFalse(connection.in_atomic_block)
                return original(**kwargs)

            render.side_effect = checked
            paper = publish(self.user, course())
            proposal = propose(self.user, paper.pk, paper.current_id, course(explanation="Improve"))
        self.assertTrue(RenderedSubmission.objects.filter(submission=proposal).exists())

    def test_api_push_renders_before_writes(self: "RenderTransactionTests") -> None:
        import uuid
        from accounts.tokens import issue_token
        from .tests import document

        original = bananamark._request

        def checked(payload: str, endpoint: str) -> dict[str, Any]:
            self.assertFalse(connection.in_atomic_block)
            return original(payload, endpoint)

        with patch("publishing.bananamark._request", side_effect=checked):
            _, raw = issue_token(self.user, "Architecture test", can_publish=True)
            response = self.client.post(
                "/api/v1/push/",
                {
                    **document(markdown="# API article\n\nContent."),
                    "paper_id": None,
                    "base_hash": None,
                },
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer " + raw,
                HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
            )
        self.assertEqual(response.status_code, 201)

    def test_changed_base_after_compilation_rejects_proposal(
        self: "RenderTransactionTests",
    ) -> None:
        from . import documents
        from .services import decide
        from .models import Submission

        base_id = self.paper.current_id
        competitor = propose(self.user, self.paper.pk, base_id, course(explanation="Other edit"))
        original = documents.prepare
        count = Submission.objects.count()

        def concurrent_acceptance(
            data: dict[str, Any], base: Submission
        ) -> documents.PreparedDocument:
            result = original(data, base)
            decide(self.user, competitor.pk, "accepted")
            return result

        with patch("publishing.services.prepare", side_effect=concurrent_acceptance):
            with self.assertRaisesMessage(ValidationError, "newer accepted version"):
                propose(self.user, self.paper.pk, base_id, course(explanation="Late edit"))
        self.assertEqual(Submission.objects.count(), count)
        self.assertEqual(RenderedSubmission.objects.count(), count)
