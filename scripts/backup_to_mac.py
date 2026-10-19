"""Fetch the newest server backup over pinned SSH, verify it, then record receipt.

The user config lives outside the repository. This script needs no database or
mail credentials. launchd retries every six hours while this Mac is online.
"""

from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
from backup_retention import digest, prune, NAME


def atomic_json(path, value):
    pending = path.with_suffix(".tmp")
    pending.write_text(json.dumps(value, indent=2) + "\n")
    pending.chmod(0o600)
    pending.replace(path)


def main(config_path):
    os.umask(0o077)
    config = json.loads(config_path.read_text())
    destination = Path(config["destination"]).expanduser()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    host = config["host"]
    if not re.fullmatch(r"[a-zA-Z0-9_.@-]+", host) or host.startswith("-"):
        raise ValueError("Invalid SSH destination")
    options = [
        "-i",
        str(Path(config["identity"]).expanduser()),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "UserKnownHostsFile=" + str(Path(config["known_hosts"]).expanduser()),
    ]

    def remote(command, timeout=300):
        return subprocess.check_output(
            ["ssh", *options, host, command], text=True, timeout=timeout
        ).strip()

    status_path = destination / "status.json"
    with (destination / ".lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        previous = json.loads(status_path.read_text()) if status_path.exists() else {}
        try:
            name = remote(
                "cd /opt/peerpedia && sudo find backups -maxdepth 1 -type f -name 'peerpedia-*.dump' -printf '%f\\n' | sort | tail -n 1"
            )
            if not NAME.fullmatch(name):
                raise ValueError("No completed daily backup exists on the server")
            date = datetime.strptime(name[10:26], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            if (datetime.now(timezone.utc) - date).total_seconds() > 48 * 3600:
                raise ValueError(
                    "Server backup is older than 48 hours; check the daily backup service"
                )
            target = destination / name
            remote_path = "/opt/peerpedia/backups/" + name
            expected = remote("sudo sha256sum " + shlex.quote(remote_path)).split()[0]
            if not re.fullmatch("[0-9a-f]{64}", expected):
                raise ValueError("Invalid remote checksum")
            if not target.exists() or digest(target) != expected:
                # A real restore in a disposable server database precedes replication.
                remote(
                    "cd /opt/peerpedia && sudo sh scripts/restore-check.sh "
                    + shlex.quote("backups/" + name),
                    timeout=600,
                )
                with tempfile.NamedTemporaryFile(
                    dir=destination, prefix=".partial-", delete=False
                ) as output:
                    pending = Path(output.name)
                    try:
                        subprocess.run(
                            ["ssh", *options, host, "sudo cat " + shlex.quote(remote_path)],
                            stdout=output,
                            check=True,
                            timeout=600,
                        )
                        output.flush()
                        os.fsync(output.fileno())
                        if digest(pending) != expected:
                            raise ValueError("Downloaded backup checksum does not match")
                        pending.replace(target)
                    finally:
                        pending.unlink(missing_ok=True)
                target.with_suffix(".dump.sha256").write_text(expected + "  " + name + "\n")
            target.with_suffix(".dump.offsite").write_text(expected + "\n")
            # Server retention is allowed only after the verified local copy exists.
            remote(
                "printf %s "
                + shlex.quote(expected)
                + " | sudo tee "
                + shlex.quote(remote_path + ".offsite")
                + " >/dev/null"
            )
            remote(
                "cd /opt/peerpedia && sudo python3 scripts/backup_retention.py backups --days 7 --keep 3"
            )
            prune(destination, days=30, keep=7)
            atomic_json(
                status_path,
                {
                    "ok": True,
                    "checked_at": datetime.now(timezone.utc).isoformat(),
                    "backup": name,
                    "sha256": expected,
                },
            )
            print("Verified off-server backup: " + name, flush=True)
        except Exception as error:
            atomic_json(
                status_path,
                {
                    "ok": False,
                    "checked_at": datetime.now(timezone.utc).isoformat(),
                    "last_backup": previous.get("backup", previous.get("last_backup")),
                    "error": str(error)[:1000],
                },
            )
            raise


if __name__ == "__main__":
    main(Path(sys.argv[1]).expanduser())
