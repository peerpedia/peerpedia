import logging
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.contrib.auth.views import LoginView, PasswordResetView
from django.core import signing
from django.core.mail import send_mail
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views.decorators.http import require_POST
from .forms import LoginForm, SignupForm
from .models import User
from .security import limited

logger = logging.getLogger(__name__)


def send_verification(user):
    token = signing.dumps({"user": user.pk, "email": user.email}, salt="verify-email")
    url = settings.SITE_URL + reverse("verify_email", args=[token])
    send_mail(
        "Verify your Peerpedia email",
        f"Welcome to Peerpedia.\n\nVerify your email to publish, submit changes, and review papers:\n{url}\n\nThis link expires in 24 hours. If you did not create this account, ignore this email.",
        settings.DEFAULT_FROM_EMAIL,
        [user.email],
    )


@limited("signup", limit=10, seconds=3600)
def signup(request):
    if request.user.is_authenticated:
        return redirect("browse")
    form = SignupForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        login(request, user, backend="accounts.backends.UsernameOrEmailBackend")
        try:
            send_verification(user)
        except Exception:
            logger.exception("Verification email delivery failed")
            messages.error(
                request,
                "Your account was created, but email delivery failed. Please try sending the verification email again.",
            )
        return redirect("verification_needed")
    return render(request, "accounts/signup.html", {"form": form})


class PeerLoginView(LoginView):
    authentication_form = LoginForm
    template_name = "accounts/login.html"


class PeerPasswordResetView(PasswordResetView):
    template_name = "accounts/password_reset.html"
    email_template_name = "accounts/reset_email.txt"
    subject_template_name = "accounts/reset_subject.txt"

    def form_valid(self, form):
        # Use configured origin, not request Host, in outgoing reset links.
        self.extra_email_context = {"site_url": settings.SITE_URL}
        try:
            return super().form_valid(form)
        except Exception:
            logger.exception("Password reset email delivery failed")
            # Keep the same response whether or not the account exists.
            return redirect("password_reset_done")


@login_required
def verification_needed(request):
    return render(request, "accounts/verify.html")


@login_required
@require_POST
@limited("verify", limit=4, seconds=3600)
def resend_verification(request):
    if not request.user.email_verified:
        try:
            send_verification(request.user)
            messages.success(request, "Verification email sent. Check your inbox.")
        except Exception:
            logger.exception("Verification email delivery failed")
            messages.error(request, "Email delivery is unavailable. Please try again later.")
    return redirect("verification_needed")


def verify_email(request, token):
    try:
        data = signing.loads(token, salt="verify-email", max_age=86400)
        user = User.objects.get(pk=data["user"], email=data["email"], is_active=True)
    except (signing.BadSignature, User.DoesNotExist, KeyError):
        return render(
            request,
            "error.html",
            {
                "heading": "Verification link unavailable",
                "detail": "This link is invalid or expired. Sign in and request a new verification email.",
            },
            status=400,
        )
    if request.method == "POST":
        user.email_verified = True
        user.save(update_fields=["email_verified"])
        messages.success(request, "Email verified. You can now participate in Peerpedia.")
        return redirect("browse" if request.user.is_authenticated else "login")
    return render(request, "accounts/verify_confirm.html", {"token": token})
