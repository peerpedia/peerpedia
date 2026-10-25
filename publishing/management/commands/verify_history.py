from datetime import timezone
import re
from django.core.management.base import BaseCommand, CommandError
from publishing.models import Paper, Submission, PaperLicense


def valid_label(code, timestamp, digest):
    if not code or not re.fullmatch(r"[0-9]{6}\.[0-9a-f]{12,64}", code):
        return False
    date, prefix = code.split(".")
    return date == timestamp.astimezone(timezone.utc).strftime("%y%m%d") and digest.startswith(
        prefix
    )


class Command(BaseCommand):
    help = "Recompute all submission hashes and validate accepted-history links."

    def handle(self, **options):
        count = 0
        for submission in Submission.objects.select_related("base", "paper", "decision").iterator():
            if not valid_label(submission.public_id, submission.created_at, submission.hash):
                raise CommandError(f"Invalid snapshot identifier: {submission.pk}")
            if submission.calculate_hash() != submission.hash:
                raise CommandError(f"Hash mismatch: {submission.pk}")
            if submission.base_id and submission.base.paper_id != submission.paper_id:
                raise CommandError(f"Cross-paper base: {submission.pk}")
            if submission.manifest_version >= 3:
                if (
                    submission.agreement.user_id != submission.contributor_id
                    or submission.license_code != submission.paper.license_declaration.license_code
                ):
                    raise CommandError(f"Invalid submission licensing: {submission.pk}")
            count += 1
        for paper in Paper.objects.select_related("current__decision"):
            if (
                not paper.current_id
                or paper.current.paper_id != paper.pk
                or paper.current.status != "accepted"
            ):
                raise CommandError(f"Invalid current version: {paper.pk}")
            first = (
                paper.submissions.filter(decision__action="accepted")
                .select_related("decision")
                .order_by("decision__created_at", "pk")
                .first()
            )
            if not first or not valid_label(paper.public_id, first.decision.created_at, first.hash):
                raise CommandError(f"Invalid paper identifier: {paper.pk}")
        for grant in PaperLicense.objects.select_related("paper"):
            actual = set(
                grant.paper.submissions.filter(manifest_version__lt=3).values_list(
                    "hash", flat=True
                )
            )
            if not set(grant.legacy_hashes) <= actual:
                raise CommandError(f"Invalid legacy declaration scope: {grant.pk}")
        self.stdout.write(self.style.SUCCESS(f"Verified {count} immutable submissions."))
