from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from django.db import DatabaseError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from django.urls import reverse

from .identifiers import assign
from .models import Decision, Paper
from .services import decide, propose, publish
from .test_support import consenting_user
from .tests import document


class PaperIdentifierTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = consenting_user(
            "identifiers", "identifiers@example.org", "password", email_verified=True
        )
        cls.paper = publish(cls.user, document())

    def test_first_publication_month_and_revision_stability(self):
        first = self.paper.current
        code = (
            first.decision.created_at.astimezone(timezone.utc).strftime("%y%m.") + first.hash[:12]
        )
        self.assertEqual(self.paper.public_id, code)
        proposal = propose(self.user, self.paper.pk, first.pk, document(markdown="A new version"))
        with patch.object(
            Decision._meta.get_field("created_at"),
            "_get_default",
            return_value=datetime(2031, 12, 1, tzinfo=timezone.utc),
        ):
            decide(self.user, proposal.pk, "accepted")
        self.paper.refresh_from_db()
        self.assertEqual(self.paper.public_id, code)
        self.assertEqual(first.calculate_hash(), first.hash)
        self.assertEqual(self.client.get(first.read_url).context["submission"].pk, first.pk)
        self.assertEqual(self.client.get(self.paper.read_url).context["submission"].pk, proposal.pk)
        self.assertNotIn("public_id", first.manifest())

    def test_public_and_legacy_urls_and_visibility(self):
        for url in [
            self.paper.get_absolute_url(),
            self.paper.read_url,
            self.paper.current.read_url,
            reverse("paper", args=[self.paper.pk]),
            reverse("read_paper", args=[self.paper.pk]),
            reverse("read_submission", args=[self.paper.current_id]),
        ]:
            self.assertEqual(self.client.get(url).status_code, 200, url)
        other = publish(self.user, document(title="Other"))
        mismatch = reverse("read_version", args=[other.public_id, self.paper.current_id])
        self.assertEqual(self.client.get(mismatch).status_code, 404)
        Paper.objects.filter(pk=self.paper.pk).update(is_hidden=True)
        for url in [
            self.paper.get_absolute_url(),
            self.paper.read_url,
            self.paper.current.read_url,
            f"/api/v1/papers/{self.paper.public_id}/",
        ]:
            self.assertEqual(self.client.get(url).status_code, 404)

    def test_api_search_and_generated_links(self):
        data = self.client.get(f"/api/v1/papers/{self.paper.public_id}/").json()
        self.assertEqual(data["paper_id"], str(self.paper.pk))
        self.assertEqual(data["paper_identifier"], self.paper.public_id)
        self.assertEqual(data["current"]["hash"], self.paper.current.hash)
        self.assertEqual(data["current"]["manifest"], self.paper.current.manifest())
        self.assertEqual(data["current"]["read_url"], self.paper.current.read_url)
        response = self.client.get("/", {"q": self.paper.public_id})
        self.assertContains(response, self.paper.get_absolute_url())
        self.assertContains(response, self.paper.read_url)
        self.assertContains(response, self.paper.public_id)
        self.assertEqual(
            len(self.client.get("/api/v1/papers/", {"q": self.paper.public_id}).json()["papers"]), 1
        )

    def test_number_cannot_be_changed_or_cleared(self):
        for value in ["2611.123456789abc", None]:
            with self.assertRaises(DatabaseError), transaction.atomic():
                Paper.objects.filter(pk=self.paper.pk).update(public_id=value)

    def test_collision_extends_hash_prefix(self):
        from types import SimpleNamespace

        collision = Paper.objects.create(owner=self.user)
        value = assign(
            collision,
            SimpleNamespace(hash=self.paper.current.hash),
            self.paper.current.decision.created_at,
        )
        self.assertEqual(value, self.paper.public_id[:5] + self.paper.current.hash[:14])
        self.assertNotEqual(value, self.paper.public_id)

    def test_month_is_utc(self):
        paper = Paper.objects.create(owner=self.user)
        value = assign(
            paper,
            self.paper.current,
            datetime(2031, 11, 1, 0, 30, tzinfo=timezone(timedelta(hours=8))),
        )
        self.assertTrue(value.startswith("3110."))


class IdentifierMigrationTests(TransactionTestCase):
    def test_backfill_uses_first_acceptance_without_rewriting_snapshots(self):
        user = consenting_user("migration-id", email_verified=True)
        with patch.object(
            Decision._meta.get_field("created_at"),
            "_get_default",
            return_value=datetime(2024, 3, 31, 23, 59, tzinfo=timezone.utc),
        ):
            paper = publish(user, document())
        first = paper.current
        later = propose(user, paper.pk, first.pk, document(markdown="Later version"))
        decide(user, later.pk, "accepted")
        original_hashes = {first.pk: first.hash, later.pk: later.hash}
        after = MigrationExecutor(connection).loader.graph.leaf_nodes("publishing")
        try:
            MigrationExecutor(connection).migrate(
                [("publishing", "0012_draft_bibliography_draft_chapters_and_more")]
            )
        finally:
            MigrationExecutor(connection).migrate(after)
        paper.refresh_from_db()
        self.assertEqual(paper.public_id, "2403." + first.hash[:12])
        self.assertEqual(paper.current_id, later.pk)
        for snapshot in paper.submissions.all():
            self.assertEqual(snapshot.hash, original_hashes[snapshot.pk])
            self.assertEqual(snapshot.calculate_hash(), snapshot.hash)
