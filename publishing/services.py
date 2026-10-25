from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from .models import Decision, Paper, Submission, PullRequest, PullRequestCommit


def require_verified(user):
    if not user.is_authenticated or not user.is_active or not user.email_verified:
        raise PermissionDenied("A verified account is required.")


@transaction.atomic
def publish(user, data):
    require_verified(user)
    from .licensing import require_agreement, LICENSES, VERSION, document_hash
    from .models import PaperLicense

    agreement = require_agreement(user)
    from .documents import prepare

    data = prepare(data)
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
    decision = Decision.objects.create(submission=submission, actor=user, action="accepted")
    paper.current = submission
    paper.accepted_at = decision.created_at
    paper.save(update_fields=["current", "accepted_at"])
    from .identifiers import assign

    assign(paper, submission, decision.created_at)
    from .diagram_cache import enqueue

    enqueue(submission)
    return paper


@transaction.atomic
def propose(
    user, paper_id, base_id, data, *, pull_request_id=None, expected_head=None, section=None
):
    require_verified(user)
    from .licensing import require_agreement, paper_license

    agreement = require_agreement(user)
    paper = Paper.objects.select_for_update().get(pk=paper_id, is_hidden=False)
    license_code = paper_license(paper)
    from .documents import prepare

    data = prepare(data, paper.current)
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
                "This PR has changed or closed. Your draft has been preserved. Open the PR to review its latest state."
            )
    if section:
        from . import sections
        from .subjects import METADATA_FIELDS

        from .drafts import section_source

        current_source = section_source(paper.current, section)
        supplied_source = next(
            (p["markdown"] for p in data.get("chapters", []) if p["id"] == section.get("chapter")),
            data["markdown"],
        )
        boundary = {k: v for k, v in section.items() if k != "chapter"}
        if sections.find(current_source, section.get("anchor")) != boundary:
            raise ValidationError("The section boundary does not match the accepted base.")
        replacement = sections.extract(current_source, section, supplied_source)
        if sections.combine(current_source, section, replacement) != supplied_source:
            raise ValidationError("The section does not form a complete document.")
        if section.get("chapter"):
            if (
                [(p["id"], p["title"]) for p in data["chapters"]]
                != [(p["id"], p["title"]) for p in paper.current.chapters]
                or any(
                    p != q
                    for p, q in zip(data["chapters"], paper.current.chapters)
                    if p["id"] != section["chapter"]
                )
                or data.get("bibliography", "") != paper.current.bibliography
            ):
                raise ValidationError(
                    "Section PRs cannot change other chapters or the bibliography."
                )
        if any(data.get(k) != getattr(paper.current, k) for k in METADATA_FIELDS):
            raise ValidationError("Section PRs cannot change paper metadata.")
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
    from .diagram_cache import enqueue

    enqueue(submission)
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
