from .queries import public_papers, submission_queryset, search_papers
from .comparisons import diff_lines, metadata_diff
import uuid
from django import forms
from django.contrib import messages
from django.core import signing
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.db import connection, IntegrityError
from django.db.models import Avg, Count
from django.http import HttpResponse, JsonResponse, Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils.safestring import mark_safe
from django.views.decorators.http import require_POST
from accounts.security import limited, verified_required
from .forms import CommentForm, ReviewForm, UploadForm
from .licensing import PublicationConsentForm, agreement_required
from .models import Comment, Review, Submission, PullRequest, PullRequestCommit
from .rendering import render_markdown
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


def paper_detail(request, paper_id=None, public_id=None):
    paper = get_object_or_404(
        public_papers(), **({"public_id": public_id} if public_id else {"pk": paper_id})
    )
    reviews = paper.reviews.filter(is_hidden=False).select_related("user")
    stats = reviews.aggregate(average=Avg("score"), count=Count("pk"))
    own_review = (
        paper.reviews.filter(user=request.user).first() if request.user.is_authenticated else None
    )
    form = ReviewForm(
        initial={"score": own_review.score, "text": own_review.text} if own_review else None
    )
    tab = request.GET.get("tab", "reviews")
    if tab not in {"reviews", "submissions", "history"}:
        tab = "reviews"
    proposals = paper.submissions.filter(base__isnull=False, head_of__isnull=False).select_related(
        "decision", "base"
    )
    history = (
        paper.submissions.filter(decision__action="accepted")
        .select_related("decision")
        .order_by("-decision__created_at")
    )
    return render(
        request,
        "publishing/paper.html",
        {
            "paper": paper,
            "stats": stats,
            "review_page": Paginator(reviews, 20).get_page(request.GET.get("page")),
            "review_form": form,
            "own_review": own_review,
            "tab": tab,
            "submission_page": Paginator(proposals, 25).get_page(request.GET.get("page")),
            "history_page": Paginator(history, 25).get_page(request.GET.get("page")),
            "contributions": history.filter(base__isnull=False)
            .values("contributor_name")
            .annotate(total=Count("pk"))
            .order_by("contributor_name"),
        },
    )


def read_paper(request, paper_id):
    paper = get_object_or_404(public_papers(), pk=paper_id)
    return reader(request, paper.current)


def read_permalink(request, public_id):
    paper = get_object_or_404(public_papers(), public_id=public_id)
    return reader(request, paper.current)


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


def reader(request, submission):
    edit_url = (
        reverse("edit_paper", args=[submission.paper_id]) + "?version=" + str(submission.pk)
        if submission.pk == submission.paper.current_id
        else None
    )
    from .documents import pages, digest
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
    selected = request.GET.get("chapter")
    if not selected and request.GET.get("discussion"):
        from .feedback_queries import anchors_for, mapping

        try:
            discussion_id = uuid.UUID(request.GET["discussion"])
        except ValueError:
            raise Http404()
        anchor = anchors_for(submission).filter(pk=discussion_id).first()
        if anchor:
            all_blocks = [block for page in refs.result["pages"] for block in page["blocks"]]
            _, spans = mapping(anchor, submission, all_blocks)
            if spans:
                selected = next(
                    (b.get("chapter") for b in all_blocks if b["id"] == spans[0]["block"]), None
                )
    selected = selected or chapters[0]["id"]
    page = next((p for p in chapters if p["id"] == selected), None)
    if page is None:
        raise Http404("This chapter is not in this version.")
    index = chapters.index(page)
    reader_url = submission.read_url
    if edit_url and submission.chapters:
        edit_url += "&" + urlencode({"chapter": selected})
    body, contents = refs.render(
        selected,
        edit_url=edit_url,
        passage_annotations=True,
    )
    from urllib.parse import urlencode

    config = {
        "index": reverse("passage_index", args=[submission.pk]),
        "create": reverse("passage_create", args=[submission.pk]),
        "participate": request.user.is_authenticated
        and request.user.is_active
        and request.user.email_verified,
        "login": reverse("login") + "?" + urlencode({"next": request.get_full_path()}),
        "version": submission.public_id,
        "status": submission.status,
    }
    from .licensing import acceptance

    if (
        request.user.is_authenticated
        and request.user.email_verified
        and not acceptance(request.user)
    ):
        config.update(
            participate=False,
            login=reverse("agreements") + "?" + urlencode({"next": request.get_full_path()}),
            agreement_required=True,
        )
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
            "discussion_config": config,
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
            "chapter_edit_url": edit_url,
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
                "explicit": bool(request.GET.get("chapter") or request.GET.get("discussion")),
                "progress_url": reverse("reading_progress", args=[submission.paper_id])
                if request.user.is_authenticated
                else "",
                "user": request.user.pk if request.user.is_authenticated else "visitor",
                "chapters": [
                    {
                        "id": p["id"],
                        "hash": digest(p["markdown"]),
                        "url": reader_url + "?" + urlencode({"chapter": p["id"]}),
                    }
                    for p in chapters
                ],
            },
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


@verified_required
@limited("upload", limit=40, seconds=3600)
@agreement_required
def upload(request, paper_id=None):
    paper = get_object_or_404(public_papers(), pk=paper_id) if paper_id else None
    if request.method == "GET":
        return redirect("edit_paper", paper_id=paper.pk) if paper else redirect("write")
    if request.method == "POST" and request.POST.get("action") == "confirm":
        return confirm_upload(request, paper)
    initial = (
        {**{key: getattr(paper.current, key) for key in METADATA_FIELDS}, "base": paper.current_id}
        if paper
        else {}
    )
    form = UploadForm(
        request.POST or None,
        request.FILES or None,
        initial=initial,
        initial_publication=paper is None,
    )
    if request.method == "POST" and form.is_valid():
        base_id = form.cleaned_data.get("base")
        if paper and str(base_id) != str(paper.current_id):
            form.add_error(
                None,
                "The paper has changed since you opened this form. Reload this page and use the latest accepted version.",
            )
        else:
            data = form.submission_data()
            try:
                preview_body = render_markdown(data["markdown"])
            except ValidationError as error:
                form.add_error("file", error)
                return render(request, "publishing/upload.html", {"form": form, "paper": paper})
            data["id"] = str(uuid.uuid4())
            payload = {
                "user": request.user.pk,
                "paper": str(paper.pk) if paper else None,
                "base": str(base_id) if paper else None,
                "data": data,
            }
            token = signing.dumps(payload, salt="upload-preview", compress=True)
            response = render(
                request,
                "publishing/preview.html",
                {
                    "paper": paper,
                    "data": data,
                    "token": token,
                    "consent_form": PublicationConsentForm(paper=paper),
                    "subjects": subject_links(
                        data["primary_category"], data["secondary_categories"]
                    ),
                    "diff": diff_lines(paper.current.markdown, data["markdown"]) if paper else [],
                    "metadata_changes": metadata_diff(paper.current if paper else None, data),
                    "body": mark_safe(preview_body),
                },
            )
            response["Cache-Control"] = "no-store"
            return response
    return render(request, "publishing/upload.html", {"form": form, "paper": paper})


def confirm_upload(request, paper):
    try:
        payload = signing.loads(request.POST.get("token", ""), salt="upload-preview", max_age=3600)
        if payload["user"] != request.user.pk or payload["paper"] != (
            str(paper.pk) if paper else None
        ):
            raise signing.BadSignature()
    except (signing.BadSignature, KeyError, ValueError):
        return render(
            request,
            "error.html",
            {
                "heading": "Preview expired",
                "detail": "Please upload your document again. Nothing has been published.",
            },
            status=400,
        )
    existing = Submission.objects.filter(pk=payload["data"]["id"], contributor=request.user).first()
    if existing:
        return redirect(existing.get_absolute_url())
    consent = PublicationConsentForm(request.POST, paper=paper)
    if not consent.is_valid():
        data = payload["data"]
        return render(
            request,
            "publishing/preview.html",
            {
                "paper": paper,
                "data": data,
                "token": request.POST.get("token"),
                "consent_form": consent,
                "body": mark_safe(render_markdown(data["markdown"])),
                "subjects": subject_links(data["primary_category"], data["secondary_categories"]),
                "diff": diff_lines(paper.current.markdown, data["markdown"]) if paper else [],
                "metadata_changes": metadata_diff(paper.current if paper else None, data),
            },
            status=400,
        )
    if not paper:
        payload["data"]["license"] = consent.code()
    try:
        if paper:
            submission = propose(request.user, paper.pk, payload["base"], payload["data"])
            messages.success(request, "Submission published. Its contents are now frozen.")
            return redirect(submission.get_absolute_url())
        new_paper = publish(request.user, payload["data"])
    except ValidationError as error:
        return render(
            request,
            "error.html",
            {"heading": "Submission could not be published", "detail": " ".join(error.messages)},
            status=409,
        )
    except IntegrityError:
        existing = Submission.objects.filter(
            pk=payload["data"]["id"], contributor=request.user
        ).first()
        if existing:
            return redirect(existing.get_absolute_url())
        raise
    messages.success(
        request, "Your paper is published. Future changes will create new submissions."
    )
    return redirect(new_paper.get_absolute_url())


def submission_detail(request, submission_id):
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
            "linked_discussions": pr.linked_threads.select_related("thread__passage__submission")
            if pr
            else [],
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
