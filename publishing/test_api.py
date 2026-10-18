import json
import uuid
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
import threading
from unittest import skipUnless

from django.db import connection, connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from accounts.models import User
from accounts.tokens import issue_token
from .models import ApiPush, Paper, Submission
from .services import decide, propose, publish
from .tests import document


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class APITests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user("owner", "owner@example.org", "password", email_verified=True)
        self.other = User.objects.create_user("other", "other@example.org", "password", email_verified=True)
        self.paper = publish(self.owner, document())
        self.token, self.raw = issue_token(self.other, "Tests")
        self.data = {**document(markdown="# Updated\r\n"), "paper_id": str(self.paper.pk), "base_hash": self.paper.current.hash}

    def send(self, data=None, key=None, token=None, client=None):
        return (client or self.client).post("/api/v1/push/", data=json.dumps(data if data is not None else self.data), content_type="application/json",
                                          HTTP_AUTHORIZATION="Bearer " + (token or self.raw), HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()))

    def test_public_download_contains_verifiable_snapshot(self):
        record = self.client.get(f"/api/v1/papers/{self.paper.pk}/").json()["current"]
        self.assertEqual(record["hash"], self.paper.current.hash)
        self.assertEqual(record["markdown"], self.paper.current.markdown)
        self.assertEqual(record["manifest"], self.paper.current.manifest())

    def test_token_push_creates_pending_proposal_without_csrf_cookie(self):
        response = self.send(client=Client(enforce_csrf_checks=True))
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["status"], "pending")
        self.assertEqual(response.json()["markdown"], self.data["markdown"])
        self.paper.refresh_from_db()
        self.assertEqual(self.paper.current.hash, self.data["base_hash"])

    def test_session_cookie_does_not_authorize_api(self):
        self.client.force_login(self.owner)
        response = self.client.post("/api/v1/push/", self.data, content_type="application/json")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response["WWW-Authenticate"], "Bearer")

    def test_token_cannot_authenticate_website_or_accept_submissions(self):
        proposal = propose(self.other, self.paper.pk, self.paper.current_id, document(markdown="Changed"))
        response = self.client.post(f"/submissions/{proposal.pk}/decision/", {"action": "accepted"}, HTTP_AUTHORIZATION="Bearer " + self.raw)
        self.assertEqual(response.status_code, 302)
        self.assertIn("/accounts/login/", response.url)
        self.assertEqual(proposal.status, "pending")

    def test_proposal_token_cannot_publish_new_paper(self):
        self.data.update(paper_id=None, base_hash=None)
        self.assertEqual(self.send().status_code, 403)
        self.assertEqual(Paper.objects.count(), 1)

    def test_publish_scope_and_retry_create_exactly_one_new_paper(self):
        _, raw = issue_token(self.owner, "Publisher", can_publish=True)
        self.data.update(paper_id=None, base_hash=None)
        key = uuid.uuid4()
        first, second = self.send(key=key, token=raw), self.send(key=key, token=raw)
        self.assertEqual((first.status_code, second.status_code), (201, 200))
        self.assertEqual(first.json()["hash"], second.json()["hash"])
        self.assertEqual(Paper.objects.count(), 2)
        self.assertEqual(first.json()["status"], "accepted")

    def test_retry_survives_acceptance_and_changed_request_is_rejected(self):
        key = uuid.uuid4()
        first = self.send(key=key).json()
        decide(self.owner, first["manifest"]["submission_id"], "accepted")
        retry = self.send(key=key)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["hash"], first["hash"])
        self.assertEqual(retry.json()["status"], "accepted")
        self.data["markdown"] = "Another change"
        self.assertEqual(self.send(key=key).json()["error"]["code"], "idempotency_conflict")
        self.assertEqual(ApiPush.objects.count(), 1)

    def test_stale_base_rejected_without_any_new_record(self):
        proposal = propose(self.owner, self.paper.pk, self.paper.current_id, document(markdown="New base"))
        decide(self.owner, proposal.pk, "accepted")
        response = self.send()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "stale_base")
        self.assertEqual(Submission.objects.count(), 2)
        self.assertFalse(ApiPush.objects.exists())

    def test_shared_upload_validation_and_malformed_requests(self):
        for change in [{"markdown": "![image](https://example.org/a.png)"}, {"markdown": "\x00"}, {"markdown": "   "},
                       {"title": ""}, {"authors": []}, {"paper_id": "bad"}, {"base_hash": 123}, {"extra": "field"}]:
            with self.subTest(change=change):
                self.assertEqual(self.send({**self.data, **change}).status_code, 400)
        self.assertEqual(self.send({**self.data, "markdown": "x" * (1024 * 1024 + 1)}).status_code, 413)
        self.assertEqual(self.send({**self.data, "markdown": "\ud800"}).status_code, 400)
        self.assertEqual(Submission.objects.count(), 1)

    def test_revoked_expired_disabled_and_unverified_tokens_are_denied(self):
        for token_fields, user_fields in [({"revoked_at": timezone.now()}, {}), ({"expires_at": timezone.now() - timedelta(seconds=1)}, {}),
                                         ({}, {"is_active": False}), ({}, {"email_verified": False})]:
            token, raw = issue_token(self.other, "Restricted")
            for key, value in token_fields.items():
                setattr(token, key, value)
            token.save()
            for key, value in user_fields.items():
                setattr(self.other, key, value)
            self.other.save()
            self.assertEqual(self.send(token=raw).status_code, 401)
            self.other.is_active = self.other.email_verified = True
            self.other.save()

    def test_hidden_content_including_retry_is_unavailable(self):
        key = uuid.uuid4()
        result = self.send(key=key).json()
        self.paper.is_hidden = True
        self.paper.save()
        self.assertEqual(self.client.get(f"/api/v1/papers/{self.paper.pk}/").status_code, 404)
        self.assertEqual(self.client.get(result["url"].replace("/submissions/", "/api/v1/submissions/")).status_code, 404)
        self.assertEqual(self.send(key=key).status_code, 404)

    def test_auth_identity_has_no_secret_and_method_errors_are_json(self):
        response = self.client.get("/api/v1/me/", HTTP_AUTHORIZATION="Bearer " + self.raw)
        self.assertEqual(response.json()["scopes"], ["propose"])
        self.assertNotContains(response, self.raw)
        self.assertEqual(self.client.get("/api/v1/push/").status_code, 405)
        self.assertEqual(self.client.get("/api/v1/push/")["Allow"], "POST")

    def test_rate_limit_response_is_machine_readable(self):
        for _ in range(40):
            self.send({**self.data, "title": ""})
        result = self.send()
        self.assertEqual(result.status_code, 429)
        self.assertEqual(result.json()["error"]["code"], "rate_limited")


@skipUnless(connection.vendor == "postgresql", "Requires PostgreSQL row locks")
@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ConcurrentPushTests(TransactionTestCase):
    def test_concurrent_retries_create_one_submission(self):
        user = User.objects.create_user("owner", "owner@example.org", "password", email_verified=True)
        _, raw = issue_token(user, "Concurrent", can_publish=True)
        key = str(uuid.uuid4())
        data = {**document(), "paper_id": None, "base_hash": None}
        barrier = threading.Barrier(2)
        def send(_):
            try:
                barrier.wait(timeout=10)
                response = Client().post("/api/v1/push/", data, content_type="application/json", HTTP_AUTHORIZATION="Bearer " + raw, HTTP_IDEMPOTENCY_KEY=key)
                return response.status_code, response.json()["hash"]
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(send, range(2)))
        self.assertCountEqual([r[0] for r in results], [200, 201])
        self.assertEqual(results[0][1], results[1][1])
        self.assertEqual(Paper.objects.count(), 1)
        self.assertEqual(ApiPush.objects.count(), 1)
