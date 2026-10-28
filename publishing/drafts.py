"""Private working copies. Publication still goes through the frozen-history services."""

import json
from functools import wraps
from django import forms
from django.conf import settings
from django.contrib import messages
from django.core import signing
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import transaction
from django.db.models import Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_POST, require_http_methods
from accounts.models import User
from accounts.security import verified_required, limited
from .models import Draft, Paper, PullRequest
from .forms import UploadForm
from .licensing import PublicationConsentForm, agreement_required
from .services import publish, propose
from .subjects import METADATA_FIELDS
from . import sections, documents, publication
from .comparisons import diff_lines, metadata_diff


class DraftForm(UploadForm):
    markdown = forms.CharField(required=False, strip=False, widget=forms.Textarea)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, initial_publication=True, **kwargs)
        del self.fields["file"]
        del self.fields["base"]
        self.fields["explanation"].widget = forms.Textarea(
            attrs={
                "rows": 3,
                "placeholder": "Correct the sign in Equation 2 and explain the assumption used in its proof.",
            }
        )
        self.fields["explanation"].help_text = publication.CHANGE[2]
        for field in self.fields.values():
            field.required = False

    def clean_markdown(self):
        source = self.cleaned_data["markdown"]
        try:
            size = len(source.encode("utf-8"))
        except UnicodeEncodeError:
            raise forms.ValidationError("Use valid UTF-8 text.")
        if size > settings.MAX_MARKDOWN_BYTES:
            raise forms.ValidationError("Drafts can contain up to 1 MB of Markdown.")
        if "\x00" in source:
            raise forms.ValidationError("Use a text document without NUL characters.")
        return source


FIELDS = (*METADATA_FIELDS, "explanation")


def private(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        response = view(request, *args, **kwargs)
        response["Cache-Control"] = "no-store, private"
        response["Vary"] = "Cookie"
        return response

    return wrapped


def owned(request, pk, lock=False):
    qs = Draft.objects.select_for_update(of=("self",)) if lock else Draft.objects
    return get_object_or_404(
        qs.select_related("paper__current", "base", "pull_request__head"),
        Q(paper__isnull=True) | Q(paper__is_hidden=False),
        pk=pk,
        owner=request.user,
    )


def state(draft):
    latest = draft.paper.current if draft.paper_id else None
    return {
        "id": str(draft.pk),
        "revision": draft.revision,
        "data": draft.data,
        "is_section": bool(draft.section),
        "markdown": draft.markdown,
        "chapters": draft.chapters,
        "bibliography": draft.bibliography,
        "updated_at": draft.updated_at.isoformat(),
        "base": str(draft.base_id) if draft.base_id else None,
        "latest": str(latest.pk) if latest else None,
        "stale": bool(latest and latest.pk != draft.base_id),
        "submitted_url": draft.submitted.get_absolute_url() if draft.submitted_id else None,
    }


def payload(request):
    try:
        data = json.loads(request.body)
        if not isinstance(data, dict) or type(data.get("revision")) is not int:
            raise ValueError()
        return data
    except (ValueError, UnicodeDecodeError):
        return None


def conflict(draft):
    return JsonResponse(
        {
            "error": "This draft changed in another tab or device. Choose which copy to continue with.",
            "draft": state(draft),
        },
        status=409,
    )


@private
@verified_required
@require_http_methods(["GET", "POST"])
def start(request, paper_id=None, pr_id=None):
    paper = (
        get_object_or_404(Paper, pk=paper_id, is_hidden=False, current__isnull=False)
        if paper_id
        else None
    )
    pr = None
    if pr_id:
        pr = get_object_or_404(
            PullRequest.objects.select_related("paper__current", "head"),
            pk=pr_id,
            contributor=request.user,
            paper__is_hidden=False,
        )
        paper = pr.paper
        if pr.head.status != "pending":
            messages.info(
                request,
                "This PR is closed. Edit the latest accepted paper to propose another change.",
            )
            return redirect("edit_paper", paper_id=paper.pk)
    source = pr.head if pr else paper.current if paper else None
    section = pr.head.pr_commit.section if pr else {}
    scope = (
        (
            (section.get("chapter", "") + ":" if section.get("chapter") else "")
            + section.get("anchor", "")
        )
        if pr
        else request.GET.get("scope", "")[:200]
    )
    if scope and not pr:
        if not source or request.GET.get("version") != str(source.pk):
            messages.error(
                request,
                "The paper changed since you opened it. Choose a section from the latest version.",
            )
            return redirect(paper.read_url) if paper else redirect("browse")
        chapter_id = request.GET.get("chapter", "")
        chapter = (
            next((p for p in documents.pages(source) if p["id"] == chapter_id), None)
            if source.chapters
            else None
        )
        if source.chapters and chapter is None:
            messages.error(request, "Choose a section from an existing chapter.")
            return redirect(paper.read_url)
        section = sections.find(chapter["markdown"] if chapter else source.markdown, scope)
        if chapter and section:
            section["chapter"] = chapter["id"]
            scope = chapter["id"] + ":" + scope
        if not section:
            messages.error(
                request,
                "That section is no longer available. Choose a section from the latest paper.",
            )
            return redirect(paper.read_url)
    if request.method == "GET":
        if paper:
            existing = Draft.objects.filter(
                owner=request.user, paper=paper, scope_key=scope, submitted__isnull=True
            ).first()
            if existing:
                messages.info(
                    request,
                    "Resumed your draft."
                    if existing.pull_request_id == (pr.pk if pr else None)
                    else "Resumed your existing draft for this paper. Finish or discard it before starting a different change.",
                )
                return redirect(reverse("editor", args=[existing.pk]) + section_query(request))
        return render(request, "publishing/editor_start.html", {"paper": paper})
    # Serialize first creation per user, including concurrent requests from tabs.
    with transaction.atomic():
        User.objects.select_for_update().get(pk=request.user.pk)
        if paper:
            existing = Draft.objects.filter(
                owner=request.user, paper=paper, scope_key=scope, submitted__isnull=True
            ).first()
            if existing:
                return redirect(reverse("editor", args=[existing.pk]) + section_query(request))
        source = pr.head if pr else paper.current if paper else None
        data = (
            {key: getattr(source, key) for key in METADATA_FIELDS}
            if source
            else {
                "title": "",
                "authors": "",
                "abstract": "",
                "primary_category": "",
                "secondary_categories": [],
            }
        )
        data["explanation"] = ""
        draft = Draft.objects.create(
            owner=request.user,
            paper=paper,
            base=source.base if pr else source,
            pull_request=pr,
            pr_head=source if pr else None,
            scope_key=scope,
            section=section,
            data=data,
            chapters=source.chapters if source and not section else [],
            bibliography=source.bibliography if source else "",
            markdown=sections.extract(
                section_source(source.base, section), section, section_source(source, section)
            )
            if section and pr
            else sections.text(section_source(source, section), section)
            if section
            else source.markdown
            if source
            else "",
        )
    return redirect(reverse("editor", args=[draft.pk]) + section_query(request))


def section_query(request):
    from urllib.parse import urlencode

    query = {k: request.GET[k][:200] for k in ("section", "chapter") if request.GET.get(k)}
    return "?" + urlencode(query) if query else ""


@private
@verified_required
def listing(request):
    drafts = request.user.drafts.filter(submitted__isnull=True).filter(
        Q(paper__isnull=True) | Q(paper__is_hidden=False)
    )
    return render(request, "publishing/drafts.html", {"drafts": drafts})


@private
@verified_required
def editor(request, draft_id):
    draft = owned(request, draft_id)
    if draft.submitted_id:
        return redirect(draft.submitted.get_absolute_url())
    initial = state(draft)
    is_revision = bool(
        draft.paper_id or getattr(getattr(draft, "workingcopy", None), "mirror_id", None)
    )
    initial["publication_requirements"] = publication.requirements(is_revision)
    initial["publication_issues"] = []
    if request.GET.get("check") == "1":
        try:
            check = publication.form(
                draft.data,
                full_markdown(draft),
                is_revision=is_revision,
                base=draft.base_id
                or getattr(getattr(draft, "workingcopy", None), "base", {})
                .get("manifest", {})
                .get("submission_id"),
            )
            initial["publication_issues"] = publication.issues(check)
        except ValidationError as error:
            initial["publication_issues"] = [
                {"field": "markdown", "label": "Paper text", "message": " ".join(error.messages)}
            ]
    initial.update(
        save_url=reverse("draft_save", args=[draft.pk]),
        preview_url=reverse("draft_preview", args=[draft.pk]),
        export_url=reverse("draft_export", args=[draft.pk]),
        rebase_url=reverse("draft_rebase", args=[draft.pk]),
        user_id=request.user.pk,
        section=request.GET.get("section", "")[:200],
        chapter=request.GET.get("chapter", ""),
        references_url=reverse("reference_search"),
    )
    pending = (
        PullRequest.objects.filter(
            paper_id=draft.paper_id, contributor=request.user, head__decision__isnull=True
        )
        if draft.paper_id
        else []
    )
    return render(
        request,
        "publishing/editor.html",
        {
            "draft": draft,
            "initial": initial,
            "form": DraftForm(initial=draft.data),
            "pending": pending,
        },
    )


@private
@verified_required
@require_POST
@limited("draft_save", limit=240, seconds=60)
def save(request, draft_id):
    data = payload(request)
    if data is None:
        return JsonResponse({"error": "Invalid draft request."}, status=400)
    with transaction.atomic():
        draft = owned(request, draft_id, lock=True)
        if draft.submitted_id or draft.revision != data["revision"]:
            return conflict(draft)
        if not isinstance(data.get("data"), dict) or not isinstance(data.get("markdown"), str):
            return JsonResponse({"error": "Invalid draft contents."}, status=400)
        fields = {
            key: data["data"].get(key, [] if key == "secondary_categories" else "")
            for key in FIELDS
        }
        if any(
            not isinstance(v, list if k == "secondary_categories" else str)
            for k, v in fields.items()
        ):
            return JsonResponse({"error": "Invalid paper details."}, status=400)
        try:
            json.dumps(fields, ensure_ascii=False).encode("utf-8")
        except UnicodeEncodeError:
            return JsonResponse({"error": "Use valid UTF-8 paper details."}, status=400)
        if draft.section:
            if any(
                fields[k] != draft.data.get(k, [] if k == "secondary_categories" else "")
                for k in METADATA_FIELDS
            ):
                return JsonResponse(
                    {"error": "Use the full-paper editor to change paper details."}, status=400
                )
        form = DraftForm({**fields, "markdown": data["markdown"]})
        if not form.is_valid():
            return JsonResponse(
                {"error": "Check the draft contents.", "fields": form.errors.get_json_data()},
                status=400,
            )
        chapters = data.get("chapters", draft.chapters)
        bibliography = data.get("bibliography", draft.bibliography)
        try:
            documents.validate(chapters, bibliography, allow_empty=True)
            if draft.section and (chapters or bibliography != draft.bibliography):
                raise ValidationError("Use the full-paper editor to change chapters or references.")
            if chapters and form.cleaned_data["markdown"] != documents.combined(chapters):
                raise ValidationError("The saved chapters do not match the complete document.")
        except ValidationError as error:
            return JsonResponse({"error": " ".join(error.messages)}, status=400)
        draft.chapters, draft.bibliography = chapters, bibliography
        draft.data = {key: form.cleaned_data[key] for key in FIELDS}
        draft.markdown = form.cleaned_data["markdown"]
        draft.revision += 1
        draft.save(
            update_fields=["data", "markdown", "chapters", "bibliography", "revision", "updated_at"]
        )
    return JsonResponse(state(draft))


@private
@verified_required
@require_POST
@limited("draft_preview", limit=120, seconds=60)
def preview(request, draft_id):
    draft = owned(request, draft_id)
    data = payload(request)
    source = data.get("markdown") if data else None
    try:
        size = (
            len(source.encode("utf-8"))
            if isinstance(source, str)
            else settings.MAX_MARKDOWN_BYTES + 1
        )
    except UnicodeEncodeError:
        size = settings.MAX_MARKDOWN_BYTES + 1
    if size > settings.MAX_MARKDOWN_BYTES:
        return JsonResponse({"error": "Preview accepts up to 1 MB of Markdown."}, status=400)
    try:
        chapters = data.get("chapters", [])
        bibliography = data.get("bibliography", "")
        documents.validate(chapters, bibliography, allow_empty=True)
        from .references import ReferenceDocument

        line_offset = 0
        if draft.section:
            draft.markdown = source
            chapters = full_chapters(draft)
            bibliography = draft.bibliography
            chapter = draft.section.get("chapter", "main")
            context = section_source(draft.base, draft.section)
            line_offset = context[: draft.section["start"]].count("\n")
            full_source = full_markdown(draft)
        else:
            chapter = data.get("chapter", "main")
            full_source = source
        refs = ReferenceDocument(
            chapters or [{"id": "main", "title": "", "markdown": full_source}],
            bibliography,
            number_sections=bool(chapters),
            render_chapter=chapter,
        )
        if chapter not in refs.sources:
            raise ValidationError("Select an existing chapter.")
        from .rendering import render_reader

        body, toc = render_reader(
            source if draft.section else refs.sources[chapter],
            references=refs,
            chapter=chapter,
            source_lines=True,
            reference_line_offset=line_offset,
        )
        targets = []
        for target in refs.targets:
            target = dict(target)
            if draft.section:
                inside = target["chapter"] == chapter and (
                    line_offset < target["line"] <= line_offset + len(source.splitlines())
                )
                if not inside and not target["explicit"]:
                    continue
                if inside:
                    target["line"] -= line_offset
                    target["end_line"] -= line_offset
                target["chapter"] = "main" if inside else target["chapter"]
            targets.append(target)
    except ValidationError as error:
        return JsonResponse(
            {
                "error": " ".join(error.messages),
                "diagnostics": [
                    {
                        **(e.params or {}),
                        "message": e.message % e.params if e.params else str(e.message),
                    }
                    for e in error.error_list
                ],
            },
            status=400,
        )
    return JsonResponse(
        {
            "html": body,
            "contents": toc,
            "targets": targets,
            "warnings": refs.warnings,
        }
    )


@private
@verified_required
@require_http_methods(["GET", "POST"])
def rebase(request, draft_id):
    if request.method == "GET":
        draft = owned(request, draft_id)
        if not draft.paper_id or draft.submitted_id:
            return redirect("editor", draft_id=draft.pk)
        latest = draft.paper.current
        if draft.section:
            try:
                latest_source = section_source(latest, draft.section)
            except ValidationError as error:
                messages.error(request, " ".join(error.messages))
                return redirect("editor", draft_id=draft.pk)
            target = (
                sections.find(latest_source, request.GET.get("target", ""))
                if request.GET.get("target")
                else sections.match(
                    section_source(draft.base, draft.section),
                    draft.section,
                    latest_source,
                )
            )
            return render(
                request,
                "publishing/section_rebase.html",
                {
                    "draft": draft,
                    "latest": latest,
                    "target": target,
                    "choices": sections.sections(latest_source),
                    "original": sections.text(
                        section_source(draft.base, draft.section), draft.section
                    ),
                    "latest_text": sections.text(latest_source, target) if target else "",
                    "unchanged": bool(
                        target
                        and sections.text(latest_source, target)
                        == sections.text(section_source(draft.base, draft.section), draft.section)
                    ),
                },
            )
        return render(
            request,
            "publishing/draft_rebase.html",
            {
                "draft": draft,
                "latest": latest,
                "diff": diff_lines(draft.base.markdown, latest.markdown),
                "metadata_changes": metadata_diff(
                    draft.base, {k: getattr(latest, k) for k in METADATA_FIELDS}
                ),
            },
        )
    data = payload(request)
    if data is None:
        return JsonResponse({"error": "Invalid request."}, status=400)
    draft = owned(request, draft_id)
    if draft.submitted_id or data["revision"] != draft.revision:
        return conflict(draft)
    if not draft.paper_id or str(draft.paper.current_id) != data.get("latest"):
        return JsonResponse(
            {"error": "The accepted version changed again. Refresh the comparison."}, status=409
        )
    if draft.section:
        try:
            latest_source = section_source(draft.paper.current, draft.section)
        except ValidationError as error:
            return JsonResponse({"error": " ".join(error.messages)}, status=409)
        target = sections.find(latest_source, data.get("target", ""))
        if not target or target["level"] != draft.section["level"]:
            return JsonResponse(
                {"error": "Select a replacement section at the same heading level."}, status=400
            )
        if (
            Draft.objects.filter(
                owner=request.user,
                paper=draft.paper,
                scope_key=(
                    draft.section.get("chapter", "") + ":" if draft.section.get("chapter") else ""
                )
                + target["anchor"],
                submitted__isnull=True,
            )
            .exclude(pk=draft.pk)
            .exists()
        ):
            return JsonResponse(
                {"error": "You already have a draft for that section. Finish or discard it first."},
                status=409,
            )
        if draft.section.get("chapter"):
            target["chapter"] = draft.section["chapter"]
        draft.section = target
        draft.scope_key = (
            target.get("chapter", "") + ":" if target.get("chapter") else ""
        ) + target["anchor"]
        draft.data.update({k: getattr(draft.paper.current, k) for k in METADATA_FIELDS})
        draft.bibliography = draft.paper.current.bibliography
    draft.base = draft.paper.current
    draft.revision += 1
    with transaction.atomic():
        locked = owned(request, draft_id, lock=True)
        if locked.submitted_id or data["revision"] != locked.revision:
            return conflict(locked)
        if locked.paper.current_id != draft.base_id:
            return JsonResponse(
                {"error": "The accepted version changed again. Refresh the comparison."}, status=409
            )
        for field in ("base", "section", "scope_key", "data", "bibliography", "revision"):
            setattr(locked, field, getattr(draft, field))
        locked.save(
            update_fields=[
                "base",
                "section",
                "scope_key",
                "data",
                "bibliography",
                "revision",
                "updated_at",
            ]
        )
    return JsonResponse(state(draft))


def section_source(snapshot, section):
    if section.get("chapter"):
        page = next((p for p in documents.pages(snapshot) if p["id"] == section["chapter"]), None)
        if page is None:
            raise ValidationError(
                "This chapter was deleted. Preserve your text and use the full-paper editor to reconcile it."
            )
        return page["markdown"]
    return snapshot.markdown


def full_chapters(draft):
    if draft.section.get("chapter"):
        result = [dict(p) for p in documents.pages(draft.base)]
        page = next(p for p in result if p["id"] == draft.section["chapter"])
        page["markdown"] = sections.combine(page["markdown"], draft.section, draft.markdown)
        return result
    return draft.chapters


def full_markdown(draft):
    chapters = full_chapters(draft)
    if chapters:
        return documents.combined(chapters)
    return (
        sections.combine(section_source(draft.base, draft.section), draft.section, draft.markdown)
        if draft.section
        else draft.markdown
    )


def refresh_section(draft):
    """Advance only an unchanged, unambiguous section; the next page reviews the result."""
    latest = draft.paper.current
    if draft.base_id == latest.pk:
        return False
    target = sections.match(
        section_source(draft.base, draft.section),
        draft.section,
        section_source(latest, draft.section),
    )
    if not target or sections.text(section_source(latest, draft.section), target) != sections.text(
        section_source(draft.base, draft.section), draft.section
    ):
        raise ValidationError(
            "Your section changed or moved ambiguously. Compare the latest version and resolve the section before submitting. Your draft is preserved."
        )
    if (
        Draft.objects.filter(
            owner=draft.owner,
            paper=draft.paper,
            scope_key=(
                draft.section.get("chapter", "") + ":" if draft.section.get("chapter") else ""
            )
            + target["anchor"],
            submitted__isnull=True,
        )
        .exclude(pk=draft.pk)
        .exists()
    ):
        raise ValidationError(
            "Another draft already occupies this section. Finish or discard that draft first."
        )
    if draft.section.get("chapter"):
        target["chapter"] = draft.section["chapter"]
    draft.base, draft.section, draft.scope_key = (
        latest,
        target,
        (target.get("chapter", "") + ":" if target.get("chapter") else "") + target["anchor"],
    )
    draft.data.update({k: getattr(latest, k) for k in METADATA_FIELDS})
    draft.bibliography = latest.bibliography
    draft.revision += 1
    return True


@private
@verified_required
@require_POST
@limited("draft_submit", limit=40, seconds=3600)
@agreement_required
def review(request, draft_id, *, consent_form=None):
    try:
        draft = owned(request, draft_id)
        original_revision = draft.revision
        if draft.submitted_id:
            return redirect(draft.submitted.get_absolute_url())
        if consent_form is None and request.POST.get("revision") != str(draft.revision):
            raise ValidationError(
                "Your draft changed. Review the latest saved copy before submitting."
            )
        refreshed = refresh_section(draft) if draft.section else False
        source = full_markdown(draft)
        form = UploadForm(
            {**draft.data, "base": draft.base_id},
            {"file": SimpleUploadedFile("paper.md", source.encode("utf-8"))},
            initial_publication=not draft.paper_id,
        )
        if not form.is_valid():
            messages.error(
                request, "Your draft is saved. Complete the highlighted items before reviewing."
            )
            return redirect(reverse("editor", args=[draft.pk]) + "?check=1")
        if draft.paper_id and draft.base_id != draft.paper.current_id:
            raise ValidationError("Update to the latest accepted version before submitting.")
        documents.validate(full_chapters(draft), draft.bibliography)
        from .references import ReferenceDocument

        chapters = full_chapters(draft) or [
            {"id": "main", "title": draft.title, "markdown": source}
        ]
        refs = ReferenceDocument(chapters, draft.bibliography, number_sections=bool(draft.chapters))
        body = "".join(refs.render(p["id"])[0] for p in chapters)
        with transaction.atomic():
            locked = owned(request, draft_id, lock=True)
            if locked.submitted_id or locked.revision != original_revision:
                raise ValidationError(
                    "Your draft changed. Review the latest saved copy before submitting."
                )
            if draft.paper_id and draft.base_id != locked.paper.current_id:
                raise ValidationError("The accepted version changed. Review your draft again.")
            if refreshed:
                for field in ("base", "section", "scope_key", "data", "bibliography", "revision"):
                    setattr(locked, field, getattr(draft, field))
                locked.save(
                    update_fields=[
                        "base",
                        "section",
                        "scope_key",
                        "data",
                        "bibliography",
                        "revision",
                        "updated_at",
                    ]
                )
        token = signing.dumps(
            {"draft": str(draft.pk), "revision": draft.revision, "owner": request.user.pk},
            salt="draft-review",
        )
        return render(
            request,
            "publishing/draft_review.html",
            {
                "draft": draft,
                "token": token,
                "body": body,
                "reference_warnings": refs.warnings,
                "refreshed": refreshed,
                "diff": diff_lines(
                    section_source(draft.base, draft.section) if draft.base else "", source
                ),
                "metadata_changes": metadata_diff(draft.base, draft.data),
                "subjects": form.cleaned_data,
                "consent_form": consent_form
                if consent_form is not None
                else PublicationConsentForm(paper=draft.paper),
            },
        )
    except ValidationError as error:
        messages.error(request, " ".join(error.messages))
        return redirect("editor", draft_id=draft_id)


@private
@verified_required
@require_POST
@agreement_required
def submit(request, draft_id):
    try:
        token = signing.loads(request.POST.get("token", ""), salt="draft-review", max_age=3600)
        if token["draft"] != str(draft_id) or token["owner"] != request.user.pk:
            raise signing.BadSignature()
    except (signing.BadSignature, KeyError):
        messages.error(request, "The review expired. Please review your draft again.")
        return redirect("editor", draft_id=draft_id)
    try:
        draft = owned(request, draft_id)
        if draft.submitted_id:
            return redirect(draft.submitted.get_absolute_url())
        if token["revision"] != draft.revision:
            raise ValidationError(
                "Your draft changed after this preview. Review it again before submitting."
            )
        form = UploadForm(
            {**draft.data, "base": draft.base_id},
            {"file": SimpleUploadedFile("paper.md", full_markdown(draft).encode())},
            initial_publication=not draft.paper_id,
        )
        if not form.is_valid():
            messages.error(
                request,
                "Your draft is saved. Complete the highlighted items before submitting.",
            )
            return redirect(reverse("editor", args=[draft.pk]) + "?check=1")
        consent = PublicationConsentForm(request.POST, paper=draft.paper)
        if not consent.is_valid():
            return review(request, draft.pk, consent_form=consent)
        data = form.submission_data()
        data.update(chapters=full_chapters(draft), bibliography=draft.bibliography)
        if not draft.paper_id:
            data["license"] = consent.code()
        from .services import prepare_proposal

        prepared = (
            prepare_proposal(data, draft.base, draft.section or None)
            if draft.paper_id
            else documents.prepare(data)
        )
        with transaction.atomic():
            draft = owned(request, draft_id, lock=True)
            if draft.submitted_id:
                return redirect(draft.submitted.get_absolute_url())
            if token["revision"] != draft.revision:
                raise ValidationError(
                    "Your draft changed while preparing it. Review it again before submitting."
                )
            if draft.paper_id:
                submitted = propose(
                    request.user,
                    draft.paper_id,
                    draft.base_id,
                    prepared,
                    pull_request_id=draft.pull_request_id,
                    expected_head=draft.pr_head_id,
                    section=draft.section or None,
                )
            else:
                submitted = publish(request.user, prepared).current
            draft.submitted = submitted
            draft.data = {}
            draft.markdown = ""
            draft.chapters, draft.bibliography = [], ""
            draft.revision += 1
            draft.save(
                update_fields=[
                    "submitted",
                    "data",
                    "markdown",
                    "chapters",
                    "bibliography",
                    "revision",
                    "updated_at",
                ]
            )
    except ValidationError as error:
        messages.error(request, " ".join(error.messages))
        return redirect("editor", draft_id=draft_id)
    messages.success(
        request,
        "Snapshot submitted and frozen." if submitted.base_id else "Your paper is published.",
    )
    return redirect(submitted.get_absolute_url())


@private
@verified_required
@require_POST
def discard(request, draft_id):
    with transaction.atomic():
        draft = owned(request, draft_id, lock=True)
        if request.POST.get("revision") != str(draft.revision) or draft.submitted_id:
            message = (
                "This draft changed. Reload it before deciding whether to discard the latest copy."
            )
            if request.headers.get("Accept") == "application/json":
                return JsonResponse({"error": message}, status=409)
            messages.error(request, message)
            return redirect("editor", draft_id=draft.pk)
        draft.delete()
    messages.success(request, "Draft discarded. Published history is unchanged.")
    if request.headers.get("Accept") == "application/json":
        return JsonResponse({"url": reverse("drafts")})
    return redirect("drafts")


@private
@verified_required
@require_POST
def export(request, draft_id):
    """Download this browser's complete working copy, including unsaved/conflicting edits."""
    from django.http import HttpResponse
    from .documents import archive

    owned(request, draft_id)
    data = payload(request)
    if (
        not data
        or not isinstance(data.get("data"), dict)
        or not isinstance(data.get("markdown"), str)
    ):
        return JsonResponse({"error": "Invalid draft contents."}, status=400)
    try:
        chapters = data.get("chapters", [])
        bibliography = data.get("bibliography", "")
        documents.validate(
            chapters or [{"id": "main", "title": "Draft", "markdown": data["markdown"]}],
            bibliography,
            allow_empty=True,
        )
        info = {key: data["data"].get(key, "") for key in METADATA_FIELDS}
        info["license"] = ""
        content = archive(chapters, bibliography, data["markdown"], info)
    except (ValidationError, TypeError, UnicodeError) as error:
        return JsonResponse({"error": str(error)}, status=400)
    response = HttpResponse(content, content_type="application/zip")
    response["Content-Disposition"] = 'attachment; filename="peerpedia-draft.zip"'
    return response
