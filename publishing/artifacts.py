"""Durable BM output. Reading a frozen snapshot does not need a live compiler."""

import hashlib
from functools import lru_cache
from django.conf import settings
from django.utils import timezone
from .models import RenderedSubmission, Submission


def renderer_version() -> str:
    return _renderer_version(settings.STATIC_URL)


@lru_cache(maxsize=2)
def _renderer_version(static_url: str) -> str:
    digest = hashlib.sha256()
    for name in (
        "editor/package-lock.json",
        "editor/dialect.js",
        "editor/chapter-title.js",
        "editor/render-document.mjs",
        "publishing/artifacts.py",
    ):
        digest.update(name.encode())
        digest.update((settings.BASE_DIR / name).read_bytes())
    digest.update(static_url.encode())
    return digest.hexdigest()


def store(submission: Submission, result: dict, version: str) -> dict:
    reader_url = submission.read_url
    result = {
        **result,
        "targets": [{**target, "url": reader_url + target["url"]} for target in result["targets"]],
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
    copies = RenderedSubmission.objects.filter(
        submission=submission, source_hash=submission.hash
    ).order_by("-created_at", "-pk")
    artifact = (
        copies.filter(renderer_version=renderer_version()).first() if refresh else copies.first()
    )
    if artifact:
        if refresh and copies.values_list("pk", flat=True).first() != artifact.pk:
            # Re-select a cached build as the current reading copy. Its HTML and
            # the immutable submission are independent of this build timestamp.
            copies.filter(pk=artifact.pk).update(created_at=timezone.now())
        return artifact.result
    from .bananamark import request
    from .documents import pages

    result = request(
        pages=pages(submission),
        bibliography=submission.bibliography,
        numberSections=bool(submission.chapters),
        diagrams=True,
    )
    return store(submission, result, renderer_version())


def references(submission):
    from .documents import pages
    from .references import ReferenceDocument

    return ReferenceDocument(
        pages(submission), reader_url=submission.read_url, result=load(submission)
    )
