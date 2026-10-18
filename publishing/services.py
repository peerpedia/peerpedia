from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone
from .models import Decision, Paper, Submission


def require_verified(user):
    if not user.is_authenticated or not user.is_active or not user.email_verified:
        raise PermissionDenied("A verified account is required.")


@transaction.atomic
def publish(user, data):
    require_verified(user)
    paper = Paper.objects.create(owner=user)
    submission = Submission.objects.create(paper=paper, contributor=user, contributor_name=user.username, **data)
    decision = Decision.objects.create(submission=submission, actor=user, action="accepted")
    paper.current = submission
    paper.accepted_at = decision.created_at
    paper.save(update_fields=["current", "accepted_at"])
    return paper


@transaction.atomic
def propose(user, paper_id, base_id, data):
    require_verified(user)
    paper = Paper.objects.select_for_update().get(pk=paper_id, is_hidden=False)
    if str(paper.current_id) != str(base_id):
        raise ValidationError("This paper has a newer accepted version. Download it and prepare a new submission; your upload has not been published.")
    return Submission.objects.create(paper=paper, contributor=user, contributor_name=user.username, base_id=base_id, **data)


@transaction.atomic
def decide(user, submission_id, action):
    require_verified(user)
    proposal = Submission.objects.select_related("paper").get(pk=submission_id, paper__is_hidden=False)
    paper = Paper.objects.select_for_update().get(pk=proposal.paper_id)
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
        raise ValidationError("This proposal is based on an older version and cannot be accepted. A new submission is required.")
    event = Decision.objects.create(submission=proposal, actor=user, action=action)
    if action == "accepted":
        paper.current = proposal
        paper.accepted_at = event.created_at
        paper.save(update_fields=["current", "accepted_at"])
    return event
