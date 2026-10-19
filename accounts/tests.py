import re
from django.core import mail, signing
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from django.urls import reverse
from .models import User


@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    SITE_URL="http://testserver",
)
class AccountTests(TestCase):
    def signup(self):
        return self.client.post(
            reverse("signup"),
            {
                "username": "researcher",
                "email": "person@example.org",
                "password1": "Strong-Test-Password-721",
                "password2": "Strong-Test-Password-721",
            },
        )

    def test_signup_and_email_verification(self):
        response = self.signup()
        self.assertRedirects(response, reverse("verification_needed"))
        user = User.objects.get(username="researcher")
        self.assertFalse(user.email_verified)
        self.assertEqual(len(mail.outbox), 1)
        link = re.search(r"http://testserver(/accounts/verify/\S+)", mail.outbox[0].body).group(1)
        self.assertEqual(self.client.get(link).status_code, 200)
        user.refresh_from_db()
        self.assertFalse(user.email_verified)  # Email scanners cannot verify an account.
        self.client.post(link)
        user.refresh_from_db()
        self.assertTrue(user.email_verified)

    def test_invalid_verification_link(self):
        self.assertEqual(
            self.client.get(reverse("verify_email", args=["invalid"])).status_code, 400
        )

    def test_verification_token_is_bound_to_email(self):
        user = User.objects.create_user("researcher", "old@example.org", "password")
        token = signing.dumps({"user": user.pk, "email": user.email}, salt="verify-email")
        user.email = "new@example.org"
        user.save()
        self.assertEqual(self.client.post(reverse("verify_email", args=[token])).status_code, 400)

    def test_login_with_username_and_email_case_insensitive(self):
        User.objects.create_user("Researcher", "person@example.org", "Strong-Test-Password-721")
        for name in ["researcher", "PERSON@example.org"]:
            self.client.logout()
            response = self.client.post(
                reverse("login"), {"username": name, "password": "Strong-Test-Password-721"}
            )
            self.assertEqual(response.status_code, 302)
            self.assertIn("_auth_user_id", self.client.session)

    def test_disabled_accounts_cannot_sign_in(self):
        User.objects.create_user("disabled", "disabled@example.org", "password", is_active=False)
        response = self.client.post(
            reverse("login"), {"username": "disabled", "password": "password"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_email_and_username_uniqueness_are_case_insensitive(self):
        User.objects.create_user("reader", "reader@example.org", "password")
        for username, email in [("READER", "other@example.org"), ("other", "READER@example.org")]:
            with self.assertRaises(IntegrityError), transaction.atomic():
                User.objects.create_user(username, email, "password")

    def test_username_cannot_overlap_email_identifier(self):
        response = self.client.post(
            reverse("signup"),
            {
                "username": "a@example.org",
                "email": "person@example.org",
                "password1": "Strong-Test-Password-721",
                "password2": "Strong-Test-Password-721",
            },
        )
        self.assertContains(response, "Use 3–30 letters")
        self.assertFalse(User.objects.exists())

    def test_login_rate_limit(self):
        for _ in range(20):
            self.client.post(reverse("login"), {"username": "nobody", "password": "wrong"})
        response = self.client.post(reverse("login"), {"username": "nobody", "password": "wrong"})
        self.assertEqual(response.status_code, 429)
        self.assertIn("Retry-After", response)

    def test_admin_login_rate_limit_and_staff_access(self):
        User.objects.create_superuser(
            "administrator", "admin@example.org", "Strong-Test-Password-721"
        )
        login_url = reverse("admin:login")
        for _ in range(10):
            self.client.post(login_url, {"username": "administrator", "password": "wrong"})
        response = self.client.post(
            login_url, {"username": "administrator", "password": "Strong-Test-Password-721"}
        )
        self.assertEqual(response.status_code, 429)
        self.assertNotIn("_auth_user_id", self.client.session)
        response = self.client.post(
            login_url,
            {"username": "administrator", "password": "Strong-Test-Password-721"},
            REMOTE_ADDR="192.0.2.2",
        )
        self.assertEqual(response.status_code, 302)
        self.assertRedirects(
            self.client.get(reverse("admin:index")),
            reverse("staff_mfa") + "?next=%2Fadmin%2F",
            fetch_redirect_response=False,
        )

    def test_reset_password_end_to_end_and_one_use(self):
        user = User.objects.create_user("reader", "reader@example.org", "Old-Password-789")
        self.client.post(reverse("password_reset"), {"email": "reader@example.org"})
        link = re.search(r"http://testserver(/accounts/reset/\S+)", mail.outbox[0].body).group(1)
        response = self.client.get(link)
        self.assertEqual(response.status_code, 302)
        confirmation_url = response.url
        response = self.client.post(
            confirmation_url,
            {"new_password1": "New-Password-987", "new_password2": "New-Password-987"},
        )
        self.assertRedirects(response, reverse("password_reset_complete"))
        user.refresh_from_db()
        self.assertTrue(user.check_password("New-Password-987"))
        self.assertContains(self.client.get(link), "This link has expired")

    def test_reset_unknown_account_same_public_response(self):
        response = self.client.post(reverse("password_reset"), {"email": "unknown@example.org"})
        self.assertRedirects(response, reverse("password_reset_done"))
        self.assertEqual(len(mail.outbox), 0)

    def test_safe_login_redirect(self):
        User.objects.create_user("reader", "reader@example.org", "password")
        response = self.client.post(
            reverse("login"),
            {"username": "reader", "password": "password", "next": "https://evil.example"},
        )
        self.assertEqual(response.url, "/")
