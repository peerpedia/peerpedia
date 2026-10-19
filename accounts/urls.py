from django.contrib.auth import views as auth
from django.urls import path
from . import views, social
from django.views.generic import RedirectView, TemplateView
from .security import limited
from . import tokens
from .mfa import security

urlpatterns = [
    path("google/login/", social.google_login, name="google_login"),
    path("google/login/callback/", social.google_callback, name="google_callback"),
    path("google/signup/", social.google_signup, name="socialaccount_signup"),
    path("connections/", social.connections, name="socialaccount_connections"),
    path(
        "google/cancelled/",
        TemplateView.as_view(template_name="socialaccount/login_cancelled.html"),
        name="socialaccount_login_cancelled",
    ),
    path(
        "sign-in/",
        RedirectView.as_view(pattern_name="login", query_string=True),
        name="account_login",
    ),
    path("security/", security, name="staff_mfa"),
    path("tokens/", tokens.token_settings, name="access_tokens"),
    path("tokens/<int:token_id>/revoke/", tokens.revoke_token, name="revoke_token"),
    path("signup/", views.signup, name="signup"),
    path(
        "login/",
        limited("login", limit=20, account_field="username")(views.PeerLoginView.as_view()),
        name="login",
    ),
    path("logout/", auth.LogoutView.as_view(), name="logout"),
    path(
        "password/change/",
        auth.PasswordChangeView.as_view(template_name="accounts/password_change.html"),
        name="password_change",
    ),
    path(
        "password/changed/",
        auth.PasswordChangeDoneView.as_view(template_name="accounts/password_change_done.html"),
        name="password_change_done",
    ),
    path("verification/", views.verification_needed, name="verification_needed"),
    path("verification/resend/", views.resend_verification, name="resend_verification"),
    path("verify/<str:token>/", views.verify_email, name="verify_email"),
    path(
        "password-reset/",
        limited("reset", limit=5, account_field="email")(views.PeerPasswordResetView.as_view()),
        name="password_reset",
    ),
    path(
        "password-reset/sent/",
        auth.PasswordResetDoneView.as_view(template_name="accounts/password_reset_done.html"),
        name="password_reset_done",
    ),
    path(
        "reset/<uidb64>/<token>/",
        auth.PasswordResetConfirmView.as_view(template_name="accounts/password_reset_confirm.html"),
        name="password_reset_confirm",
    ),
    path(
        "reset/done/",
        auth.PasswordResetCompleteView.as_view(
            template_name="accounts/password_reset_complete.html"
        ),
        name="password_reset_complete",
    ),
]
