"""Durable BM output. Reading a frozen snapshot does not need a live compiler."""

import hashlib
import re
from html import escape
from html.parser import HTMLParser
from functools import lru_cache
from django.conf import settings
from .models import RenderedSubmission, Submission


@lru_cache(maxsize=1)
def renderer_version() -> str:
    digest = hashlib.sha256()
    for name in (
        "editor/package-lock.json",
        "editor/dialect.js",
        "editor/chapter-title.js",
        "editor/render-document.mjs",
        "editor/passage-html.mjs",
        "publishing/artifacts.py",
    ):
        digest.update(name.encode())
        digest.update((settings.BASE_DIR / name).read_bytes())
    digest.update(settings.STATIC_URL.encode())
    return digest.hexdigest()


def snapshot_page(page: dict, reader: str) -> dict:
    page = dict(page)
    bindings = page.pop("snapshot_links", None)
    if bindings is None:  # Also accept an older render worker during an upgrade.
        page["html"] = reader_links(page["html"], reader)
    elif bindings:
        source = page["html"].encode("utf-8")
        chunks = []
        cursor = 0
        for start, width, href in bindings:
            chunks.extend((source[cursor:start], escape(reader + href, quote=True).encode("utf-8")))
            cursor = start + width
        chunks.append(source[cursor:])
        page["html"] = b"".join(chunks).decode("utf-8")
    return page


def store(submission: Submission, result: dict, version: str) -> dict:
    result = {
        **result,
        "pages": [snapshot_page(page, submission.read_url) for page in result["pages"]],
        "targets": [
            {**target, "url": submission.read_url + target["url"]} for target in result["targets"]
        ],
    }
    artifact, _ = RenderedSubmission.objects.get_or_create(
        submission=submission,
        renderer_version=version,
        defaults={"source_hash": submission.hash, "result": result},
    )
    return artifact.result


def load(submission: Submission, *, refresh: bool = False) -> dict:
    # Keep the last explicitly built version across BM upgrades. Rebuild with the
    # management command, never make ordinary reading depend on an upgrade.
    query = RenderedSubmission.objects.filter(submission=submission, source_hash=submission.hash)
    if refresh:
        query = query.filter(renderer_version=renderer_version())
    artifact = query.order_by("-created_at", "-pk").first()
    if artifact:
        return artifact.result
    from .bananamark import request
    from .documents import pages

    result = request(
        pages=pages(submission),
        bibliography=submission.bibliography,
        numberSections=bool(submission.chapters),
        diagrams=True,
        snapshotLinks=True,
    )
    return store(submission, result, renderer_version())


def reader_links(html, reader):
    replacements = []
    offsets = [0]
    for line in html.split("\n"):
        offsets.append(offsets[-1] + len(line) + 1)

    class Links(HTMLParser):
        def handle_starttag(self, tag, attrs):
            href = dict(attrs).get("href", "")
            if tag != "a" or not href.startswith("?chapter="):
                return
            raw = self.get_starttag_text()
            rewritten = re.sub(
                r'(\shref=")[^"]*"',
                lambda match: match[1] + escape(reader + href, quote=True) + '"',
                raw,
            )
            line, column = self.getpos()
            start = offsets[line - 1] + column
            replacements.append((start, start + len(raw), rewritten))

    Links(convert_charrefs=False).feed(html)
    for start, end, value in reversed(replacements):
        html = html[:start] + value + html[end:]
    return html


def references(submission):
    from .documents import pages
    from .references import ReferenceDocument

    return ReferenceDocument(
        pages(submission), reader_url=submission.read_url, result=load(submission)
    )
