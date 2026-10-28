"""Locate a compatible CLI without reading secrets, contacting servers or installing anything."""

import json
from pathlib import Path
import re
import shutil
import subprocess


def check():
    dedicated = Path.home() / ".local/share/peerpedia/venv/bin/peerpedia"
    candidates = [str(dedicated), shutil.which("peerpedia")]
    checked = []
    for candidate in dict.fromkeys(candidates):
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            result = subprocess.run(
                [candidate, "--version"], capture_output=True, text=True, timeout=10
            )
        except (OSError, subprocess.TimeoutExpired):
            checked.append({"executable": candidate, "status": "unavailable"})
            continue
        match = re.fullmatch(r"peerpedia (\d+)\.(\d+)\.(\d+)\s*", result.stdout)
        if result.returncode == 0 and match:
            version = tuple(int(n) for n in match.groups())
            if version >= (0, 1, 1):
                return {
                    "ready": True,
                    "executable": str(Path(candidate).absolute()),
                    "version": ".".join(match.groups()),
                    "library": str(Path.home() / "Documents/Peerpedia"),
                    "server": "https://peerpedia.dev",
                    "authentication": "Not checked; public reading needs no account.",
                }
        checked.append({"executable": candidate, "status": "upgrade_required"})
    return {
        "ready": False,
        "requires": "peerpedia-cli >=0.1.1 on Python >=3.12",
        "checked": checked,
        "instructions": "Follow skills/peerpedia/references/setup.md in this plugin.",
    }


if __name__ == "__main__":
    print(json.dumps(check(), indent=2))
