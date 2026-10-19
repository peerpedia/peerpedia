"""Exercise our actual callback and signup with only Google's HTTPS exchange mocked."""

import time
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import jwt
from django.contrib import admin
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from allauth.socialaccount.models import SocialAccount, SocialToken
from allauth.account.models import EmailAddress
from .models import User

PASSWORD = "Google-Test-Password-487!"
PROVIDERS = {
    "google": {
        "APP": {"client_id": "test-client", "secret": "test-secret", "key": ""},
        "SCOPE": ["openid", "email", "profile"],
        "OAUTH_PKCE_ENABLED": True,
    }
}


@override_settings(
    GOOGLE_LOGIN_ENABLED=True,
    SOCIALACCOUNT_PROVIDERS=PROVIDERS,
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class GoogleTests(TestCase):
    def start(self, **data):
        response = self.client.post(reverse("google_login"), data)
        self.assertEqual(response.status_code, 302)
        query = parse_qs(urlsplit(response.url).query)
        self.assertEqual(urlsplit(response.url).hostname, "accounts.google.com")
        return query

    def callback(self, state, email="reader@gmail.com", sub="google-reader", **claims):
        payload = {
            "sub": sub,
            "email": email,
            "email_verified": True,
            "iss": "https://accounts.google.com",
            "aud": "test-client",
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
            "picture": "https://example.com/tracking.png",
            **claims,
        }
        token = jwt.encode(
            payload, "test-only-signing-key-not-used-in-production-12345", algorithm="HS256"
        )
        with patch(
            "allauth.socialaccount.providers.oauth2.client.OAuth2Client.get_access_token",
            return_value={
                "access_token": "must-not-retain",
                "refresh_token": "must-not-retain-refresh",
                "id_token": token,
            },
        ) as exchange:
            response = self.client.get(
                reverse("google_callback"), {"code": "test-code", "state": state}
            )
        return response, exchange

    def test_new_user_selects_username_and_email_cannot_be_forged(self):
        query = self.start(next="/inbox/")
        self.assertEqual(set(query["scope"][0].split()), {"openid", "email", "profile"})
        self.assertEqual(query["code_challenge_method"], ["S256"])
        response, exchange = self.callback(query["state"][0])
        self.assertEqual(response.url, reverse("socialaccount_signup"))
        self.assertTrue(exchange.call_args.kwargs["pkce_code_verifier"])
        self.assertNotIn("must-not-retain", str(dict(self.client.session)))
        self.assertNotIn("tracking.png", str(dict(self.client.session)))
        response = self.client.get(response.url)
        self.assertContains(response, "Choose a username")
        response = self.client.post(
            reverse("socialaccount_signup"),
            {
                "username": "reader-one",
                "email": "victim@example.org",
            },
        )
        self.assertEqual(response.url, "/inbox/")
        user = User.objects.get(username="reader-one")
        self.assertEqual(user.email, "reader@gmail.com")
        self.assertTrue(user.email_verified)
        self.assertFalse(user.has_usable_password())
        self.assertFalse(user.is_staff)
        self.assertTrue(EmailAddress.objects.get(user=user).verified)
        self.assertFalse(SocialToken.objects.exists())
        self.assertEqual(int(self.client.session["_auth_user_id"]), user.pk)

    def test_email_collision_requires_explicit_link_not_automatic_login(self):
        existing = User.objects.create_user("reader", "Reader@gmail.com", PASSWORD)
        state = self.start()["state"][0]
        response, _ = self.callback(state)
        self.assertEqual(response.url, reverse("login"))
        self.assertNotIn("_auth_user_id", self.client.session)
        self.assertFalse(SocialAccount.objects.exists())
        self.assertEqual(User.objects.count(), 1)
        existing.refresh_from_db()
        self.assertFalse(existing.email_verified)

    def test_explicit_link_requires_password_matching_email_and_can_disconnect(self):
        user = User.objects.create_user("reader", "reader@gmail.com", PASSWORD)
        self.client.force_login(user)
        response = self.client.post(
            reverse("google_login"), {"process": "connect", "password": "wrong"}
        )
        self.assertEqual(response.url, reverse("socialaccount_connections"))
        self.assertNotIn("google_connect", self.client.session)
        state = self.start(process="connect", password=PASSWORD)["state"][0]
        response, _ = self.callback(state, email="different@gmail.com")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(SocialAccount.objects.exists())
        state = self.start(process="connect", password=PASSWORD)["state"][0]
        response, _ = self.callback(state)
        self.assertEqual(response.url, reverse("socialaccount_connections"))
        self.assertEqual(SocialAccount.objects.get().user_id, user.pk)
        self.client.post(reverse("socialaccount_connections"), {"password": "wrong"})
        self.assertTrue(SocialAccount.objects.exists())
        self.client.post(reverse("socialaccount_connections"), {"password": PASSWORD})
        self.assertFalse(SocialAccount.objects.exists())

    def test_existing_identity_login_preserves_user_and_rejects_inactive(self):
        user = User.objects.create_user("reader", "old@gmail.com", PASSWORD, email_verified=True)
        SocialAccount.objects.create(user=user, provider="google", uid="google-reader")
        response, _ = self.callback(self.start()["state"][0], email="new@gmail.com")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(int(self.client.session["_auth_user_id"]), user.pk)
        user.refresh_from_db()
        self.assertEqual(user.email, "old@gmail.com")
        self.client.logout()
        user.is_active = False
        user.save()
        response, _ = self.callback(self.start()["state"][0])
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_google_login_does_not_bypass_staff_mfa(self):
        user = User.objects.create_superuser("admin-reader", "reader@gmail.com", PASSWORD)
        SocialAccount.objects.create(user=user, provider="google", uid="google-reader")
        response, _ = self.callback(self.start()["state"][0])
        self.assertEqual(response.status_code, 302)
        self.assertNotIn("otp_device_id", self.client.session)
        response = self.client.get(reverse("admin:index"))
        self.assertTrue(response.url.startswith(reverse("staff_mfa")))
        self.assertFalse(admin.site.is_registered(SocialAccount))

    def test_wrong_state_replay_and_wrong_browser_are_rejected(self):
        state = self.start()["state"][0]
        response, exchange = self.callback("made-up-state")
        self.assertContains(response, "Sign-in could not be completed", status_code=401)
        exchange.assert_not_called()
        other = Client()
        response = other.get(reverse("google_callback"), {"code": "test", "state": state})
        self.assertContains(response, "Sign-in could not be completed", status_code=401)
        self.callback(state)
        response, exchange = self.callback(state)
        self.assertContains(response, "Sign-in could not be completed", status_code=401)
        exchange.assert_not_called()

    def test_invalid_token_claims_and_unverified_email_are_rejected(self):
        for claims in (
            {"aud": "other-client"},
            {"iss": "https://evil.example"},
            {"exp": 1},
            {"email_verified": False},
        ):
            response, _ = self.callback(self.start()["state"][0], **claims)
            self.assertNotEqual(response.status_code, 302)
            self.assertNotIn("socialaccount_sociallogin", self.client.session)
            self.assertNotIn("_auth_user_id", self.client.session)
        self.assertFalse(User.objects.exists())

    def test_csrf_post_only_disabled_configuration_and_minimal_routes(self):
        self.assertEqual(self.client.get(reverse("google_login")).status_code, 405)
        csrf = Client(enforce_csrf_checks=True)
        self.assertEqual(csrf.post(reverse("google_login")).status_code, 403)
        with override_settings(GOOGLE_LOGIN_ENABLED=False):
            self.assertNotContains(self.client.get(reverse("login")), "Continue with Google")
            self.assertEqual(self.client.post(reverse("google_login")).status_code, 503)
        for path in (
            "/accounts/google/login/token/",
            "/accounts/email/",
            "/accounts/password/reset/",
        ):
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_open_redirect_rejected_and_cancel_can_retry(self):
        query = self.start(next="https://evil.example/")
        response = self.client.get(
            reverse("google_callback"), {"state": query["state"][0], "error": "access_denied"}
        )
        self.assertEqual(response.url, reverse("socialaccount_login_cancelled"))
        self.assertContains(self.client.get(response.url), "Sign-in cancelled")
        self.callback(self.start(next="https://evil.example/")["state"][0])
        response = self.client.post(reverse("socialaccount_signup"), {"username": "safe-reader"})
        self.assertEqual(response.url, "/")

    def test_username_validation_and_signup_race_with_existing_email(self):
        self.callback(self.start()["state"][0])
        User.objects.create_user("TAKEN", "another@example.org", PASSWORD)
        response = self.client.post(reverse("socialaccount_signup"), {"username": "taken"})
        self.assertContains(response, "That username is already taken")
        User.objects.create_user("race-winner", "reader@gmail.com", PASSWORD)
        response = self.client.post(reverse("socialaccount_signup"), {"username": "new-reader"})
        self.assertContains(response, "An account already uses this email")
        self.assertFalse(SocialAccount.objects.exists())

    def test_google_only_account_cannot_disconnect_or_access_another_account(self):
        user = User.objects.create_user("reader", "reader@gmail.com")
        other = User.objects.create_user("other", "other@example.org", PASSWORD)
        SocialAccount.objects.create(user=user, provider="google", uid="google-reader")
        self.client.force_login(other)
        state = self.start(process="connect", password=PASSWORD)["state"][0]
        response, _ = self.callback(state, email=other.email)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(SocialAccount.objects.get().user_id, user.pk)
        self.client.force_login(user)
        self.client.post(reverse("socialaccount_connections"), {"password": PASSWORD})
        self.assertTrue(SocialAccount.objects.exists())

    def test_google_only_password_setup_requires_email_link(self):
        from django.core import mail
        from django.contrib.auth.tokens import default_token_generator
        from django.utils.encoding import force_bytes
        from django.utils.http import urlsafe_base64_encode

        user = User.objects.create_user("reader", "reader@gmail.com", email_verified=True)
        SocialAccount.objects.create(user=user, provider="google", uid="google-reader")
        response = self.client.post(reverse("password_reset"), {"email": user.email})
        self.assertEqual(response.url, reverse("password_reset_done"))
        self.assertEqual(len(mail.outbox), 1)
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())
        url = reverse(
            "password_reset_confirm",
            args=[
                urlsafe_base64_encode(force_bytes(user.pk)),
                default_token_generator.make_token(user),
            ],
        )
        response = self.client.get(url)
        self.assertEqual(response.status_code, 302)
        response = self.client.post(
            response.url, {"new_password1": PASSWORD, "new_password2": PASSWORD}
        )
        self.assertEqual(response.url, reverse("password_reset_complete"))
        user.refresh_from_db()
        self.assertTrue(user.check_password(PASSWORD))
        self.assertEqual(self.client.get(url).context["validlink"], False)
        self.client.force_login(user)
        self.client.post(reverse("socialaccount_connections"), {"password": PASSWORD})
        self.assertFalse(SocialAccount.objects.exists())

    def test_unverified_unusable_password_account_cannot_reset(self):
        from django.core import mail

        user = User.objects.create_user("reader", "reader@gmail.com", email_verified=False)
        SocialAccount.objects.create(user=user, provider="google", uid="google-reader")
        self.client.post(reverse("password_reset"), {"email": user.email})
        self.assertEqual(len(mail.outbox), 0)

    def test_expired_link_confirmation_cannot_connect(self):
        user = User.objects.create_user("reader", "reader@gmail.com", PASSWORD)
        self.client.force_login(user)
        state = self.start(process="connect", password=PASSWORD)["state"][0]
        session = self.client.session
        session["google_connect"] = [user.pk, time.time() - 601]
        session.save()
        response, _ = self.callback(state)
        self.assertEqual(response.status_code, 400)
        self.assertFalse(SocialAccount.objects.exists())

    def test_google_form_redirect_is_allowed_only_on_auth_pages(self):
        login_policy = self.client.get(reverse("login"))["Content-Security-Policy"]
        self.assertIn("form-action 'self' https://accounts.google.com", login_policy)
        browse_policy = self.client.get(reverse("browse"))["Content-Security-Policy"]
        self.assertNotIn("accounts.google.com", browse_policy)
        with override_settings(GOOGLE_LOGIN_ENABLED=False):
            self.assertNotIn(
                "accounts.google.com", self.client.get(reverse("login"))["Content-Security-Policy"]
            )
