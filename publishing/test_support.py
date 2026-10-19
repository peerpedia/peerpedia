"""Explicit consenting-user fixtures for publishing tests, never production authentication."""

from accounts.models import User
from .models import AgreementAcceptance
from .licensing import VERSION, document_hash


def consenting_user(*args, **kwargs):
    user = User.objects.create_user(*args, **kwargs)
    if user.email_verified:
        AgreementAcceptance.objects.create(
            user=user, version=VERSION, document_hash=document_hash()
        )
    return user
