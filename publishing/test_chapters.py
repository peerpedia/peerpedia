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
        "markdown": "# Introduction\n\n## Motivation {@sec:motivation}\n\nA unique passage about topology. See @eq:one and [@wen].\n",
    },
    {
        "id": "proof",
        "title": "A proof",
        "markdown": "# A proof\n\n::: theorem {@thm:one}\nEvery example has a proof.\n:::\n\n```math {@eq:one}\nx=1\n```\n",
    },
]
BIB = "wen:\n  type: book\n  title: Quantum Field Theory\n  author: Wen, Xiao-Gang\n  year: 2004\n  url: https://example.org/book\n"


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

    def test_published_titles_are_derived_and_old_snapshots_are_not_rewritten(self):
        value = course()
        value["chapters"][0].pop("title")
        value["chapters"][1]["title"] = "Wrong manually supplied title"
        paper = publish(self.user, value)
        self.assertEqual([p["title"] for p in paper.current.chapters], ["Introduction", "A proof"])
        before = paper.current.hash
        response = self.client.get(paper.current.read_url + "?chapter=proof")
        self.assertContains(response, 'class="section-edit chapter-edit ui-icon-button"')
        self.assertContains(response, "Copy reference to A proof")
        self.assertContains(response, "Paper details")
        paper.current.refresh_from_db()
        self.assertEqual(paper.current.hash, before)

    def test_upload_entry_points_use_the_same_editor(self):
        self.assertRedirects(
            self.client.get(reverse("publish")), reverse("write"), fetch_redirect_response=False
        )
        self.assertRedirects(
            self.client.get(reverse("propose", args=[self.paper.pk])),
            reverse("edit_paper", args=[self.paper.pk]),
            fetch_redirect_response=False,
        )

    def chapter_draft(self):
        response = self.client.post(
            reverse("edit_paper", args=[self.paper.pk])
            + f"?version={self.paper.current_id}&chapter=intro&scope=%40chapter"
        )
        return Draft.objects.get(pk=response.url.split("/")[2])

    def test_chapter_draft_is_independent_and_preview_excludes_other_chapters(self):
        whole = self.client.post(reverse("edit_paper", args=[self.paper.pk]))
        draft = self.chapter_draft()
        self.assertNotEqual(str(draft.pk), whole.url.split("/")[2])
        self.assertEqual(draft.section["kind"], "chapter")
        self.assertEqual(draft.scope_key, "intro:@chapter")
        self.assertEqual(draft.markdown, CHAPTERS[0]["markdown"])
        self.assertEqual(draft.chapters, [])
        self.assertEqual(self.chapter_draft().pk, draft.pk)
        response = self.client.post(
            reverse("draft_preview", args=[draft.pk]),
            json.dumps({"revision": draft.revision, "markdown": draft.markdown}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("A unique passage", response.json()["html"])
        self.assertNotIn("Every example has a proof.", response.json()["html"])
        self.assertIn("(2.1)", response.json()["html"])

    def test_chapter_pr_renames_heading_preserves_other_chapters_and_resumes(self):
        from .drafts import full_chapters

        draft = self.chapter_draft()
        draft.markdown = "# Renamed chapter\n\nNew introduction.\n\n## New section\n\nIts proof."
        draft.data["explanation"] = "Improve the chapter"
        draft.save()
        response = self.client.post(
            reverse("draft_review", args=[draft.pk]), {"revision": draft.revision}
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": response.context["token"], "rights_confirmed": True},
        )
        draft.refresh_from_db()
        self.assertIsNotNone(draft.submitted_id)
        submitted = draft.submitted
        self.assertEqual(submitted.chapters[0]["title"], "Renamed chapter")
        self.assertEqual(submitted.chapters[1], CHAPTERS[1])
        self.assertEqual(submitted.bibliography, BIB)
        pr = submitted.pr_commit.request
        self.client.post(reverse("edit_pr", args=[pr.pk]))
        resumed = Draft.objects.get(pull_request=pr, submitted__isnull=True)
        self.assertEqual(resumed.markdown, submitted.chapters[0]["markdown"])
        self.assertEqual(resumed.section["kind"], "chapter")
        self.assertEqual(full_chapters(resumed)[1], CHAPTERS[1])

    def test_chapter_refresh_preserves_unrelated_changes_and_blocks_same_chapter_changes(self):
        from .drafts import refresh_section, full_chapters

        draft = self.chapter_draft()
        other = course()
        other["chapters"][1]["markdown"] += "\nAnother author's improvement."
        other["markdown"] = combined(other["chapters"])
        updated = propose(self.user, self.paper.pk, self.paper.current_id, other)
        decide(self.user, updated.pk, "accepted")
        draft.refresh_from_db()
        self.assertTrue(refresh_section(draft))
        self.assertEqual(full_chapters(draft)[1], updated.chapters[1])
        draft.save()
        changed = course()
        changed["chapters"][0]["markdown"] += "\nA competing edit."
        changed["markdown"] = combined(changed["chapters"])
        update = propose(self.user, self.paper.pk, updated.pk, changed)
        decide(self.user, update.pk, "accepted")
        draft.refresh_from_db()
        with self.assertRaises(ValidationError):
            refresh_section(draft)
        response = self.client.get(reverse("draft_rebase", args=[draft.pk]))
        self.assertContains(response, "Review the latest chapter")
        self.assertEqual(len(response.context["choices"]), 1)
        self.assertEqual(response.context["target"]["kind"], "chapter")
        response = self.client.post(
            reverse("draft_rebase", args=[draft.pk]),
            json.dumps(
                {"revision": draft.revision, "latest": str(update.pk), "target": "@chapter"}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        draft.refresh_from_db()
        self.assertEqual(draft.section["end"], len(update.chapters[0]["markdown"]))

    def test_chapter_pr_rejects_tampering_with_other_content(self):
        from . import sections

        scope = {**sections.chapter(CHAPTERS[0]["markdown"]), "chapter": "intro"}
        for change in ("other", "bibliography", "order", "metadata"):
            value = course()
            if change == "other":
                value["chapters"][1]["markdown"] += "\nOutside edit."
            if change == "bibliography":
                value["bibliography"] = ""
            if change == "order":
                value["chapters"].reverse()
            if change == "metadata":
                value["title"] = "Changed title"
            value["markdown"] = combined(value["chapters"])
            with self.subTest(change=change), self.assertRaises(ValidationError):
                propose(self.user, self.paper.pk, self.paper.current_id, value, section=scope)

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
        self.assertContains(response, self.paper.current.read_url + "?chapter=proof#eq:one")
        self.assertContains(response, "Wen 2004")
        response = self.client.get(
            reverse("read_submission", args=[self.paper.current_id]) + "?chapter=proof"
        )
        self.assertContains(response, "(2.1)")
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
            + f"?version={self.paper.current_id}&chapter=intro&scope=motivation"
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
            + f"?version={self.paper.current_id}&chapter=intro&scope=motivation"
        )
        response = self.client.post(url)
        draft = Draft.objects.get(pk=response.url.split("/")[2])
        response = self.client.post(
            reverse("draft_preview", args=[draft.pk]),
            json.dumps({"revision": draft.revision, "markdown": draft.markdown}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("(2.1)", response.json()["html"])
        self.assertIn("Wen 2004", response.json()["html"])
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
                {"revision": draft.revision, "latest": str(proposed.pk), "target": "motivation"}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertIn("chapter was deleted", response.json()["error"])

    def test_section_rebase_preserves_new_bibliography(self):
        from .drafts import refresh_section

        response = self.client.post(
            reverse("edit_paper", args=[self.paper.pk])
            + f"?version={self.paper.current_id}&chapter=intro&scope=motivation"
        )
        draft = Draft.objects.get(pk=response.url.split("/")[2])
        data = course()
        data["bibliography"] += "\nnew:\n  type: book\n  title: A new book\n"
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
            self.assertEqual(archive.read("references.yaml").decode(), BIB)
            self.assertEqual(json.loads(archive.read("paper.json"))["chapters"][0]["id"], "intro")
        self.paper.is_hidden = True
        self.paper.save()
        self.assertEqual(
            self.client.get(
                reverse("reference_search") + f"?submission={self.paper.current_id}"
            ).status_code,
            404,
        )

    def test_download_verifier_reads_declared_bibliography_and_rejects_tampering(self):
        import io
        from pathlib import Path
        import subprocess
        import sys
        import tempfile
        import zipfile

        response = self.client.get(reverse("download", args=[self.paper.current_id]))
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        bibliography = json.loads(files["paper.json"])["bibliography"]
        verifier = Path(__file__).resolve().parents[1] / "scripts/verify_submission.py"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = root / "submission.json"
            manifest.write_bytes(files["submission.json"])
            source = root / "source.zip"
            for tampered in (False, True):
                with zipfile.ZipFile(source, "w") as archive:
                    for name, data in files.items():
                        archive.writestr(
                            name, data + b"\n" if tampered and name == bibliography else data
                        )
                result = subprocess.run(
                    [sys.executable, str(verifier), str(manifest), str(source)],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if tampered:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Bibliography does not match", result.stderr)
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(self.paper.current.hash, result.stdout)


class ReferenceTests(SimpleTestCase):
    def test_native_numbering_and_references(self):
        source = "$$a=1$$\n\n```math {@eq:one}\nb=2\n```\n\n::: theorem [Named] {@thm:one}\nA claim.\n:::\n\nSee @thm:one and @eq:one."
        r = ReferenceDocument([{"id": "main", "title": "One", "markdown": source}])
        body, _ = r.render("main")
        self.assertEqual(sum(t["kind"] == "equation" for t in r.targets), 1)
        self.assertIn('href="#thm:one"', body)
        self.assertIn("Theorem 1.1", body)

    def test_missing_labels_and_unsupported_bibliography_fields_block_rendering(self):
        for source, bibliography in [
            ("See @missing.", ""),
            ("Text.", "book:\n  type: book\n  title: Book\n  unknown: value"),
        ]:
            with self.assertRaises(ValidationError):
                ReferenceDocument(
                    [{"id": "main", "title": "One", "markdown": source}], bibliography
                ).render("main")
