"""Stable public aliases; UUIDs and frozen manifests remain unchanged."""

from datetime import datetime, timezone
from django.db import IntegrityError, transaction


class PaperCodeConverter:
    regex = r"[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])\.[0-9a-f]{12,64}"

    def to_python(self, value):
        datetime(2000 + int(value[:2]), int(value[2:4]), int(value[4:6]))
        return value

    def to_url(self, value):
        return str(value)


def assign(paper, first_submission, published_at):
    if paper.public_id:
        return paper.public_id
    prefix = published_at.astimezone(timezone.utc).strftime("%y%m%d")
    for length in range(12, 65, 2):
        candidate = f"{prefix}.{first_submission.hash[:length]}"
        try:
            with transaction.atomic():
                paper.public_id = candidate
                paper.save(update_fields=["public_id"])
            return candidate
        except IntegrityError:
            if not type(paper).objects.filter(public_id=candidate).exclude(pk=paper.pk).exists():
                raise
    raise RuntimeError("Could not allocate a unique paper identifier.")


def save_snapshot(submission, save, *args, **kwargs):
    prefix = submission.created_at.astimezone(timezone.utc).strftime("%y%m%d")
    for length in range(12, 65, 2):
        candidate = f"{prefix}.{submission.hash[:length]}"
        try:
            with transaction.atomic():
                submission.public_id = candidate
                return save(*args, **kwargs)
        except IntegrityError:
            collision = type(submission).objects.filter(public_id=candidate)
            if not collision.exists() or collision.filter(hash=submission.hash).exists():
                raise
    raise RuntimeError("Could not allocate a unique snapshot identifier.")
