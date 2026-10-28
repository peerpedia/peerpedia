"""Deploy only the current main commit after its push workflow passes every gate.

Run from a trusted checkout with GitHub CLI authentication and existing SSH access.
No production credentials are stored in GitHub Actions.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

REPOSITORY = "peerpedia/peerpedia"
REQUIRED_JOBS = {"test", "browser", "quality", "security"}
ROOT = Path(__file__).resolve().parent.parent
BACKUP_PATH_FILTER = (
    r"sed -n -e 's/^Backup written to \([^ ]*\.dump\).*$/\1/p' -e t -e '/^backups\/.*\.dump$/p'"
)


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def github(path):
    return json.loads(run("gh", "api", f"repos/{REPOSITORY}/{path}"))


def verified_release(sha, read=github):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Use the full, forty-character commit SHA.")
    branch = read("branches/main")
    if branch["commit"]["sha"] != sha:
        raise ValueError("The requested commit is not the current main commit.")
    runs = read(
        f"actions/workflows/tests.yml/runs?head_sha={sha}&event=push&branch=main&per_page=20"
    )["workflow_runs"]
    if not runs:
        raise ValueError("No main push test run exists for this exact commit.")
    latest = max(runs, key=lambda item: item["id"])
    if latest["status"] != "completed" or latest["conclusion"] != "success":
        raise ValueError("The latest main push workflow has not passed. Nothing was deployed.")
    jobs = read(f"actions/runs/{latest['id']}/jobs?per_page=100")["jobs"]
    successful = {job["name"] for job in jobs if job["conclusion"] == "success"}
    if not REQUIRED_JOBS <= successful:
        raise ValueError("Backend, browser, quality, and security gates must all pass.")
    return latest["html_url"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sha")
    parser.add_argument("--host", required=True)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--known-hosts", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_.@-]+", args.host) or args.host.startswith("-"):
        parser.error("Invalid SSH destination.")
    evidence = verified_release(args.sha)
    print(f"All release gates passed: {evidence}", flush=True)
    if args.check_only:
        return
    options = [
        "-i",
        str(args.identity.expanduser()),
        "-o",
        f"UserKnownHostsFile={args.known_hosts.expanduser()}",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
    ]
    with tempfile.TemporaryDirectory(prefix="peerpedia-release-") as folder:
        archive = Path(folder) / "source.tar.gz"
        subprocess.run(
            ["git", "archive", "--format=tar.gz", f"--output={archive}", args.sha],
            cwd=ROOT,
            check=True,
        )
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        destination = f"/tmp/peerpedia-release-{args.sha}.tar.gz"
        subprocess.run(["scp", *options, str(archive), f"{args.host}:{destination}"], check=True)
        # Check once more immediately before changing the server, including main advancement.
        verified_release(args.sha)
        script = rf"""set -eu
cd /opt/peerpedia
exec 9>/tmp/peerpedia-release.lock
flock -n 9
printf '%s  %s\n' {shlex.quote(digest)} {shlex.quote(destination)} | sha256sum -c -
backup=$(sudo sh scripts/backup.sh | {BACKUP_PATH_FILTER})
test -n "$backup"
sudo sh scripts/restore-check.sh "$backup"
sudo docker image tag peerpedia-web:local peerpedia-web:before-{args.sha[:12]}
sudo tar -xzf {shlex.quote(destination)} -C /opt/peerpedia
sudo docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker compose build web renderer
sudo docker compose run --rm migrate
sudo docker compose up -d --no-deps --remove-orphans renderer web
for attempt in $(seq 1 30); do
  if sudo docker inspect --format '{{{{.State.Health.Status}}}}' peerpedia-web-1 | grep -qx healthy &&
     sudo docker inspect --format '{{{{.State.Health.Status}}}}' peerpedia-renderer-1 | grep -qx healthy; then
    sudo docker compose exec -T web python manage.py build_reading_copies
    sudo docker compose exec -T web python manage.py verify_history
    sudo docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    printf '%s\n' {args.sha} | sudo tee /opt/peerpedia/.release >/dev/null
    exit 0
  fi
  sleep 2
done
printf '%s\n' 'Deployment health check failed; previous image retained. Inspect before any rollback.' >&2
exit 1
"""
        subprocess.run(
            ["ssh", *options, args.host, "sh", "-s"], input=script, text=True, check=True
        )


if __name__ == "__main__":
    main()
