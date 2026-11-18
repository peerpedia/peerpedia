import re
from collections.abc import Iterator
from allauth.account.forms import SignupForm as AllauthSignupForm
from django import forms
from django.contrib.auth.forms import AuthenticationForm, PasswordResetForm
from django.db.models import F
from .models import User


class SignupForm(AllauthSignupForm):
    username = forms.CharField(
        min_length=3,
        max_length=30,
        help_text="Use 3–30 letters, numbers, underscores, or hyphens.",
        widget=forms.TextInput(attrs={"autocomplete": "username"}),
    )
    email = forms.EmailField(
        help_text="Private. Used to verify your account and reset your password."
    )

    def clean_username(self: "SignupForm") -> str:
        value = self.cleaned_data["username"].strip()
        if not re.fullmatch(r"[A-Za-z0-9_\-]{3,30}", value):
            raise forms.ValidationError("Use 3–30 letters, numbers, underscores, or hyphens.")
        if User.objects.filter(username__iexact=value).exists():
            raise forms.ValidationError("That username is already taken.")
        return value

    def clean_email(self: "SignupForm") -> str:
        value = self.cleaned_data["email"].strip().lower()
        if User.objects.filter(email__iexact=value).exists():
            raise forms.ValidationError(
                "An account already uses this email. Sign in or reset your password."
            )
        return value


class LoginForm(AuthenticationForm):
    username = forms.CharField(
        label="Username or email",
        widget=forms.TextInput(attrs={"autofocus": True, "autocomplete": "username"}),
    )


class PeerPasswordResetForm(PasswordResetForm):
    def get_users(self: "PeerPasswordResetForm", email: str) -> Iterator[User]:
        for user in super().get_users(email):
            yield user
        # Google-only users can add a local password by proving email ownership again.
        for user in User.objects.filter(
            email__iexact=email,
            is_active=True,
            emailaddress__verified=True,
            emailaddress__email__iexact=F("email"),
            socialaccount__provider="google",
        ).distinct():
            if not user.has_usable_password():
                yield user
