from unittest.mock import patch
from datetime import datetime, timezone
from django.contrib import admin
from django.test import TestCase, Client, override_settings
from django.urls import reverse
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice
from django_otp.plugins.otp_static.models import StaticDevice, StaticToken
from .models import User, RateLimit

PASSWORD = "Administrator-Only-Test-782!"


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class SecurityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_superuser("admin-user", "admin@example.org", PASSWORD)
        self.url = reverse("staff_mfa")

    def code(self, device):
        return f"{totp(device.bin_key):06d}"

    def enroll(self):
        self.client.force_login(self.user)
        self.client.post(self.url, {"action": "start", "password": PASSWORD})
        device = TOTPDevice.objects.get(user=self.user, confirmed=False)
        self.enrollment_code = self.code(device)
        response = self.client.post(self.url, {"action": "confirm", "code": self.enrollment_code})
        self.assertEqual(response.status_code, 200)
        device.refresh_from_db()
        self.assertTrue(device.confirmed)
        return device, response.context["codes"]

    def test_staff_sessions_are_gated_and_ordinary_readers_are_not(self):
        self.client.force_login(self.user)
        for path in [reverse("admin:index"), reverse("access_tokens"), reverse("browse")]:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 302)
            self.assertTrue(response.url.startswith(self.url))
        reader = User.objects.create_user("reader", "reader@example.org")
        self.client.force_login(reader)
        self.assertEqual(self.client.get(reverse("browse")).status_code, 200)
        self.assertEqual(self.client.get(self.url).status_code, 403)

    def test_enrollment_requires_password_and_confirmation_and_codes_are_shown_once(self):
        self.client.force_login(self.user)
        self.client.post(self.url, {"action": "start", "password": "wrong"})
        self.assertFalse(TOTPDevice.objects.exists())
        device, codes = self.enroll()
        self.assertEqual(len(codes), 8)
        self.assertEqual(StaticToken.objects.count(), 8)
        self.assertEqual(self.client.get(reverse("admin:index")).status_code, 200)
        response = self.client.get(self.url)
        self.assertIsNone(response.context["codes"])
        self.assertNotContains(response, device.key)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertNotIn(device.key, str(self.client.session.items()))

    def test_totp_replay_and_open_redirect_are_rejected(self):
        device, _ = self.enroll()
        self.client.logout()
        self.client.force_login(self.user)
        # Replay the exact accepted code, even if the real clock changed steps.
        response = self.client.post(self.url, {"action": "verify", "code": self.enrollment_code})
        self.assertContains(response, "Invalid or recently used code")
        self.assertNotIn("otp_device_id", self.client.session)
        # Next time step, without real waiting or resetting the replay counter.
        timestamp = (device.last_t + 2) * device.step
        with (
            patch("django_otp.oath.time", return_value=timestamp),
            patch("django_otp.plugins.otp_totp.models.time.time", return_value=timestamp),
            patch(
                "django.utils.timezone.now",
                return_value=datetime.fromtimestamp(timestamp, timezone.utc),
            ),
        ):
            code = self.code(device)
            response = self.client.post(
                self.url, {"action": "verify", "code": code, "next": "https://evil.example"}
            )
        self.assertEqual(response.url, reverse("admin:index"))

    def test_recovery_code_is_single_use_and_can_replace_lost_authenticator(self):
        old, codes = self.enroll()
        self.client.logout()
        self.client.force_login(self.user)
        response = self.client.post(self.url, {"action": "verify", "code": codes[0]})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(StaticToken.objects.count(), 7)
        self.client.post(self.url, {"action": "start", "password": PASSWORD})
        new = TOTPDevice.objects.get(user=self.user, confirmed=False)
        response = self.client.post(self.url, {"action": "confirm", "code": self.code(new)})
        self.assertEqual(len(response.context["codes"]), 8)
        self.assertFalse(TOTPDevice.objects.filter(pk=old.pk).exists())
        self.assertFalse(StaticToken.objects.filter(token__in=codes).exists())
        self.client.logout()
        self.client.force_login(self.user)
        response = self.client.post(self.url, {"action": "verify", "code": codes[0]})
        self.assertContains(response, "Invalid or recently used code")

    def test_password_only_session_cannot_replace_or_read_existing_device(self):
        device, codes = self.enroll()
        self.client.logout()
        self.client.force_login(self.user)
        response = self.client.post(self.url, {"action": "start", "password": PASSWORD})
        self.assertContains(response, "Verify your existing authenticator")
        self.assertNotContains(response, device.key)
        self.assertNotContains(response, codes[0])
        self.assertFalse(TOTPDevice.objects.filter(confirmed=False).exists())
        self.client.post(self.url, {"action": "recovery", "password": PASSWORD})
        self.assertTrue(StaticToken.objects.filter(token=codes[0]).exists())

    def test_enrollment_expires_and_cannot_be_confirmed_from_another_session(self):
        self.client.force_login(self.user)
        self.client.post(self.url, {"action": "start", "password": PASSWORD})
        device = TOTPDevice.objects.get(user=self.user)
        other = Client()
        other.force_login(self.user)
        other.post(self.url, {"action": "confirm", "code": self.code(device)})
        device.refresh_from_db()
        self.assertFalse(device.confirmed)
        session = self.client.session
        session["mfa_enrollment"] = [device.pk, 0]
        session.save()
        self.client.post(self.url, {"action": "confirm", "code": self.code(device)})
        device.refresh_from_db()
        self.assertFalse(device.confirmed)

    def test_mfa_enforces_csrf_and_limits_guesses_across_addresses(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user)
        self.assertEqual(
            client.post(self.url, {"action": "start", "password": PASSWORD}).status_code, 403
        )
        self.client.force_login(self.user)
        for i in range(15):
            self.client.post(
                self.url, {"action": "start", "password": "wrong"}, REMOTE_ADDR=f"192.0.2.{i}"
            )
        self.assertEqual(
            self.client.post(
                self.url, {"action": "start", "password": PASSWORD}, REMOTE_ADDR="198.51.100.1"
            ).status_code,
            429,
        )

    def test_login_account_limit_survives_ip_route_and_identifier_changes(self):
        for i in range(20):
            url = reverse("login") if i % 2 else reverse("admin:login")
            username = "ADMIN@example.org" if i % 2 else "ADMIN-USER"
            self.client.post(
                url, {"username": username, "password": "wrong"}, REMOTE_ADDR=f"192.0.2.{i}"
            )
        response = self.client.post(
            reverse("login"),
            {"username": "admin-user", "password": PASSWORD},
            REMOTE_ADDR="198.51.100.1",
        )
        self.assertEqual(response.status_code, 429)
        self.assertNotIn("_auth_user_id", self.client.session)
        self.assertFalse(RateLimit.objects.filter(key__icontains="admin").exists())

    def test_mfa_secrets_are_not_exposed_in_admin(self):
        self.assertFalse(admin.site.is_registered(TOTPDevice))
        self.assertFalse(admin.site.is_registered(StaticDevice))

    def test_verification_expires_even_if_the_browser_session_is_extended(self):
        self.enroll()
        session = self.client.session
        session["staff_mfa_verified_at"] = 0
        session.set_expiry(86400)
        session.save()
        response = self.client.get(reverse("admin:index"))
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.url.startswith(self.url))
        self.assertNotIn("otp_device_id", self.client.session)

    def test_changing_the_password_does_not_remove_second_factor(self):
        device, _ = self.enroll()
        self.user.set_password("Replacement-Test-Password-983!")
        self.user.save()
        self.client.logout()
        self.client.post(
            reverse("login"),
            {"username": self.user.username, "password": "Replacement-Test-Password-983!"},
        )
        response = self.client.get(reverse("admin:index"))
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.url.startswith(self.url))
        self.assertTrue(TOTPDevice.objects.filter(pk=device.pk, confirmed=True).exists())
