"""Shared public visibility queries for website and API readers."""

from .models import Paper, Submission


def public_papers():
    return Paper.objects.filter(is_hidden=False, current__isnull=False).select_related(
        "current", "owner"
    )


def submission_queryset():
    return Submission.objects.filter(paper__is_hidden=False).select_related(
        "paper__owner", "base", "decision", "contributor"
    )
