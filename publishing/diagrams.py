"""A worker-only CSP permits WebAssembly without weakening document policies."""

import json

from django.http import HttpResponse
from django.templatetags.static import static
from django.views.decorators.http import require_safe


@require_safe
def worker(request):
    assets = {
        "engine": static("vendor/tikzjax/peerpedia-engine.js"),
        "wasm": static("vendor/tikzjax/tex.wasm"),
        "core": static("vendor/tikzjax/core.bin"),
    }
    response = HttpResponse(
        "self.diagramAssets="
        + json.dumps(assets)
        + ";importScripts("
        + json.dumps(static("diagram-worker.js"))
        + ");",
        content_type="application/javascript",
    )
    response["Cache-Control"] = "no-cache"
    return response


def visible_artifact(key, include_svg=False):
    import re
    from django.http import Http404
    from django.shortcuts import get_object_or_404
    from .models import DiagramArtifact

    if not re.fullmatch(r"[0-9a-f]{64}", key):
        raise Http404
    query = (
        DiagramArtifact.objects.filter(submissions__paper__is_hidden=False)
        .distinct()
        .defer("source")
    )
    if not include_svg:
        query = query.defer("svg")
    return get_object_or_404(query, key=key)


@require_safe
def status(request, key):
    from django.http import JsonResponse
    from django.urls import reverse

    item = visible_artifact(key)
    response = JsonResponse(
        {
            "status": "error" if item.status == "obsolete" else item.status,
            "url": reverse("diagram_svg", args=[key]) if item.status == "ready" else None,
            "error": item.error if item.status in {"error", "obsolete"} else "",
        }
    )
    response["Cache-Control"] = "no-store"
    return response


@require_safe
def svg(request, key):
    from django.http import Http404, HttpResponseNotModified

    item = visible_artifact(key, include_svg=True)
    if item.status != "ready":
        raise Http404
    etag = '"' + key + '"'
    response = (
        HttpResponseNotModified()
        if request.headers.get("If-None-Match") == etag
        else HttpResponse(item.svg, content_type="image/svg+xml")
    )
    response["ETag"] = etag
    response["Cache-Control"] = "public, max-age=86400"
    response["X-Content-Type-Options"] = "nosniff"
    return response
