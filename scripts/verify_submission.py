"""Verify downloaded submission.json and submission.md using Python's standard library."""

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("manifest", type=Path)
parser.add_argument("markdown", type=Path)
args = parser.parse_args()
record = json.loads(args.manifest.read_text(encoding="utf-8"))
manifest = record["manifest"]
if manifest.get("format") not in {
    "peerpedia-submission-v1",
    "peerpedia-submission-v2",
    "peerpedia-submission-v3",
    "peerpedia-submission-v4",
}:
    raise SystemExit("Unknown manifest format")
source = args.markdown.read_bytes()
if manifest["format"] == "peerpedia-submission-v4":
    if not zipfile.is_zipfile(args.markdown):
        raise SystemExit("For v4, pass the complete downloaded ZIP as the second argument.")
    with zipfile.ZipFile(args.markdown) as archive:
        info = json.loads(archive.read("paper.json"))
        specs = info["chapters"]
        if [(p["id"], p["title"]) for p in specs] != [
            (p["id"], p["title"]) for p in manifest["chapters"]
        ]:
            raise SystemExit("FAIL: Chapter order or titles do not match")
        texts = []
        for page, expected in zip(specs, manifest["chapters"]):
            text = archive.read(page["file"])
            if hashlib.sha256(text).hexdigest() != expected["markdown_sha256"]:
                raise SystemExit("FAIL: Chapter does not match the manifest")
            texts.append(text)
        source = b"\n\n".join(texts) if texts else archive.read("paper.md")
        if (
            hashlib.sha256(archive.read("references.bib")).hexdigest()
            != manifest["bibliography_sha256"]
        ):
            raise SystemExit("FAIL: Bibliography does not match the manifest")
if hashlib.sha256(source).hexdigest() != manifest["markdown_sha256"]:
    raise SystemExit("FAIL: Markdown does not match the manifest")
canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
    "utf-8"
)
if hashlib.sha256(canonical).hexdigest() != record["hash"]:
    raise SystemExit("FAIL: Manifest does not match the submission hash")
print("Verified:", record["hash"])
