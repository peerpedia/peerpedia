from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from publishing.artifacts import load
from publishing.models import Submission


class Command(BaseCommand):
    help = "Prepare durable reading copies without changing immutable article sources."

    def add_arguments(self, parser):
        parser.add_argument(
            "--refresh", action="store_true", help="Build with the current renderer version."
        )

    def handle(self, *args, **options):
        count, skipped = 0, 0
        snapshots = Submission.objects.select_related("paper").order_by("created_at")
        for submission in snapshots.iterator(chunk_size=50):
            try:
                load(submission, refresh=options["refresh"])
            except ValidationError as error:
                # Historical test snapshots may predate the current grammar. Do
                # not rewrite them or make them block the current publication.
                # Transport failures have no source-error code and remain fatal.
                if submission.paper.current_id == submission.pk or not error.code:
                    raise CommandError(
                        f"Could not prepare {submission.public_id}: {error}"
                    ) from error
                skipped += 1
                self.stderr.write(
                    self.style.WARNING(
                        f"Skipped historical snapshot {submission.public_id}: {error}"
                    )
                )
                continue
            count += 1
        self.stdout.write(
            self.style.SUCCESS(
                f"Reading copies ready for {count} snapshots; skipped {skipped} historical snapshots."
            )
        )
