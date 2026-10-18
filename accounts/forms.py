import re
from django import forms
from django.contrib.auth.forms import AuthenticationForm, UserCreationForm
from .models import User


class SignupForm(UserCreationForm):
    username = forms.CharField(min_length=3, max_length=30, help_text="Use 3–30 letters, numbers, underscores, or hyphens.", widget=forms.TextInput(attrs={"autocomplete": "username"}))
    email = forms.EmailField(help_text="Private. Used to verify your account and reset your password.")

    class Meta:
        model = User
        fields = ("username", "email", "password1", "password2")

    def clean_username(self):
        value = self.cleaned_data["username"].strip()
        if not re.fullmatch(r"[A-Za-z0-9_\-]{3,30}", value):
            raise forms.ValidationError("Use 3–30 letters, numbers, underscores, or hyphens.")
        if User.objects.filter(username__iexact=value).exists():
            raise forms.ValidationError("That username is already taken.")
        return value

    def clean_email(self):
        value = self.cleaned_data["email"].strip().lower()
        if User.objects.filter(email__iexact=value).exists():
            raise forms.ValidationError("An account already uses this email. Sign in or reset your password.")
        return value


class LoginForm(AuthenticationForm):
    username = forms.CharField(label="Username or email", widget=forms.TextInput(attrs={"autofocus": True, "autocomplete": "username"}))
