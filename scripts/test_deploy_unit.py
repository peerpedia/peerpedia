import unittest
from deploy import verified_release

SHA = "a" * 40


class ReleaseGateTests(unittest.TestCase):
    def reader(self, status="success", jobs=None, head=SHA):
        def read(path):
            if path == "branches/main":
                return {"commit": {"sha": head}}
            if "/jobs?" in path:
                return {
                    "jobs": jobs
                    if jobs is not None
                    else [
                        {"name": n, "conclusion": "success"} for n in ["test", "browser", "quality"]
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

    def test_all_gates_required(self):
        self.assertEqual(verified_release(SHA, self.reader()), "https://example.org/run")
        for reader in [
            self.reader("failure"),
            self.reader(head="b" * 40),
            self.reader(jobs=[{"name": "test", "conclusion": "success"}]),
        ]:
            with self.assertRaises(ValueError):
                verified_release(SHA, reader)

    def test_no_run_or_latest_failed_rerun_blocks_release(self):
        base = self.reader()

        def read(path):
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
