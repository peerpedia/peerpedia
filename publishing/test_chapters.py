import copy
import json
from django.test import TestCase, SimpleTestCase, override_settings
from django.core.exceptions import ValidationError
from django.db import DatabaseError, transaction
from django.urls import reverse
from .test_support import consenting_user
from .tests import document
from .services import publish, propose, decide
from .models import Draft, Submission
from .documents import combined, digest
from .references import ReferenceDocument
from . import passages

CHAPTERS = [
    {
        "id": "intro",
        "title": "Introduction",
        "markdown": "# Introduction\n\n## Motivation {#sec:motivation}\n\nA unique passage about topology. See @eq:one and [@wen].\n",
    },
    {
        "id": "proof",
        "title": "A proof",
        "markdown": "# A proof\n\n::: theorem {#thm:one}\nEvery example has a proof.\n:::\n\n::: equation {#eq:one}\n$$\nx=1\n$$\n:::\n",
    },
]
BIB = "@book{wen, title={Quantum Field Theory}, author={Wen, Xiao-Gang}, year={2004}, url={https://example.org/book}, customfield={Keep this}}"


def course(**changes):
    return document(
        markdown=combined(CHAPTERS), chapters=copy.deepcopy(CHAPTERS), bibliography=BIB, **changes
    )


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ChapterTests(TestCase):
    def setUp(self):
        self.user = consenting_user(
            "coursewriter", "course@example.org", "test", email_verified=True
        )
        self.client.force_login(self.user)
        self.paper = publish(self.user, course())

    def test_hash_covers_order_titles_content_and_bibliography(self):
        s = self.paper.current
        self.assertEqual(s.manifest_version, 4)
        original = s.hash
        for field, value in [
            ("chapters", list(reversed(s.chapters))),
            ("bibliography", BIB + "\n"),
        ]:
            original_value = getattr(s, field)
            setattr(s, field, value)
            self.assertNotEqual(s.calculate_hash(), original)
            setattr(s, field, original_value)
        with self.assertRaises(DatabaseError), transaction.atomic():
            Submission.objects.filter(pk=s.pk).update(bibliography="changed")
        s.refresh_from_db()
        self.assertEqual(s.calculate_hash(), original)

    def test_old_client_cannot_drop_chapters(self):
        with self.assertRaisesMessage(ValidationError, "update the CLI"):
            propose(self.user, self.paper.pk, self.paper.current_id, document())

    def test_validation_rejects_duplicate_ids_and_bad_contents(self):
        for changed in [
            CHAPTERS + [CHAPTERS[0]],
            CHAPTERS + [{**CHAPTERS[0], "id": "INTRO"}],
            [{**CHAPTERS[0], "id": "../bad"}],
            [{**CHAPTERS[0], "markdown": "![x](x.png)"}],
        ]:
            data = course()
            data["chapters"] = changed
            with self.assertRaises(ValidationError):
                publish(self.user, data)

    def test_reader_is_one_chapter_and_links_are_frozen(self):
        response = self.client.get(reverse("read_paper", args=[self.paper.pk]))
        self.assertContains(response, "A unique passage")
        self.assertNotContains(response, "Every example has a proof.")
        self.assertContains(
            response, f"/submissions/{self.paper.current_id}/read/?chapter=proof#eq%3Aone"
        )
        self.assertContains(response, "Quantum Field Theory (Wen, 2004)")
        response = self.client.get(
            reverse("read_submission", args=[self.paper.current_id]) + "?chapter=proof"
        )
        self.assertContains(response, "Equation (2.1)")
        self.assertContains(response, "Theorem 2.1")
        self.assertEqual(
            self.client.get(
                reverse("read_paper", args=[self.paper.pk]) + "?chapter=deleted"
            ).status_code,
            404,
        )

    def test_draft_roundtrip_and_section_preserves_other_chapter(self):
        url = (
            reverse("edit_paper", args=[self.paper.pk])
            + f"?version={self.paper.current_id}&chapter=intro&scope=sec:motivation"
        )
        response = self.client.post(url)
        draft = Draft.objects.get(pk=response.url.split("/")[2])
        self.assertEqual(draft.section["chapter"], "intro")
        body = {
            "revision": draft.revision,
            "data": {**draft.data, "explanation": "Improve motivation"},
            "markdown": draft.markdown.replace("A unique passage", "An improved passage"),
        }
        response = self.client.post(
            reverse("draft_save", args=[draft.pk]),
            json.dumps(body),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        draft.refresh_from_db()
        response = self.client.post(
            reverse("draft_review", args=[draft.pk]), {"revision": draft.revision}
        )
        self.assertEqual(response.status_code, 200, response.content)
        response = self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": response.context["token"], "rights_confirmed": True},
        )
        draft.refresh_from_db()
        self.assertIsNotNone(draft.submitted_id, response.content)
        self.assertEqual(draft.submitted.chapters[1], CHAPTERS[1])
        self.assertIn("An improved passage", draft.submitted.chapters[0]["markdown"])
        self.assertEqual(draft.submitted.bibliography, BIB)

    def test_section_preview_resolves_whole_document_and_deleted_chapter_rebase(self):
        url = (
            reverse("edit_paper", args=[self.paper.pk])
            + f"?version={self.paper.current_id}&chapter=intro&scope=sec:motivation"
        )
        response = self.client.post(url)
        draft = Draft.objects.get(pk=response.url.split("/")[2])
        response = self.client.post(
            reverse("draft_preview", args=[draft.pk]),
            json.dumps({"revision": draft.revision, "markdown": draft.markdown}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("Equation (2.1)", response.json()["html"])
        self.assertIn("Quantum Field Theory (Wen, 2004)", response.json()["html"])
        self.assertEqual(response.json()["warnings"], [])
        target = next(t for t in response.json()["targets"] if t["label"] == "sec:motivation")
        self.assertEqual(target["line"], 1)
        replacement = course()
        replacement["chapters"] = replacement["chapters"][1:]
        replacement["markdown"] = combined(replacement["chapters"])
        proposed = propose(self.user, self.paper.pk, self.paper.current_id, replacement)
        decide(self.user, proposed.pk, "accepted")
        response = self.client.get(reverse("draft_rebase", args=[draft.pk]))
        self.assertRedirects(response, reverse("editor", args=[draft.pk]))
        response = self.client.post(
            reverse("draft_rebase", args=[draft.pk]),
            json.dumps(
                {"revision": draft.revision, "latest": str(proposed.pk), "target": "sec:motivation"}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertIn("chapter was deleted", response.json()["error"])

    def test_section_rebase_preserves_new_bibliography(self):
        from .drafts import refresh_section

        response = self.client.post(
            reverse("edit_paper", args=[self.paper.pk])
            + f"?version={self.paper.current_id}&chapter=intro&scope=sec:motivation"
        )
        draft = Draft.objects.get(pk=response.url.split("/")[2])
        data = course()
        data["bibliography"] += "\n@book{new, title={A new book}}"
        proposed = propose(self.user, self.paper.pk, self.paper.current_id, data)
        decide(self.user, proposed.pk, "accepted")
        draft.paper.refresh_from_db()
        self.assertTrue(refresh_section(draft))
        self.assertEqual(draft.bibliography, data["bibliography"])

    def test_progress_is_private_and_changed_chapter_keeps_old_hash(self):
        url = reverse("reading_progress", args=[self.paper.pk])
        response = self.client.post(
            url,
            json.dumps(
                {
                    "submission": str(self.paper.current_id),
                    "chapter": "intro",
                    "position": 0.4,
                    "complete": True,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["completed"]["intro"], digest(CHAPTERS[0]["markdown"]))
        other = consenting_user("reader2", "r@example.org", "test", email_verified=True)
        self.client.force_login(other)
        self.assertEqual(self.client.get(url).json()["completed"], {})
        self.assertEqual(
            self.client.post(
                url, "{}", content_type="application/json", HTTP_AUTHORIZATION="Bearer ignored"
            ).status_code,
            403,
        )
        self.client.logout()
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_reordered_chapters_move_comments_unambiguously(self):
        available = passages.blocks(self.paper.current)
        block = next(b for b in available if "unique passage" in b["text"])
        selected, quote, key = passages.validate(
            self.paper.current, [{"block": block["id"], "start": 0, "end": len(block["text"])}]
        )
        from types import SimpleNamespace

        revised = course()
        revised["chapters"].reverse()
        revised["markdown"] = combined(revised["chapters"])
        s = propose(self.user, self.paper.pk, self.paper.current_id, revised)
        state, spans = passages.locate(SimpleNamespace(spans=selected), passages.blocks(s))
        self.assertEqual(state, "current")
        target = next(b for b in passages.blocks(s) if b["id"] == spans[0]["block"])
        self.assertEqual(target["chapter"], "intro")

    def test_legacy_hash_survives_and_revision_can_add_chapters(self):
        old = publish(self.user, document()).current
        before = old.hash
        s = propose(self.user, old.paper_id, old.pk, course())
        decide(self.user, s.pk, "accepted")
        old.refresh_from_db()
        self.assertEqual(old.calculate_hash(), before)
        self.assertEqual(old.chapters, [])

    def test_zip_export_and_hidden_discovery(self):
        import io
        import zipfile

        response = self.client.get(reverse("download", args=[self.paper.current_id]))
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertEqual(archive.read("references.bib").decode(), BIB)
            self.assertEqual(json.loads(archive.read("paper.json"))["chapters"][0]["id"], "intro")
        self.paper.is_hidden = True
        self.paper.save()
        self.assertEqual(
            self.client.get(
                reverse("reference_search") + f"?submission={self.paper.current_id}"
            ).status_code,
            404,
        )


class ReferenceTests(SimpleTestCase):
    def test_reference_safety_and_unnumbered_equations(self):
        source = """# One

$$
a=1
$$

::: unnumbered
$$
b=2
$$
:::

::: theorem Named {#thm:one}
A claim.
:::

See @thm:one, @missing, [@evil, p. 5].

`@thm:one`
"""
        r = ReferenceDocument(
            [{"id": "main", "title": "One", "markdown": source}],
            "@misc{evil,title={<script>alert(1)</script>},url={javascript:alert(1)}}",
        )
        body, _ = r.render("main", passage_annotations=True)
        self.assertEqual(sum(t["kind"] == "equation" for t in r.targets), 1)
        self.assertIn('href="#thm:one"', body)
        self.assertNotIn('href="javascript:', body)
        self.assertNotIn("<script>", body)
        self.assertIn("<code>@thm:one</code>", body)
        self.assertIn("Unresolved reference @missing.", r.warnings)

    def test_bibtex_unknown_fields_and_types_remain(self):
        from .references import bibliography_entries

        entries, warnings = bibliography_entries("@dataset{data,title={Data},myfield={custom}}")
        self.assertEqual(entries["data"]["myfield"], "custom")
        self.assertEqual(warnings, [])
