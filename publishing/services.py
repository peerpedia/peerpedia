from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from .models import Decision, Paper, Submission, PullRequest, PullRequestCommit


def require_verified(user):
    if not user.is_authenticated or not user.is_active or not user.email_verified:
        raise PermissionDenied("A verified account is required.")


@transaction.atomic
def publish(user, data):
    require_verified(user)
    paper = Paper.objects.create(owner=user)
    submission = Submission.objects.create(
        paper=paper, contributor=user, contributor_name=user.username, **data
    )
    decision = Decision.objects.create(submission=submission, actor=user, action="accepted")
    paper.current = submission
    paper.accepted_at = decision.created_at
    paper.save(update_fields=["current", "accepted_at"])
    return paper


@transaction.atomic
def propose(
    user, paper_id, base_id, data, *, pull_request_id=None, expected_head=None, section=None
):
    require_verified(user)
    paper = Paper.objects.select_for_update().get(pk=paper_id, is_hidden=False)
    if str(paper.current_id) != str(base_id):
        raise ValidationError(
            "This paper has a newer accepted version. Download it and prepare a new submission; your upload has not been published."
        )
    pr = None
    if pull_request_id:
        pr = (
            PullRequest.objects.select_for_update()
            .select_related("head")
            .get(pk=pull_request_id, paper=paper)
        )
        if pr.contributor_id != user.pk:
            raise PermissionDenied("Only the PR contributor can add snapshots.")
        if str(pr.head_id) != str(expected_head) or pr.head.status != "pending":
            raise ValidationError(
                "This PR has changed or closed. Your draft has been preserved. Open the PR to review its latest state."
            )
    if section:
        from . import sections
        from .subjects import METADATA_FIELDS

        if sections.find(paper.current.markdown, section.get("anchor")) != section:
            raise ValidationError("The section boundary does not match the accepted base.")
        replacement = sections.extract(paper.current.markdown, section, data["markdown"])
        if sections.combine(paper.current.markdown, section, replacement) != data["markdown"]:
            raise ValidationError("The section does not form a complete document.")
        if any(data.get(k) != getattr(paper.current, k) for k in METADATA_FIELDS):
            raise ValidationError("Section PRs cannot change paper metadata.")
    submission = Submission.objects.create(
        paper=paper, contributor=user, contributor_name=user.username, base_id=base_id, **data
    )
    if pr:
        number = pr.commits.count() + 1
        pr.head = submission
        pr.save(update_fields=["head"])
    else:
        pr = PullRequest.objects.create(paper=paper, contributor=user, head=submission)
        number = 1
    PullRequestCommit.objects.create(
        request=pr, submission=submission, number=number, section=section or {}
    )
    from .notifications import notify

    notify([paper.owner_id], user, paper, "proposal", pr=pr)
    return submission


@transaction.atomic
def decide(user, submission_id, action):
    require_verified(user)
    proposal = Submission.objects.select_related("paper").get(
        pk=submission_id, paper__is_hidden=False
    )
    paper = Paper.objects.select_for_update().get(pk=proposal.paper_id)
    commit = PullRequestCommit.objects.filter(submission=proposal).first()
    if commit:
        pr = PullRequest.objects.select_for_update().get(pk=commit.request_id)
        if pr.head_id != proposal.pk:
            raise ValidationError(
                "This snapshot has been superseded. Review the latest snapshot before making a decision."
            )
    if action not in {"accepted", "rejected", "withdrawn"}:
        raise ValidationError("Unknown decision.")
    if action == "withdrawn":
        if proposal.contributor_id != user.pk:
            raise PermissionDenied("Only the contributor can withdraw this submission.")
    elif paper.owner_id != user.pk:
        raise PermissionDenied("Only the corresponding author can accept or reject submissions.")
    if Decision.objects.filter(submission=proposal).exists():
        raise ValidationError("This submission already has a final decision.")
    if action == "accepted" and proposal.base_id != paper.current_id:
        raise ValidationError(
            "This proposal is based on an older version and cannot be accepted. A new submission is required."
        )
    event = Decision.objects.create(submission=proposal, actor=user, action=action)
    if action == "accepted":
        paper.current = proposal
        paper.accepted_at = event.created_at
        paper.save(update_fields=["current", "accepted_at"])
    from .notifications import notify

    notify([proposal.contributor_id], user, paper, "decision", pr=pr if commit else None)
    if commit:
        for link in pr.linked_threads.select_related("thread"):
            notify([link.thread.user_id], user, paper, "decision", thread=link.thread, pr=pr)
    return event
