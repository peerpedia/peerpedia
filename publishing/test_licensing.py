import io
import uuid
from unittest.mock import patch
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command, CommandError
from django.db import DatabaseError, transaction
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from accounts.models import User
from accounts.tokens import issue_token
from .licensing import VERSION, LICENSES, document_hash
from .models import AgreementAcceptance, Paper, PaperLicense, Submission, RightsRequest, Decision
from .services import publish, propose
from .tests import document
from .test_support import consenting_user


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class LicensingTests(TestCase):
    def setUp(self):
        self.owner = consenting_user("owner", "owner@example.org", "password", email_verified=True)
        self.new = User.objects.create_user(
            "new", "new@example.org", "password", email_verified=True
        )

    def accept(self, **data):
        self.client.force_login(self.new)
        return self.client.post(reverse("agreements"), {"version": VERSION, "agree": "on", **data})

    def test_acceptance_is_explicit_versioned_csrf_protected_and_browser_only(self):
        self.client.force_login(self.new)
        self.client.get(reverse("agreements"))
        self.assertFalse(AgreementAcceptance.objects.filter(user=self.new).exists())
        for data in ({"version": VERSION}, {"version": "old", "agree": "on"}):
            self.client.post(reverse("agreements"), data)
            self.assertFalse(AgreementAcceptance.objects.filter(user=self.new).exists())
        browser = Client(enforce_csrf_checks=True)
        browser.force_login(self.new)
        self.assertEqual(
            browser.post(reverse("agreements"), {"version": VERSION, "agree": "on"}).status_code,
            403,
        )
        _, token = issue_token(self.new, "Tool")
        anonymous = Client()
        self.assertEqual(
            anonymous.post(
                reverse("agreements"),
                {"version": VERSION, "agree": "on"},
                HTTP_AUTHORIZATION="Bearer " + token,
            ).status_code,
            302,
        )
        result = self.accept(next="https://attacker.example/")
        self.assertEqual(result.url, "/")
        self.accept()
        record = AgreementAcceptance.objects.get(user=self.new)
        self.assertEqual(record.document_hash, document_hash())
        with self.assertRaises(DatabaseError), transaction.atomic():
            AgreementAcceptance.objects.filter(pk=record.pk).update(version="forged")

    def test_all_choices_are_explicit_and_in_frozen_manifest(self):
        for code in LICENSES:
            paper = publish(self.owner, document(license=code))
            record = paper.current
            self.assertEqual(record.manifest()["license"], code)
            self.assertEqual(record.manifest()["agreement"]["version"], VERSION)
            self.assertEqual(record.licensing["code"], code)
            self.assertEqual(record.calculate_hash(), record.hash)
            proposal = propose(self.owner, paper.pk, record.pk, document(license=code))
            self.assertEqual(proposal.license_code, code)
        data = document()
        del data["license"]
        with self.assertRaisesMessage(ValidationError, "Choose a content license"):
            publish(self.owner, data)
        self.assertEqual(Paper.objects.count(), len(LICENSES))

    def test_license_cannot_be_changed_and_revision_can_inherit(self):
        paper = publish(self.owner, document())
        data = document()
        del data["license"]
        proposal = propose(self.owner, paper.pk, paper.current_id, data)
        self.assertEqual(proposal.license_code, "CC-BY-4.0")
        for code in ["CC0-1.0", "", [], None]:
            with self.assertRaises(ValidationError):
                propose(self.owner, paper.pk, paper.current_id, document(license=code))
        with self.assertRaises(DatabaseError), transaction.atomic():
            PaperLicense.objects.filter(paper=paper).update(license_code="CC0-1.0")
        with self.assertRaises(DatabaseError), transaction.atomic():
            Submission.objects.filter(pk=proposal.pk).update(license_code="CC0-1.0")

    def test_missing_or_new_agreement_blocks_service_and_api_without_fabricating_consent(self):
        with self.assertRaisesMessage(ValidationError, "website"):
            publish(self.new, document())
        _, token = issue_token(self.new, "Tool", can_publish=True)
        body = {**document(), "paper_id": None, "base_hash": None}
        reply = self.client.post(
            "/api/v1/push/",
            body,
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + token,
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
        self.assertEqual(reply.status_code, 403)
        self.assertEqual(reply.json()["error"]["code"], "agreement_required")
        self.assertFalse(AgreementAcceptance.objects.filter(user=self.new).exists())
        with patch("publishing.licensing.VERSION", "future"):
            with self.assertRaises(ValidationError):
                publish(self.owner, document())
        self.accept()
        reply = self.client.post(
            "/api/v1/push/",
            body,
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer " + token,
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
        self.assertEqual(reply.status_code, 201)

    def legacy(self, owner=None):
        owner = owner or self.owner
        paper = Paper.objects.create(owner=owner)
        data = document()
        del data["license"]
        record = Submission.objects.create(
            paper=paper, contributor=owner, contributor_name=owner.username, **data
        )
        Decision.objects.create(submission=record, actor=owner, action="accepted")
        paper.current = record
        paper.save()
        return paper

    def declare(self, confirm=True):
        call_command(
            "declare_legacy_license",
            owner=self.owner.username,
            license="CC-BY-4.0",
            authority="Owner's explicit instruction for existing papers and public PR permission.",
            confirm_owner_rights=confirm,
            stdout=io.StringIO(),
        )

    def test_legacy_declaration_is_scoped_dated_idempotent_and_never_rehashes(self):
        paper, other = self.legacy(), self.legacy(self.new)
        before = paper.current.manifest(), paper.current.hash
        self.assertIsNone(paper.current.licensing["code"])
        self.declare(confirm=False)
        self.assertFalse(PaperLicense.objects.exists())
        self.declare()
        self.declare()
        record = Submission.objects.get(pk=paper.current_id)
        self.assertEqual((record.manifest(), record.hash), before)
        self.assertEqual(record.licensing["code"], "CC-BY-4.0")
        self.assertIsNotNone(record.licensing["declaration"]["declared_at"])
        self.assertIsNone(other.current.licensing["code"])
        self.assertEqual(PaperLicense.objects.count(), 1)
        self.assertFalse(AgreementAcceptance.objects.filter(user=self.new).exists())
        self.client.get(reverse("manifest", args=[record.pk]))
        call_command("verify_history", stdout=io.StringIO())

    def test_legacy_grant_refuses_to_license_other_contributors(self):
        paper = self.legacy()
        data = document()
        del data["license"]
        Submission.objects.create(
            paper=paper,
            contributor=self.new,
            contributor_name=self.new.username,
            base=paper.current,
            **data,
        )
        with self.assertRaises(CommandError):
            self.declare()
        self.assertFalse(PaperLicense.objects.exists())

    def test_upload_confirmation_cannot_skip_rights_or_license(self):
        self.client.force_login(self.owner)
        data = document()
        data["file"] = SimpleUploadedFile("paper.md", data.pop("markdown").encode())
        response = self.client.post(reverse("publish"), data)
        token = response.context["token"]
        for additions in ({}, {"license": "CC-BY-4.0"}, {"rights_confirmed": "on"}):
            result = self.client.post(
                reverse("publish"), {"token": token, "action": "confirm", **additions}
            )
            self.assertEqual(result.status_code, 400)
            self.assertFalse(Paper.objects.exists())
        result = self.client.post(
            reverse("publish"),
            {
                "token": token,
                "action": "confirm",
                "license": "CC-BY-NC-ND-4.0",
                "rights_confirmed": "on",
            },
        )
        self.assertEqual(result.status_code, 302)
        paper = Paper.objects.get()
        self.assertEqual(paper.current.license_code, "CC-BY-NC-ND-4.0")
        downloaded = self.client.get(reverse("download", args=[paper.current_id]))
        self.assertEqual(downloaded["X-Content-License"], "CC-BY-NC-ND-4.0")
        self.assertIn('rel="license"', downloaded["Link"])
        self.assertEqual(downloaded.content, paper.current.markdown.encode())
        self.assertContains(self.client.get(reverse("paper", args=[paper.pk])), "CC BY-NC-ND 4.0")

    def test_editor_confirmation_cannot_skip_rights_or_license(self):
        from .models import Draft

        self.client.force_login(self.owner)
        draft = Draft.objects.create(
            owner=self.owner,
            data={k: v for k, v in document().items() if k not in {"license", "markdown"}},
            markdown="# Note",
        )
        response = self.client.post(
            reverse("draft_review", args=[draft.pk]), {"revision": draft.revision}
        )
        token = response.context["token"]
        self.client.post(reverse("draft_submit", args=[draft.pk]), {"token": token})
        self.assertFalse(Paper.objects.exists())
        self.client.post(
            reverse("draft_submit", args=[draft.pk]),
            {"token": token, "rights_confirmed": "on", "license": "CC0-1.0"},
        )
        self.assertEqual(Paper.objects.get().current.license_code, "CC0-1.0")

    def test_comments_require_agreement_but_are_not_cc_licensed(self):
        from .discussion_actions import create
        from .passages import blocks

        paper = publish(self.owner, document())
        self.client.force_login(self.new)
        result = self.client.post(
            reverse("review", args=[paper.pk]), {"score": 5, "text": "Review"}
        )
        self.assertEqual(result.status_code, 302)
        self.assertIn("/agreements/", result.url)
        block = blocks(paper.current.markdown)[0]
        with self.assertRaisesMessage(ValidationError, "agreement"):
            create(
                self.new,
                {
                    "spans": [{"block": block["id"], "start": 0, "end": 4}],
                    "score": 5,
                    "text": "Text",
                },
                paper.current_id,
            )
        self.assertContains(
            self.client.get(reverse("terms")),
            "No general Creative Commons license is assigned to comments",
        )

    def test_private_rights_requests_are_not_public_or_api_readable(self):
        result = self.client.post(
            reverse("rights_request"),
            {
                "name": "Rights holder",
                "email": "rights@example.org",
                "work_url": "https://peerpedia.dev/papers/example/",
                "details": "Private supporting evidence",
                "accurate": "on",
            },
        )
        self.assertEqual(result.status_code, 200)
        self.assertEqual(RightsRequest.objects.count(), 1)
        self.assertNotContains(
            self.client.get(reverse("rights_request")), "Private supporting evidence"
        )
        self.assertEqual(self.client.get("/api/v1/rights/").status_code, 404)
