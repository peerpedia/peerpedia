"""Reading discussions use verified browser sessions. Tool credentials cannot write."""

from . import discussion_actions as actions
from .feedback_queries import (
    offset,
    passage_index,
    passage_detail,
    comment_replies,
    comment_history,
    FeedbackError,
)
import json
from functools import wraps
from django.core.exceptions import ValidationError
from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_POST
from accounts.security import limited


def private_response(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        response = view(request, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        response["Vary"] = "Cookie"
        return response

    return wrapper


def browser_write(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        if request.headers.get("Authorization") or not request.user.is_authenticated:
            return JsonResponse(
                {
                    "error": "Sign in on the website to participate. CLI/API access to discussions is read-only."
                },
                status=403,
            )
        if not request.user.is_active or not request.user.email_verified:
            return JsonResponse({"error": "Verify your email before participating."}, status=403)
        try:
            data = json.loads(request.body)
            if not isinstance(data, dict):
                raise ValueError()
            json.dumps(data, ensure_ascii=False).encode("utf-8")
            return view(request, data, *args, **kwargs)
        except (ValueError, UnicodeError, TypeError):
            return JsonResponse({"error": "Invalid request."}, status=400)
        except ValidationError as error:
            return JsonResponse({"error": " ".join(error.messages)}, status=400)

    return private_response(require_POST(limited("passage_write", limit=100, seconds=60)(wrapper)))


@private_response
@require_GET
def index(request, submission_id):
    return JsonResponse(passage_index(submission_id, offset(request.GET.get("offset"))))


def feedback_response(operation, *args):
    try:
        return JsonResponse(operation(*args))
    except FeedbackError as error:
        return JsonResponse({"error": str(error)}, status=error.status)


@private_response
@require_GET
def detail(request, passage_id):
    return feedback_response(
        passage_detail, passage_id, request.user, offset(request.GET.get("offset"))
    )


@private_response
@require_GET
def replies(request, comment_id):
    return feedback_response(
        comment_replies, comment_id, request.user, offset(request.GET.get("offset"))
    )


@private_response
@require_GET
def history(request, comment_id):
    return feedback_response(comment_history, comment_id, offset(request.GET.get("offset")))


@browser_write
def create(request, data, submission_id):
    result = actions.create(request.user, data, submission_id)
    return JsonResponse(result.data, status=result.status)


@browser_write
def reply(request, data, comment_id):
    result = actions.reply(request.user, data, comment_id)
    return JsonResponse(result.data, status=result.status)


@browser_write
def edit(request, data, comment_id):
    result = actions.edit(request.user, data, comment_id)
    return JsonResponse(result.data, status=result.status)


@browser_write
def vote(request, data, comment_id):
    result = actions.vote(request.user, data, comment_id)
    return JsonResponse(result.data, status=result.status)


@browser_write
def resolve(request, data, comment_id):
    result = actions.resolve(request.user, data, comment_id)
    return JsonResponse(result.data, status=result.status)


@browser_write
def report(request, data, comment_id):
    result = actions.report(request.user, data, comment_id)
    return JsonResponse(result.data, status=result.status)


@browser_write
def link_pr(request, data, comment_id):
    result = actions.link_pr(request.user, data, comment_id)
    return JsonResponse(result.data, status=result.status)
