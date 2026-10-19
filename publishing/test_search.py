"""Public discovery must never expose hidden documents or unaccepted text."""

from django.test import TestCase, override_settings
from .models import Paper, Review
from .services import publish, propose, decide
from .test_support import consenting_user
from .tests import document


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class SearchTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = consenting_user("owner", "owner@example.org", "password", email_verified=True)
        cls.reader = consenting_user(
            "reader", "reader@example.org", "password", email_verified=True
        )
        cls.paper = publish(
            cls.owner, document(title="Galois extensions", secondary_categories=["math.AG"])
        )

    def search(self, **params):
        response = self.client.get("/api/v1/papers/", params)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_title_author_subject_and_website_parity(self):
        for params in (
            {"q": "galois"},
            {"q": "Ada"},
            {"subject": "math.AG"},
            {"q": "Number Theory"},
        ):
            with self.subTest(params=params):
                rows = self.search(**params)["papers"]
                self.assertEqual([r["paper_id"] for r in rows], [str(self.paper.pk)])
                self.assertEqual(rows[0]["hash"], self.paper.current.hash)
                self.assertIsNone(rows[0]["average_rating"])
                self.assertEqual(rows[0]["rating_count"], 0)
                self.assertNotIn("markdown", rows[0])
                self.assertContains(self.client.get("/", params), "Galois extensions")
        self.assertEqual(self.search(q="unrelated")["papers"], [])

    def test_only_accepted_public_content_and_visible_ratings(self):
        pending = propose(
            self.reader,
            self.paper.pk,
            self.paper.current_id,
            document(title="Secret pending discovery"),
        )
        self.assertEqual(self.search(q="Secret pending")["papers"], [])
        Review.objects.create(paper=self.paper, user=self.owner, score=5, text="Useful")
        Review.objects.create(
            paper=self.paper, user=self.reader, score=1, text="Hidden", is_hidden=True
        )
        row = self.search()["papers"][0]
        self.assertEqual((row["average_rating"], row["rating_count"]), (5, 1))
        decide(self.owner, pending.pk, "accepted")
        self.assertEqual(len(self.search(q="Secret pending")["papers"]), 1)
        self.paper.is_hidden = True
        self.paper.save()
        self.assertEqual(self.search()["papers"], [])
        self.assertEqual(self.client.get(f"/api/v1/papers/{self.paper.pk}/prs/").status_code, 404)

    def test_pagination_sorting_invalid_filters_and_read_only(self):
        for i in range(26):
            publish(self.owner, document(title=f"Paper {i}"))
        Review.objects.create(paper=self.paper, user=self.owner, score=4, text="Useful")
        first = self.search(sort="rating")
        self.assertEqual(first["papers"][0]["paper_id"], str(self.paper.pk))
        self.assertEqual(len(first["papers"]), 25)
        second = self.search(sort="rating", offset=first["next"])
        self.assertEqual(len(second["papers"]), 2)
        self.assertIsNone(second["next"])
        ids = [r["paper_id"] for r in first["papers"] + second["papers"]]
        self.assertEqual(len(set(ids)), Paper.objects.count())
        for params in ({"q": "x" * 201}, {"subject": "unknown"}, {"sort": "bad"}):
            self.assertEqual(self.client.get("/api/v1/papers/", params).status_code, 400)
        self.assertEqual(self.client.post("/api/v1/papers/").status_code, 405)

    def test_pr_discovery_includes_pending_and_decided_conversations(self):
        pending = propose(
            self.reader, self.paper.pk, self.paper.current_id, document(markdown="Pending")
        )
        rejected = propose(
            self.owner, self.paper.pk, self.paper.current_id, document(markdown="Rejected")
        )
        decide(self.owner, rejected.pk, "rejected")
        response = self.client.get(f"/api/v1/papers/{self.paper.pk}/prs/")
        self.assertEqual(response.status_code, 200)
        rows = response.json()["prs"]
        self.assertEqual({r["status"] for r in rows}, {"pending", "rejected"})
        row = next(r for r in rows if r["head_id"] == str(pending.pk))
        self.assertEqual(row["contributor"], "reader")
        self.assertEqual(row["head_hash"], pending.hash)
        self.assertEqual(self.client.post(f"/api/v1/papers/{self.paper.pk}/prs/").status_code, 405)
