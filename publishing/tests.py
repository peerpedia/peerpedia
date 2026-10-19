import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest import skipUnless
from django.core import signing
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DatabaseError, connection, connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from accounts.models import User
from .forms import UploadForm
from .models import Comment, Decision, ModerationEvent, Paper, Review, Submission
from .rendering import render_markdown, render_reader
from .services import decide, propose, publish
from .views import diff_lines


def document(**changes):
    data = {"primary_category": "math.NT", "secondary_categories": [], "title": "A test paper", "authors": "Ada Example\nBo Example", "abstract": "An abstract for testing.", "markdown": "# A test paper\n\nAn equation: $x^2$.\n", "explanation": "Initial publication."}
    data.update(changes)
    return data


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class PublishingTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user("owner", "owner@example.org", "a-test-password", email_verified=True)
        cls.other = User.objects.create_user("other", "other@example.org", "another-password", email_verified=True)
        cls.unverified = User.objects.create_user("newuser", "new@example.org", "another-password")
        cls.paper = publish(cls.owner, document())

    def login(self, user=None):
        self.client.force_login(user or self.owner)

    def proposal(self, **changes):
        return propose(self.other, self.paper.pk, self.paper.current_id, document(markdown="# Revised\n", explanation="Correct the proof.", **changes))

    def test_initial_publication_is_accepted(self):
        self.assertEqual(self.paper.owner, self.owner)
        self.assertEqual(self.paper.current.status, "accepted")
        self.assertEqual(self.paper.current.contributor, self.owner)
        self.assertEqual(self.paper.current.hash, self.paper.current.calculate_hash())

    def test_anonymous_can_read_every_public_view(self):
        s = self.proposal()
        for url in [reverse("browse"), reverse("paper", args=[self.paper.pk]), reverse("read_paper", args=[self.paper.pk]), reverse("submission", args=[s.pk]), reverse("read_submission", args=[s.pk]), reverse("download", args=[s.pk]), reverse("manifest", args=[s.pk]), reverse("compare", args=[self.paper.pk])]:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)

    def test_browse_has_no_abstract_and_separate_read_link(self):
        response = self.client.get(reverse("browse"))
        self.assertNotContains(response, self.paper.current.abstract)
        self.assertContains(response, reverse("paper", args=[self.paper.pk]))
        self.assertContains(response, reverse("read_paper", args=[self.paper.pk]))

    def test_reader_has_no_platform_chrome(self):
        response = self.client.get(reverse("read_paper", args=[self.paper.pk]))
        self.assertContains(response, '<h1 id="section-a-test-paper" data-passage="b0" data-passage-kind="text" data-passage-text="A test paper">A test paper</h1>', html=True)
        for forbidden in ["site-header", "site-footer", "Go back", "Sign in"]:
            self.assertNotContains(response, forbidden)

    def test_owner_only_acceptance(self):
        s = self.proposal()
        with self.assertRaises(PermissionDenied):
            decide(self.other, s.pk, "accepted")
        self.paper.refresh_from_db()
        self.assertNotEqual(self.paper.current_id, s.pk)
        decide(self.owner, s.pk, "accepted")
        self.paper.refresh_from_db()
        self.assertEqual(self.paper.current_id, s.pk)

    def test_owner_can_submit_and_accept_own_change(self):
        s = propose(self.owner, self.paper.pk, self.paper.current_id, document(markdown="A correction."))
        decide(self.owner, s.pk, "accepted")
        s.refresh_from_db()
        self.assertEqual(s.status, "accepted")

    def test_admin_has_no_acceptance_override(self):
        self.other.is_superuser = True
        self.other.save()
        with self.assertRaises(PermissionDenied):
            decide(self.other, self.proposal().pk, "accepted")

    def test_stale_proposal_cannot_be_accepted(self):
        first, second = self.proposal(), self.proposal()
        decide(self.owner, first.pk, "accepted")
        with self.assertRaises(ValidationError):
            decide(self.owner, second.pk, "accepted")
        self.assertFalse(Decision.objects.filter(submission=second).exists())
        self.assertEqual(self.client.get(reverse("submission", args=[second.pk])).status_code, 200)

    def test_cannot_submit_against_old_version(self):
        s = self.proposal()
        decide(self.owner, s.pk, "accepted")
        with self.assertRaises(ValidationError):
            self.proposal()

    def test_rejected_and_withdrawn_remain_public(self):
        for action in ["rejected", "withdrawn"]:
            s = self.proposal()
            decide(self.owner if action == "rejected" else self.other, s.pk, action)
            self.assertEqual(self.client.get(reverse("submission", args=[s.pk])).status_code, 200)
            self.assertEqual(self.client.get(reverse("download", args=[s.pk])).status_code, 200)
            with self.assertRaises(ValidationError):
                decide(self.owner, s.pk, "accepted")

    def test_only_contributor_can_withdraw(self):
        with self.assertRaises(PermissionDenied):
            decide(self.owner, self.proposal().pk, "withdrawn")

    def test_hash_and_metadata_stay_unchanged_after_acceptance(self):
        s = self.proposal()
        before = s.manifest()
        h = s.hash
        decide(self.owner, s.pk, "accepted")
        s.refresh_from_db()
        self.assertEqual(s.hash, h)
        self.assertEqual(s.manifest(), before)

    def test_model_blocks_snapshot_edits(self):
        s = self.proposal()
        s.title = "Replacement"
        with self.assertRaises(ValidationError):
            s.save()

    def test_database_blocks_snapshot_updates_and_deletion(self):
        s = self.proposal()
        for query in ["UPDATE publishing_submission SET title='tampered' WHERE id=%s", "DELETE FROM publishing_submission WHERE id=%s"]:
            with self.assertRaises(DatabaseError), transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(query, [s.pk.hex if connection.vendor == "sqlite" else s.pk])
        s.refresh_from_db()
        self.assertEqual(s.hash, s.calculate_hash())

    def test_database_blocks_decision_edits(self):
        with self.assertRaises(DatabaseError), transaction.atomic():
            Decision.objects.filter(submission=self.paper.current).update(action="rejected")

    def test_audit_records_are_immutable(self):
        event = ModerationEvent.objects.create(actor=self.owner, target="test", reason="Moderation")
        with self.assertRaises(DatabaseError), transaction.atomic():
            ModerationEvent.objects.filter(pk=event.pk).update(reason="changed")

    def test_snapshot_preserves_contributor_name(self):
        s = self.proposal()
        self.other.username = "renamed"
        self.other.save()
        s.refresh_from_db()
        self.assertEqual(s.contributor_name, "other")
        self.assertEqual(s.hash, s.calculate_hash())

    def test_download_and_manifest_can_be_verified_independently(self):
        raw = "# Café\r\n\r\n中文 $α$\r\n"
        s = propose(self.other, self.paper.pk, self.paper.current_id, document(markdown=raw))
        download = self.client.get(reverse("download", args=[s.pk]))
        record = self.client.get(reverse("manifest", args=[s.pk])).json()
        self.assertEqual(download.content, raw.encode())
        self.assertEqual(hashlib.sha256(download.content).hexdigest(), record["manifest"]["markdown_sha256"])
        digest = hashlib.sha256(json.dumps(record["manifest"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(digest, record["hash"])

    def test_review_requires_score_and_nonempty_text(self):
        self.login()
        url = reverse("review", args=[self.paper.pk])
        for data in [{"score": 4}, {"text": "Good"}, {"score": 6, "text": "Good"}, {"score": 4, "text": "  "}]:
            self.assertEqual(self.client.post(url, data).status_code, 400)
        self.assertEqual(Review.objects.count(), 0)

    def test_owner_review_and_edit_one_review(self):
        self.login()
        url = reverse("review", args=[self.paper.pk])
        self.client.post(url, {"score": 4, "text": "Useful argument."})
        original = Review.objects.get()
        self.client.post(url, {"score": 5, "text": "The correction improves it."})
        current = Review.objects.get()
        self.assertEqual(current.pk, original.pk)
        self.assertEqual(current.created_at, original.created_at)
        self.assertEqual(current.score, 5)
        self.assertContains(self.client.get(reverse("paper", args=[self.paper.pk])), "5.0")

    def test_reviews_sort_by_original_posting_time(self):
        a = Review.objects.create(paper=self.paper, user=self.owner, score=3, text="First")
        b = Review.objects.create(paper=self.paper, user=self.other, score=4, text="Second")
        a.text = "Edited first"
        a.save()
        response = self.client.get(reverse("paper", args=[self.paper.pk]))
        self.assertEqual(list(response.context["review_page"]), [b, a])

    def test_hidden_reviews_not_in_average_and_not_self_restorable(self):
        Review.objects.create(paper=self.paper, user=self.owner, score=1, text="Hidden", is_hidden=True)
        Review.objects.create(paper=self.paper, user=self.other, score=5, text="Visible")
        response = self.client.get(reverse("paper", args=[self.paper.pk]))
        self.assertEqual(response.context["stats"], {"average": 5.0, "count": 1})
        self.login()
        self.assertEqual(self.client.post(reverse("review", args=[self.paper.pk]), {"score": 4, "text": "Try to restore"}).status_code, 403)

    def test_comments_are_flat_and_escape_html(self):
        self.login(self.other)
        s = self.proposal()
        url = reverse("comment", args=[s.pk])
        self.assertEqual(self.client.post(url, {"text": " "}).status_code, 400)
        self.client.post(url, {"text": '<script>alert("x")</script>'})
        response = self.client.get(reverse("submission", args=[s.pk]))
        self.assertContains(response, "&lt;script&gt;")
        self.assertNotContains(response, '<script>alert("x")</script>')
        self.assertNotContains(response, "Reply")

    def test_unverified_accounts_cannot_participate(self):
        self.login(self.unverified)
        self.assertRedirects(self.client.get(reverse("publish")), reverse("verification_needed"))
        with self.assertRaises(PermissionDenied):
            publish(self.unverified, document())

    def test_hidden_papers_have_no_public_access(self):
        self.paper.is_hidden = True
        self.paper.save(update_fields=["is_hidden"])
        for name, pk in [("paper", self.paper.pk), ("read_paper", self.paper.pk), ("submission", self.paper.current_id), ("download", self.paper.current_id), ("manifest", self.paper.current_id)]:
            self.assertEqual(self.client.get(reverse(name, args=[pk])).status_code, 404)
        self.assertNotContains(self.client.get(reverse("browse")), self.paper.current.title)

    def test_search_by_author_and_content(self):
        for query in ["Ada", "equation", "abstract", "test paper"]:
            self.assertContains(self.client.get(reverse("browse"), {"q": query}), self.paper.current.title)
        self.assertNotContains(self.client.get(reverse("browse"), {"q": "not-a-match"}), self.paper.current.title)

    def test_rating_and_latest_sorting(self):
        newer = publish(self.other, document(title="New paper"))
        Review.objects.create(paper=self.paper, user=self.owner, score=5, text="Review")
        rated = self.client.get(reverse("browse"), {"sort": "rating"})
        recent = self.client.get(reverse("browse"), {"sort": "latest"})
        self.assertEqual(list(rated.context["page"])[0], self.paper)
        self.assertEqual(list(recent.context["page"])[0], newer)
        s = self.proposal()
        decide(self.owner, s.pk, "accepted")
        self.assertEqual(list(self.client.get(reverse("browse")).context["page"])[0], self.paper)

    def test_upload_preview_publish_and_idempotent_confirmation(self):
        self.login()
        count = Paper.objects.count()
        data = document()
        del data["markdown"]
        data["file"] = SimpleUploadedFile("paper.md", b"# Uploaded\n\nText\n")
        response = self.client.post(reverse("publish"), data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Paper.objects.count(), count)
        token = response.context["token"]
        confirm = self.client.post(reverse("publish"), {"action": "confirm", "token": token})
        self.assertEqual(confirm.status_code, 302)
        self.assertEqual(Paper.objects.count(), count + 1)
        self.client.post(reverse("publish"), {"action": "confirm", "token": token})
        self.assertEqual(Paper.objects.count(), count + 1)

    def test_preview_token_is_bound_to_user_and_cannot_be_modified(self):
        self.login()
        data = document()
        data["file"] = SimpleUploadedFile("paper.md", b"# Document")
        response = self.client.post(reverse("publish"), data)
        token = response.context["token"]
        self.login(self.other)
        self.assertEqual(self.client.post(reverse("publish"), {"action": "confirm", "token": token}).status_code, 400)
        self.login()
        self.assertEqual(self.client.post(reverse("publish"), {"action": "confirm", "token": token + "x"}).status_code, 400)

    def test_proposal_preview_becomes_stale_before_confirmation(self):
        self.login(self.other)
        data = document()
        data.update(base=str(self.paper.current_id), file=SimpleUploadedFile("change.md", b"# Changed"))
        url = reverse("propose", args=[self.paper.pk])
        response = self.client.post(url, data)
        self.assertEqual(response.status_code, 200)
        s = self.proposal()
        decide(self.owner, s.pk, "accepted")
        self.assertEqual(self.client.post(url, {"action": "confirm", "token": response.context["token"]}).status_code, 409)

    def test_images_invalid_files_and_empty_uploads_are_rejected(self):
        for filename, source in [("paper.pdf", b"%PDF"), ("paper.md", b"\xff"), ("paper.md", b"  "), ("paper.md", b"![figure](https://example.org/a.png)"), ("paper.md", b"![figure][f]\n\n[f]: https://example.org/a.png")]:
            form = UploadForm(document(), {"file": SimpleUploadedFile(filename, source)}, initial_publication=True)
            self.assertFalse(form.is_valid())
            self.assertIn("file", form.errors)

    def test_upload_limit(self):
        form = UploadForm(document(), {"file": SimpleUploadedFile("paper.md", b"x" * (1024 * 1024 + 1))}, initial_publication=True)
        self.assertFalse(form.is_valid())

    def test_rendering_does_not_execute_html_or_javascript_links(self):
        rendered = render_markdown('<script>alert(1)</script>\n\n<img src="http://bad">\n\n[bad](javascript:alert(1))\n\n![image](http://bad)')
        self.assertNotIn("<script>", rendered)
        self.assertNotIn("<img", rendered)
        self.assertNotIn('href="javascript:', rendered)
        self.assertIn("&lt;script&gt;", rendered)

    def test_reader_outline_unique_anchors_and_safe_labels(self):
        source = '# Title\n\n## A *proof*\n\n### Detail\n\n## A proof\n\n## A proof-2\n\n## <script>bad()</script>\n\n```md\n## Not a section\n```'
        body, contents = render_reader(source)
        self.assertEqual([item['id'] for item in contents[:4]], [
            'section-a-proof', 'section-detail', 'section-a-proof-2', 'section-a-proof-2-2',
        ])
        self.assertEqual([item['depth'] for item in contents[:3]], [0, 1, 0])
        self.assertEqual(len(contents), 5)
        self.assertNotIn('<script>', body)
        paper = publish(self.owner, document(markdown=source))
        response = self.client.get(reverse('read_paper', args=[paper.pk]))
        self.assertContains(response, 'aria-label="Table of contents"')
        self.assertNotContains(response, '<script>bad()')
        self.assertContains(response, '&lt;script&gt;bad()&lt;/script&gt;')
        self.assertContains(response, 'href="#section-a-proof-2-2"')
        paper.current.refresh_from_db()
        self.assertEqual(paper.current.markdown, source)
        self.assertEqual(paper.current.hash, paper.current.calculate_hash())

    def test_reader_without_section_headings_has_no_empty_sidebar(self):
        for source in ('Plain note.', '# Just a title\n\nA note.'):
            body, contents = render_reader(source)
            self.assertEqual(contents, [])
        _, contents = render_reader('## First section\n\n# Another top-level section')
        self.assertEqual(len(contents), 2)

    def test_equations_and_code_are_distinct(self):
        result = render_markdown("Inline $x^2$.\n\n$$\nx=1\n$$\n\n```python\nx = '$notmath$'\n```\n")
        self.assertIn('class="math inline"', result)
        self.assertIn('class="math block"', result)
        self.assertIn("$notmath$", result)

    def test_diff_includes_missing_newline_change(self):
        lines = diff_lines("same\n", "same")
        self.assertIn("-same", lines)
        self.assertIn("+same", lines)
        self.assertIn("\\ No newline at end of file", lines)

    def test_bracket_equations_are_supported_and_escaped(self):
        rendered = render_markdown(r"Inline \(x^2\)." + "\n\n\\[\nx^2\n\\]\n")
        self.assertIn('class="math inline"', rendered)
        self.assertIn('class="math block"', rendered)
        unsafe = render_markdown(r"\(<script>alert(1)</script>\)")
        self.assertNotIn("<script>", unsafe)
        self.assertIn("&lt;script&gt;", unsafe)

    def test_diff_page_escapes_source(self):
        s = propose(self.other, self.paper.pk, self.paper.current_id, document(markdown="<script>evil()</script>\n"))
        response = self.client.get(reverse("submission", args=[s.pk]))
        self.assertContains(response, "&lt;script&gt;")
        self.assertNotContains(response, "<script>evil()")

    def test_mutations_require_post(self):
        self.login()
        s = self.proposal()
        for name, pk in [("review", self.paper.pk), ("comment", s.pk), ("decision", s.pk)]:
            self.assertEqual(self.client.get(reverse(name, args=[pk])).status_code, 405)

    def test_csrf_required(self):
        from django.test import Client
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.owner)
        self.assertEqual(client.post(reverse("review", args=[self.paper.pk]), {"score": 5, "text": "Review"}).status_code, 403)


@skipUnless(connection.vendor == "postgresql", "Concurrency guarantee requires PostgreSQL")
@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ConcurrentAcceptanceTests(TransactionTestCase):
    def test_only_one_of_two_competing_proposals_can_be_accepted(self):
        owner = User.objects.create_user("owner", "owner@example.org", "a-test-password", email_verified=True)
        paper = publish(owner, document())
        proposals = [propose(owner, paper.pk, paper.current_id, document(markdown=f"Version {i}")) for i in range(2)]
        barrier = threading.Barrier(2)

        def accept(submission_id):
            try:
                user = User.objects.get(pk=owner.pk)
                barrier.wait(timeout=10)
                try:
                    decide(user, submission_id, "accepted")
                    return "accepted"
                except ValidationError:
                    return "stale"
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(accept, [s.pk for s in proposals]))
        self.assertCountEqual(outcomes, ["accepted", "stale"])
        paper.refresh_from_db()
        self.assertIn(paper.current_id, [s.pk for s in proposals])
        self.assertEqual(Decision.objects.filter(submission__in=proposals, action="accepted").count(), 1)
