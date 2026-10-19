import os
from pathlib import Path
import tempfile
import unittest
from backup_retention import candidates, digest, prune


class RetentionTests(unittest.TestCase):
    def test_no_pruning_without_verified_receipt_and_keep_newest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = []
            for i in range(1, 11):
                path = root / f"peerpedia-202601{i:02d}T000000Z.dump"
                path.write_bytes(f"backup-{i}".encode())
                path.with_suffix(".dump.sha256").write_text(digest(path))
                os.utime(path, (0, 0))
                files.append(path)
            self.assertEqual(candidates(root, 30, 7), [])
            files[-2].with_suffix(".dump.offsite").write_text("wrong-checksum")
            self.assertEqual(candidates(root, 30, 7), [])
            files[-2].with_suffix(".dump.offsite").write_text(digest(files[-2]))
            self.assertEqual(candidates(root, 30, 7), list(reversed(files[:3])))
            legacy = root / "peerpedia-20250101T000000Z.dump"
            legacy.write_bytes(b"legacy-without-managed-checksum")
            os.utime(legacy, (0, 0))
            prune(root)
            self.assertTrue(legacy.exists())
            self.assertTrue(files[-1].exists())
            self.assertEqual(sum(p.exists() for p in files), 7)

    def test_receipt_never_authorizes_deleting_newer_unreplicated_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for i in range(1, 11):
                p = root / f"peerpedia-202602{i:02d}T000000Z.dump"
                p.write_bytes(b"backup")
                p.with_suffix(".dump.sha256").write_text(digest(p))
                os.utime(p, (0, 0))
            first = root / "peerpedia-20260201T000000Z.dump"
            first.with_suffix(".dump.offsite").write_text(digest(first))
            self.assertEqual(candidates(root, 7, 3), [])
