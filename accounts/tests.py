import re
import time
from unittest.mock import patch
from allauth.account.models import EmailAddress, EmailConfirmationHMAC
from django.core import mail, signing
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.http import HttpResponse
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from .models import User


@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    SITE_URL="http://testserver",
)
class AccountTests(TestCase):
    def signup(self: "AccountTests", target: str = "") -> HttpResponse:
        return self.client.post(
            reverse("signup"),
            {
                "next": target,
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

    def test_requested_upload_survives_signup_verification_and_agreement(
        self: "AccountTests",
    ) -> None:
        from publishing.licensing import VERSION

        target = reverse("publish")
        login_page = self.client.get(target, follow=True)
        self.assertContains(login_page, reverse("signup", query={"next": target}))
        signup_page = self.client.get(reverse("signup"), {"next": target})
        self.assertContains(signup_page, reverse("login", query={"next": target}))
        self.assertContains(signup_page, f'<input type="hidden" name="next" value="{target}">')
        self.assertRedirects(
            self.signup(target), reverse("verification_needed", query={"next": target})
        )
        link = re.search(r"http://testserver(/accounts/verify/\S+)", mail.outbox[0].body)[1]
        # Email may open in a different browser. Keep the requested action after signing in there.
        browser = Client()
        sign_in = browser.post(link)
        self.assertRedirects(sign_in, reverse("login", query={"next": target}))
        accepted = browser.post(
            sign_in.url,
            {"username": "researcher", "password": "Strong-Test-Password-721"},
            follow=True,
        )
        self.assertEqual(accepted.context["next"], target)
        self.assertRedirects(
            browser.post(
                reverse("agreements"), {"version": VERSION, "agree": "on", "next": target}
            ),
            target,
        )

    def test_verification_uses_pending_page_and_rejects_external_destination(
        self: "AccountTests",
    ) -> None:
        self.signup("//external.example/paper")
        link = re.search(r"http://testserver(/accounts/verify/\S+)", mail.outbox[0].body)[1]
        self.assertNotIn("external", link)
        target = reverse("access_tokens")
        self.client.get(target, follow=True)
        self.assertRedirects(self.client.post(link), target)

    def test_verification_resumes_the_most_recent_action_in_the_same_browser(
        self: "AccountTests",
    ) -> None:
        self.signup(reverse("browse"))
        link = re.search(r"http://testserver(/accounts/verify/\S+)", mail.outbox[0].body)[1]
        target = reverse("access_tokens")
        self.client.get(target, follow=True)
        self.assertRedirects(self.client.post(link), target)

    def test_old_signed_links_keep_the_original_24_hour_window(self: "AccountTests") -> None:
        user = User.objects.create_user("migrated", "migrated@example.org", "password")
        address = EmailAddress.objects.create(user=user, email=user.email, primary=True)
        payload = {"user": user.pk, "email": user.email}
        now = time.time()
        for age, expected_status in ((86401, 400), (86340, 302)):
            with patch("django.core.signing.time.time", return_value=now - age):
                token = signing.dumps(payload, salt="verify-email")
            link = reverse("verify_email", args=[token])
            if expected_status == 302:
                self.assertEqual(self.client.get(link).status_code, 200)
                self.assertFalse(user.email_verified)
            self.assertEqual(self.client.post(link).status_code, expected_status)
        address.refresh_from_db()
        self.assertTrue(address.verified)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_delivery_failure_leaves_signup_usable_for_resending(self: "AccountTests") -> None:
        with (
            patch(
                "allauth.account.adapter.DefaultAccountAdapter.send_confirmation_mail",
                side_effect=OSError,
            ),
            self.assertLogs("accounts.social", level="ERROR"),
        ):
            self.assertRedirects(self.signup(), reverse("verification_needed"))
        self.assertTrue(self.client.session["_auth_user_id"])
        self.assertFalse(User.objects.get().email_verified)
        self.assertFalse(mail.outbox)
        self.client.post(reverse("resend_verification"))
        self.assertEqual(len(mail.outbox), 1)

    def test_resend_and_confirmation_use_only_the_current_active_address(
        self: "AccountTests",
    ) -> None:
        self.signup()
        user = User.objects.get(username="researcher")
        self.assertIn("_auth_user_id", self.client.session)
        self.assertRedirects(self.client.get(reverse("publish")), reverse("verification_needed"))
        address = user.emailaddress_set.get()
        original = reverse("verify_email", args=[EmailConfirmationHMAC(address).key])
        user.email = "replacement@example.org"
        user.save(update_fields=["email"])
        self.assertEqual(self.client.post(original).status_code, 400)
        self.client.post(reverse("resend_verification"))
        self.assertEqual(mail.outbox[-1].to, [user.email])
        resent = re.search(r"http://testserver(/accounts/verify/\S+)", mail.outbox[-1].body)[1]
        user.is_active = False
        user.save(update_fields=["is_active"])
        self.assertEqual(self.client.post(resent).status_code, 400)
        user.is_active = True
        user.save(update_fields=["is_active"])
        self.assertEqual(self.client.post(resent).status_code, 302)
        self.assertTrue(user.email_verified)
        self.assertEqual(user.emailaddress_set.get(primary=True).email, user.email)
        self.assertEqual(self.client.post(resent).status_code, 400)

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

    def test_reset_password_end_to_end_and_one_use(self: "AccountTests") -> None:
        user = User.objects.create_user("reader", "reader@example.org", "Old-Password-789")
        target = reverse("inbox")
        self.client.post(reverse("password_reset", query={"next": target}), {"email": user.email})
        self.client = Client()
        link = re.search(r"http://testserver(/accounts/reset/\S+)", mail.outbox[0].body).group(1)
        response = self.client.get(link)
        self.assertEqual(response.status_code, 302)
        confirmation_url = response.url
        response = self.client.post(
            confirmation_url,
            {"new_password1": "New-Password-987", "new_password2": "New-Password-987"},
        )
        self.assertRedirects(response, reverse("password_reset_complete"))
        self.assertContains(self.client.get(response.url), reverse("login", query={"next": target}))
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


class VerificationMigrationTests(TransactionTestCase):
    def test_migration_preserves_publishing_rights_and_reuses_google_address(
        self: "VerificationMigrationTests",
    ) -> None:
        before = [
            ("accounts", "0002_accesstoken"),
            ("account", "0009_emailaddress_unique_primary_email"),
        ]
        executor = MigrationExecutor(connection)
        current = executor.loader.graph.leaf_nodes()
        executor.migrate(before)
        try:
            old = executor.loader.project_state(before).apps
            users = old.get_model("accounts", "User").objects
            addresses = old.get_model("account", "EmailAddress").objects
            local = users.create(username="local", email="Local@Example.org", email_verified=True)
            pending = users.create(username="pending", email="pending@example.org")
            google = users.create(
                username="google", email="google@example.org", email_verified=True
            )
            known = addresses.create(
                user=google, email="Google@example.org", primary=True, verified=True
            )
            token = signing.dumps({"user": pending.pk, "email": pending.email}, salt="verify-email")
            addresses.create(user=pending, email=local.email.lower(), primary=True, verified=True)
        finally:
            MigrationExecutor(connection).migrate(current)
        self.assertTrue(User.objects.get(pk=local.pk).email_verified)
        self.assertFalse(User.objects.get(pk=pending.pk).email_verified)
        self.assertEqual(EmailAddress.objects.get(user_id=google.pk).pk, known.pk)
        self.assertTrue(EmailAddress.objects.get(pk=known.pk).verified)
        self.assertFalse(EmailAddress.objects.get(user_id=pending.pk, primary=True).verified)
        self.assertEqual(EmailAddress.objects.get(pk=known.pk).email, google.email)
        link = reverse("verify_email", args=[token])
        self.assertEqual(self.client.get(link).status_code, 200)
        self.assertFalse(User.objects.get(pk=pending.pk).email_verified)
        self.assertEqual(self.client.post(link).status_code, 302)
        self.assertTrue(User.objects.get(pk=pending.pk).email_verified)
