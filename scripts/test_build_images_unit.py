import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent


class BuildImagesTests(unittest.TestCase):
    def run_build(
        self, fail_renderer: bool = False
    ) -> tuple[subprocess.CompletedProcess[str], list[str]]:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            docker = folder / "docker"
            docker.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BUILD_TEST_LOG"\n'
                'case "$*" in *"buildx build"*"content-renderer"*) '
                'if [ "$BUILD_TEST_FAIL" = 1 ]; then exit 42; fi ;; esac\n'
            )
            docker.chmod(0o755)
            log = folder / "calls"
            result = subprocess.run(
                ["sh", "scripts/build-images.sh"],
                cwd=ROOT,
                env={
                    **os.environ,
                    "PATH": f"{folder}:{os.environ['PATH']}",
                    "BUILD_TEST_LOG": str(log),
                    "BUILD_TEST_FAIL": "1" if fail_renderer else "0",
                },
                text=True,
                capture_output=True,
            )
            return result, log.read_text().splitlines() if log.exists() else []

    def test_builds_are_bounded_and_builder_stops_after_success(self) -> None:
        result, calls = self.run_build()
        self.assertEqual(result.returncode, 0, result.stderr)
        create = next(call for call in calls if call.startswith("buildx create"))
        self.assertIn("--driver docker-container", create)
        self.assertIn("memory=512m,memory-swap=1g,cpu-period=100000,cpu-quota=100000", create)
        builds = [call for call in calls if call.startswith("buildx build")]
        self.assertEqual(len(builds), 2)
        self.assertIn("--target content-renderer", builds[0])
        self.assertIn("--target app", builds[1])
        self.assertTrue(all("--load" in call for call in builds))
        self.assertEqual(calls[-1], "buildx stop peerpedia-release")

    def test_failed_renderer_build_aborts_without_building_web(self) -> None:
        result, calls = self.run_build(fail_renderer=True)
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertEqual(len([call for call in calls if call.startswith("buildx build")]), 1)
        self.assertEqual(calls[-1], "buildx stop peerpedia-release")
