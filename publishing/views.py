from .queries import public_papers, submission_queryset, search_papers
from .comparisons import diff_lines, metadata_diff
import uuid
from typing import Any
from django import forms
from django.contrib import messages
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core import signing
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.db import connection, IntegrityError
from django.db.models import Avg, Count
from django.http import HttpRequest, HttpResponse, JsonResponse, Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils.safestring import mark_safe
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods, require_POST
from accounts.security import limited, verified_required
from .forms import CommentForm, ReviewForm, UploadForm
from .licensing import PublicationConsentForm, agreement_required
from .models import Comment, Paper, Review, Submission, PullRequest, PullRequestCommit
from .documents import PreparedDocument, prepare
from .services import decide, propose, publish
from .subjects import (
    METADATA_FIELDS,
    filter_choices,
    subject_links,
)


def browse(request):
    query = request.GET.get("q", "").strip()[:200]
    sort = request.GET.get("sort", "latest")
    if sort not in {"latest", "rating"}:
        sort = "latest"
    subject = request.GET.get("subject", "")
    papers = search_papers(query, subject, sort)
    return render(
        request,
        "publishing/browse.html",
        {
            "page": Paginator(papers, 25).get_page(request.GET.get("page")),
            "query": query,
            "sort": sort,
            "subject": subject,
            "subject_select": forms.Select(
                choices=filter_choices(), attrs={"id": "subject"}
            ).render("subject", subject),
        },
    )


def paper_permalink(request, public_id):
    return paper_detail(request, public_id=public_id)


def paper_detail(
    request: HttpRequest, paper_id: uuid.UUID | None = None, public_id: str | None = None
) -> HttpResponse:
    paper = get_object_or_404(
        public_papers(), **({"public_id": public_id} if public_id else {"pk": paper_id})
    )
    tab = request.GET.get("tab")
    page = request.GET.get("page")
    context: dict[str, Any] = {"paper": paper}
    if tab == "submissions":
        proposals = paper.submissions.filter(base__isnull=False, head_of__isnull=False)
        context["submission_page"] = Paginator(proposals, 25).get_page(page)
    elif tab == "history":
        history = (
            paper.submissions.filter(decision__action="accepted")
            .select_related("decision")
            .order_by("-decision__created_at")
        )
        context["history_page"] = Paginator(history, 25).get_page(page)
        context["contributions"] = (
            history.filter(base__isnull=False)
            .values("contributor_name")
            .annotate(total=Count("pk"))
            .order_by("contributor_name")
        )
    else:
        tab = "reviews"
        reviews = paper.reviews.filter(is_hidden=False).select_related("user")
        own = (
            paper.reviews.filter(user=request.user).first()
            if request.user.is_authenticated
            else None
        )
        context.update(
            stats=reviews.aggregate(average=Avg("score"), count=Count("pk")),
            review_page=Paginator(reviews, 20).get_page(page),
            own_review=own,
            review_form=ReviewForm(initial={"score": own.score, "text": own.text} if own else None),
        )
    return render(request, "publishing/paper.html", {**context, "tab": tab})


def read_paper(request: HttpRequest, paper_id: uuid.UUID) -> HttpResponse:
    paper = get_object_or_404(public_papers(), pk=paper_id)
    return redirect(reverse("read_snapshot", args=[paper.current.public_id], query=request.GET))


def read_permalink(request: HttpRequest, public_id: str) -> HttpResponse:
    paper = get_object_or_404(public_papers(), public_id=public_id)
    return redirect(reverse("read_snapshot", args=[paper.current.public_id], query=request.GET))


def read_version(request, public_id, submission_id):
    submission = get_object_or_404(
        submission_queryset(), pk=submission_id, paper__public_id=public_id
    )
    return reader(request, submission)


def snapshot_target(public_id):
    return get_object_or_404(submission_queryset(), public_id=public_id)


def snapshot_detail(request, public_id):
    return submission_detail(request, snapshot_target(public_id).pk)


def snapshot_read(request, public_id):
    return reader(request, snapshot_target(public_id))


def snapshot_download(request, public_id):
    return download(request, snapshot_target(public_id).pk)


def snapshot_manifest(request, public_id):
    return manifest(request, snapshot_target(public_id).pk)


def read_submission(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    return reader(request, submission)


def reader(request: HttpRequest, submission: Submission) -> HttpResponse:
    from .documents import pages
    from urllib.parse import urlencode

    chapters = pages(submission)
    from .artifacts import references

    try:
        refs = references(submission)
        titles = {p["id"]: p.get("title") for p in refs.result["pages"]}
        chapters = [{**p, "title": titles.get(p["id"]) or p["title"]} for p in chapters]
    except ValidationError:
        response = render(
            request,
            "error.html",
            {
                "heading": "This article is temporarily unavailable",
                "detail": "Its reading copy could not be prepared. Please try again shortly.",
            },
            status=503,
        )
        response["Retry-After"] = "30"
        return response
    selected = request.GET.get("chapter") or chapters[0]["id"]
    page = next((p for p in chapters if p["id"] == selected), None)
    if page is None:
        raise Http404("This chapter is not in this version.")
    index = chapters.index(page)
    reader_url = submission.read_url
    body, contents = refs.render(selected)
    response = render(
        request,
        "publishing/reader.html",
        {
            "submission": submission,
            "citation_config": {
                "text": f"{submission.authors.replace(chr(10), ', ')}. {submission.title}. Peerpedia, snapshot {submission.public_id}.",
                "url": request.build_absolute_uri(submission.read_url),
                "paper_url": request.build_absolute_uri(submission.paper.get_absolute_url()),
            },
            "body": mark_safe(body),
            "contents": contents,
            "chapters": [
                {
                    **p,
                    "url": reader_url + "?" + urlencode({"chapter": p["id"]}),
                    "selected": p["id"] == selected,
                }
                for p in chapters
            ]
            if submission.chapters
            else [],
            "chapter": page,
            "chapter_reference_url": reader_url + "?" + urlencode({"chapter": selected}),
            "chapter_number": index + 1,
            "chapter_has_title": any(
                h.get("title")
                for p in refs.result["pages"]
                if p["id"] == selected
                for h in p["headings"]
            ),
            "previous_chapter": reader_url + "?" + urlencode({"chapter": chapters[index - 1]["id"]})
            if index
            else "",
            "next_chapter": reader_url + "?" + urlencode({"chapter": chapters[index + 1]["id"]})
            if index + 1 < len(chapters)
            else "",
            "reading_config": {
                "paper": str(submission.paper_id),
                "submission": str(submission.pk),
                "chapter": selected,
                "explicit": bool(request.GET.get("chapter")),
                "progress_url": reverse("reading_progress", args=[submission.paper_id])
                if request.user.is_authenticated
                else "",
                "user": request.user.pk if request.user.is_authenticated else "visitor",
                "chapters": {
                    p["id"]: reader_url + "?" + urlencode({"chapter": p["id"]}) for p in chapters
                },
            }
            if submission.chapters
            else None,
        },
    )
    response["Cache-Control"] = "private, no-store"
    return response


def download(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    if submission.chapters or submission.bibliography:
        from .documents import archive

        info = {k: getattr(submission, k) for k in METADATA_FIELDS}
        info["license"] = submission.licensing["code"]
        content = archive(
            submission.chapters,
            submission.bibliography,
            submission.markdown,
            info,
            {"manifest": submission.manifest(), "hash": submission.hash},
        )
        response = HttpResponse(content, content_type="application/zip")
        response["Content-Disposition"] = f'attachment; filename="{submission.public_id}.zip"'
        return response
    response = HttpResponse(
        submission.markdown.encode("utf-8"), content_type="text/markdown; charset=utf-8"
    )
    response["Content-Disposition"] = f'attachment; filename="{submission.public_id}.md"'
    response["X-Content-SHA256"] = submission.manifest()["markdown_sha256"]
    response["X-Submission-SHA256"] = submission.hash
    rights = submission.licensing
    if rights["code"]:
        response["X-Content-License"] = rights["code"]
        response["Link"] = f'<{request.build_absolute_uri(rights["url"])}>; rel="license"'
    return response


def manifest(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    response = JsonResponse(
        {
            "hash": submission.hash,
            "manifest": submission.manifest(),
            "licensing": submission.licensing,
        },
        json_dumps_params={"indent": 2, "ensure_ascii": False},
    )
    response["Content-Disposition"] = f'attachment; filename="{submission.public_id}.json"'
    return response


@never_cache
@verified_required
@limited("upload", limit=40, seconds=3600)
@agreement_required
@require_http_methods(["GET", "POST"])
def upload(request: HttpRequest, paper_id: uuid.UUID | None = None) -> HttpResponse:
    paper = get_object_or_404(public_papers(), pk=paper_id) if paper_id else None
    action = request.POST.get("action")
    token = request.POST.get("token", "")
    previous = None
    if token or action in {"edit", "confirm"}:
        try:
            previous = signing.loads(token, salt="upload-preview", max_age=3600)
            if previous["user"] != request.user.pk or previous["paper"] != (
                str(paper.pk) if paper else None
            ):
                raise signing.BadSignature()
        except (signing.BadSignature, KeyError, ValueError):
            return render(
                request,
                "error.html",
                {
                    "heading": "Preview expired",
                    "detail": "Upload your Markdown file again.",
                    "retry_upload": True,
                    "paper": paper,
                },
                status=400,
            )
        if action == "confirm":
            return confirm_upload(request, paper, previous, token)
        if paper and str(paper.current_id) != previous["base"]:
            return render(
                request,
                "error.html",
                {
                    "heading": "This paper has a newer version",
                    "detail": "Download the latest accepted version before proposing changes.",
                    "retry_upload": True,
                    "paper": paper,
                },
                status=409,
            )
    if paper and (paper.current.chapters or paper.current.bibliography):
        return render(
            request,
            "publishing/upload.html",
            {"paper": paper, "source_bundle": True},
            status=409 if request.method == "POST" else 200,
        )
    initial = (
        {**{key: getattr(paper.current, key) for key in METADATA_FIELDS}, "base": paper.current_id}
        if paper
        else {}
    )
    reviewing = request.method == "POST" and action != "edit"
    filename = ""
    if previous:
        filename = previous.get("filename", "paper.md")
        initial.update(previous["data"])
        initial["file"] = SimpleUploadedFile(filename, previous["data"]["markdown"].encode())
    form = UploadForm(
        request.POST if reviewing else None,
        request.FILES if reviewing else None,
        initial=initial,
        initial_publication=paper is None,
    )
    if reviewing and form.is_valid():
        base_id = form.cleaned_data.get("base")
        if paper and base_id != paper.current_id:
            form.add_error(
                None,
                "The paper has changed since you opened this form. Reload this page and use the latest accepted version.",
            )
        elif request.FILES and (
            list(request.FILES) != ["file"] or len(request.FILES.getlist("file")) != 1
        ):
            form.add_error("file", "Upload one Markdown file. Use the CLI for multiple files.")
        else:
            data = {**form.submission_data(), "id": str(uuid.uuid4())}
            try:
                prepared = prepare(data, paper.current if paper else None)
            except ValidationError as error:
                form.add_error("file", error)
            else:
                payload = {
                    "user": request.user.pk,
                    "paper": str(paper.pk) if paper else None,
                    "base": str(base_id) if paper else None,
                    "data": data,
                    "filename": form.cleaned_data["file"].name,
                }
                token = signing.dumps(payload, salt="upload-preview", compress=True)
                return upload_preview(
                    request, paper, prepared, token, PublicationConsentForm(paper=paper)
                )
    return render(
        request,
        "publishing/upload.html",
        {"form": form, "paper": paper, "previous_token": token, "filename": filename},
    )


def upload_preview(
    request: HttpRequest,
    paper: Paper | None,
    prepared: PreparedDocument,
    token: str,
    consent: PublicationConsentForm,
    *,
    status: int = 200,
) -> HttpResponse:
    data = prepared.data
    return render(
        request,
        "publishing/preview.html",
        {
            "paper": paper,
            "data": data,
            "token": token,
            "consent_form": consent,
            "subjects": subject_links(data["primary_category"], data["secondary_categories"]),
            "diff": diff_lines(paper.current.markdown, data["markdown"]) if paper else [],
            "metadata_changes": metadata_diff(paper.current if paper else None, data),
            "body": mark_safe(prepared.result["pages"][0]["html"]),
        },
        status=status,
    )


def confirm_upload(
    request: HttpRequest, paper: Paper | None, payload: dict[str, Any], token: str
) -> HttpResponse:
    data = payload["data"]
    existing = Submission.objects.filter(pk=data["id"], contributor=request.user).first()
    if existing:
        return redirect(existing.get_absolute_url() if paper else existing.paper.get_absolute_url())
    consent = PublicationConsentForm(request.POST, paper=paper)
    try:
        if paper and str(paper.current_id) != payload["base"]:
            raise ValidationError(
                "This paper has a newer accepted version. Download it before submitting your changes."
            )
        if not consent.is_valid():
            prepared = prepare(data, paper.current if paper else None)
            return upload_preview(request, paper, prepared, token, consent, status=400)
        if paper:
            submission = propose(request.user, paper.pk, payload["base"], data)
            messages.success(request, "Proposal submitted for review.")
            return redirect(submission.get_absolute_url())
        new_paper = publish(request.user, {**data, "license": consent.code()})
    except ValidationError as error:
        return render(
            request,
            "error.html",
            {
                "heading": "Submission could not be published",
                "detail": " ".join(error.messages),
                "retry_upload": True,
                "paper": paper,
            },
            status=409,
        )
    except IntegrityError:
        existing = Submission.objects.filter(pk=data["id"], contributor=request.user).first()
        if existing:
            return redirect(
                existing.get_absolute_url() if paper else existing.paper.get_absolute_url()
            )
        raise
    messages.success(request, "Paper published.")
    return redirect(new_paper.get_absolute_url())


def submission_detail(request: HttpRequest, submission_id: uuid.UUID) -> HttpResponse:
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    base = submission.base
    from .documents import chapter_diff

    changes = (
        chapter_diff(base, submission)
        if submission.chapters or submission.bibliography or (base and base.chapters)
        else []
    )
    selected_change = next(
        (c for c in changes if c["id"] == request.GET.get("chapter")),
        changes[0] if changes else None,
    )
    commit = (
        PullRequestCommit.objects.filter(submission=submission)
        .select_related("request__head")
        .first()
    )
    pr = commit.request if commit else None
    comments = (
        Comment.objects.filter(submission__pr_commit__request=pr)
        if pr
        else submission.comments.all()
    )
    return render(
        request,
        "publishing/submission.html",
        {
            "submission": submission,
            "paper": submission.paper,
            "diff": selected_change["diff"]
            if selected_change
            else diff_lines(base.markdown if base else "", submission.markdown),
            "chapter_changes": changes,
            "selected_change": selected_change,
            "metadata_changes": metadata_diff(
                base, {key: getattr(submission, key) for key in METADATA_FIELDS}
            ),
            "stale": submission.status == "pending"
            and submission.base_id != submission.paper.current_id,
            "comments": comments.filter(is_hidden=False).select_related("user", "submission"),
            "comment_form": CommentForm(),
            "pr": pr,
            "commits": pr.commits.select_related("submission") if pr else [],
        },
    )


def pull_request_detail(request, pr_id):
    pr = get_object_or_404(PullRequest, pk=pr_id, paper__is_hidden=False)
    return submission_detail(request, pr.head_id)


@verified_required
@require_POST
def decision(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    try:
        decide(request.user, submission_id, request.POST.get("action"))
    except ValidationError as error:
        messages.error(request, " ".join(error.messages))
    else:
        messages.success(request, "Decision recorded. The submitted document remains unchanged.")
    return redirect(submission.get_absolute_url())


@verified_required
@require_POST
@limited("review", limit=30, seconds=3600)
@agreement_required
def review(request, paper_id):
    paper = get_object_or_404(public_papers(), pk=paper_id)
    form = ReviewForm(request.POST)
    existing = Review.objects.filter(paper=paper, user=request.user).first()
    if existing and existing.is_hidden:
        return render(
            request,
            "error.html",
            {
                "heading": "Review hidden by moderation",
                "detail": "This review cannot be edited while it is hidden.",
            },
            status=403,
        )
    if form.is_valid():
        Review.objects.update_or_create(paper=paper, user=request.user, defaults=form.cleaned_data)
        from .notifications import notify

        notify([paper.owner_id], request.user, paper, "review")
        messages.success(request, "Your review has been saved.")
        return redirect(paper.get_absolute_url() + "#reviews")
    return render(
        request, "publishing/review_form.html", {"form": form, "paper": paper}, status=400
    )


@verified_required
@require_POST
@limited("comment", limit=40, seconds=3600)
@agreement_required
def comment(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    form = CommentForm(request.POST)
    if form.is_valid():
        Comment.objects.create(
            submission=submission, user=request.user, text=form.cleaned_data["text"]
        )
        from .notifications import notify

        pr = submission.pr_commit.request if hasattr(submission, "pr_commit") else None
        notify(
            [submission.paper.owner_id, submission.contributor_id],
            request.user,
            submission.paper,
            "pr_comment",
            pr=pr,
        )
        return redirect(submission.get_absolute_url() + "#conversation")
    return render(
        request,
        "publishing/comment_form.html",
        {"form": form, "submission": submission},
        status=400,
    )


def compare(request, paper_id):
    paper = get_object_or_404(public_papers(), pk=paper_id)
    versions = (
        paper.submissions.filter(decision__action="accepted")
        .select_related("decision")
        .order_by("decision__created_at")
    )
    before_id = request.GET.get("before")
    after_id = request.GET.get("after")
    try:
        before = get_object_or_404(versions, pk=before_id) if before_id else versions.first()
        after = get_object_or_404(versions, pk=after_id) if after_id else paper.current
    except (ValidationError, ValueError):
        raise Http404
    return render(
        request,
        "publishing/compare.html",
        {
            "paper": paper,
            "versions": versions,
            "before": before,
            "after": after,
            "diff": diff_lines(before.markdown, after.markdown),
            "metadata_changes": metadata_diff(
                before, {key: getattr(after, key) for key in METADATA_FIELDS}
            ),
        },
    )


def health(request):
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
    return JsonResponse({"status": "ok"})
