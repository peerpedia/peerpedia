import hashlib
from django.test import Client, TestCase, override_settings
from .models import AccessToken, User
from .tokens import authenticate_token, issue_token


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class TokenTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            "reader", "reader@example.org", "password", email_verified=True
        )
        self.client.force_login(self.user)

    def test_creation_requires_password_and_displays_secret_only_once(self):
        data = {"name": "Laptop", "days": 30, "password": "wrong"}
        self.assertContains(self.client.post("/accounts/tokens/", data), "Incorrect password")
        self.assertFalse(AccessToken.objects.exists())
        data["password"] = "password"
        response = self.client.post("/accounts/tokens/", data)
        raw = response.context["new_token"]
        self.assertEqual(response["Cache-Control"], "no-store")
        token = AccessToken.objects.get()
        self.assertEqual(token.digest, hashlib.sha256(raw.encode()).hexdigest())
        self.assertFalse(token.can_publish)
        self.assertNotContains(self.client.get("/accounts/tokens/"), raw)
        self.assertEqual(authenticate_token(raw).pk, token.pk)

    def test_only_owner_can_revoke_and_csrf_is_required(self):
        token, raw = issue_token(self.user, "Laptop")
        other = User.objects.create_user(
            "other", "other@example.org", "password", email_verified=True
        )
        self.client.force_login(other)
        url = f"/accounts/tokens/{token.pk}/revoke/"
        self.assertEqual(self.client.post(url).status_code, 404)
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user)
        self.assertEqual(client.post(url).status_code, 403)
        self.client.force_login(self.user)
        self.assertEqual(self.client.get(url).status_code, 405)
        self.client.post(url)
        self.assertIsNone(authenticate_token(raw))

    def test_unverified_users_cannot_create_tokens(self):
        self.user.email_verified = False
        self.user.save()
        self.assertRedirects(self.client.get("/accounts/tokens/"), "/accounts/verification/")
