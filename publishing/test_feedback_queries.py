"""Protect feedback query costs and public/private response boundaries."""

from publishing.test_support import consenting_user

import json
from django.contrib.auth.models import AnonymousUser
from django.db import connection
from django.test import TestCase, RequestFactory
from django.test.utils import CaptureQueriesContext
from . import api, passages
from .feedback_queries import passage_index, passage_detail, comment_replies
from .models import Passage, PassageComment, PassageVote, PassagePRLink
from .services import publish, propose
from .tests import document


class FeedbackQueryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = consenting_user(
            "query-owner", email="query-owner@example.org", email_verified=True
        )
        source = "\n\n".join(f"Paragraph {i} makes a distinct claim." for i in range(100))
        cls.paper = publish(cls.owner, document(markdown=source))
        cls.anchors = []
        for block in passages.blocks(source):
            selected, quote, key = passages.validate(
                source, [{"block": block["id"], "start": 0, "end": len(block["text"])}]
            )
            cls.anchors.append(
                Passage.objects.create(
                    submission=cls.paper.current, spans=selected, quote=quote, key=key
                )
            )

    def test_hundred_passages_use_bounded_queries_and_preserve_statistics(self):
        PassageComment.objects.create(
            passage=self.anchors[0], user=self.owner, text="Visible", score=4
        )
        hidden_user = consenting_user("hidden-rater", email="hidden@example.org")
        PassageComment.objects.create(
            passage=self.anchors[0], user=hidden_user, text="Hidden", score=1, is_hidden=True
        )
        with CaptureQueriesContext(connection) as queries:
            result = passage_index(self.paper.current_id)
        self.assertLessEqual(len(queries), 5)
        self.assertEqual(len(result["passages"]), 100)
        self.assertIsNone(result["next"])
        self.assertEqual(result["passages"][0]["count"], 2)
        self.assertEqual(result["passages"][0]["ratings"], 1)
        self.assertEqual(result["passages"][0]["average"], 4)
        self.assertIsNone(result["passages"][1]["average"])

    def test_ranked_pages_replies_and_personal_votes_are_bounded(self):
        roots = []
        for i in range(25):
            user = consenting_user(f"rater-{i}", email=f"rater-{i}@example.org")
            roots.append(
                PassageComment.objects.create(
                    passage=self.anchors[0], user=user, text=f"Root {i}", score=3
                )
            )
        proposal = propose(self.owner, self.paper.pk, self.paper.current_id, document())
        PassagePRLink.objects.create(
            thread=roots[0], pull_request=proposal.pr_commit.request, user=self.owner
        )
        PassageVote.objects.create(comment=roots[0], user=self.owner, value=1)
        for i in range(100):
            child = PassageComment.objects.create(
                passage=self.anchors[0],
                user=self.owner,
                parent=roots[0],
                root=roots[0],
                depth=1,
                text=f"Reply {i}",
            )
            PassageVote.objects.create(comment=child, user=self.owner, value=-1)
        with CaptureQueriesContext(connection) as queries:
            first = passage_detail(self.anchors[0].pk, self.owner)
        self.assertLessEqual(len(queries), 7)
        self.assertEqual(len(first["threads"]), 10)
        self.assertEqual(first["threads"][0]["id"], str(roots[0].pk))
        self.assertEqual(first["threads"][0]["vote"], 1)
        self.assertEqual(first["threads"][0]["links"][0]["status"], "pending")
        self.assertEqual(len(first["threads"][0]["replies"]), 30)
        self.assertEqual(first["threads"][0]["next_replies"], 30)
        pages = (
            first["threads"]
            + passage_detail(self.anchors[0].pk, self.owner, 10)["threads"]
            + passage_detail(self.anchors[0].pk, self.owner, 20)["threads"]
        )
        self.assertEqual(len({row["id"] for row in pages}), 25)
        with CaptureQueriesContext(connection) as queries:
            replies = comment_replies(roots[0].pk, self.owner)
        self.assertLessEqual(len(queries), 2)
        self.assertEqual(len(replies["replies"]), 100)
        self.assertTrue(all(row["vote"] == -1 for row in replies["replies"]))
        public = passage_detail(self.anchors[0].pk, AnonymousUser())
        self.assertEqual(public["threads"][0]["vote"], 0)
        self.assertFalse(public["threads"][0]["can_edit"])

    def test_public_api_does_not_mutate_authenticated_request(self):
        request = RequestFactory().get("/")
        request.user = self.owner
        response = api.feedback(request, paper_id=self.paper.pk)
        self.assertEqual(response.status_code, 200)
        self.assertIs(request.user, self.owner)
        self.assertEqual(json.loads(response.content)["access"], "read-only")
