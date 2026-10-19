from publishing.test_support import consenting_user
import json
from urllib.parse import urlencode
from django.core.exceptions import ValidationError
from django.db import DatabaseError, transaction
from django.test import TestCase, override_settings
from django.urls import reverse
from . import sections
from .models import Draft, Submission, PullRequestCommit
from .services import publish, propose, decide
from .tests import document

SOURCE = "# Course\n\nIntro.\n\n## A\n\nAlpha.\n\n### Child\n\nProof.\n\n## B\n\nBeta.\n"


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class SectionTests(TestCase):
    def setUp(self):
        self.user = consenting_user("section-writer", email_verified=True)
        self.paper = publish(self.user, document(markdown=SOURCE))
        self.client.force_login(self.user)

    def start(self, anchor="section-a"):
        url = (
            reverse("edit_paper", args=[self.paper.pk])
            + "?"
            + urlencode({"scope": anchor, "version": self.paper.current_id})
        )
        response = self.client.post(url)
        return Draft.objects.get(pk=response.url.split("/")[2])

    def save(self, draft, source, **details):
        response = self.client.post(
            reverse("draft_save", args=[draft.pk]),
            json.dumps(
                {
                    "revision": draft.revision,
                    "data": {**draft.data, "explanation": "Improve the proof", **details},
                    "markdown": source,
                }
            ),
            content_type="application/json",
        )
        draft.refresh_from_db()
        return response

    def accept_elsewhere(self, source):
        submission = propose(
            self.user, self.paper.pk, self.paper.current_id, document(markdown=source)
        )
        decide(self.user, submission.pk, "accepted")
        self.paper.refresh_from_db()
        return submission

    def review(self, draft):
        return self.client.post(
            reverse("draft_review", args=[draft.pk]), {"revision": draft.revision}
        )

    def submit(self, draft, response):
        result = self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": response.context["token"], "license": "CC-BY-4.0", "rights_confirmed": "on"},
        )
        draft.refresh_from_db()
        return result

    def test_parser_boundaries_nested_fences_setext_and_duplicate_headings(self):
        found = sections.sections(SOURCE)
        self.assertEqual([s["anchor"] for s in found], ["section-a", "section-child", "section-b"])
        self.assertIn("### Child", sections.text(SOURCE, found[0]))
        self.assertNotIn("## B", sections.text(SOURCE, found[0]))
        tricky = "# T\n\nA\n---\n\n```\n## Not a section\n```\n\n> ## Quoted\n\n## A\n\nLast.\n"
        self.assertEqual(
            [s["anchor"] for s in sections.sections(tricky)], ["section-a", "section-a-2"]
        )
        unicode_source = SOURCE.replace("Intro.", "Intro.\u2028Still the same Markdown line.")
        self.assertTrue(
            sections.text(unicode_source, sections.sections(unicode_source)[0]).startswith("## A\n")
        )
        crlf = SOURCE.replace("\n", "\r\n")
        self.assertTrue(sections.text(crlf, sections.sections(crlf)[0]).startswith("## A\r\n"))

    def test_independent_parent_child_whole_drafts_and_resume(self):
        parent, child = self.start(), self.start("section-child")
        whole = self.client.post(reverse("edit_paper", args=[self.paper.pk]))
        self.assertEqual(Draft.objects.filter(submitted__isnull=True).count(), 3)
        self.assertEqual(self.start().pk, parent.pk)
        self.assertTrue(child.markdown.startswith("### Child"))
        self.assertNotIn("## B", parent.markdown)
        self.assertNotEqual(whole.url, reverse("editor", args=[parent.pk]))
        self.assertContains(
            self.client.get(reverse("editor", args=[parent.pk])), "Includes subsections"
        )
        self.assertNotContains(
            self.client.get(reverse("editor", args=[parent.pk])), 'name="authors"'
        )

    def test_section_metadata_cannot_change(self):
        draft = self.start()
        self.assertEqual(
            self.save(draft, draft.markdown, title="Unauthorized title").status_code, 400
        )
        self.assertEqual(draft.data["title"], self.paper.current.title)

    def test_complete_snapshot_preserves_neighbors_and_hash(self):
        draft = self.start()
        self.save(
            draft,
            draft.markdown.replace("Alpha.", "A stronger argument.").replace(
                "## A\n", "## Renamed\n"
            ),
        )
        response = self.review(draft)
        self.assertEqual(response.status_code, 200)
        self.submit(draft, response)
        expected = SOURCE.replace("Alpha.", "A stronger argument.").replace(
            "## A\n", "## Renamed\n"
        )
        self.assertEqual(draft.submitted.markdown, expected)
        self.assertEqual(draft.submitted.hash, draft.submitted.calculate_hash())
        self.assertEqual(draft.submitted.status, "pending")
        self.assertEqual(draft.submitted.pr_commit.section["anchor"], "section-a")
        self.assertEqual(self.paper.current.markdown, SOURCE)

    def test_review_preserves_unrelated_accepted_changes_and_metadata(self):
        draft = self.start()
        self.save(draft, draft.markdown.replace("Alpha.", "My edit."))
        latest = self.accept_elsewhere(SOURCE.replace("Beta.", "Their edit."))
        response = self.review(draft)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.context["refreshed"])
        draft.refresh_from_db()
        self.assertEqual(draft.base_id, latest.pk)
        self.submit(draft, response)
        self.assertIn("My edit.", draft.submitted.markdown)
        self.assertIn("Their edit.", draft.submitted.markdown)

    def test_child_change_conflicts_with_parent_and_explicit_rebase_preserves_draft(self):
        draft = self.start()
        self.save(draft, draft.markdown.replace("Alpha.", "My edit."))
        latest = self.accept_elsewhere(SOURCE.replace("Proof.", "Accepted child proof."))
        self.assertEqual(self.review(draft).status_code, 302)
        original = draft.markdown
        compare = self.client.get(reverse("draft_rebase", args=[draft.pk]))
        self.assertContains(compare, "Accepted child proof.")
        response = self.client.post(
            reverse("draft_rebase", args=[draft.pk]),
            json.dumps(
                {"revision": draft.revision, "latest": str(latest.pk), "target": "section-a"}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        self.assertEqual(draft.markdown, original)
        self.assertEqual(draft.base_id, latest.pk)

    def test_neighbor_acceptance_after_review_invalidates_submission(self):
        draft = self.start()
        self.save(draft, draft.markdown.replace("Alpha.", "My edit."))
        response = self.review(draft)
        self.accept_elsewhere(SOURCE.replace("Beta.", "Newer beta."))
        count = Submission.objects.count()
        self.submit(draft, response)
        self.assertIsNone(draft.submitted_id)
        self.assertEqual(Submission.objects.count(), count)

    def test_pr_refresh_adds_snapshot_and_keeps_prior_hash(self):
        draft = self.start()
        self.save(draft, draft.markdown.replace("Alpha.", "My edit."))
        self.submit(draft, self.review(draft))
        first = draft.submitted
        original_hash = first.hash
        latest = self.accept_elsewhere(SOURCE.replace("Beta.", "Accepted beta."))
        pr = first.pr_commit.request
        response = self.client.post(reverse("edit_pr", args=[pr.pk]))
        update = Draft.objects.get(pk=response.url.split("/")[2])
        self.assertTrue(update.section)
        self.assertIn("My edit.", update.markdown)
        self.save(update, update.markdown)
        self.submit(update, self.review(update))
        pr.refresh_from_db()
        first.refresh_from_db()
        self.assertEqual(pr.commits.count(), 2)
        self.assertEqual(first.hash, original_hash)
        self.assertEqual(pr.head.base_id, latest.pk)
        self.assertIn("Accepted beta.", pr.head.markdown)
        with self.assertRaises(ValidationError):
            decide(self.user, first.pk, "accepted")

    def test_stale_reader_link_cannot_select_a_different_section(self):
        old = self.paper.current_id
        self.accept_elsewhere(SOURCE.replace("## A", "## Renamed"))
        response = self.client.post(
            reverse("edit_paper", args=[self.paper.pk])
            + "?"
            + urlencode({"scope": "section-a", "version": old})
        )
        self.assertEqual(response.url, reverse("read_paper", args=[self.paper.pk]))
        self.assertFalse(Draft.objects.exists())

    def test_structure_escape_and_ambiguous_targets_require_review(self):
        section = sections.find(SOURCE, "section-a")
        for edit in ["## A\n\n```\nUnclosed", "## A\n\n## Extra sibling\n", "# New paper\n"]:
            with self.assertRaises(ValidationError):
                sections.combine(SOURCE, section, edit)
        duplicate = "# T\n\n## A\n\nSame.\n\n## A\n\nSame.\n\n"
        self.assertIsNone(sections.match(duplicate, sections.sections(duplicate)[0], duplicate))

    def test_section_membership_stays_immutable(self):
        draft = self.start()
        self.save(draft, draft.markdown)
        self.submit(draft, self.review(draft))
        with self.assertRaises(DatabaseError), transaction.atomic():
            PullRequestCommit.objects.filter(submission=draft.submitted).update(section={})
