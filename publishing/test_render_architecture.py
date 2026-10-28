from io import StringIO
from unittest.mock import patch
from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.db import connection
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from . import bananamark
from .artifacts import reader_links
from .models import RenderedSubmission, Draft
from .references import ReferenceDocument
from .services import publish, propose
from .test_support import consenting_user
from .test_chapters import course


class DocumentRenderTests(SimpleTestCase):
    def test_whole_review_renders_book_once(self):
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

    def test_link_binding_does_not_rewrite_code(self):
        html = '<code>href="?chapter=b"</code><a href="?chapter=b#thm:a">Theorem</a>'
        self.assertEqual(
            reader_links(html, "/snapshot/read/"),
            '<code>href="?chapter=b"</code><a href="/snapshot/read/?chapter=b#thm:a">Theorem</a>',
        )


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ReadingCopyTests(TestCase):
    def setUp(self):
        self.user = consenting_user("writer", "writer@example.org", "test", email_verified=True)
        self.paper = publish(self.user, course())

    def test_reading_references_and_passages_work_without_renderer(self):
        self.assertEqual(RenderedSubmission.objects.count(), 1)
        bananamark._request.cache_clear()
        with patch(
            "publishing.bananamark._request",
            side_effect=AssertionError("Renderer must not be called"),
        ):
            response = self.client.get(self.paper.current.read_url)
            self.assertContains(response, self.paper.current.read_url + "?chapter=proof#eq:one")
            self.assertContains(response, 'aria-label="Copy reference to Motivation"')
            self.assertContains(response, 'data-reference="@sec:motivation"')
            self.assertEqual(
                self.client.get(reverse("passage_index", args=[self.paper.current_id])).status_code,
                200,
            )
            refs = self.client.get(
                reverse("reference_search"), {"submission": self.paper.current_id}
            )
            self.assertEqual(refs.status_code, 200)
            self.assertTrue(
                all(
                    t["url"].startswith(self.paper.current.read_url) for t in refs.json()["targets"]
                )
            )

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

    def test_draft_review_and_submit_compile_before_lock_and_recheck_revision(self):
        response = self.client.post(reverse("edit_paper", args=[self.paper.pk]))
        draft = Draft.objects.get(pk=response.url.split("/")[2])
        draft.data["explanation"] = "Improve"
        draft.save(update_fields=["data"])
        original = bananamark.request

        def checked(**kwargs):
            self.assertFalse(connection.in_atomic_block)
            return original(**kwargs)

        with (
            patch("publishing.references.request", side_effect=checked),
            patch("publishing.bananamark.request", side_effect=checked),
        ):
            response = self.client.post(
                reverse("draft_review", args=[draft.pk]), {"revision": draft.revision}
            )
            self.assertEqual(response.status_code, 200)
            token = response.context["token"]

        original_revision = draft.revision

        # Simulate a save arriving while the submission is being compiled.
        def changed(**kwargs):
            self.assertFalse(connection.in_atomic_block)
            Draft.objects.filter(pk=draft.pk).update(revision=draft.revision + 1)
            return original(**kwargs)

        with patch("publishing.bananamark.request", side_effect=changed):
            response = self.client.post(
                reverse("draft_submit", args=[draft.pk]),
                {"token": token, "rights_confirmed": "on"},
            )
        draft.refresh_from_db()
        self.assertIsNone(draft.submitted_id)
        self.assertEqual(draft.revision, original_revision + 1)
        self.assertEqual(response.status_code, 302)

    def test_api_commit_and_section_proposal_do_not_compile_under_locks(self):
        import uuid
        from accounts.tokens import issue_token
        from . import sections
        from .tests import document

        source = "# Note\n\n## First\n\nOriginal.\n\n## Second\n\nUnchanged.\n"
        paper = publish(self.user, document(markdown=source))
        section = sections.sections(source)[0]
        revised = sections.combine(source, section, "## First\n\nCorrected.\n\n")
        original = bananamark._request

        def checked(*args):
            self.assertFalse(connection.in_atomic_block)
            return original(*args)

        with patch("publishing.bananamark._request", side_effect=checked):
            record = propose(
                self.user,
                paper.pk,
                paper.current_id,
                document(markdown=revised, explanation="Section correction"),
                section=section,
            )
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
        self.assertEqual(record.base_id, paper.current_id)
        self.assertEqual(response.status_code, 201)

    def test_changed_base_after_compilation_rejects_proposal(self):
        from . import documents
        from .services import decide
        from .models import Submission

        base_id = self.paper.current_id
        competitor = propose(self.user, self.paper.pk, base_id, course(explanation="Other edit"))
        original = documents.prepare
        count = Submission.objects.count()

        def concurrent_acceptance(*args, **kwargs):
            result = original(*args, **kwargs)
            decide(self.user, competitor.pk, "accepted")
            return result

        with patch("publishing.documents.prepare", side_effect=concurrent_acceptance):
            with self.assertRaisesMessage(ValidationError, "newer accepted version"):
                propose(self.user, self.paper.pk, base_id, course(explanation="Late edit"))
        self.assertEqual(Submission.objects.count(), count)
        self.assertEqual(RenderedSubmission.objects.count(), count)

    def test_full_paper_rebase_comparison_remains_available(self):
        from .services import decide

        response = self.client.post(reverse("edit_paper", args=[self.paper.pk]))
        draft = Draft.objects.get(pk=response.url.split("/")[2])
        proposal = propose(
            self.user,
            self.paper.pk,
            self.paper.current_id,
            course(explanation="New accepted version"),
        )
        decide(self.user, proposal.pk, "accepted")
        response = self.client.get(reverse("draft_rebase", args=[draft.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context["latest"].pk, proposal.pk)
