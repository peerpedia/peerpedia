"""Publication contracts shared with the offline TypeScript client."""

from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path

from django.test import SimpleTestCase

from cli.peerpedia_cli import main as client
from publishing.models import AgreementAcceptance, Submission

FIXTURES = Path(__file__).resolve().parents[1] / "tests/fixtures/publication-protocol"


class SharedProtocolTests(SimpleTestCase):
    def test_historical_records_match_server_and_cli(self) -> None:
        for version in range(1, 5):
            with self.subTest(version=version):
                record = json.loads((FIXTURES / f"v{version}.json").read_text())
                manifest = record["manifest"]
                row = Submission(
                    id=manifest["submission_id"],
                    paper_id=manifest["paper_id"],
                    contributor_id=manifest["contributor_id"],
                    contributor_name=manifest["contributor_name"],
                    title=manifest["title"],
                    authors=manifest["authors"],
                    abstract=manifest["abstract"],
                    explanation=manifest["explanation"],
                    created_at=datetime.fromisoformat(manifest["submitted_at"]),
                    manifest_version=version,
                    markdown=record["markdown"],
                    chapters=record["chapters"],
                    bibliography=record["bibliography"],
                    primary_category=manifest.get("primary_category", ""),
                    secondary_categories=manifest.get("secondary_categories", []),
                    license_code=manifest.get("license", ""),
                )
                if manifest["base_hash"]:
                    row.base = Submission(hash=manifest["base_hash"])
                if version >= 3:
                    agreement = manifest["agreement"]
                    row.agreement = AgreementAcceptance(
                        id=agreement["acceptance_id"],
                        version=agreement["version"],
                        document_hash=agreement["sha256"],
                        created_at=datetime.fromisoformat(agreement["accepted_at"]),
                    )
                self.assertEqual(row.manifest(), manifest)
                self.assertEqual(row.calculate_hash(), record["hash"])
                client.verify(record)
                for field in ("markdown", "bibliography") if version == 4 else ("markdown",):
                    altered = deepcopy(record)
                    altered[field] += "changed"
                    with self.assertRaises(client.ClientError):
                        client.verify(altered)
                normalized = deepcopy(record)
                normalized["markdown"] = normalized["markdown"].replace("\r\n", "\n")
                with self.assertRaises(client.ClientError):
                    client.verify(normalized)
