from django.contrib.auth import views as auth
from django.urls import path
from . import views
from .security import limited
from . import tokens

urlpatterns = [
    path("tokens/", tokens.token_settings, name="access_tokens"),
    path("tokens/<int:token_id>/revoke/", tokens.revoke_token, name="revoke_token"),
    path("signup/", views.signup, name="signup"),
    path("login/", limited("login", limit=20)(views.PeerLoginView.as_view()), name="login"),
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
        limited("reset", limit=5)(views.PeerPasswordResetView.as_view()),
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
