"""Private reading state and public, frozen citation discovery."""

import json
import math
import uuid
from django.core.exceptions import ValidationError
from accounts.security import limited
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_http_methods, require_GET
from django.db import transaction
from .models import ReadingProgress, Submission, Paper
from .queries import search_papers
from .documents import pages, digest
from .references import ReferenceDocument


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


@require_GET
@limited("reference_search", limit=120, seconds=60)
def reference_search(request):
    snapshot_id = request.GET.get("submission")
    if snapshot_id:
        try:
            snapshot_id = uuid.UUID(snapshot_id)
        except ValueError:
            return JsonResponse({"error": "Use a submission UUID."}, status=400)
        submission = get_object_or_404(Submission, pk=snapshot_id, paper__is_hidden=False)
        reader = submission.read_url
        refs = ReferenceDocument(pages(submission), submission.bibliography, reader)
        return JsonResponse(
            {
                "targets": refs.targets,
                "chapters": [
                    {"id": p["id"], "title": p["title"], "url": reader + "?chapter=" + p["id"]}
                    for p in pages(submission)
                ],
            }
        )
    results = []
    for paper in search_papers(request.GET.get("q", "")[:200], "", "latest")[:20]:
        s = paper.current
        results.append(
            {
                "id": str(paper.pk),
                "paper_identifier": paper.public_id,
                "submission": str(s.pk),
                "snapshot_identifier": s.public_id,
                "title": s.title,
                "authors": s.authors,
                "year": s.created_at.year,
                "url": request.build_absolute_uri(s.read_url),
                "hash": s.hash,
            }
        )
    return JsonResponse({"papers": results})
