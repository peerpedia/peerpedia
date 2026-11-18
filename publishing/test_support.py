"""Explicit consenting-user fixtures for publishing tests, never production authentication."""

from accounts.models import User
from .models import AgreementAcceptance
from .licensing import VERSION, document_hash


def consenting_user(
    username: str,
    email: str | None = None,
    password: str | None = None,
    *,
    email_verified: bool = False,
    **extra_fields: object,
) -> User:
    user = User.objects.create_user(
        username, email or f"{username}@example.org", password, **extra_fields
    )
    user.emailaddress_set.create(email=user.email.lower(), primary=True, verified=email_verified)
    if email_verified:
        AgreementAcceptance.objects.create(
            user=user, version=VERSION, document_hash=document_hash()
        )
    return user
