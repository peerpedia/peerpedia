"""Read-only recovery of private drafts saved before the web editor retired."""

import io
import json
import zipfile
from uuid import UUID

from django.core.serializers.json import DjangoJSONEncoder
from django.db.models import Q, QuerySet
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_safe

from accounts.models import User
from accounts.security import verified_required
from .documents import archive
from .models import Draft
from .subjects import METADATA_FIELDS


def archived_drafts(owner: User) -> QuerySet[Draft]:
    return Draft.objects.filter(owner=owner).filter(
        Q(paper__isnull=True) | Q(paper__is_hidden=False)
    )


@never_cache
@verified_required
@require_safe
def listing(request: HttpRequest) -> HttpResponse:
    drafts = archived_drafts(request.user).defer("markdown", "chapters", "bibliography")
    return render(request, "publishing/drafts.html", {"drafts": drafts})


@never_cache
@verified_required
@require_safe
def detail(request: HttpRequest, draft_id: UUID) -> HttpResponse:
    get_object_or_404(archived_drafts(request.user).only("id"), pk=draft_id)
    return redirect("drafts")


@never_cache
@verified_required
@require_safe
def export(request: HttpRequest, draft_id: UUID) -> HttpResponse:
    draft = get_object_or_404(archived_drafts(request.user), pk=draft_id)
    info = {key: draft.data[key] for key in METADATA_FIELDS if key in draft.data}
    chapters = [{**page, "title": page.get("title", "")} for page in draft.chapters]
    output = io.BytesIO(archive(chapters, draft.bibliography, draft.markdown, info))
    details = {
        "id": draft.pk,
        "paper": draft.paper_id,
        "base": draft.base_id,
        "pull_request": draft.pull_request_id,
        "pr_head": draft.pr_head_id,
        "submitted": draft.submitted_id,
        "revision": draft.revision,
        "updated_at": draft.updated_at,
        "scope_key": draft.scope_key,
        "section": draft.section,
        "data": draft.data,
    }
    with zipfile.ZipFile(output, "a", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(
            "draft.json", json.dumps(details, cls=DjangoJSONEncoder, ensure_ascii=False, indent=2)
        )
        if chapters:
            bundle.writestr("paper.md", draft.markdown)
    response = HttpResponse(output.getvalue(), content_type="application/zip")
    response["Content-Disposition"] = f'attachment; filename="peerpedia-draft-{draft.pk}.zip"'
    return response
