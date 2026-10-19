"""Run one bounded compilation at a time outside web request workers."""

import json
import time
from datetime import timedelta
from urllib.error import URLError
from urllib.request import Request, ProxyHandler, build_opener

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from publishing.diagram_cache import enqueue, key_for, sanitize
from publishing.models import DiagramArtifact, Submission


def open_renderer(request, timeout):
    return build_opener(ProxyHandler({})).open(request, timeout=timeout)


def claim():
    now = timezone.now()
    with transaction.atomic():
        DiagramArtifact.objects.filter(
            status="processing", attempts__gte=3, updated_at__lt=now - timedelta(minutes=2)
        ).update(
            status="error",
            error="Diagram worker repeatedly stopped. Its source is preserved.",
            updated_at=now,
        )
        item = (
            DiagramArtifact.objects.select_for_update(skip_locked=True)
            .filter(
                Q(status="pending", available_at__lte=now)
                | Q(status="processing", updated_at__lt=now - timedelta(minutes=2))
            )
            .order_by("available_at")
            .first()
        )
        if not item:
            return None
        item.status, item.updated_at = "processing", now
        item.attempts += 1
        item.save(update_fields=["status", "updated_at", "attempts"])
        return item


def process_one():
    item = claim()
    if item is None:
        return False
    if item.key != key_for(item.source):
        # An upgrade must not write new-engine output under an old cache key.
        DiagramArtifact.objects.filter(
            key=item.key, status="processing", attempts=item.attempts
        ).update(
            status="obsolete",
            error="The diagram renderer changed. Reload this page.",
            updated_at=timezone.now(),
        )
        return True
    try:
        request = Request(
            settings.DIAGRAM_RENDERER_URL.rstrip("/") + "/compile",
            data=json.dumps({"source": item.source}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with open_renderer(request, timeout=40) as response:
            raw = response.read(2100001)
        if len(raw) > 2100000:
            raise ValueError("Diagram output is too large.")
        data = json.loads(raw)
        if data.get("error"):
            item.status = "error"
            item.error = str(data["error"])[:250]
        else:
            item.svg = sanitize(data["result"])
            item.status = "ready"
            item.error = ""
    except (URLError, TimeoutError, OSError):
        item.status = "pending" if item.attempts < 3 else "error"
        item.error = "Diagram rendering is temporarily unavailable. Its source is preserved."
        item.available_at = timezone.now() + timedelta(seconds=30)
    except (ValueError, KeyError, TypeError):
        item.status = "error"
        item.error = "The diagram could not be rendered safely. Check its source."
    # A stale worker cannot overwrite a job reclaimed after its lease expired.
    DiagramArtifact.objects.filter(
        key=item.key, status="processing", attempts=item.attempts
    ).update(
        status=item.status,
        svg=item.svg,
        error=item.error,
        available_at=item.available_at,
        updated_at=timezone.now(),
    )
    return True


class Command(BaseCommand):
    help = (
        "Render queued diagrams; --backfill queues existing public snapshots without changing them."
    )

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")
        parser.add_argument("--backfill", action="store_true")
        parser.add_argument("--retry-errors", action="store_true")

    def handle(self, *args, **options):
        if options["backfill"]:
            for submission in Submission.objects.filter(paper__is_hidden=False).iterator(
                chunk_size=100
            ):
                enqueue(submission)
        if options["retry_errors"]:
            DiagramArtifact.objects.filter(status="error").exclude(source="").update(
                status="pending", attempts=0, available_at=timezone.now()
            )
        while True:
            worked = process_one()
            if not worked:
                if options["once"]:
                    return
                time.sleep(2)
