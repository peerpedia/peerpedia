"""Google authentication through allauth, without a second password/account system."""

import logging
import time
from smtplib import SMTPException
from copy import deepcopy
from functools import wraps
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db import IntegrityError, transaction
from django.dispatch import receiver
from django.http import HttpRequest, HttpResponse
from django.urls import reverse
from django.shortcuts import redirect, render
from django.views.decorators.cache import never_cache
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_POST
from allauth.utils import get_request_param
from allauth.account.adapter import DefaultAccountAdapter
from allauth.account.models import EmailAddress, EmailConfirmation, EmailConfirmationHMAC
from allauth.core.exceptions import ImmediateHttpResponse
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
from allauth.socialaccount.forms import SignupForm as SocialSignupForm
from allauth.socialaccount.models import SocialAccount, SocialLogin
from allauth.socialaccount.signals import social_account_added
from allauth.socialaccount.providers.google.views import GoogleOAuth2Adapter
from allauth.socialaccount.providers.oauth2.views import OAuth2LoginView, OAuth2CallbackView
from allauth.socialaccount.views import SignupView
from .forms import SignupForm
from .mfa import PasswordForm
from .models import User
from .security import limited, local_destination


def unavailable(request, detail, status=400):
    return render(
        request, "error.html", {"heading": "Google sign-in", "detail": detail}, status=status
    )


def enabled(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if not settings.GOOGLE_LOGIN_ENABLED:
            return unavailable(request, "Google sign-in is not configured yet.", 503)
        return view(request, *args, **kwargs)

    return wrapped


def verified_email(sociallogin: SocialLogin) -> str | None:
    return next((e.email.lower() for e in sociallogin.email_addresses if e.verified), None)


def verify_google_address(user: User, sociallogin: SocialLogin) -> None:
    email = verified_email(sociallogin)
    if user.is_active and email and user.email.casefold() == email.casefold():
        address, _ = EmailAddress.objects.get_or_create(user=user, email=email)
        address.set_verified()


@receiver(social_account_added)
def google_connected(
    sender: type[SocialLogin], request: HttpRequest, sociallogin: SocialLogin, **kwargs: object
) -> None:
    if sociallogin.account.provider == "google":
        verify_google_address(request.user, sociallogin)


class GoogleAdapter(GoogleOAuth2Adapter):
    def complete_login(self, request, app, token, **kwargs):
        sociallogin = super().complete_login(request, app, token, **kwargs)
        # Keep only identity metadata needed by the account page, not avatar/tracking URLs.
        email = verified_email(sociallogin)
        sociallogin.account.extra_data = {"email": email, "email_verified": bool(email)}
        return sociallogin


class AccountAdapter(DefaultAccountAdapter):
    def get_email_confirmation_url(
        self: "AccountAdapter",
        request: HttpRequest,
        emailconfirmation: EmailConfirmation | EmailConfirmationHMAC,
    ) -> str:
        target = local_destination(
            get_request_param(request, "next") or request.session.get("verification_next", "")
        )
        return settings.SITE_URL + reverse(
            "verify_email", args=[emailconfirmation.key], query={"next": target} if target else None
        )

    def send_confirmation_mail(
        self: "AccountAdapter",
        request: HttpRequest,
        emailconfirmation: EmailConfirmation | EmailConfirmationHMAC,
        signup: bool,
    ) -> None:
        try:
            super().send_confirmation_mail(request, emailconfirmation, signup)
        except (OSError, SMTPException):
            if not signup:
                raise
            logging.getLogger(__name__).exception("Signup verification email delivery failed")
            messages.error(request, "Email delivery failed. Please resend the verification email.")

    def login(self, request, user):
        # Our existing backend resolves sessions; no additional password entry point is exposed.
        login(request, user, backend="accounts.backends.UsernameOrEmailBackend")

    def respond_user_inactive(self, request, user):
        return unavailable(
            request, "This account is inactive. Contact the site administrator.", 403
        )


class SocialAdapter(DefaultSocialAccountAdapter):
    def pre_social_login(
        self: "SocialAdapter", request: HttpRequest, sociallogin: SocialLogin
    ) -> None:
        sociallogin.token = (
            None  # Never retain Google access/refresh tokens, even in signup sessions.
        )
        email = verified_email(sociallogin)
        if not settings.GOOGLE_LOGIN_ENABLED or not email:
            raise ImmediateHttpResponse(
                unavailable(request, "Google must supply a verified email address to continue.")
            )
        if sociallogin.state.get("process") == "connect":
            user_id, started = request.session.pop("google_connect", [None, 0])
            if (
                not request.user.is_authenticated
                or user_id != request.user.pk
                or not 0 <= time.time() - started < 600
                or email.casefold() != request.user.email.casefold()
            ):
                raise ImmediateHttpResponse(
                    unavailable(
                        request,
                        "Confirm your password again and choose the Google account with your Peerpedia email.",
                    )
                )
        elif request.user.is_authenticated:
            raise ImmediateHttpResponse(redirect("socialaccount_connections"))
        elif not sociallogin.is_existing and User.objects.filter(email__iexact=email).exists():
            messages.info(
                request,
                "You already have a Peerpedia account. Sign in with your password, then open Account to connect Google.",
            )
            target = local_destination(sociallogin.state.get("next") or "")
            raise ImmediateHttpResponse(
                redirect(reverse("login", query={"next": target} if target else None))
            )
        # Existing accounts are found by Google's stable subject, never by an email match.
        if sociallogin.is_existing and sociallogin.state.get("process") != "connect":
            verify_google_address(sociallogin.user, sociallogin)


class GoogleSignupForm(SocialSignupForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["username"] = deepcopy(SignupForm.base_fields["username"])
        # A forged POST must not replace Google's verified email with another address.
        self.fields["email"].disabled = True
        self.initial["email"] = verified_email(self.sociallogin)

    clean_username = SignupForm.clean_username
    clean_email = SignupForm.clean_email


class GoogleSignupView(SignupView):
    def form_valid(self, form):
        pending = self.request.session.get("socialaccount_sociallogin")
        try:
            with transaction.atomic():
                return super().form_valid(form)
        except IntegrityError:
            # Concurrent signup can win either case-insensitive unique constraint.
            self.request.session["socialaccount_sociallogin"] = pending
            form.add_error(
                None,
                "That username or email was just registered. Sign in or choose another username.",
            )
            return self.form_invalid(form)


@never_cache
@require_POST
@enabled
@limited("google_login", limit=20)
@sensitive_post_parameters("password")
def google_login(request):
    if get_request_param(request, "process", "login") not in {"login", "connect"}:
        raise PermissionDenied
    if get_request_param(request, "process") == "connect":
        if not request.user.is_authenticated:
            raise PermissionDenied
        if not request.user.check_password(request.POST.get("password", "")):
            messages.error(request, "Incorrect password. Google was not connected.")
            return redirect("socialaccount_connections")
        request.session["google_connect"] = [request.user.pk, time.time()]
    elif request.user.is_authenticated:
        return redirect("socialaccount_connections")
    return OAuth2LoginView.adapter_view(GoogleAdapter)(request)


@never_cache
@enabled
def google_callback(request):
    return OAuth2CallbackView.adapter_view(GoogleAdapter)(request)


@login_required
@never_cache
@limited("google_disconnect", limit=10)
@sensitive_post_parameters("password")
def connections(request: HttpRequest) -> HttpResponse:
    from publishing.drafts import archived_drafts

    form = PasswordForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            user = User.objects.select_for_update().get(pk=request.user.pk)
            if not user.check_password(form.cleaned_data["password"]):
                form.add_error("password", "Incorrect password. Google was not disconnected.")
            else:
                SocialAccount.objects.filter(user=user, provider="google").delete()
                messages.success(
                    request, "Google disconnected. You can still sign in with your password."
                )
                return redirect("socialaccount_connections")
    return render(
        request,
        "accounts/connections.html",
        {
            "form": form,
            "has_archived_drafts": request.user.email_verified
            and archived_drafts(request.user).exists(),
            "google_account": SocialAccount.objects.filter(
                user=request.user, provider="google"
            ).first(),
        },
    )


google_signup = never_cache(
    enabled(limited("google_signup", limit=10, seconds=3600)(GoogleSignupView.as_view()))
)
