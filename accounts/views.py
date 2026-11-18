import logging
from typing import Any
from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.contrib.auth.views import LoginView, PasswordResetConfirmView, PasswordResetView
from django.core import signing
from allauth.account.adapter import get_adapter
from allauth.account.models import EmailAddress, EmailConfirmationHMAC
from allauth.account.views import SignupView
from django.db import IntegrityError, transaction
from django.db.models import F
from django.http import HttpRequest, HttpResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views.decorators.http import require_http_methods, require_POST
from .forms import LoginForm, SignupForm, PeerPasswordResetForm
from .models import User
from .security import limited, local_destination

logger = logging.getLogger(__name__)


class PeerSignupView(SignupView):
    form_class = SignupForm
    template_name = "accounts/signup.html"

    def get_success_url(self: "PeerSignupView") -> str:
        target = local_destination(self.get_next_url() or "")
        return reverse("verification_needed", query={"next": target} if target else None)

    def form_valid(self: "PeerSignupView", form: SignupForm) -> HttpResponse:
        try:
            with transaction.atomic():
                return super().form_valid(form)
        except IntegrityError:
            form.add_error(None, "That username or email was just registered.")
            return self.form_invalid(form)


class PeerLoginView(LoginView):
    authentication_form = LoginForm
    template_name = "accounts/login.html"


class PeerPasswordResetView(PasswordResetView):
    form_class = PeerPasswordResetForm
    template_name = "accounts/password_reset.html"
    email_template_name = "accounts/reset_email.txt"
    subject_template_name = "accounts/reset_subject.txt"

    def form_valid(self: "PeerPasswordResetView", form: PeerPasswordResetForm) -> HttpResponse:
        target = local_destination(self.request.GET.get("next", ""))
        self.request.session["reset_next"] = target
        self.extra_email_context = {"site_url": settings.SITE_URL, "next": target}
        try:
            return super().form_valid(form)
        except Exception:
            logger.exception("Password reset email delivery failed")
            # Keep the same response whether or not the account exists.
            return redirect("password_reset_done")


class PeerPasswordResetConfirmView(PasswordResetConfirmView):
    template_name = "accounts/password_reset_confirm.html"

    def dispatch(
        self: "PeerPasswordResetConfirmView", request: HttpRequest, *args: Any, **kwargs: Any
    ) -> HttpResponse:
        response = super().dispatch(request, *args, **kwargs)
        if request.method == "GET" and response.status_code == 302:
            # Django has verified the emailed link and removed its token from the URL.
            request.session["reset_next"] = local_destination(request.GET.get("next", ""))
        return response


@login_required
def verification_needed(request: HttpRequest) -> HttpResponse:
    if "next" in request.GET:
        request.session["verification_next"] = local_destination(request.GET["next"])
    target = request.session.get("verification_next", "")
    return render(request, "accounts/verify.html", {"next": target})


@login_required
@require_POST
@limited("verify", limit=4, seconds=3600)
def resend_verification(request: HttpRequest) -> HttpResponse:
    if not request.user.email_verified:
        try:
            address, _ = EmailAddress.objects.get_or_create(
                user=request.user, email=request.user.email.lower()
            )
            address.send_confirmation(request)
            messages.success(request, "Verification email sent. Check your inbox.")
        except Exception:
            logger.exception("Verification email delivery failed")
            messages.error(request, "Email delivery is unavailable. Please try again later.")
    return redirect("verification_needed")


def legacy_confirmation(token: str) -> EmailConfirmationHMAC | None:
    # Links issued before the allauth migration are valid for their original 24 hours.
    try:
        data = signing.loads(token, salt="verify-email", max_age=86400)
        user = User.objects.get(pk=data["user"], email=data["email"], is_active=True)
        address = EmailAddress.objects.get(user=user, email=user.email.lower(), verified=False)
    except (signing.BadSignature, User.DoesNotExist, EmailAddress.DoesNotExist, KeyError):
        return None
    return EmailConfirmationHMAC(address)


@require_http_methods(["GET", "POST"])
@transaction.atomic
def verify_email(request: HttpRequest, token: str) -> HttpResponse:
    confirmation = EmailConfirmationHMAC.from_key(token) or legacy_confirmation(token)
    if confirmation:
        # Recheck both records under lock so an email change, deactivation, or
        # second confirmation cannot race the publishing permission change.
        address = (
            EmailAddress.objects.select_related("user")
            .select_for_update()
            .filter(
                pk=confirmation.email_address.pk,
                user__is_active=True,
                email__iexact=F("user__email"),
                verified=False,
            )
            .first()
        )
        if address:
            if request.method == "GET":
                return render(request, "accounts/verify_confirm.html")
            if get_adapter().confirm_email(request, address):
                target = local_destination(request.GET.get("next", ""))
                if request.user.pk == address.user_id:
                    pending = request.session.pop("verification_next", "")
                    return redirect(pending or target or reverse("browse"))
                return redirect(reverse("login", query={"next": target} if target else None))
    return render(
        request,
        "error.html",
        {
            "heading": "Verification link unavailable",
            "detail": "This link is invalid or expired. Sign in and request a new verification email.",
        },
        status=400,
    )
