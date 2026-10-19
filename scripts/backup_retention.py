"""Remove expired managed backups only after a newer off-server receipt exists."""

import argparse
import hashlib
from pathlib import Path
import re
import time

NAME = re.compile(r"peerpedia-\d{8}T\d{6}Z\.dump\Z")


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def candidates(directory, days, keep, now=None):
    """Legacy/unmanaged files and unreplicated recent backups are never pruned."""
    now = time.time() if now is None else now
    files = sorted(
        (
            p
            for p in directory.iterdir()
            if NAME.fullmatch(p.name) and p.is_file() and not p.is_symlink()
        ),
        reverse=True,
    )
    receipts = []
    for path in files:
        receipt = path.with_suffix(".dump.offsite")
        if receipt.is_file() and receipt.read_text().strip() == digest(path):
            receipts.append(path.name)
    if not receipts:
        return []
    watermark = max(receipts)
    return [
        p
        for p in files[keep:]
        if p.name < watermark
        and p.with_suffix(".dump.sha256").is_file()
        and p.stat().st_mtime < now - days * 86400
    ]


def prune(directory, days=30, keep=7):
    for path in candidates(directory, days, keep):
        path.unlink()
        for suffix in (".dump.sha256", ".dump.offsite"):
            path.with_suffix(suffix).unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--keep", type=int, default=7)
    args = parser.parse_args()
    if args.days < 7 or args.keep < 3:
        parser.error("Retain at least seven days and three backups.")
    prune(args.directory, args.days, args.keep)
