"""Install a per-user, six-hour backup pull job on macOS using existing SSH access."""

import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--known-hosts", type=Path, required=True)
    parser.add_argument(
        "--destination",
        type=Path,
        default=Path.home() / "Library/Application Support/PeerpediaBackup/backups",
    )
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This installer is for macOS.")
    for path in [args.identity, args.known_hosts]:
        if not path.expanduser().is_file():
            parser.error("The existing SSH key and pinned host file must be available.")
    os.umask(0o077)
    folder = Path.home() / "Library/Application Support/PeerpediaBackup"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ["backup_to_mac.py", "backup_retention.py"]:
        shutil.copyfile(Path(__file__).with_name(name), folder / name)
    config = folder / "config.json"
    config.write_text(
        json.dumps(
            {
                "host": args.host,
                "identity": str(args.identity.expanduser()),
                "known_hosts": str(args.known_hosts.expanduser()),
                "destination": str(args.destination.expanduser()),
            },
            indent=2,
        )
        + "\n"
    )
    config.chmod(0o600)
    label = "dev.peerpedia.backup"
    plist = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
    plist.parent.mkdir(parents=True, exist_ok=True)
    job = {
        "Label": label,
        "ProgramArguments": [
            shutil.which("python3") or sys._base_executable,
            str(folder / "backup_to_mac.py"),
            str(config),
        ],
        "StartInterval": 21600,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "StandardOutPath": str(folder / "backup.log"),
        "StandardErrorPath": str(folder / "backup-errors.log"),
    }
    plist.write_bytes(plistlib.dumps(job))
    domain = f"gui/{os.getuid()}"
    subprocess.run(
        ["launchctl", "bootout", f"{domain}/{label}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    print(f"Backup job installed. Status: {args.destination.expanduser() / 'status.json'}")


if __name__ == "__main__":
    main()
