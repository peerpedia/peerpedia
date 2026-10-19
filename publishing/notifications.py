"""Grouped, account-private activity. No email delivery or comment excerpts."""

from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.core.paginator import Paginator
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.http import require_POST
from .models import Notification

LABELS = {
    "passage": "New passage discussion",
    "reply": "Replies to a discussion",
    "edit": "A discussion was updated",
    "vote": "Votes on your comment",
    "linked_fix": "A proposed fix was linked",
    "decision": "A PR received a decision",
    "resolved": "Discussion status changed",
    "proposal": "New PR activity",
    "review": "A paper review was posted or updated",
    "pr_comment": "New PR comments",
    "report": "A comment needs moderation",
}


def visible(user):
    query = Notification.objects.filter(user=user, paper__is_hidden=False)
    return query if user.is_staff else query.exclude(kind="report")


@transaction.atomic
def notify(recipients, actor, paper, kind, *, thread=None, pr=None):
    key = f"{kind}:{thread.pk if thread else pr.pk if pr else paper.pk}"
    for user_id in sorted(set(recipients) - {actor.pk}):
        record, created = Notification.objects.get_or_create(
            user_id=user_id,
            group_key=key,
            defaults={
                "actor": actor,
                "paper": paper,
                "thread": thread,
                "pull_request": pr,
                "kind": kind,
            },
        )
        if not created:
            record = Notification.objects.select_for_update().get(pk=record.pk)
            record.count = record.count + 1 if record.unread else 1
            record.revision += 1
            record.actor = actor
            record.pull_request = pr
            record.unread = True
            record.updated_at = timezone.now()
            record.save(
                update_fields=["count", "revision", "actor", "pull_request", "unread", "updated_at"]
            )


def discussion_activity(comment, actor, kind):
    root = comment.root or comment
    paper = root.passage.submission.paper
    recipients = {paper.owner_id, root.user_id}
    if comment.parent_id:
        recipients.add(comment.parent.user_id)
    if comment.parent_id or kind in {"resolved", "edit"}:
        recipients.update(root.descendants.values_list("user_id", flat=True))
    notify(recipients, actor, paper, kind, thread=root)


def link_activity(link):
    notify(
        [link.thread.user_id, link.pull_request.paper.owner_id],
        link.user,
        link.pull_request.paper,
        "linked_fix",
        thread=link.thread,
        pr=link.pull_request,
    )


def destination(item):
    if item.kind == "report":
        return reverse("admin:publishing_passagereport_changelist")
    if item.thread_id:
        return (
            reverse("read_submission", args=[item.thread.passage.submission_id])
            + "?discussion="
            + str(item.thread.passage_id)
        )
    if item.pull_request_id:
        return reverse("pull_request", args=[item.pull_request_id])
    return reverse("paper", args=[item.paper_id]) + "#reviews"


@login_required
def inbox(request):
    seen_before = timezone.now().isoformat()
    query = visible(request.user).select_related("actor", "paper__current", "thread__passage")
    only_unread = request.GET.get("filter") == "unread"
    if only_unread:
        query = query.filter(unread=True)
    page = Paginator(query, 25).get_page(request.GET.get("page"))
    for item in page:
        item.label = LABELS.get(item.kind, "New activity")
    response = render(
        request,
        "publishing/inbox.html",
        {"page": page, "only_unread": only_unread, "seen_before": seen_before},
    )
    response["Cache-Control"] = "private, no-store"
    return response


@login_required
@require_POST
def open_notification(request, notification_id):
    if request.headers.get("Authorization"):
        from django.http import HttpResponseForbidden

        return HttpResponseForbidden("Use the website to manage your inbox.")
    item = get_object_or_404(
        visible(request.user).select_related("thread__passage"), pk=notification_id
    )
    try:
        revision = int(request.POST.get("revision", ""))
    except ValueError:
        revision = -1
    visible(request.user).filter(pk=item.pk, revision=revision).update(unread=False)
    return redirect(destination(item))


@login_required
@require_POST
def mark_read(request):
    from django.http import HttpResponseBadRequest, HttpResponseForbidden

    if request.headers.get("Authorization"):
        return HttpResponseForbidden("Use the website to manage your inbox.")
    try:
        cutoff = parse_datetime(request.POST.get("seen_before", ""))
    except ValueError:
        cutoff = None
    if not cutoff or timezone.is_naive(cutoff) or cutoff > timezone.now():
        return HttpResponseBadRequest("Refresh the inbox and try again.")
    visible(request.user).filter(unread=True, updated_at__lte=cutoff).update(unread=False)
    return redirect("inbox")
