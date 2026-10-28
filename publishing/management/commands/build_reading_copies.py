from django.core.management.base import BaseCommand
from publishing.artifacts import load
from publishing.models import Submission


class Command(BaseCommand):
    help = "Prepare durable reading copies without changing immutable article sources."

    def add_arguments(self, parser):
        parser.add_argument(
            "--refresh", action="store_true", help="Build with the current renderer version."
        )

    def handle(self, *args, **options):
        count = 0
        for submission in Submission.objects.order_by("created_at").iterator(chunk_size=50):
            load(submission, refresh=options["refresh"])
            count += 1
        self.stdout.write(self.style.SUCCESS(f"Reading copies ready for {count} snapshots."))
