from publishing.test_support import consenting_user
import json
from types import SimpleNamespace
from django.core.exceptions import ValidationError
from django.db import DatabaseError, transaction
from django.test import TestCase, Client, override_settings
from django.urls import reverse
from . import passages
from .models import Passage, PassageComment, PassageCommentRevision, PassageVote, PassageReport
from .rendering import render_reader
from .services import publish, propose, decide
from .tests import document

SOURCE = '# Notes\n\n## Claim\n\nA unique claim with 🌱 and $x^2$.\n\n## Proof\n\nThe proof is short.\n\n$$y=2$$\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n~~~python\nprint("ok")\n~~~\n'


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class DiscussionTests(TestCase):
    def setUp(self):
        self.owner = consenting_user("author", email="author@example.org", email_verified=True)
        self.other = consenting_user(
            "commenter", email="commenter@example.org", email_verified=True
        )
        self.third = consenting_user("reader", email="reader@example.org", email_verified=True)
        self.paper = publish(self.owner, document(markdown=SOURCE))
        self.base = self.paper.current
        block = next(b for b in passages.blocks(SOURCE) if b["text"].startswith("A unique"))
        self.spans = [{"block": block["id"], "start": 0, "end": len(block["text"])}]
        self.client.force_login(self.other)

    def post(self, name, pk, data, **kw):
        return self.client.post(
            reverse("passage_" + name, args=[pk]),
            json.dumps(data),
            content_type="application/json",
            **kw,
        )

    def create(self, submission=None, spans=None, score=4, text="Explain the claim."):
        response = self.post(
            "create",
            (submission or self.base).pk,
            {"spans": spans or self.spans, "score": score, "text": text},
        )
        self.assertEqual(response.status_code, 201, response.content)
        return PassageComment.objects.get(pk=response.json()["comment"])

    def detail(self, comment):
        return self.client.get(reverse("passage_detail", args=[comment.passage_id])).json()

    def test_canonical_unicode_math_table_and_rendering(self):
        found = passages.blocks(SOURCE)
        self.assertEqual([b["kind"] for b in found][-3:], ["equation", "table", "code"])
        chosen = passages.validate(SOURCE, self.spans)
        self.assertIn("🌱 and $x^2$", chosen[1])
        normalized = passages.validate(SOURCE, [{**self.spans[0], "ignored": "extra"}])
        self.assertEqual(chosen[2], normalized[2])
        html, _ = render_reader(SOURCE, passage_annotations=True, edit_url="/edit/?version=1")
        self.assertIn('data-passage-math="$x^2$"', html)
        self.assertIn('data-passage-kind="table"', html)
        self.assertIn('data-passage-kind="equation"', html)
        self.assertEqual(html.count('data-passage-kind="code"'), 1)
        breaks, _ = render_reader("First line.  \nSecond line.", passage_annotations=True)
        self.assertIn("First line.<br>Second line.", breaks)
        self.assertEqual(
            passages.blocks("First line.  \nSecond line.")[0]["text"], "First line.\nSecond line."
        )
        self.assertNotIn(
            "<script>", render_reader("<script>alert(1)</script>", passage_annotations=True)[0]
        )
        for b in found[-3:]:
            with self.assertRaises(ValidationError):
                passages.validate(SOURCE, [{"block": b["id"], "start": 1, "end": len(b["text"])}])
        for spans in [
            [],
            [{"block": "missing", "start": 0, "end": 1}],
            [{**self.spans[0], "start": True}],
        ]:
            with self.assertRaises(ValidationError):
                passages.validate(SOURCE, spans)

    def test_rating_requires_written_text_and_valid_score(self):
        for data in [
            {"score": 0, "text": "ok"},
            {"score": True, "text": "ok"},
            {"text": "ok"},
            {"score": 4, "text": "  "},
        ]:
            self.assertEqual(
                self.post("create", self.base.pk, {"spans": self.spans, **data}).status_code, 400
            )
        self.assertEqual(Passage.objects.count(), 0)
        c = self.create()
        self.assertEqual(self.detail(c)["average"], 4)
        self.assertEqual(
            self.post(
                "create", self.base.pk, {"spans": self.spans, "score": 5, "text": "duplicate"}
            ).status_code,
            409,
        )
        self.client.force_login(self.third)
        second = self.create(score=2)
        self.assertEqual(second.passage_id, c.passage_id)
        self.assertEqual(self.detail(c)["average"], 3)

    def test_browser_session_verified_csrf_and_no_token_writes(self):
        self.client.logout()
        data = {"spans": self.spans, "score": 4, "text": "hello"}
        self.assertEqual(self.post("create", self.base.pk, data).status_code, 403)
        self.client.force_login(self.other)
        self.assertEqual(
            self.post(
                "create", self.base.pk, data, HTTP_AUTHORIZATION="Bearer tool-token"
            ).status_code,
            403,
        )
        self.other.email_verified = False
        self.other.save()
        self.assertEqual(self.post("create", self.base.pk, data).status_code, 403)
        self.other.email_verified = True
        self.other.save()
        strict = Client(enforce_csrf_checks=True)
        strict.force_login(self.other)
        self.assertEqual(
            strict.post(
                reverse("passage_create", args=[self.base.pk]),
                json.dumps(data),
                content_type="application/json",
            ).status_code,
            403,
        )
        reader = strict.get(reverse("read_submission", args=[self.base.pk]))
        self.assertEqual(reader.status_code, 200)
        self.assertEqual(
            strict.post(
                reverse("passage_create", args=[self.base.pk]),
                json.dumps(data),
                content_type="application/json",
                HTTP_X_CSRFTOKEN=strict.cookies["csrftoken"].value,
            ).status_code,
            201,
        )

    def test_deep_replies_votes_toggle_and_preserved_edits(self):
        root = self.create()
        parent = root
        for i in range(12):
            response = self.post("reply", parent.pk, {"text": f"Reply {i}"})
            self.assertEqual(response.status_code, 201, response.content)
            parent = PassageComment.objects.get(pk=response.json()["comment"])
        self.assertEqual(parent.depth, 12)
        self.assertEqual(parent.root_id, root.pk)
        self.assertEqual(len(self.detail(root)["threads"][0]["replies"]), 12)
        for v in [1, 1, -1]:
            self.assertEqual(self.post("vote", root.pk, {"value": v}).status_code, 200)
            self.assertEqual(PassageVote.objects.count(), 1)
        self.assertEqual(
            self.post(
                "edit", root.pk, {"text": "Clarified", "score": 5, "revision": 1}
            ).status_code,
            200,
        )
        self.assertEqual(PassageVote.objects.get().value, -1)
        self.assertEqual(
            self.post("edit", root.pk, {"text": "stale", "score": 1, "revision": 1}).status_code,
            409,
        )
        history = self.client.get(reverse("passage_history", args=[root.pk])).json()["revisions"]
        self.assertEqual([r["text"] for r in history], ["Clarified", "Explain the claim."])
        self.assertEqual(self.post("vote", root.pk, {"value": 0}).status_code, 200)
        self.assertEqual(PassageVote.objects.count(), 0)
        self.client.force_login(self.owner)
        self.assertEqual(
            self.post(
                "edit", root.pk, {"text": "author override", "score": 1, "revision": 2}
            ).status_code,
            403,
        )
        self.assertEqual(self.post("resolve", root.pk, {"resolved": True}).status_code, 403)
        self.client.force_login(self.other)
        self.assertEqual(self.post("resolve", root.pk, {"resolved": True}).status_code, 200)
        self.assertEqual(self.detail(root)["threads"][0]["state"], "Resolved")
        self.assertEqual(self.post("resolve", root.pk, {"resolved": False}).status_code, 200)

    def test_soft_delete_and_hidden_comments_preserve_replies_not_ratings(self):
        root = self.create()
        self.post("reply", root.pk, {"text": "Survives deletion"})
        self.post("edit", root.pk, {"delete": True, "revision": 1})
        data = self.detail(root)
        self.assertEqual(data["ratings"], 0)
        self.assertIsNone(data["average"])
        self.assertEqual(data["threads"][0]["text"], "Comment deleted.")
        self.assertEqual(data["threads"][0]["replies"][0]["text"], "Survives deletion")
        self.assertEqual(
            self.client.get(reverse("passage_history", args=[root.pk])).status_code, 404
        )
        new = self.create()
        new.is_hidden = True
        new.save()
        data = self.detail(new)
        self.assertEqual(data["ratings"], 0)
        self.assertEqual(self.post("vote", new.pk, {"value": 1}).status_code, 404)
        self.assertEqual(
            self.client.get(reverse("passage_history", args=[new.pk])).status_code, 404
        )
        self.assertEqual(
            self.post(
                "create",
                self.base.pk,
                {"spans": self.spans, "score": 5, "text": "bypass moderation"},
            ).status_code,
            409,
        )
        self.assertEqual(
            self.post("reply", new.pk, {"text": "Reply to placeholder"}).status_code, 201
        )

    def test_frozen_anchors_history_database_protection(self):
        root = self.create()
        for model, pk, changes in [
            (Passage, root.passage_id, {"quote": "alter"}),
            (PassageCommentRevision, root.history.get().pk, {"text": "alter"}),
        ]:
            with self.assertRaises(DatabaseError), transaction.atomic():
                model.objects.filter(pk=pk).update(**changes)
            with self.assertRaises(DatabaseError), transaction.atomic():
                model.objects.filter(pk=pk)._raw_delete("default")

    def test_exact_ancestry_carry_forward_and_changed_historical(self):
        root = self.create()
        unchanged = propose(
            self.owner,
            self.paper.pk,
            self.base.pk,
            document(markdown=SOURCE.replace("The proof is short.", "An unrelated new proof.")),
        )
        decide(self.owner, unchanged.pk, "accepted")
        result = self.client.get(reverse("passage_index", args=[unchanged.pk])).json()["passages"][
            0
        ]
        self.assertEqual(result["state"], "current")
        self.assertEqual(result["average"], 4)
        self.client.force_login(self.third)
        next_comment = self.create(submission=unchanged)
        self.assertEqual(next_comment.passage_id, root.passage_id)
        changed = propose(
            self.owner,
            self.paper.pk,
            unchanged.pk,
            document(markdown=unchanged.markdown.replace("A unique claim", "A better claim")),
        )
        result = self.client.get(reverse("passage_index", args=[changed.pk])).json()["passages"][0]
        self.assertEqual(result["state"], "historical")
        self.assertIsNone(result["average"])
        self.assertEqual(result["ratings"], 0)
        self.assertIn("A unique claim", result["quote"])
        self.assertIn(str(self.base.pk), result["original_url"])
        duplicate = passages.blocks(SOURCE + "\n\nA unique claim with 🌱 and $x^2$.\n")
        self.assertNotEqual(passages.locate(root.passage, duplicate)[0], "current")

    def test_pr_snapshots_related_only_and_linked_fix_state(self):
        a = propose(self.other, self.paper.pk, self.base.pk, document(markdown=SOURCE + "\nOne.\n"))
        c = self.create(submission=a)
        unrelated = propose(
            self.owner, self.paper.pk, self.base.pk, document(markdown=SOURCE + "\nOther PR.\n")
        )
        self.assertEqual(
            self.client.get(reverse("passage_index", args=[unrelated.pk])).json()["passages"], []
        )
        b = propose(
            self.other,
            self.paper.pk,
            self.base.pk,
            document(markdown=SOURCE + "\nTwo.\n"),
            pull_request_id=a.pr_commit.request_id,
            expected_head=a.pk,
        )
        self.assertEqual(
            self.client.get(reverse("passage_index", args=[b.pk])).json()["passages"][0]["id"],
            str(c.passage_id),
        )
        self.assertEqual(
            self.post("link_pr", c.pk, {"pr": str(unrelated.pr_commit.request_id)}).status_code, 404
        )
        self.assertEqual(
            self.post("link_pr", c.pk, {"pr": str(a.pr_commit.request_id)}).status_code, 200
        )
        decide(self.owner, b.pk, "accepted")
        data = self.detail(c)
        self.assertEqual(data["threads"][0]["state"], "Change accepted — awaiting commenter review")
        c.refresh_from_db()
        self.assertFalse(c.resolved)
        page = self.client.get(reverse("pull_request", args=[a.pr_commit.request_id]))
        self.assertContains(page, "Passage discussions addressed")
        self.assertContains(page, "Awaiting commenter review")
        self.assertEqual(
            len(self.client.get(reverse("passage_index", args=[b.pk])).json()["passages"]), 1
        )

    def test_reports_and_hidden_paper_privacy(self):
        root = self.create()
        self.assertEqual(self.post("report", root.pk, {"reason": "Needs review"}).status_code, 200)
        self.post("report", root.pk, {"reason": "Updated explanation"})
        self.assertEqual(PassageReport.objects.count(), 1)
        self.assertNotIn("Updated explanation", str(self.detail(root)))
        from django.contrib.admin.sites import AdminSite
        from .admin import PassageReportAdmin

        admin = PassageReportAdmin(PassageReport, AdminSite())
        admin.hide_reported(SimpleNamespace(user=self.owner), PassageReport.objects.all())
        root.refresh_from_db()
        self.assertTrue(root.is_hidden)
        self.assertTrue(PassageReport.objects.get().reviewed)
        self.assertEqual(self.detail(root)["ratings"], 0)
        self.paper.is_hidden = True
        self.paper.save()
        for name, pk in [
            ("index", self.base.pk),
            ("detail", root.passage_id),
            ("history", root.pk),
        ]:
            self.assertEqual(
                self.client.get(reverse("passage_" + name, args=[pk])).status_code, 404
            )
        self.assertEqual(self.post("reply", root.pk, {"text": "hidden paper"}).status_code, 404)

    def test_pagination_and_ranking(self):
        root = self.create()
        self.client.force_login(self.third)
        self.create(score=1)
        self.post("vote", root.pk, {"value": 1})
        self.assertEqual(self.detail(root)["threads"][0]["id"], str(root.pk))
        for i in range(32):
            PassageComment.objects.create(
                passage=root.passage, user=self.owner, parent=root, root=root, depth=1, text=str(i)
            )
        first = self.detail(root)["threads"][0]
        self.assertEqual(len(first["replies"]), 30)
        self.assertEqual(first["next_replies"], 30)
        tail = self.client.get(reverse("passage_replies", args=[root.pk]) + "?offset=30").json()
        self.assertEqual(len(tail["replies"]), 2)
        self.assertIsNone(tail["next"])
