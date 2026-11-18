"""Measure complete HTTP renders of a downloaded Peerpedia paper on a running renderer."""

import argparse
import hashlib
import json
from pathlib import Path
from time import perf_counter
from urllib.request import ProxyHandler, Request, build_opener


def manuscript(folder: Path) -> dict:
    manifest = json.loads((folder / "paper.json").read_text(encoding="utf-8"))
    chapters = manifest.get("chapters", [])
    pages = [
        {"id": page["id"], "markdown": (folder / page["file"]).read_text(encoding="utf-8")}
        for page in chapters
    ]
    if not pages:
        pages.append({"id": "main", "markdown": (folder / "paper.md").read_text(encoding="utf-8")})
    bibliography = manifest.get("bibliography")
    return {
        "pages": pages,
        "numberSections": bool(chapters),
        "bibliography": (folder / bibliography).read_text(encoding="utf-8") if bibliography else "",
        "diagrams": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paper", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8765/render")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--budget", type=float, default=2.0, help="Maximum seconds per run")
    args = parser.parse_args()
    if args.runs < 1 or args.budget <= 0:
        parser.error("runs and budget must be positive")
    payload = manuscript(args.paper)
    request = Request(args.url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
    renderer = build_opener(ProxyHandler({}))
    slowest = 0.0
    expected_ids = [page["id"] for page in payload["pages"]]
    checksum = None
    for run in range(1, args.runs + 1):
        start = perf_counter()
        with renderer.open(request, timeout=120) as response:
            result = json.load(response)
        elapsed = perf_counter() - start
        if "error" in result:
            raise SystemExit(result["error"]["message"])
        pages = result["result"]["pages"]
        if [page["id"] for page in pages] != expected_ids or not all(
            page.get("nativeHtml") and not page["blocks"] for page in pages
        ):
            raise SystemExit("Expected complete native HTML for every chapter.")
        digest = hashlib.sha256()
        for page in pages:
            data = page["html"].encode()
            digest.update(len(data).to_bytes(8, "big"))
            digest.update(data)
        if checksum is not None and digest.hexdigest() != checksum:
            raise SystemExit("Rendered HTML changed between identical requests.")
        checksum = digest.hexdigest()
        slowest = max(slowest, elapsed)
        print(f"Run {run}: {elapsed:.3f}s for {len(pages)} chapters, HTML sha256 {checksum}")
    return int(slowest > args.budget)


if __name__ == "__main__":
    raise SystemExit(main())
