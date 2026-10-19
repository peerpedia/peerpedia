"""Verify downloaded submission.json and submission.md using Python's standard library."""

import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("manifest", type=Path)
parser.add_argument("markdown", type=Path)
args = parser.parse_args()
record = json.loads(args.manifest.read_text(encoding="utf-8"))
manifest = record["manifest"]
if manifest.get("format") not in {"peerpedia-submission-v1", "peerpedia-submission-v2"}:
    raise SystemExit("Unknown manifest format")
if hashlib.sha256(args.markdown.read_bytes()).hexdigest() != manifest["markdown_sha256"]:
    raise SystemExit("FAIL: Markdown does not match the manifest")
canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
    "utf-8"
)
if hashlib.sha256(canonical).hexdigest() != record["hash"]:
    raise SystemExit("FAIL: Manifest does not match the submission hash")
print("Verified:", record["hash"])
