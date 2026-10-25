"""Stable public aliases; UUIDs and frozen manifests remain unchanged."""

from datetime import timezone
from django.db import IntegrityError, transaction


class PaperCodeConverter:
    regex = r"[0-9]{2}(?:0[1-9]|1[0-2])\.[0-9a-f]{12,64}"

    def to_python(self, value):
        return value

    def to_url(self, value):
        return str(value)


def assign(paper, first_submission, published_at):
    if paper.public_id:
        return paper.public_id
    prefix = published_at.astimezone(timezone.utc).strftime("%y%m")
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
