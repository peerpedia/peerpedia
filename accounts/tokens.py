"""Personal credentials only grant API submission access, never browser login."""

import hashlib
import secrets
from datetime import timedelta
from django import forms
from django.contrib import messages
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods, require_POST
from .models import AccessToken
from .security import limited, verified_required


def issue_token(user, name, days=90, can_publish=False):
    raw = "pp_" + secrets.token_urlsafe(32)
    token = AccessToken.objects.create(
        user=user,
        name=name,
        digest=hashlib.sha256(raw.encode()).hexdigest(),
        prefix=raw[:10],
        can_publish=can_publish,
        expires_at=timezone.now() + timedelta(days=days),
    )
    return token, raw


def authenticate_token(raw):
    if not raw.startswith("pp_") or len(raw) > 100:
        return None
    return (
        AccessToken.objects.select_related("user")
        .filter(
            digest=hashlib.sha256(raw.encode()).hexdigest(),
            revoked_at__isnull=True,
            expires_at__gt=timezone.now(),
            user__is_active=True,
            user__email_verified=True,
        )
        .first()
    )


class TokenForm(forms.Form):
    name = forms.CharField(max_length=80, help_text="For example: Laptop or Research assistant.")
    days = forms.TypedChoiceField(
        label="Expires after", coerce=int, choices=[(30, "30 days"), (90, "90 days")], initial=90
    )
    can_publish = forms.BooleanField(required=False, label="Also allow publishing new papers")
    password = forms.CharField(label="Confirm your password", widget=forms.PasswordInput)


@sensitive_post_parameters("password")
@verified_required
@require_http_methods(["GET", "POST"])
@limited("tokens", limit=10, seconds=3600)
def token_settings(request):
    form = TokenForm(request.POST or None)
    raw = None
    if request.method == "POST" and form.is_valid():
        if not request.user.check_password(form.cleaned_data["password"]):
            form.add_error("password", "Incorrect password.")
        else:
            _, raw = issue_token(
                request.user,
                form.cleaned_data["name"],
                form.cleaned_data["days"],
                form.cleaned_data["can_publish"],
            )
            form = TokenForm()
    response = render(
        request,
        "accounts/tokens.html",
        {
            "form": form,
            "new_token": raw,
            "tokens": request.user.access_tokens.order_by("-created_at"),
            "now": timezone.now(),
        },
    )
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "same-origin"
    return response


@verified_required
@require_POST
def revoke_token(request, token_id):
    token = get_object_or_404(AccessToken, pk=token_id, user=request.user)
    if token.revoked_at is None:
        token.revoked_at = timezone.now()
        token.save(update_fields=["revoked_at"])
    messages.success(request, "Access token revoked.")
    return redirect("access_tokens")
