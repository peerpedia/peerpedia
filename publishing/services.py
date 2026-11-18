from typing import Any
from uuid import UUID
from accounts.models import User
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from .documents import PreparedDocument, prepare
from .models import Decision, Paper, Submission, PullRequest, PullRequestCommit


def require_verified(user: User) -> None:
    if not user.is_authenticated or not user.is_active or not user.email_verified:
        raise PermissionDenied("A verified account is required.")


def publish(user: User, data: dict[str, Any] | PreparedDocument) -> Paper:
    require_verified(user)
    from .licensing import require_agreement

    require_agreement(user)
    prepared = data if isinstance(data, PreparedDocument) else prepare(data)
    if prepared.base_id is not None:
        raise ValidationError("A new paper cannot use a revision's prepared content.")
    return _publish(user, prepared)


def propose(
    user: User,
    paper_id: UUID,
    base_id: UUID | str,
    data: dict[str, Any] | PreparedDocument,
    *,
    pull_request_id: UUID | None = None,
    expected_head: UUID | None = None,
) -> Submission:
    require_verified(user)
    from .licensing import require_agreement

    require_agreement(user)
    if isinstance(data, PreparedDocument):
        prepared = data
    else:
        paper = Paper.objects.select_related("current").get(pk=paper_id, is_hidden=False)
        if str(paper.current_id) != str(base_id):
            raise ValidationError(
                "This paper has a newer accepted version. Update your base before submitting."
            )
        prepared = prepare(data, paper.current)
    if str(prepared.base_id) != str(base_id):
        raise ValidationError("Prepared content does not match this submission's base.")
    return _propose(
        user,
        paper_id,
        base_id,
        prepared,
        pull_request_id=pull_request_id,
        expected_head=expected_head,
    )


@transaction.atomic
def _publish(user: User, prepared: PreparedDocument) -> Paper:
    require_verified(user)
    from .licensing import require_agreement, LICENSES, VERSION, document_hash
    from .models import PaperLicense

    agreement = require_agreement(user)
    data = dict(prepared.data)
    license_code = data.pop("license", None)
    if not isinstance(license_code, str) or license_code not in LICENSES:
        raise ValidationError(
            "Choose a content license for the new paper.", code="license_required"
        )
    paper = Paper.objects.create(owner=user)
    PaperLicense.objects.create(
        paper=paper,
        actor=user,
        license_code=license_code,
        agreement_version=VERSION,
        document_hash=document_hash(),
        authority="Corresponding author selected this license when publishing.",
    )
    submission = Submission.objects.create(
        paper=paper,
        contributor=user,
        contributor_name=user.username,
        manifest_version=4 if data.get("chapters") or data.get("bibliography") else 3,
        license_code=license_code,
        agreement=agreement,
        **data,
    )
    from .artifacts import store

    store(submission, prepared.result, prepared.renderer_version)
    decision = Decision.objects.create(submission=submission, actor=user, action="accepted")
    paper.current = submission
    paper.accepted_at = decision.created_at
    paper.save(update_fields=["current", "accepted_at"])
    from .identifiers import assign

    assign(paper, submission, decision.created_at)
    return paper


@transaction.atomic
def _propose(
    user: User,
    paper_id: UUID,
    base_id: UUID | str,
    prepared: PreparedDocument,
    *,
    pull_request_id: UUID | None,
    expected_head: UUID | None,
) -> Submission:
    require_verified(user)
    from .licensing import require_agreement, paper_license

    agreement = require_agreement(user)
    paper = Paper.objects.select_for_update().get(pk=paper_id, is_hidden=False)
    license_code = paper_license(paper)
    data = dict(prepared.data)
    supplied = data.pop("license", license_code)
    if supplied != license_code:
        raise ValidationError(
            "Revisions must inherit the paper's fixed license.", code="license_mismatch"
        )
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
                "This PR has changed or closed. Review its latest snapshot before submitting another update."
            )
    submission = Submission.objects.create(
        paper=paper,
        contributor=user,
        contributor_name=user.username,
        base_id=base_id,
        manifest_version=4 if data.get("chapters") or data.get("bibliography") else 3,
        license_code=license_code,
        agreement=agreement,
        **data,
    )
    from .artifacts import store

    store(submission, prepared.result, prepared.renderer_version)
    if pr:
        number = pr.commits.count() + 1
        pr.head = submission
        pr.save(update_fields=["head"])
    else:
        pr = PullRequest.objects.create(paper=paper, contributor=user, head=submission)
        number = 1
    PullRequestCommit.objects.create(request=pr, submission=submission, number=number)
    from .notifications import notify

    notify([paper.owner_id], user, paper, "proposal", pr=pr)
    return submission


@transaction.atomic
def decide(user: User, submission_id: UUID, action: str) -> Decision:
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
    return event
