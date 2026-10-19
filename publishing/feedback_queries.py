"""Bounded feedback queries shared by browser and public read-only API handlers."""

from django.db.models import (
    Avg,
    Count,
    Q,
    F,
    Value,
    FloatField,
    Case,
    When,
    OuterRef,
    Subquery,
    Prefetch,
)
from django.db.models.functions import Coalesce, Cast
from django.shortcuts import get_object_or_404
from django.urls import reverse
from .models import (
    Submission,
    Passage,
    PassageComment,
    PassageVote,
    PullRequest,
    PullRequestCommit,
    PassagePRLink,
)
from . import passages


class FeedbackError(Exception):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


def visible_submission(pk):
    return get_object_or_404(
        Submission.objects.select_related("paper"), pk=pk, paper__is_hidden=False
    )


def visible_comment(pk, lock=False):
    query = (
        PassageComment.objects.select_for_update(of=("self",)) if lock else PassageComment.objects
    )
    return get_object_or_404(
        query.select_related("user", "passage__submission__paper", "parent__user"),
        pk=pk,
        passage__submission__paper__is_hidden=False,
    )


def lineage(submission):
    """Accepted ancestry and earlier snapshots in the same PR, never unrelated PRs."""
    rows = list(
        Submission.objects.filter(paper_id=submission.paper_id).values_list("pk", "base_id")
    )
    bases = dict(rows)
    ids, at = set(), submission.pk
    while at and at not in ids:
        ids.add(at)
        at = bases.get(at)
    commits = list(
        PullRequestCommit.objects.filter(submission_id__in=ids).values_list("request_id", "number")
    )
    if commits:
        earlier = Q(pk__in=[])
        for pr, number in commits:
            earlier |= Q(request_id=pr, number__lte=number)
        ids.update(
            PullRequestCommit.objects.filter(earlier).values_list("submission_id", flat=True)
        )
    return ids


def anchors_for(submission):
    return (
        Passage.objects.filter(submission_id__in=lineage(submission))
        .select_related("submission")
        .order_by("created_at", "pk")
    )


def mapping(anchor, submission, blocks):
    return passages.locate(anchor, blocks, anchor.submission_id == submission.pk)


def with_stats(query):
    rated = Q(comments__parent__isnull=True, comments__is_hidden=False, comments__is_deleted=False)
    return query.annotate(
        comment_count=Count("comments"),
        rating_count=Count("comments", filter=rated),
        rating_average=Avg("comments__score", filter=rated),
    )


def stats(anchor):
    return {
        "count": anchor.comment_count,
        "ratings": anchor.rating_count,
        "average": round(anchor.rating_average, 2) if anchor.rating_average is not None else None,
    }


def anchor_data(anchor, submission, blocks):
    state, spans = mapping(anchor, submission, blocks)
    summary = stats(anchor)
    if state != "current":
        summary.update(
            historical_average=summary["average"],
            historical_ratings=summary["ratings"],
            average=None,
            ratings=0,
        )
    return {
        "id": str(anchor.pk),
        "quote": anchor.quote,
        "state": state,
        "spans": spans,
        "original_version": anchor.submission.short_hash,
        "original_hash": anchor.submission.hash,
        "original_submission_id": str(anchor.submission_id),
        "original_spans": [
            {"block": s["id"], "kind": s["kind"], "start": s["start"], "end": s["end"]}
            for s in anchor.spans
        ],
        "original_url": reverse("read_submission", args=[anchor.submission_id])
        + "?discussion="
        + str(anchor.pk),
        **summary,
    }


def offset(value=0):
    try:
        return min(1_000_000, max(0, int(value)))
    except (ValueError, TypeError):
        return 0


def passage_index(submission_id, start=0):
    submission = visible_submission(submission_id)
    blocks = passages.blocks(submission.markdown)
    query = with_stats(anchors_for(submission))
    rows = list(query[start : start + 101])
    return {
        "passages": [anchor_data(a, submission, blocks) for a in rows[:100]],
        "next": start + 100 if len(rows) > 100 else None,
    }


def vote_query(query, user):
    own_vote = Value(0)
    if user.is_authenticated:
        own_vote = Coalesce(
            Subquery(
                PassageVote.objects.filter(comment_id=OuterRef("pk"), user_id=user.pk).values(
                    "value"
                )[:1]
            ),
            Value(0),
        )
    return query.select_related("user", "parent__user").annotate(
        up=Count("votes", filter=Q(votes__value=1)),
        down=Count("votes", filter=Q(votes__value=-1)),
        own_vote=own_vote,
    )


def comment_data(comment, user):
    own = user.is_authenticated and comment.user_id == user.pk
    unavailable = comment.is_hidden or comment.is_deleted
    return {
        "id": str(comment.pk),
        "parent": str(comment.parent_id) if comment.parent_id else None,
        "root": str(comment.root_id or comment.pk),
        "depth": comment.depth,
        "author": comment.user.username,
        "reply_to": comment.parent.user.username if comment.parent_id else None,
        "text": "Comment hidden by an administrator."
        if comment.is_hidden
        else "Comment deleted."
        if comment.is_deleted
        else comment.text,
        "score": None if unavailable else comment.score,
        "revision": comment.revision,
        "edited": comment.revision > 1,
        "created": comment.created_at.isoformat(),
        "up": 0 if unavailable else comment.up,
        "down": 0 if unavailable else comment.down,
        "vote": comment.own_vote if not unavailable else 0,
        "unavailable": unavailable,
        "can_edit": own and not unavailable,
        "can_resolve": own and not comment.parent_id and not unavailable,
        "resolved": comment.resolved,
    }


def links_for(comment):
    return [
        {
            "id": str(link.pull_request_id),
            "url": reverse("pull_request", args=[link.pull_request_id]),
            "label": link.pull_request.head.explanation[:160],
            "status": link.pull_request.head.status,
        }
        for link in comment.feedback_links
    ]


def passage_detail(passage_id, user, start=0):
    anchor = get_object_or_404(
        with_stats(Passage.objects.select_related("submission")),
        pk=passage_id,
        submission__paper__is_hidden=False,
    )
    # Rank in SQL before slicing; hidden/deleted comments retain their old last-place rank.
    ranked = vote_query(anchor.comments.filter(parent__isnull=True), user).annotate(
        rank=Case(
            When(Q(is_hidden=True) | Q(is_deleted=True), then=Value(-2.0)),
            default=Cast(F("up") - F("down"), FloatField()) / (F("up") + F("down") + 3),
            output_field=FloatField(),
        )
    )
    ranked = ranked.order_by("-rank", "-created_at", "-pk")
    roots = list(
        ranked.prefetch_related(
            Prefetch(
                "linked_prs",
                queryset=PassagePRLink.objects.select_related(
                    "pull_request__head__decision", "pull_request__head__pr_commit__request"
                ),
                to_attr="feedback_links",
            ),
            Prefetch(
                "descendants",
                queryset=vote_query(PassageComment.objects.all(), user)[:31],
                to_attr="feedback_replies",
            ),
        )[start : start + 11]
    )
    result = []
    for c in roots[:10]:
        row = comment_data(c, user)
        row["links"] = links_for(c)
        row["state"] = (
            "Resolved"
            if c.resolved
            else "Change accepted — awaiting commenter review"
            if any(link["status"] == "accepted" for link in row["links"])
            else "Open"
        )
        replies = c.feedback_replies
        row["replies"] = [comment_data(r, user) for r in replies[:30]]
        row["next_replies"] = 30 if len(replies) > 30 else None
        result.append(row)
    own_prs = (
        PullRequest.objects.filter(
            paper_id=anchor.submission.paper_id, contributor=user
        ).select_related("head")
        if user.is_authenticated
        else []
    )
    return {
        "quote": anchor.quote,
        "threads": result,
        "next": start + 10 if len(roots) > 10 else None,
        "own_rating": anchor.comments.filter(
            user=user, parent__isnull=True, is_deleted=False
        ).exists()
        if user.is_authenticated
        else False,
        "own_prs": [{"id": str(p.pk), "label": p.head.explanation[:120]} for p in own_prs],
        **stats(anchor),
    }


def comment_replies(comment_id, user, start=0):
    root = visible_comment(comment_id)
    if root.parent_id:
        raise FeedbackError("Choose a top-level discussion.", 400)
    rows = list(vote_query(root.descendants.all(), user)[start : start + 101])
    return {
        "replies": [comment_data(c, user) for c in rows[:100]],
        "next": start + 100 if len(rows) > 100 else None,
    }


def comment_history(comment_id, start=0):
    comment = visible_comment(comment_id)
    if comment.is_hidden or comment.is_deleted:
        raise FeedbackError("This comment is unavailable.", 404)
    rows = list(
        comment.history.order_by("-number").values("number", "text", "score", "created_at")[
            start : start + 51
        ]
    )
    return {"revisions": rows[:50], "next": start + 50 if len(rows) > 50 else None}
