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
