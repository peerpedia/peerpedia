import copy
import json
from django.test import TestCase, SimpleTestCase, override_settings
from django.core.exceptions import ValidationError
from django.db import DatabaseError, transaction
from django.urls import reverse
from .test_support import consenting_user
from .tests import document
from .services import publish, propose, decide
from .models import Submission
from .documents import combined
from .references import ReferenceDocument

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

    def test_published_titles_are_derived_and_old_snapshots_are_not_rewritten(
        self: "ChapterTests",
    ) -> None:
        value = course()
        value["chapters"][0].pop("title")
        value["chapters"][1]["title"] = "Wrong manually supplied title"
        paper = publish(self.user, value)
        self.assertEqual([p["title"] for p in paper.current.chapters], ["Introduction", "A proof"])
        before = paper.current.hash
        response = self.client.get(paper.current.read_url + "?chapter=proof")
        self.assertContains(response, "Copy reference to A proof")
        self.assertContains(response, "Abstract &amp; reviews")
        paper.current.refresh_from_db()
        self.assertEqual(paper.current.hash, before)

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

    def test_reader_is_one_chapter_and_links_are_frozen(self: "ChapterTests") -> None:
        for name, key in [
            ("read_paper", self.paper.pk),
            ("read_paper_permalink", self.paper.public_id),
        ]:
            response = self.client.get(reverse(name, args=[key]), {"chapter": "intro"}, follow=True)
            self.assertEqual(
                response.redirect_chain, [(self.paper.current.read_url + "?chapter=intro", 302)]
            )
        self.assertContains(response, "A unique passage")
        self.assertNotContains(response, "Every example has a proof.")
        self.assertContains(response, 'href="?chapter=proof#eq:one"')
        self.assertContains(response, "Wen 2004")
        response = self.client.get(
            reverse("read_submission", args=[self.paper.current_id]) + "?chapter=proof"
        )
        self.assertContains(response, "(2.1)")
        self.assertContains(response, "Theorem 2.1")
        self.assertEqual(
            self.client.get(
                reverse("read_paper", args=[self.paper.pk]) + "?chapter=deleted", follow=True
            ).status_code,
            404,
        )

    def test_position_is_private_and_legacy_completion_flag_is_ignored(
        self: "ChapterTests",
    ) -> None:
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
        self.assertEqual(response.json(), {"chapter": "intro", "position": 0.4})
        self.assertEqual(self.client.get(url).json(), response.json())
        other = consenting_user("reader2", "r@example.org", "test", email_verified=True)
        self.client.force_login(other)
        self.assertEqual(self.client.get(url).json(), {"chapter": "", "position": 0})
        self.assertEqual(
            self.client.post(
                url, "{}", content_type="application/json", HTTP_AUTHORIZATION="Bearer ignored"
            ).status_code,
            403,
        )
        self.client.logout()
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_legacy_hash_survives_and_revision_can_add_chapters(self):
        old = publish(self.user, document()).current
        before = old.hash
        s = propose(self.user, old.paper_id, old.pk, course())
        decide(self.user, s.pk, "accepted")
        old.refresh_from_db()
        self.assertEqual(old.calculate_hash(), before)
        self.assertEqual(old.chapters, [])

    def test_zip_export_and_hidden_download(self: "ChapterTests") -> None:
        import io
        import zipfile

        response = self.client.get(reverse("download", args=[self.paper.current_id]))
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertEqual(archive.read("references.yaml").decode(), BIB)
            self.assertEqual(json.loads(archive.read("paper.json"))["chapters"][0]["id"], "intro")
        self.paper.is_hidden = True
        self.paper.save()
        self.assertEqual(
            self.client.get(reverse("download", args=[self.paper.current_id])).status_code,
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
