from collections.abc import Callable
from typing import Any

import unittest
import subprocess
from deploy import verified_release, BACKUP_PATH_FILTER

SHA = "a" * 40


class ReleaseGateTests(unittest.TestCase):
    def test_old_and_new_backup_output_produce_one_path(self) -> None:
        path = "backups/peerpedia-20261019T041302Z.dump"
        for output in [
            path + "\n",
            f"Backup written to {path}. Copy it to storage outside this server.\n",
        ]:
            result = subprocess.run(
                ["sh", "-c", BACKUP_PATH_FILTER],
                input=output,
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(result.stdout, path + "\n")

    def reader(
        self, status: str = "success", jobs: list[dict[str, Any]] | None = None, head: str = SHA
    ) -> Callable[[str], dict[str, Any]]:
        def read(path: str) -> dict[str, Any]:
            if path == "branches/main":
                return {"commit": {"sha": head}}
            if "/jobs?" in path:
                return {
                    "jobs": jobs
                    if jobs is not None
                    else [
                        {"name": n, "conclusion": "success"}
                        for n in ["test", "browser", "quality", "security", "obsidian"]
                    ]
                }
            return {
                "workflow_runs": [
                    {
                        "id": 1,
                        "status": "completed",
                        "conclusion": status,
                        "html_url": "https://example.org/run",
                    }
                ]
            }

        return read

    def test_all_gates_required(self) -> None:
        self.assertEqual(verified_release(SHA, self.reader()), "https://example.org/run")
        for reader in [
            self.reader("failure"),
            self.reader(head="b" * 40),
            self.reader(jobs=[{"name": "test", "conclusion": "success"}]),
        ]:
            with self.assertRaises(ValueError):
                verified_release(SHA, reader)

    def test_no_run_or_latest_failed_rerun_blocks_release(self) -> None:
        base = self.reader()

        def read(path: str) -> dict[str, Any]:
            if "workflows/" in path:
                return {
                    "workflow_runs": [
                        {"id": 2, "status": "in_progress", "conclusion": None},
                        {"id": 1, "status": "completed", "conclusion": "success"},
                    ]
                }
            return base(path)

        with self.assertRaises(ValueError):
            verified_release(SHA, read)
        with self.assertRaises(ValueError):
            verified_release(
                SHA, lambda p: base(p) if p == "branches/main" else {"workflow_runs": []}
            )

    def test_plugin_gate_missing_failed_or_skipped_blocks_release(self) -> None:
        website = [
            {"name": name, "conclusion": "success"}
            for name in ("test", "browser", "quality", "security")
        ]
        for conclusion in (None, "failure", "skipped", "cancelled"):
            jobs = website + (
                [{"name": "obsidian", "conclusion": conclusion}] if conclusion else []
            )
            with self.subTest(conclusion=conclusion), self.assertRaises(ValueError):
                verified_release(SHA, self.reader(jobs=jobs))
