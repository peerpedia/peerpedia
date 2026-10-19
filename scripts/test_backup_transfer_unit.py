from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import backup_to_mac


class TransferTests(unittest.TestCase):
    def test_checksum_failure_never_acknowledges_or_retains_partial_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {
                        "host": "admin@example.org",
                        "identity": str(root / "key"),
                        "known_hosts": str(root / "hosts"),
                        "destination": str(root / "backups"),
                    }
                )
            )
            name = "peerpedia-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".dump"
            expected = hashlib.sha256(b"complete backup").hexdigest()

            def read(args, **kwargs):
                command = args[-1]
                if "find backups" in command:
                    return name + "\n"
                if "sha256sum" in command:
                    return expected + "  backup.dump\n"
                if "restore-check.sh" in command:
                    return "Verified\n"
                self.fail("A failed transfer must not acknowledge or prune backups")

            def transfer(args, **kwargs):
                kwargs["stdout"].write(b"truncated")

            with (
                patch.object(backup_to_mac.subprocess, "check_output", side_effect=read),
                patch.object(backup_to_mac.subprocess, "run", side_effect=transfer),
            ):
                with self.assertRaisesRegex(ValueError, "checksum"):
                    backup_to_mac.main(config)
            self.assertFalse(list((root / "backups").glob("*.dump")))
            self.assertFalse(list((root / "backups").glob(".partial-*")))
            self.assertFalse(json.loads((root / "backups/status.json").read_text())["ok"])

    def test_stale_server_backup_is_reported_before_transfer(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {
                        "host": "admin@example.org",
                        "identity": "key",
                        "known_hosts": "hosts",
                        "destination": str(root / "backups"),
                    }
                )
            )
            with (
                patch.object(
                    backup_to_mac.subprocess,
                    "check_output",
                    return_value="peerpedia-20000101T000000Z.dump\n",
                ),
                patch.object(backup_to_mac.subprocess, "run") as transfer,
            ):
                with self.assertRaisesRegex(ValueError, "48 hours"):
                    backup_to_mac.main(config)
                transfer.assert_not_called()
