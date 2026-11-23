"""Prove that terminating the acceptance launcher also cleans its detached host."""
from __future__ import annotations

from pathlib import Path
import os
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest


PROJECT = Path(__file__).resolve().parents[1]


def group_exists(pid: int) -> bool:
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


class HostTerminationTests(unittest.TestCase):
    def test_sigterm_removes_the_host_process_group_and_temporary_vault(self: HostTerminationTests) -> None:
        with TemporaryDirectory(prefix="p8-signal-") as directory:
            root = Path(directory)
            app = root / "Test.app"
            binary = app / "Contents/MacOS/Obsidian"
            binary.parent.mkdir(parents=True)
            binary.write_text(
                '#!/bin/sh\ntrap \'\' TERM\nprintf "%s\\n%s\\n" "$$" "$HOME" > "$PEERPEDIA_TEST_READY"\n'
                'while :; do /bin/sleep 1; done\n',
            )
            binary.chmod(0o755)
            package = root / "package"
            package.mkdir()
            ready = root / "ready"
            runner = subprocess.Popen([
                sys.executable, str(PROJECT / "scripts/validate-offline-host.py"),
                str(app), str(package), str(PROJECT / "tests/fixtures/render-paper.json"), str(root / "logs"),
            ], env=dict(os.environ, TMPDIR=str(root), PEERPEDIA_TEST_READY=str(ready)))
            pid: int | None = None
            try:
                for _ in range(100):
                    fields = ready.read_text().splitlines() if ready.exists() else []
                    if len(fields) == 2:
                        break
                    if runner.poll() is not None:
                        self.fail("Acceptance launcher exited before starting the disposable host")
                    time.sleep(0.05)
                self.assertEqual(len(fields), 2)
                pid = int(fields[0])
                isolated = Path(fields[1]).parent
                self.assertTrue((isolated / "独立 验收库").is_dir())
                self.assertTrue(group_exists(pid))
                runner.terminate()
                code = runner.wait(timeout=16)
                for _ in range(40):
                    if not group_exists(pid):
                        break
                    time.sleep(0.05)
                self.assertEqual((group_exists(pid), isolated.exists()), (False, False))
                self.assertEqual(code, 128 + signal.SIGTERM)
            finally:
                if runner.poll() is None:
                    runner.kill()
                    runner.wait(timeout=5)
                if pid is not None and group_exists(pid):
                    os.killpg(pid, signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
