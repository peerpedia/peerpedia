"""Private reading state for published papers."""

import json
import math
from uuid import UUID
from django.core.exceptions import ValidationError
from django.http import HttpRequest, JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_http_methods
from django.db import transaction
from .models import ReadingProgress, Submission, Paper
from .documents import pages


@require_http_methods(["GET", "POST"])
def progress(request: HttpRequest, paper_id: UUID) -> JsonResponse:
    paper = get_object_or_404(Paper, pk=paper_id, is_hidden=False)
    if request.headers.get("Authorization") or not request.user.is_authenticated:
        return JsonResponse(
            {"error": "Sign in on the website to save reading progress."}, status=403
        )
    with transaction.atomic():
        state, _ = ReadingProgress.objects.select_for_update().get_or_create(
            user=request.user, paper=paper
        )
        if request.method == "POST":
            try:
                data = json.loads(request.body)
                snapshot = get_object_or_404(Submission, pk=data.get("submission"), paper=paper)
                chapter = next(p for p in pages(snapshot) if p["id"] == data.get("chapter"))
                position = data.get("position", 0)
                if (
                    type(position) not in (int, float)
                    or not math.isfinite(position)
                    or not 0 <= position <= 1
                ):
                    raise ValueError()
                state.chapter, state.position = chapter["id"], position
                state.save(update_fields=["chapter", "position", "updated_at"])
            except (
                ValueError,
                TypeError,
                KeyError,
                AttributeError,
                StopIteration,
                ValidationError,
            ):
                return JsonResponse(
                    {"error": "Choose a chapter and valid reading position."}, status=400
                )
        response = JsonResponse({"chapter": state.chapter, "position": state.position})
    response["Cache-Control"] = "private, no-store"
    response["Vary"] = "Cookie"
    return response
