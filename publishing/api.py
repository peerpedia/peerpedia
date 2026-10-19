"""Versioned JSON API. Write access uses bearer tokens, never session cookies."""

from django.contrib.auth.models import AnonymousUser
from .feedback_queries import (
    passage_index,
    passage_detail,
    comment_replies,
    comment_history,
    offset,
    FeedbackError,
)
from functools import wraps
import hashlib
import json
import uuid
from django.conf import settings
from django.core.exceptions import PermissionDenied, RequestDataTooBig, ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import transaction
from django.http import Http404, JsonResponse
from django.shortcuts import get_object_or_404
from django.urls import path, reverse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.debug import sensitive_variables
from accounts.models import User
from accounts.security import limited
from accounts.tokens import authenticate_token
from .forms import UploadForm
from .models import (
    ApiPush,
    SubmissionSource,
    PullRequest,
    PassageComment,
    PassagePRLink,
    Review,
    Comment,
)
from .subjects import TAXONOMY
from .services import propose, publish
from .queries import public_papers, submission_queryset


class APIError(Exception):
    def __init__(self, code, message, status=400, details=None):
        self.code, self.message, self.status, self.details = code, message, status, details


def error_response(code, message, status, details=None):
    return JsonResponse(
        {"error": {"code": code, "message": message, "details": details}}, status=status
    )


def endpoint(method="GET", authenticated=False):
    def decorate(view):
        @csrf_exempt
        @wraps(view)
        @sensitive_variables("raw")
        def wrapped(request, *args, **kwargs):
            try:
                if request.method != method:
                    raise APIError("method_not_allowed", f"Use {method}.", 405)
                if authenticated:
                    authorization = request.headers.get("Authorization", "")
                    raw = authorization[7:] if authorization.startswith("Bearer ") else ""
                    request.api_token = authenticate_token(raw)
                    if not request.api_token:
                        raise APIError(
                            "invalid_token", "A valid, unexpired access token is required.", 401
                        )
                    request.user = request.api_token.user
                response = view(request, *args, **kwargs)
                if response.status_code == 429:
                    retry = response.get("Retry-After", "3600")
                    response = error_response(
                        "rate_limited", "Too many pushes. Try again later.", 429
                    )
                    response["Retry-After"] = retry
            except FeedbackError as error:
                response = error_response(
                    "unavailable" if error.status == 404 else "invalid_request",
                    str(error),
                    error.status,
                )
            except APIError as error:
                response = error_response(error.code, error.message, error.status, error.details)
            except Http404:
                response = error_response("not_found", "Paper or submission not found.", 404)
            except PermissionDenied:
                response = error_response("forbidden", "This action is not permitted.", 403)
            except RequestDataTooBig:
                response = error_response("too_large", "The request exceeds the upload limit.", 413)
            except UnicodeError:
                response = error_response("invalid_document", "Use valid UTF-8 text.", 400)
            except ValidationError as error:
                response = error_response("stale_base", " ".join(error.messages), 409)
            if response.status_code == 401:
                response["WWW-Authenticate"] = "Bearer"
            if response.status_code == 405:
                response["Allow"] = method
            response["Cache-Control"] = "no-store"
            return response

        return wrapped

    return decorate


def snapshot(submission):
    pr = getattr(submission, "pr_commit", None)
    return {
        "via_cli": submission.via_cli,
        "ai_assisted": submission.ai_assisted,
        "pull_request": {"id": str(pr.request_id), "snapshot": pr.number} if pr else None,
        "hash": submission.hash,
        "manifest": submission.manifest(),
        "markdown": submission.markdown,
        "status": submission.status,
        "url": reverse("submission", args=[submission.pk]),
    }


@endpoint(authenticated=True)
def me(request):
    return JsonResponse(
        {
            "username": request.user.username,
            "scopes": ["propose"] + (["publish"] if request.api_token.can_publish else []),
            "expires_at": request.api_token.expires_at.isoformat(),
        }
    )


@endpoint()
def categories(request):
    return JsonResponse(TAXONOMY)


@endpoint()
def paper(request, paper_id):
    item = get_object_or_404(public_papers(), pk=paper_id)
    return JsonResponse({"paper_id": str(item.pk), "current": snapshot(item.current)})


@endpoint()
def submission(request, submission_id):
    return JsonResponse(snapshot(get_object_or_404(submission_queryset(), pk=submission_id)))


@endpoint(method="POST", authenticated=True)
@limited("api_push", limit=40, seconds=3600)
@transaction.atomic
def push(request):
    if request.content_type != "application/json":
        raise APIError("invalid_content_type", "Send application/json.", 415)
    try:
        payload = json.loads(request.body)
        key = uuid.UUID(request.headers.get("Idempotency-Key", ""))
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise APIError("invalid_request", "Provide valid JSON and a UUID Idempotency-Key header.")
    fields = {"paper_id", "base_hash", "title", "authors", "abstract", "markdown", "explanation"}
    optional = {
        "primary_category",
        "secondary_categories",
        "pull_request_id",
        "expected_head",
        "discussion_ids",
        "ai_assisted",
    }
    if (
        not isinstance(payload, dict)
        or not fields <= set(payload)
        or set(payload) - fields - optional
    ):
        raise APIError("invalid_request", "Expected fields: " + ", ".join(sorted(fields)))
    for field in fields - {"paper_id", "base_hash"}:
        if not isinstance(payload[field], str):
            raise APIError("invalid_request", f"{field} must be text.")
    if "primary_category" in payload and not isinstance(payload["primary_category"], str):
        raise APIError("invalid_request", "primary_category must be an arXiv category code.")
    if "secondary_categories" in payload and (
        not isinstance(payload["secondary_categories"], list)
        or not all(isinstance(code, str) for code in payload["secondary_categories"])
    ):
        raise APIError(
            "invalid_request", "secondary_categories must be a list of arXiv category codes."
        )
    if type(payload.get("ai_assisted", False)) is not bool:
        raise APIError("invalid_request", "ai_assisted must be true or false.")
    pr_id, expected = payload.get("pull_request_id"), payload.get("expected_head")
    links = payload.get("discussion_ids", [])
    try:
        if pr_id is not None:
            uuid.UUID(pr_id)
            if not isinstance(expected, str) or len(expected) != 64:
                raise ValueError()
        elif expected is not None:
            raise ValueError()
        if not isinstance(links, list) or len(links) > 50:
            raise ValueError()
        for value in links:
            uuid.UUID(value)
        if len(set(links)) != len(links):
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise APIError(
            "invalid_request",
            "Use a PR UUID with its expected full head hash, and up to 50 distinct discussion thread UUIDs.",
        )
    if len(payload["markdown"].encode("utf-8")) > settings.MAX_MARKDOWN_BYTES:
        raise APIError("too_large", "Markdown must be 1 MB or smaller.", 413)
    initial = payload["paper_id"] is None
    if initial:
        if pr_id is not None or links:
            raise APIError(
                "invalid_request", "Only revisions can update PRs or address existing discussions."
            )
        if payload["base_hash"] is not None:
            raise APIError("invalid_request", "A new paper cannot have a base hash.")
        if not request.api_token.can_publish:
            raise APIError(
                "insufficient_scope",
                "This token only permits proposals. Enable new-paper publication on a new token.",
                403,
            )
    else:
        try:
            uuid.UUID(payload["paper_id"])
            if not isinstance(payload["base_hash"], str) or len(payload["base_hash"]) != 64:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise APIError("invalid_request", "Provide a paper UUID and its full base hash.")
    # Serialize retry checks and creation for the same account, including when
    # two different access tokens retry an identical push concurrently.
    User.objects.select_for_update(no_key=True).get(pk=request.user.pk)
    fingerprint = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()
    existing = (
        ApiPush.objects.select_related("submission__paper")
        .filter(user=request.user, key=key)
        .first()
    )
    if existing:
        if existing.request_hash != fingerprint:
            raise APIError(
                "idempotency_conflict",
                "This request ID was already used for different content.",
                409,
            )
        if existing.submission.paper.is_hidden:
            raise Http404()
        return JsonResponse(snapshot(existing.submission))
    item = get_object_or_404(public_papers(), pk=payload["paper_id"]) if not initial else None
    if item and item.current.hash != payload["base_hash"]:
        raise APIError(
            "stale_base",
            "A newer version exists. Fetch it and reconcile your local changes before pushing.",
            409,
        )
    pr, expected_id = None, None
    if pr_id is not None:
        pr = get_object_or_404(
            PullRequest.objects.select_related("head"),
            pk=pr_id,
            paper=item,
            contributor=request.user,
        )
        if pr.head.hash != expected or pr.head.status != "pending":
            raise APIError(
                "stale_pr",
                "This PR changed or closed. Read its current head before preparing another snapshot.",
                409,
            )
        expected_id = pr.head_id
    threads = list(
        PassageComment.objects.select_related("passage__submission__paper").filter(
            pk__in=links,
            parent__isnull=True,
            is_hidden=False,
            is_deleted=False,
            passage__submission__paper=item,
        )
    )
    if len(threads) != len(links):
        raise APIError(
            "invalid_discussion",
            "Each linked ID must name a visible top-level discussion on this paper.",
        )
    # Old clients may omit subjects when editing: inherit the accepted snapshot.
    # Explicit empty/invalid values still fail validation. Retries above retain
    # their original request fingerprint, even across the schema upgrade.
    form_payload = {
        "primary_category": item.current.primary_category if item else "",
        "secondary_categories": item.current.secondary_categories if item else [],
        **payload,
    }
    form = UploadForm(
        {**form_payload, "base": str(item.current_id) if item else ""},
        {"file": SimpleUploadedFile("paper.md", payload["markdown"].encode("utf-8"))},
        initial_publication=initial,
    )
    if not form.is_valid():
        raise APIError(
            "invalid_document",
            "Correct the document or metadata before pushing.",
            details=form.errors.get_json_data(),
        )
    data = form.submission_data()
    record = (
        publish(request.user, data).current
        if initial
        else propose(
            request.user,
            item.pk,
            item.current_id,
            data,
            pull_request_id=pr.pk if pr else None,
            expected_head=expected_id,
        )
    )
    SubmissionSource.objects.create(
        submission=record, ai_assisted=payload.get("ai_assisted", False)
    )
    from .notifications import link_activity

    for thread in threads:
        link, created = PassagePRLink.objects.get_or_create(
            thread=thread, pull_request=record.pr_commit.request, defaults={"user": request.user}
        )
        if created:
            link_activity(link)
    ApiPush.objects.create(user=request.user, key=key, request_hash=fingerprint, submission=record)
    return JsonResponse(snapshot(record), status=201)


@endpoint()
def feedback(request, paper_id=None, submission_id=None):
    record = (
        get_object_or_404(public_papers(), pk=paper_id).current
        if paper_id
        else get_object_or_404(submission_queryset(), pk=submission_id)
    )
    start = offset(request.GET.get("offset"))
    data = passage_index(record.pk, start)
    data.update(
        paper_id=str(record.paper_id),
        submission_id=str(record.pk),
        hash=record.hash,
        access="read-only",
        offset=start,
    )
    return JsonResponse(data)


@endpoint()
def passage_feedback(request, passage_id):
    return JsonResponse(
        passage_detail(passage_id, AnonymousUser(), offset(request.GET.get("offset")))
    )


@endpoint()
def feedback_replies(request, comment_id):
    return JsonResponse(
        comment_replies(comment_id, AnonymousUser(), offset(request.GET.get("offset")))
    )


@endpoint()
def feedback_history(request, comment_id):
    return JsonResponse(comment_history(comment_id, offset(request.GET.get("offset"))))


@endpoint()
def paper_reviews(request, paper_id):
    from django.db.models import Avg, Count

    item = get_object_or_404(public_papers(), pk=paper_id)
    query = Review.objects.filter(paper=item, is_hidden=False)
    start = offset(request.GET.get("offset"))
    rows = list(
        query.order_by("-updated_at", "-pk").values(
            "id", "user__username", "score", "text", "created_at", "updated_at"
        )[start : start + 101]
    )
    for row in rows:
        row["author"] = row.pop("user__username")
    return JsonResponse(
        {
            "paper_id": str(item.pk),
            "summary": query.aggregate(average=Avg("score"), count=Count("pk")),
            "reviews": rows[:100],
            "next": start + 100 if len(rows) > 100 else None,
        }
    )


@endpoint()
def pr_feedback(request, pr_id):
    pr = get_object_or_404(
        PullRequest.objects.select_related("head"), pk=pr_id, paper__is_hidden=False
    )
    start = offset(request.GET.get("offset"))
    commits = list(
        pr.commits.select_related("submission", "submission__source").order_by("number")[
            start : start + 101
        ]
    )
    rows = [
        {
            "submission_id": str(c.submission_id),
            "hash": c.submission.hash,
            "number": c.number,
            "explanation": c.submission.explanation,
            "via_cli": c.submission.via_cli,
            "ai_assisted": c.submission.ai_assisted,
        }
        for c in commits[:100]
    ]
    return JsonResponse(
        {
            "id": str(pr.pk),
            "paper_id": str(pr.paper_id),
            "head_id": str(pr.head_id),
            "head_hash": pr.head.hash,
            "status": pr.head.status,
            "snapshots": rows,
            "discussion_ids": [
                str(pk) for pk in pr.linked_threads.values_list("thread_id", flat=True)
            ],
            "next": start + 100 if len(commits) > 100 else None,
        }
    )


@endpoint()
def pr_comments(request, pr_id):
    pr = get_object_or_404(PullRequest, pk=pr_id, paper__is_hidden=False)
    start = offset(request.GET.get("offset"))
    rows = list(
        Comment.objects.filter(submission__pr_commit__request=pr, is_hidden=False)
        .order_by("created_at", "pk")
        .values("id", "user__username", "text", "created_at", "submission_id")[start : start + 101]
    )
    for row in rows:
        row["author"] = row.pop("user__username")
    return JsonResponse({"comments": rows[:100], "next": start + 100 if len(rows) > 100 else None})


urlpatterns = [
    path("papers/<uuid:paper_id>/feedback/", feedback),
    path("submissions/<uuid:submission_id>/feedback/", feedback),
    path("papers/<uuid:paper_id>/reviews/", paper_reviews),
    path("passages/<uuid:passage_id>/", passage_feedback),
    path("discussion-comments/<uuid:comment_id>/replies/", feedback_replies),
    path("discussion-comments/<uuid:comment_id>/history/", feedback_history),
    path("prs/<uuid:pr_id>/", pr_feedback),
    path("prs/<uuid:pr_id>/comments/", pr_comments),
    path("categories/", categories),
    path("me/", me),
    path("papers/<uuid:paper_id>/", paper),
    path("submissions/<uuid:submission_id>/", submission),
    path("push/", push),
]
