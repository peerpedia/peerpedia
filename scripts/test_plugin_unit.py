"""Offline checks for the plugin's CLI setup detection."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from check_plugin import validate

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "plugin_setup", ROOT / "plugins/peerpedia/scripts/check_setup.py"
)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class PluginSetupTests(unittest.TestCase):
    def test_distribution_is_self_contained(self):
        validate()

    def test_missing_cli_returns_actionable_setup_without_creating_files(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(setup.Path, "home", return_value=Path(folder)),
            patch.object(setup.shutil, "which", return_value=None),
        ):
            result = setup.check()
            self.assertFalse(result["ready"])
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_old_cli_falls_back_to_compatible_path_and_timeout_is_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            dedicated = home / ".local/share/peerpedia/venv/bin/peerpedia"
            dedicated.parent.mkdir(parents=True)
            dedicated.touch()
            alternate = home / "peerpedia"
            alternate.touch()
            with (
                patch.object(setup.Path, "home", return_value=home),
                patch.object(setup.shutil, "which", return_value=str(alternate)),
                patch.object(
                    setup.subprocess,
                    "run",
                    side_effect=[
                        subprocess.CompletedProcess([], 0, "peerpedia 0.1.0\n", ""),
                        subprocess.CompletedProcess([], 0, "peerpedia 0.1.1\n", ""),
                    ],
                ) as run,
            ):
                result = setup.check()
                self.assertTrue(result["ready"])
                self.assertEqual(result["executable"], str(alternate))
                self.assertEqual(run.call_args.kwargs["timeout"], 10)
            with (
                patch.object(setup.Path, "home", return_value=home),
                patch.object(setup.shutil, "which", return_value=None),
                patch.object(
                    setup.subprocess, "run", side_effect=subprocess.TimeoutExpired("cli", 10)
                ),
            ):
                self.assertFalse(setup.check()["ready"])


if __name__ == "__main__":
    unittest.main()
