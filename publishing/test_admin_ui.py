from publishing.test_support import consenting_user
from django.contrib.auth.models import Permission
from django.test import TestCase
from django.urls import reverse
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice
from .models import ModerationEvent
from .services import publish
from .tests import document


class AdministrationTests(TestCase):
    def setUp(self):
        self.owner = consenting_user("author", "author@example.org", email_verified=True)
        self.admin = consenting_user(
            "administrator", "admin@example.org", is_staff=True, is_superuser=True
        )
        self.paper = publish(self.owner, document())

    def verified_login(self, user):
        self.client.force_login(user)
        device = TOTPDevice.objects.create(user=user, name="Test authenticator")
        self.client.post(
            reverse("staff_mfa"), {"action": "verify", "code": f"{totp(device.bin_key):06d}"}
        )

    def test_dashboard_respects_model_permissions(self):
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(reverse("admin:index")).status_code, 302)
        staff = consenting_user("moderator", "moderator@example.org", is_staff=True)
        staff.user_permissions.add(
            Permission.objects.get(content_type__app_label="publishing", codename="view_review")
        )
        self.verified_login(staff)
        page = self.client.get(reverse("admin:index"))
        self.assertContains(page, "Paper reviews")
        self.assertNotContains(page, reverse("admin:accounts_user_changelist"))
        self.assertNotContains(page, reverse("admin:publishing_passagereport_changelist"))
        self.assertNotContains(page, reverse("admin:publishing_submission_changelist"))

    def test_dashboard_and_lists_render_with_immutable_snapshots(self):
        self.verified_login(self.admin)
        response = self.client.get(reverse("admin:index"))
        for heading in [
            "Moderation",
            "Accounts",
            "History",
            "Reported comments",
            "Your recent activity",
        ]:
            self.assertContains(response, heading)
        for model in [
            "paper",
            "review",
            "comment",
            "submission",
            "decision",
            "moderationevent",
            "passage",
            "passagecomment",
            "passagereport",
            "passagecommentrevision",
            "submissionsource",
        ]:
            self.assertEqual(
                self.client.get(reverse(f"admin:publishing_{model}_changelist")).status_code, 200
            )
        url = reverse("admin:publishing_submission_change", args=[self.paper.current_id])
        detail = self.client.get(url)
        self.assertContains(detail, self.paper.current.hash)
        self.assertNotContains(detail, 'name="_save"')
        self.assertEqual(self.client.post(url, {"title": "Overwrite"}).status_code, 403)
        self.paper.current.refresh_from_db()
        self.assertEqual(self.paper.current.title, "A test paper")

    def test_moderation_still_records_visibility_changes(self):
        self.verified_login(self.admin)
        url = reverse("admin:publishing_paper_changelist")
        original_hash = self.paper.current.hash
        response = self.client.post(
            url, {"action": "hide_selected", "_selected_action": [str(self.paper.pk)]}
        )
        self.assertEqual(response.status_code, 302)
        self.paper.refresh_from_db()
        self.assertTrue(self.paper.is_hidden)
        self.assertEqual(self.paper.current.hash, original_hash)
        self.assertEqual(ModerationEvent.objects.filter(actor=self.admin).count(), 1)
