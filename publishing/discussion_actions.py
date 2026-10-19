"""Discussion mutations. Browser authentication and JSON responses belong in views."""

from dataclasses import dataclass
from django.core.exceptions import ValidationError
from django.db import transaction
from django.shortcuts import get_object_or_404
from .models import (
    Paper,
    Passage,
    PassageComment,
    PassageCommentRevision,
    PassageVote,
    PassageReport,
    PassagePRLink,
    PullRequest,
)
from .feedback_queries import visible_submission, visible_comment, anchors_for, mapping
from .notifications import discussion_activity, notify, link_activity
from .services import require_verified
from .licensing import require_agreement
from . import passages


@dataclass(frozen=True)
class ActionResult:
    data: dict
    status: int = 200


def text_value(data, name="text", limit=5000):
    text = data.get(name)
    if not isinstance(text, str) or not text.strip() or len(text) > limit:
        raise ValidationError(f"Write between 1 and {limit} characters.")
    return text.strip()


def score_value(data):
    score = data.get("score")
    if type(score) is not int or not 1 <= score <= 5:
        raise ValidationError("Choose a rating from 1 to 5 and explain it in your comment.")
    return score


def record(comment):
    PassageCommentRevision.objects.create(
        comment=comment,
        number=comment.revision,
        text=comment.text,
        score=comment.score,
        is_deleted=comment.is_deleted,
    )


def create(user, data, submission_id):
    require_verified(user)
    require_agreement(user)
    submission = visible_submission(submission_id)
    selected, quote, key = passages.validate(submission, data.get("spans"))
    text, score = text_value(data), score_value(data)
    canonical = [{"block": s["id"], "start": s["start"], "end": s["end"]} for s in selected]
    with transaction.atomic():
        # Serialize canonical-anchor creation across users and inherited versions.
        Paper.objects.select_for_update().get(pk=submission.paper_id)
        available = passages.blocks(submission)
        anchor = None
        for candidate in anchors_for(submission):
            state, spans = mapping(candidate, submission, available)
            if state == "current" and spans == canonical:
                anchor = candidate
                break
        if anchor is None:
            anchor, _ = Passage.objects.get_or_create(
                submission=submission, key=key, defaults={"spans": selected, "quote": quote}
            )
        if anchor.comments.filter(user=user, parent__isnull=True, is_deleted=False).exists():
            return ActionResult(
                {
                    "error": "You already rated this passage. Edit your existing discussion or reply to it.",
                    "passage": str(anchor.pk),
                },
                status=409,
            )
        comment = PassageComment.objects.create(passage=anchor, user=user, text=text, score=score)
        record(comment)
        discussion_activity(comment, user, "passage")
    return ActionResult({"passage": str(anchor.pk), "comment": str(comment.pk)}, status=201)


def reply(user, data, comment_id):
    require_verified(user)
    require_agreement(user)
    with transaction.atomic():
        parent = visible_comment(comment_id, lock=True)
        comment = PassageComment.objects.create(
            passage=parent.passage,
            user=user,
            parent=parent,
            root_id=parent.root_id or parent.pk,
            depth=parent.depth + 1,
            text=text_value(data),
        )
        record(comment)
        discussion_activity(comment, user, "reply")
    return ActionResult({"comment": str(comment.pk), "passage": str(parent.passage_id)}, status=201)


def edit(user, data, comment_id):
    require_verified(user)
    require_agreement(user)
    with transaction.atomic():
        comment = visible_comment(comment_id, lock=True)
        if comment.user_id != user.pk or comment.is_hidden or comment.is_deleted:
            return ActionResult(
                {"error": "Only the author can edit this visible comment."}, status=403
            )
        if type(data.get("revision")) is not int or data["revision"] != comment.revision:
            return ActionResult(
                {"error": "This comment changed elsewhere. Reopen it before editing."}, status=409
            )
        deleting = data.get("delete") is True
        comment.text = "" if deleting else text_value(data)
        if not deleting and not comment.parent_id:
            comment.score = score_value(data)
        comment.is_deleted = deleting
        comment.revision += 1
        comment.save(update_fields=["text", "score", "is_deleted", "revision", "updated_at"])
        record(comment)
        if not deleting:
            discussion_activity(comment, user, "edit")
    return ActionResult({"ok": True})


def vote(user, data, comment_id):
    require_verified(user)
    value = data.get("value")
    if type(value) is not int or value not in (-1, 0, 1):
        raise ValidationError("Choose thumbs-up, thumbs-down, or remove your vote.")
    with transaction.atomic():
        comment = visible_comment(comment_id, lock=True)
        if comment.is_hidden or comment.is_deleted:
            return ActionResult({"error": "This comment is unavailable."}, status=404)
        if value:
            previous = (
                PassageVote.objects.filter(comment=comment, user=user)
                .values_list("value", flat=True)
                .first()
            )
            PassageVote.objects.update_or_create(
                comment=comment, user=user, defaults={"value": value}
            )
            if previous != value:
                notify(
                    [comment.user_id],
                    user,
                    comment.passage.submission.paper,
                    "vote",
                    thread=comment.root or comment,
                )
        else:
            PassageVote.objects.filter(comment=comment, user=user).delete()
    return ActionResult({"ok": True})


def resolve(user, data, comment_id):
    require_verified(user)
    with transaction.atomic():
        comment = visible_comment(comment_id, lock=True)
        if (
            comment.parent_id
            or comment.user_id != user.pk
            or comment.is_hidden
            or comment.is_deleted
        ):
            return ActionResult(
                {"error": "Only the person who started this discussion can resolve or reopen it."},
                status=403,
            )
        if type(data.get("resolved")) is not bool:
            raise ValidationError("Choose resolved or open.")
        changed = comment.resolved != data["resolved"]
        comment.resolved = data["resolved"]
        comment.save(update_fields=["resolved"])
        if changed:
            discussion_activity(comment, user, "resolved")
    return ActionResult({"ok": True})


def report(user, data, comment_id):
    require_verified(user)
    comment = visible_comment(comment_id)
    if comment.is_hidden or comment.is_deleted:
        return ActionResult({"error": "This comment is already unavailable."}, status=400)
    PassageReport.objects.update_or_create(
        comment=comment,
        reporter=user,
        defaults={"reason": text_value(data, "reason", 2000), "reviewed": False},
    )
    from accounts.models import User

    notify(
        User.objects.filter(is_staff=True, is_active=True).values_list("pk", flat=True),
        user,
        comment.passage.submission.paper,
        "report",
        thread=comment.root or comment,
    )
    return ActionResult({"ok": True})


def link_pr(user, data, comment_id):
    require_verified(user)
    comment = visible_comment(comment_id)
    if comment.parent_id or comment.is_hidden or comment.is_deleted:
        return ActionResult({"error": "Link a PR to a visible top-level discussion."}, status=400)
    pr = get_object_or_404(
        PullRequest,
        pk=data.get("pr"),
        contributor=user,
        paper_id=comment.passage.submission.paper_id,
    )
    link, created = PassagePRLink.objects.get_or_create(
        thread=comment, pull_request=pr, defaults={"user": user}
    )
    if created:
        link_activity(link)
    return ActionResult({"ok": True})
