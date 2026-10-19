"""Record an explicitly authorized grant without rewriting historical snapshots."""

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from accounts.models import User
from publishing.models import Paper, PaperLicense
from publishing.licensing import LICENSES, VERSION, document_hash


class Command(BaseCommand):
    help = (
        "Preview or record an owner's authorized license declaration for unlicensed legacy papers."
    )

    def add_arguments(self, parser):
        parser.add_argument("--owner", required=True)
        parser.add_argument("--license", required=True, choices=LICENSES)
        parser.add_argument(
            "--authority",
            required=True,
            help="Record the owner's explicit authorization and its scope.",
        )
        parser.add_argument("--confirm-owner-rights", action="store_true")

    @transaction.atomic
    def handle(self, **options):
        try:
            owner = User.objects.get(username=options["owner"])
        except User.DoesNotExist:
            raise CommandError("Owner account not found.")
        papers = list(
            Paper.objects.select_for_update(of=("self",))
            .filter(owner=owner, license_declaration__isnull=True)
            .order_by("pk")
        )
        grants = []
        for paper in papers:
            records = list(paper.submissions.all())
            if any(
                record.contributor_id != owner.pk or record.manifest_version >= 3
                for record in records
            ):
                raise CommandError(
                    f"Paper {paper.pk} includes another contributor or an existing licensed snapshot. Obtain and record all necessary permissions separately."
                )
            for record in records:
                if record.hash != record.calculate_hash():
                    raise CommandError(f"History verification failed: {record.pk}")
            grants.append((paper, sorted(record.hash for record in records)))
        self.stdout.write(
            f"{len(grants)} unlicensed papers owned by {owner.username}; license {options['license']}."
        )
        for paper, hashes in grants:
            self.stdout.write(f"{paper.pk}: {len(hashes)} historical snapshots")
        if not options["confirm_owner_rights"]:
            self.stdout.write("Preview only. No declarations recorded.")
            return
        if not options["authority"].strip():
            raise CommandError("Explicit owner authorization is required.")
        for paper, hashes in grants:
            PaperLicense.objects.create(
                paper=paper,
                actor=owner,
                license_code=options["license"],
                agreement_version=VERSION,
                document_hash=document_hash(),
                legacy_hashes=hashes,
                authority=options["authority"],
            )
        self.stdout.write(
            "Declarations recorded now. Historical snapshots and hashes are unchanged. Website agreement acceptance has not been fabricated."
        )
