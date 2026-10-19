"""Google authentication through allauth, without a second password/account system."""

import time
from copy import deepcopy
from functools import wraps
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db import IntegrityError, transaction
from django.shortcuts import redirect, render
from django.views.decorators.cache import never_cache
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_POST
from allauth.utils import get_request_param
from allauth.account.adapter import DefaultAccountAdapter
from allauth.core.exceptions import ImmediateHttpResponse
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
from allauth.socialaccount.forms import SignupForm as SocialSignupForm
from allauth.socialaccount.models import SocialAccount
from allauth.socialaccount.providers.google.views import GoogleOAuth2Adapter
from allauth.socialaccount.providers.oauth2.views import OAuth2LoginView, OAuth2CallbackView
from allauth.socialaccount.views import SignupView
from .forms import SignupForm
from .mfa import PasswordForm
from .models import User
from .security import limited


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


def verified_email(sociallogin):
    return next((e.email.lower() for e in sociallogin.email_addresses if e.verified), None)


class GoogleAdapter(GoogleOAuth2Adapter):
    def complete_login(self, request, app, token, **kwargs):
        sociallogin = super().complete_login(request, app, token, **kwargs)
        # Keep only identity metadata needed by the account page, not avatar/tracking URLs.
        email = verified_email(sociallogin)
        sociallogin.account.extra_data = {"email": email, "email_verified": bool(email)}
        return sociallogin


class AccountAdapter(DefaultAccountAdapter):
    def login(self, request, user):
        # Our existing backend resolves sessions; no additional password entry point is exposed.
        login(request, user, backend="accounts.backends.UsernameOrEmailBackend")

    def respond_user_inactive(self, request, user):
        return unavailable(
            request, "This account is inactive. Contact the site administrator.", 403
        )


class SocialAdapter(DefaultSocialAccountAdapter):
    def pre_social_login(self, request, sociallogin):
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
            raise ImmediateHttpResponse(redirect("login"))
        # Existing accounts are found by Google's stable subject, never by an email match.
        if sociallogin.is_existing and email.casefold() == sociallogin.user.email.casefold():
            if sociallogin.user.is_active and not sociallogin.user.email_verified:
                sociallogin.user.email_verified = True
                sociallogin.user.save(update_fields=["email_verified"])

    def save_user(self, request, sociallogin, form=None):
        email = verified_email(sociallogin)
        if not email:
            raise PermissionDenied
        sociallogin.user.email_verified = True
        return super().save_user(request, sociallogin, form)


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
def connections(request):
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
            "google_account": SocialAccount.objects.filter(
                user=request.user, provider="google"
            ).first(),
        },
    )


google_signup = never_cache(
    enabled(limited("google_signup", limit=10, seconds=3600)(GoogleSignupView.as_view()))
)
