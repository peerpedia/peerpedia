from publishing.test_support import consenting_user
import hashlib
import json
import uuid
from datetime import timedelta
from typing import Any
from django.db import DatabaseError, transaction
from django.http import HttpResponse
from django.test import TestCase, Client, override_settings
from django.urls import reverse
from django.utils import timezone
from django.utils.html import strip_tags
from accounts.tokens import issue_token
from .models import (
    ApiPush,
    Submission,
    SubmissionSource,
    Notification,
    Review,
)
from .services import publish, decide
from .notifications import notify
from .tests import document


@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class FeedbackTests(TestCase):
    def setUp(self: "FeedbackTests") -> None:
        self.owner = consenting_user("owner", "owner@example.org", email_verified=True)
        self.reader = consenting_user("reader", "reader@example.org", email_verified=True)
        self.third = consenting_user("third", "third@example.org", email_verified=True)
        self.paper = publish(self.owner, document())
        self.base = self.paper.current
        _, self.token = issue_token(self.third, "Tests")
        self.payload = {
            **document(markdown="# A clearer paper\n"),
            "paper_id": str(self.paper.pk),
            "base_hash": self.base.hash,
            "ai_assisted": True,
        }

    def push(
        self: "FeedbackTests", data: dict[str, Any] | None = None, key: uuid.UUID | None = None
    ) -> HttpResponse:
        return self.client.post(
            "/api/v1/push/",
            json.dumps(data or self.payload),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + self.token,
            HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
        )

    def test_retired_feedback_urls_return_404(self: "FeedbackTests") -> None:
        target = uuid.uuid4()
        for url in (
            f"/api/v1/papers/{self.paper.pk}/feedback/",
            f"/api/v1/submissions/{self.base.pk}/feedback/",
            f"/api/v1/passages/{target}/",
            f"/api/v1/discussion-comments/{target}/replies/",
            f"/api/v1/discussion-comments/{target}/history/",
        ):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 404)

    def test_public_read_only_reviews_and_hidden_content(self: "FeedbackTests") -> None:
        Review.objects.create(paper=self.paper, user=self.owner, score=4, text="Overall review.")
        Review.objects.create(
            paper=self.paper, user=self.reader, score=1, text="Hidden review.", is_hidden=True
        )
        url = f"/api/v1/papers/{self.paper.pk}/reviews/"
        result = self.client.get(url).json()
        self.assertEqual(result["summary"], {"average": 4, "count": 1})
        self.assertEqual([row["text"] for row in result["reviews"]], ["Overall review."])
        rejected = self.client.post(url, {}, HTTP_AUTHORIZATION="Bearer " + self.token)
        self.assertEqual(rejected.status_code, 405)
        self.assertEqual(rejected["Allow"], "GET")
        self.paper.is_hidden = True
        self.paper.save()
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_cli_snapshots_idempotency_attribution_and_acceptance(self: "FeedbackTests") -> None:
        key = uuid.uuid4()
        first = self.push(key=key)
        self.assertEqual(first.status_code, 201, first.content)
        self.assertEqual(self.push(key=key).json()["hash"], first.json()["hash"])
        record = first.json()
        pr = record["pull_request"]["id"]
        self.assertTrue(record["via_cli"])
        self.assertTrue(record["ai_assisted"])
        self.assertEqual(SubmissionSource.objects.count(), 1)
        source = SubmissionSource.objects.get()
        self.assertEqual(source.submission.calculate_hash(), record["hash"])
        with self.assertRaises(DatabaseError), transaction.atomic():
            SubmissionSource.objects.filter(pk=source.pk).update(ai_assisted=False)
        next_payload = {
            **self.payload,
            "pull_request_id": pr,
            "expected_head": record["hash"],
            "markdown": "# Another frozen snapshot\n",
        }
        second = self.push(next_payload)
        self.assertEqual(second.status_code, 201, second.content)
        self.assertEqual(second.json()["pull_request"], {"id": pr, "snapshot": 2})
        self.assertEqual(self.push(next_payload).status_code, 409)
        self.assertEqual(Submission.objects.count(), 3)
        self.assertEqual(SubmissionSource.objects.count(), 2)
        pr_info = self.client.get(f"/api/v1/prs/{pr}/").json()
        self.assertEqual(pr_info["head_hash"], second.json()["hash"])
        self.assertNotIn("discussion_ids", pr_info)
        self.assertEqual(len(pr_info["snapshots"]), 2)
        before = Notification.objects.get(user=self.owner, kind="proposal")
        self.assertEqual(before.count, 2)
        decide(self.owner, second.json()["manifest"]["submission_id"], "accepted")
        self.assertTrue(Notification.objects.filter(user=self.third, kind="decision").exists())
        # Retrying the old key after acceptance still returns the same frozen receipt.
        self.assertEqual(self.push(key=key).json()["hash"], record["hash"])

    def test_retired_links_and_invalid_flags_create_nothing(self: "FeedbackTests") -> None:
        for change in [
            {"discussion_ids": [str(uuid.uuid4())]},
            {"discussion_ids": ["invalid"]},
            {"ai_assisted": "yes"},
            {"expected_head": "0" * 64},
            {"discussion_ids": None},
        ]:
            response = self.push({**self.payload, **change})
            self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(Submission.objects.count(), 1)
        self.assertEqual(SubmissionSource.objects.count(), 0)
        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(self.push({**self.payload, "discussion_ids": []}).status_code, 201)

    def test_old_linked_push_can_recover_its_existing_receipt(self: "FeedbackTests") -> None:
        record = self.push().json()
        payload = {**self.payload, "discussion_ids": [str(uuid.uuid4())]}
        fingerprint = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
        receipt = ApiPush.objects.create(
            user=self.third,
            key=uuid.uuid4(),
            request_hash=fingerprint,
            submission_id=record["manifest"]["submission_id"],
        )
        retry = self.push(payload, key=receipt.key)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["hash"], record["hash"])
        self.assertEqual(Submission.objects.count(), 2)

    def test_notification_grouping_ownership_read_races_and_hidden_papers(
        self: "FeedbackTests",
    ) -> None:
        notify([self.reader.pk, self.owner.pk], self.owner, self.paper, "review")
        item = Notification.objects.get()
        self.assertEqual(item.user, self.reader)
        self.client.force_login(self.third)
        self.assertEqual(
            self.client.post(reverse("inbox_open", args=[item.pk]), {"revision": 1}).status_code,
            404,
        )
        self.client.force_login(self.reader)
        page = self.client.get(reverse("inbox"))
        self.assertContains(page, "Unread (1)")
        account = self.client.get(reverse("socialaccount_connections"))
        self.assertIn("Account, 1 unread", strip_tags(account.content.decode()))
        self.assertContains(account, 'aria-label="Inbox, 1 unread"')
        self.assertContains(account, reverse("access_tokens"))
        cutoff = page.context["seen_before"]
        notify([self.reader.pk], self.owner, self.paper, "review")
        self.client.post(reverse("inbox_open", args=[item.pk]), {"revision": 1})
        item.refresh_from_db()
        self.assertTrue(item.unread)
        self.assertEqual(item.count, 2)
        self.client.post(reverse("inbox_read"), {"seen_before": cutoff})
        item.refresh_from_db()
        self.assertTrue(item.unread)
        self.assertEqual(self.client.get(reverse("inbox_open", args=[item.pk])).status_code, 405)
        response = self.client.post(
            reverse("inbox_open", args=[item.pk]), {"revision": item.revision}
        )
        self.assertEqual(response.url, self.paper.get_absolute_url() + "#reviews")
        item.refresh_from_db()
        self.assertFalse(item.unread)
        notify([self.reader.pk], self.owner, self.paper, "review")
        item.refresh_from_db()
        self.assertEqual(item.count, 1)
        self.client.post(reverse("inbox_read"), {"seen_before": timezone.now().isoformat()})
        item.refresh_from_db()
        self.assertFalse(item.unread)
        self.assertEqual(
            self.client.post(
                reverse("inbox_read"),
                {"seen_before": (timezone.now() + timedelta(days=1)).isoformat()},
            ).status_code,
            400,
        )
        self.paper.is_hidden = True
        self.paper.save()
        self.assertNotContains(self.client.get(reverse("inbox")), "A test paper")
        self.assertEqual(self.client.get(reverse("inbox")).context["unread_notifications"], 0)

    def test_inbox_requires_session_and_csrf(self: "FeedbackTests") -> None:
        self.assertEqual(
            self.client.get(
                reverse("inbox"), HTTP_AUTHORIZATION="Bearer " + self.token
            ).status_code,
            302,
        )
        strict = Client(enforce_csrf_checks=True)
        strict.force_login(self.reader)
        self.assertEqual(
            strict.post(
                reverse("inbox_read"), {"seen_before": timezone.now().isoformat()}
            ).status_code,
            403,
        )
