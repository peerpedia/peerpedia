from django.core.management.base import BaseCommand, CommandError
from publishing.models import Paper, Submission


class Command(BaseCommand):
    help = "Recompute all submission hashes and validate accepted-history links."

    def handle(self, **options):
        count = 0
        for submission in Submission.objects.select_related("base", "paper", "decision").iterator():
            if submission.calculate_hash() != submission.hash:
                raise CommandError(f"Hash mismatch: {submission.pk}")
            if submission.base_id and submission.base.paper_id != submission.paper_id:
                raise CommandError(f"Cross-paper base: {submission.pk}")
            count += 1
        for paper in Paper.objects.select_related("current__decision"):
            if not paper.current_id or paper.current.paper_id != paper.pk or paper.current.status != "accepted":
                raise CommandError(f"Invalid current version: {paper.pk}")
        self.stdout.write(self.style.SUCCESS(f"Verified {count} immutable submissions."))
