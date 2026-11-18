"""Private reading state for published papers."""

import json
import math
from django.core.exceptions import ValidationError
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_http_methods
from django.db import transaction
from .models import ReadingProgress, Submission, Paper
from .documents import pages, digest


@require_http_methods(["GET", "POST"])
def progress(request, paper_id):
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
                if "complete" in data:
                    if type(data["complete"]) is not bool:
                        raise ValueError()
                    if data["complete"]:
                        state.completed[chapter["id"]] = digest(chapter["markdown"])
                    else:
                        state.completed.pop(chapter["id"], None)
                # Keep state bounded even after years of deleted chapters.
                state.completed = dict(list(state.completed.items())[-128:])
                state.save()
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
        response = JsonResponse(
            {"chapter": state.chapter, "position": state.position, "completed": state.completed}
        )
    response["Cache-Control"] = "private, no-store"
    response["Vary"] = "Cookie"
    return response
