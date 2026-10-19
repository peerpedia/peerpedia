"""Mandatory second factor for staff browser sessions, with explicit enrollment."""

import base64
import secrets
import time
from urllib.parse import urlencode
from django import forms
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.cache import never_cache
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_http_methods
from django_otp import login as otp_login
from django_otp.plugins.otp_static.models import StaticDevice, StaticToken
from django_otp.plugins.otp_totp.models import TOTPDevice
import segno
from .models import User
from .security import limited


class StaffMFAMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = request.user
        exempt = {reverse("staff_mfa"), reverse("logout"), reverse("admin:logout")}
        # Tokens retain their deliberately limited API scopes; they are not browser sessions.
        if (
            user.is_authenticated
            and user.is_staff
            and not user.is_verified()
            and request.path not in exempt
            and not request.path.startswith("/api/v1/")
        ):
            next_url = request.get_full_path() if request.method == "GET" else reverse("browse")
            return redirect(reverse("staff_mfa") + "?" + urlencode({"next": next_url}))
        return self.get_response(request)


class PasswordForm(forms.Form):
    password = forms.CharField(
        label="Confirm your password",
        widget=forms.PasswordInput(attrs={"autocomplete": "current-password"}),
    )


class CodeForm(forms.Form):
    code = forms.CharField(
        label="Authenticator or recovery code",
        max_length=64,
        widget=forms.TextInput(attrs={"autocomplete": "one-time-code", "autofocus": True}),
    )


def recovery_codes(user):
    StaticDevice.objects.filter(user=user).delete()
    device = StaticDevice.objects.create(user=user, name="Recovery codes")
    codes = [secrets.token_urlsafe(12) for _ in range(8)]
    StaticToken.objects.bulk_create([StaticToken(device=device, token=code) for code in codes])
    return device, codes


def verified_session(request, device):
    request.session.cycle_key()
    otp_login(request, device)
    request.session.set_expiry(12 * 3600)


@login_required
@never_cache
@sensitive_post_parameters("password", "code")
@require_http_methods(["GET", "POST"])
@limited("staff_mfa", limit=15, seconds=900)
def security(request):
    if not request.user.is_staff:
        raise PermissionDenied
    next_url = request.POST.get("next", request.GET.get("next", reverse("admin:index")))
    if not url_has_allowed_host_and_scheme(next_url, {request.get_host()}, request.is_secure()):
        next_url = reverse("admin:index")
    codes = None
    error = None
    action = request.POST.get("action")
    with transaction.atomic():
        # Serialize enrollment, recovery consumption, replacement and verification per user.
        User.objects.select_for_update().get(pk=request.user.pk)
        device = TOTPDevice.objects.filter(user=request.user, confirmed=True).first()
        pending_id, started = request.session.get("mfa_enrollment", [None, 0])
        pending = None
        if time.time() - started < 600:
            pending = TOTPDevice.objects.filter(
                pk=pending_id, user=request.user, confirmed=False
            ).first()
        password_form = PasswordForm(request.POST if action in {"start", "recovery"} else None)
        code_form = CodeForm(request.POST if action in {"confirm", "verify"} else None)
        if request.method == "POST":
            if action in {"start", "recovery"} and password_form.is_valid():
                if not request.user.check_password(password_form.cleaned_data["password"]):
                    password_form.add_error("password", "Incorrect password.")
                elif device and not request.user.is_verified():
                    error = "Verify your existing authenticator or use a recovery code first."
                elif action == "start":
                    TOTPDevice.objects.filter(user=request.user, confirmed=False).delete()
                    pending = TOTPDevice.objects.create(
                        user=request.user, name="Authenticator", confirmed=False
                    )
                    request.session["mfa_enrollment"] = [pending.pk, time.time()]
                elif device:
                    recovery, codes = recovery_codes(request.user)
                    verified_session(request, recovery)
            elif action == "confirm" and code_form.is_valid():
                if device and not request.user.is_verified():
                    error = "Verify your existing authenticator before replacing it."
                elif pending and pending.verify_token(code_form.cleaned_data["code"]):
                    TOTPDevice.objects.filter(user=request.user, confirmed=True).delete()
                    pending.confirmed = True
                    pending.save(update_fields=["confirmed"])
                    _, codes = recovery_codes(request.user)
                    verified_session(request, pending)
                    request.session.pop("mfa_enrollment", None)
                    device, pending = pending, None
                else:
                    code_form.add_error(
                        "code",
                        "Invalid or recently used code. Wait for a new code and try again. If setup expired, start again.",
                    )
            elif action == "verify" and code_form.is_valid() and device:
                code = code_form.cleaned_data["code"].replace(" ", "")
                verified = None
                if len(code) == 6 and code.isdigit() and device.verify_token(code):
                    verified = device
                elif len(code) == 16:
                    recovery = StaticDevice.objects.filter(
                        user=request.user, confirmed=True
                    ).first()
                    if recovery and recovery.verify_token(code):
                        verified = recovery
                if verified:
                    verified_session(request, verified)
                    return redirect(next_url)
                code_form.add_error(
                    "code", "Invalid or recently used code. Wait briefly before trying again."
                )
        if pending and (not device or request.user.is_verified()):
            qr = segno.make(pending.config_url).svg_inline(scale=4)
            secret = base64.b32encode(pending.bin_key).decode()
            mode = "enroll"
        else:
            qr, secret = None, None
            mode = (
                "manage"
                if device and request.user.is_verified()
                else "verify"
                if device
                else "start"
            )
    response = render(
        request,
        "accounts/security.html",
        {
            "mode": mode,
            "password_form": password_form,
            "code_form": code_form,
            "qr": qr,
            "secret": secret,
            "codes": codes,
            "error": error,
            "next": next_url,
        },
    )
    response["Referrer-Policy"] = "no-referrer"
    return response
