import difflib
import uuid
from django.conf import settings
from django import forms
from django.contrib import messages
from django.core import signing
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.db import connection, IntegrityError
from django.db.models import Avg, Count, Q, F
from django.http import HttpResponse, JsonResponse, Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils.safestring import mark_safe
from django.views.decorators.http import require_POST
from accounts.security import limited, verified_required
from .forms import CommentForm, ReviewForm, UploadForm
from .models import Comment, Decision, Paper, Review, Submission, PullRequest, PullRequestCommit
from .rendering import render_markdown, render_reader
from .services import decide, propose, publish
from .subjects import CATEGORIES, METADATA_FIELDS, equivalent_codes, filter_choices, filter_codes, label, subject_links


def public_papers():
    return Paper.objects.filter(is_hidden=False, current__isnull=False).select_related("current", "owner")


def submission_queryset():
    return Submission.objects.filter(paper__is_hidden=False).select_related("paper__owner", "base", "decision", "contributor")


def category_match(codes):
    match = Q(current__primary_category__in=codes)
    for code in codes:
        if connection.vendor == "postgresql":
            match |= Q(current__secondary_categories__contains=[code])
        else:
            # Exact quoted identifiers in the JSON array; SQLite has no JSON contains.
            match |= Q(current__secondary_categories__icontains='"' + code + '"')
    return match


def browse(request):
    papers = public_papers().annotate(
        average=Avg("reviews__score", filter=Q(reviews__is_hidden=False)),
        review_count=Count("reviews", filter=Q(reviews__is_hidden=False)),
    )
    query = request.GET.get("q", "").strip()[:200]
    sort = request.GET.get("sort", "latest")
    subject = request.GET.get("subject", "")
    codes = filter_codes(subject)
    if subject == "unclassified":
        papers = papers.filter(current__primary_category="")
    elif codes:
        papers = papers.filter(category_match(codes))
    elif subject:
        raise Http404("Unknown subject")
    if query:
        matching = Q(current__title__icontains=query) | Q(current__authors__icontains=query) | Q(current__abstract__icontains=query) | Q(current__markdown__icontains=query)
        matching_codes = [code for code, row in CATEGORIES.items() if query.casefold() in (code + " " + row["name"]).casefold()]
        if matching_codes:
            matching |= category_match(equivalent_codes(matching_codes))
        if connection.vendor == "postgresql":
            from django.contrib.postgres.search import SearchQuery, SearchVector
            papers = papers.annotate(search=SearchVector("current__title", "current__authors", "current__abstract", "current__markdown", config="simple"))
            matching |= Q(search=SearchQuery(query, config="simple", search_type="websearch"))
        papers = papers.filter(matching)
    if sort == "rating":
        papers = papers.order_by(F("average").desc(nulls_last=True), "-review_count", "-accepted_at", "-pk")
    else:
        sort = "latest"
        papers = papers.order_by("-accepted_at", "-pk")
    return render(request, "publishing/browse.html", {"page": Paginator(papers, 25).get_page(request.GET.get("page")), "query": query, "sort": sort, "subject": subject,
        "subject_select": forms.Select(choices=filter_choices(), attrs={"id": "subject"}).render("subject", subject)})


def paper_detail(request, paper_id):
    paper = get_object_or_404(public_papers(), pk=paper_id)
    reviews = paper.reviews.filter(is_hidden=False).select_related("user")
    stats = reviews.aggregate(average=Avg("score"), count=Count("pk"))
    own_review = paper.reviews.filter(user=request.user).first() if request.user.is_authenticated else None
    form = ReviewForm(initial={"score": own_review.score, "text": own_review.text} if own_review else None)
    tab = request.GET.get("tab", "reviews")
    if tab not in {"reviews", "submissions", "history"}:
        tab = "reviews"
    proposals = paper.submissions.filter(base__isnull=False, head_of__isnull=False).select_related("decision", "base")
    history = paper.submissions.filter(decision__action="accepted").select_related("decision").order_by("-decision__created_at")
    return render(request, "publishing/paper.html", {
        "paper": paper, "stats": stats, "review_page": Paginator(reviews, 20).get_page(request.GET.get("page")),
        "review_form": form, "own_review": own_review, "tab": tab,
        "submission_page": Paginator(proposals, 25).get_page(request.GET.get("page")),
        "history_page": Paginator(history, 25).get_page(request.GET.get("page")),
        "contributions": history.filter(base__isnull=False).values("contributor_name").annotate(total=Count("pk")).order_by("contributor_name"),
    })


def read_paper(request, paper_id):
    paper = get_object_or_404(public_papers(), pk=paper_id)
    return reader(request, paper.current)


def read_submission(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    return reader(request, submission)


def reader(request, submission):
    body, contents = render_reader(submission.markdown)
    return render(request, "publishing/reader.html", {"submission": submission, "body": mark_safe(body), "contents": contents})


def download(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    response = HttpResponse(submission.markdown.encode("utf-8"), content_type="text/markdown; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{submission.short_hash}.md"'
    response["X-Content-SHA256"] = submission.manifest()["markdown_sha256"]
    response["X-Submission-SHA256"] = submission.hash
    return response


def manifest(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    response = JsonResponse({"hash": submission.hash, "manifest": submission.manifest()}, json_dumps_params={"indent": 2, "ensure_ascii": False})
    response["Content-Disposition"] = f'attachment; filename="{submission.short_hash}.json"'
    return response


def diff_lines(base, proposed):
    # Context diff avoids rendering megabytes of unchanged source. Escaped by templates.
    lines = []
    for line in difflib.unified_diff(base.splitlines(keepends=True), proposed.splitlines(keepends=True), fromfile="Base version", tofile="Proposed version", n=3):
        lines.append(line.removesuffix("\n").replace("\r", " ␍"))
        if not line.endswith("\n"):
            lines.append("\\ No newline at end of file")
    return lines


def metadata_diff(base, data):
    if not base:
        return []
    def display(key, value):
        if key == "primary_category":
            return label(value)
        if key == "secondary_categories":
            return "; ".join(label(code) for code in value) or "None"
        return value
    return [{"label": {"primary_category": "Primary subject", "secondary_categories": "Cross-list subjects"}.get(key, key.title()),
             "before": display(key, getattr(base, key)), "after": display(key, data[key])}
            for key in METADATA_FIELDS if getattr(base, key) != data[key]]


@verified_required
@limited("upload", limit=40, seconds=3600)
def upload(request, paper_id=None):
    paper = get_object_or_404(public_papers(), pk=paper_id) if paper_id else None
    if request.method == "POST" and request.POST.get("action") == "confirm":
        return confirm_upload(request, paper)
    initial = {**{key: getattr(paper.current, key) for key in METADATA_FIELDS}, "base": paper.current_id} if paper else {}
    form = UploadForm(request.POST or None, request.FILES or None, initial=initial, initial_publication=paper is None)
    if request.method == "POST" and form.is_valid():
        base_id = form.cleaned_data.get("base")
        if paper and str(base_id) != str(paper.current_id):
            form.add_error(None, "The paper has changed since you opened this form. Reload this page and use the latest accepted version.")
        else:
            data = form.submission_data()
            data["id"] = str(uuid.uuid4())
            payload = {"user": request.user.pk, "paper": str(paper.pk) if paper else None, "base": str(base_id) if paper else None, "data": data}
            token = signing.dumps(payload, salt="upload-preview", compress=True)
            response = render(request, "publishing/preview.html", {
                "paper": paper, "data": data, "token": token,
                "subjects": subject_links(data["primary_category"], data["secondary_categories"]),
                "diff": diff_lines(paper.current.markdown, data["markdown"]) if paper else [],
                "metadata_changes": metadata_diff(paper.current if paper else None, data),
                "body": mark_safe(render_markdown(data["markdown"])),
            })
            response["Cache-Control"] = "no-store"
            return response
    return render(request, "publishing/upload.html", {"form": form, "paper": paper})


def confirm_upload(request, paper):
    try:
        payload = signing.loads(request.POST.get("token", ""), salt="upload-preview", max_age=3600)
        if payload["user"] != request.user.pk or payload["paper"] != (str(paper.pk) if paper else None):
            raise signing.BadSignature()
    except (signing.BadSignature, KeyError, ValueError):
        return render(request, "error.html", {"heading": "Preview expired", "detail": "Please upload your document again. Nothing has been published."}, status=400)
    existing = Submission.objects.filter(pk=payload["data"]["id"], contributor=request.user).first()
    if existing:
        return redirect("submission", submission_id=existing.pk)
    try:
        if paper:
            submission = propose(request.user, paper.pk, payload["base"], payload["data"])
            messages.success(request, "Submission published. Its contents are now frozen.")
            return redirect("submission", submission_id=submission.pk)
        new_paper = publish(request.user, payload["data"])
    except ValidationError as error:
        return render(request, "error.html", {"heading": "Submission could not be published", "detail": " ".join(error.messages)}, status=409)
    except IntegrityError:
        existing = Submission.objects.filter(pk=payload["data"]["id"], contributor=request.user).first()
        if existing:
            return redirect("submission", submission_id=existing.pk)
        raise
    messages.success(request, "Your paper is published. Future changes will create new submissions.")
    return redirect("paper", paper_id=new_paper.pk)


def submission_detail(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    base = submission.base
    commit = PullRequestCommit.objects.filter(submission=submission).select_related("request__head").first()
    pr = commit.request if commit else None
    comments = Comment.objects.filter(submission__pr_commit__request=pr) if pr else submission.comments.all()
    return render(request, "publishing/submission.html", {
        "submission": submission, "paper": submission.paper,
        "diff": diff_lines(base.markdown if base else "", submission.markdown),
        "metadata_changes": metadata_diff(base, {key: getattr(submission, key) for key in METADATA_FIELDS}),
        "stale": submission.status == "pending" and submission.base_id != submission.paper.current_id,
        "comments": comments.filter(is_hidden=False).select_related("user", "submission"), "comment_form": CommentForm(),
        "pr": pr, "commits": pr.commits.select_related("submission") if pr else [],
    })


def pull_request_detail(request, pr_id):
    pr = get_object_or_404(PullRequest, pk=pr_id, paper__is_hidden=False)
    return submission_detail(request, pr.head_id)


@verified_required
@require_POST
def decision(request, submission_id):
    get_object_or_404(submission_queryset(), pk=submission_id)
    try:
        decide(request.user, submission_id, request.POST.get("action"))
    except ValidationError as error:
        messages.error(request, " ".join(error.messages))
    else:
        messages.success(request, "Decision recorded. The submitted document remains unchanged.")
    return redirect("submission", submission_id=submission_id)


@verified_required
@require_POST
@limited("review", limit=30, seconds=3600)
def review(request, paper_id):
    paper = get_object_or_404(public_papers(), pk=paper_id)
    form = ReviewForm(request.POST)
    existing = Review.objects.filter(paper=paper, user=request.user).first()
    if existing and existing.is_hidden:
        return render(request, "error.html", {"heading": "Review hidden by moderation", "detail": "This review cannot be edited while it is hidden."}, status=403)
    if form.is_valid():
        Review.objects.update_or_create(paper=paper, user=request.user, defaults=form.cleaned_data)
        messages.success(request, "Your review has been saved.")
        return redirect(reverse("paper", args=[paper.pk]) + "#reviews")
    return render(request, "publishing/review_form.html", {"form": form, "paper": paper}, status=400)


@verified_required
@require_POST
@limited("comment", limit=40, seconds=3600)
def comment(request, submission_id):
    submission = get_object_or_404(submission_queryset(), pk=submission_id)
    form = CommentForm(request.POST)
    if form.is_valid():
        Comment.objects.create(submission=submission, user=request.user, text=form.cleaned_data["text"])
        return redirect(reverse("submission", args=[submission.pk]) + "#conversation")
    return render(request, "publishing/comment_form.html", {"form": form, "submission": submission}, status=400)


def compare(request, paper_id):
    paper = get_object_or_404(public_papers(), pk=paper_id)
    versions = paper.submissions.filter(decision__action="accepted").select_related("decision").order_by("decision__created_at")
    before_id = request.GET.get("before")
    after_id = request.GET.get("after")
    try:
        before = get_object_or_404(versions, pk=before_id) if before_id else versions.first()
        after = get_object_or_404(versions, pk=after_id) if after_id else paper.current
    except (ValidationError, ValueError):
        raise Http404
    return render(request, "publishing/compare.html", {
        "paper": paper, "versions": versions, "before": before, "after": after,
        "diff": diff_lines(before.markdown, after.markdown),
        "metadata_changes": metadata_diff(before, {key: getattr(after, key) for key in METADATA_FIELDS}),
    })


def health(request):
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
    return JsonResponse({"status": "ok"})
