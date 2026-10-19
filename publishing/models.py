import hashlib
import json
import uuid
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone


class Paper(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="papers"
    )
    current = models.ForeignKey(
        "Submission", null=True, blank=True, on_delete=models.PROTECT, related_name="current_for"
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    accepted_at = models.DateTimeField(default=timezone.now, db_index=True)
    is_hidden = models.BooleanField(default=False, db_index=True)

    def __str__(self):
        return self.current.title if self.current_id else str(self.pk)


class FrozenRecord(models.Model):
    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError("This record is immutable. Create a new submission instead.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("Historical records cannot be deleted.")


class Submission(FrozenRecord):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    paper = models.ForeignKey(Paper, on_delete=models.PROTECT, related_name="submissions")
    contributor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="submissions"
    )
    contributor_name = models.CharField(max_length=150)
    base = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.PROTECT, related_name="proposals"
    )
    title = models.CharField(max_length=250)
    authors = models.TextField(max_length=2000)
    abstract = models.TextField(max_length=10000)
    markdown = models.TextField()
    explanation = models.TextField(max_length=5000)
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    hash = models.CharField(max_length=64, unique=True, editable=False)

    class Meta:
        ordering = ["-created_at"]

    manifest_version = models.PositiveSmallIntegerField(default=2, editable=False)
    primary_category = models.CharField(max_length=32, blank=True, default="", db_index=True)
    secondary_categories = models.JSONField(default=list, blank=True)
    license_code = models.CharField(max_length=40, blank=True, default="")
    agreement = models.ForeignKey(
        "AgreementAcceptance",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="submissions",
    )

    @property
    def licensing(self):
        from .licensing import snapshot_license

        return snapshot_license(self)

    @property
    def via_cli(self):
        try:
            self.source
            return True
        except SubmissionSource.DoesNotExist:
            return self.apipush_set.exists()

    @property
    def ai_assisted(self):
        try:
            return self.source.ai_assisted
        except SubmissionSource.DoesNotExist:
            return False

    @property
    def subjects(self):
        from .subjects import subject_links

        return subject_links(self.primary_category, self.secondary_categories)

    def manifest(self):
        manifest = {
            "format": f"peerpedia-submission-v{self.manifest_version}",
            "submission_id": str(self.pk),
            "paper_id": str(self.paper_id),
            "contributor_id": self.contributor_id,
            "contributor_name": self.contributor_name,
            "base_hash": self.base.hash if self.base_id else None,
            "title": self.title,
            "authors": self.authors,
            "abstract": self.abstract,
            "markdown_sha256": hashlib.sha256(self.markdown.encode("utf-8")).hexdigest(),
            "explanation": self.explanation,
            "submitted_at": self.created_at.isoformat(),
        }

        if self.manifest_version >= 2:
            manifest.update(
                primary_category=self.primary_category,
                secondary_categories=self.secondary_categories,
            )
        if self.manifest_version >= 3:
            manifest.update(
                license=self.license_code,
                agreement={
                    "version": self.agreement.version,
                    "sha256": self.agreement.document_hash,
                    "accepted_at": self.agreement.created_at.isoformat(),
                    "acceptance_id": self.agreement_id,
                },
            )
        return manifest

    def calculate_hash(self):
        payload = json.dumps(
            self.manifest(), sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def save(self, *args, **kwargs):
        if self._state.adding:
            if self.manifest_version >= 2:
                from .subjects import validate_subjects

                validate_subjects(self.primary_category, self.secondary_categories)
                self.secondary_categories = sorted(self.secondary_categories)
            if self.manifest_version >= 3:
                from .licensing import LICENSES

                if self.license_code not in LICENSES or not self.agreement_id:
                    raise ValidationError("A license and agreement acceptance are required.")
                if self.agreement.user_id != self.contributor_id:
                    raise ValidationError("Agreement acceptance must belong to the contributor.")
            self.hash = self.calculate_hash()
        return super().save(*args, **kwargs)

    @property
    def status(self):
        try:
            return self.decision.action
        except Decision.DoesNotExist:
            try:
                if self.pr_commit.request.head_id != self.pk:
                    return "superseded"
            except PullRequestCommit.DoesNotExist:
                pass
            return "pending"

    @property
    def short_hash(self):
        return self.hash[:12]

    def __str__(self):
        return f"{self.title} · {self.short_hash}"


class AgreementAcceptance(FrozenRecord):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    version = models.CharField(max_length=40)
    document_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "version"], name="one_policy_acceptance")
        ]


class PaperLicense(FrozenRecord):
    paper = models.OneToOneField(
        Paper, on_delete=models.PROTECT, related_name="license_declaration"
    )
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    license_code = models.CharField(max_length=40)
    agreement_version = models.CharField(max_length=40)
    document_hash = models.CharField(max_length=64)
    # Legacy grants are dated declarations, never edits to an earlier manifest.
    legacy_hashes = models.JSONField(default=list)
    authority = models.TextField()
    created_at = models.DateTimeField(default=timezone.now, editable=False)


class RightsRequest(models.Model):
    name = models.CharField(max_length=200)
    email = models.EmailField()
    work_url = models.URLField(max_length=1000)
    details = models.TextField(max_length=10000)
    created_at = models.DateTimeField(default=timezone.now)
    resolved = models.BooleanField(default=False)
    staff_notes = models.TextField(blank=True)


class Decision(FrozenRecord):
    ACTIONS = [("accepted", "Accepted"), ("rejected", "Rejected"), ("withdrawn", "Withdrawn")]
    submission = models.OneToOneField(Submission, on_delete=models.PROTECT, related_name="decision")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    action = models.CharField(max_length=12, choices=ACTIONS)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(action__in=["accepted", "rejected", "withdrawn"]),
                name="valid_decision",
            )
        ]


class Review(models.Model):
    paper = models.ForeignKey(Paper, on_delete=models.PROTECT, related_name="reviews")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    score = models.PositiveSmallIntegerField()
    text = models.TextField(max_length=10000)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    is_hidden = models.BooleanField(default=False)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["paper", "user"], name="one_review_per_user"),
            models.CheckConstraint(
                condition=models.Q(score__gte=1, score__lte=5), name="valid_review_score"
            ),
            models.CheckConstraint(condition=~models.Q(text=""), name="nonempty_review"),
        ]

    @property
    def edited(self):
        return (self.updated_at - self.created_at).total_seconds() > 1


class Comment(models.Model):
    submission = models.ForeignKey(Submission, on_delete=models.PROTECT, related_name="comments")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    text = models.TextField(max_length=5000)
    created_at = models.DateTimeField(default=timezone.now)
    is_hidden = models.BooleanField(default=False)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.CheckConstraint(condition=~models.Q(text=""), name="nonempty_comment")
        ]


class ModerationEvent(FrozenRecord):
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    target = models.CharField(max_length=100)
    reason = models.TextField()
    created_at = models.DateTimeField(default=timezone.now)


class ApiPush(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    key = models.UUIDField()
    request_hash = models.CharField(max_length=64)
    submission = models.ForeignKey(Submission, on_delete=models.PROTECT)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "key"], name="unique_api_push_per_user")
        ]


class PullRequest(models.Model):
    """A conversation whose head points at an immutable submitted snapshot."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    paper = models.ForeignKey(Paper, on_delete=models.PROTECT, related_name="pull_requests")
    contributor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    head = models.OneToOneField(Submission, on_delete=models.PROTECT, related_name="head_of")
    created_at = models.DateTimeField(default=timezone.now)


class PullRequestCommit(FrozenRecord):
    request = models.ForeignKey(PullRequest, on_delete=models.PROTECT, related_name="commits")
    submission = models.OneToOneField(
        Submission, on_delete=models.PROTECT, related_name="pr_commit"
    )
    number = models.PositiveIntegerField()
    section = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["number"]
        constraints = [
            models.UniqueConstraint(fields=["request", "number"], name="unique_pr_commit_number")
        ]


class Draft(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="drafts"
    )
    paper = models.ForeignKey(Paper, null=True, blank=True, on_delete=models.PROTECT)
    base = models.ForeignKey(
        Submission, null=True, blank=True, on_delete=models.PROTECT, related_name="draft_bases"
    )
    pull_request = models.ForeignKey(PullRequest, null=True, blank=True, on_delete=models.PROTECT)
    pr_head = models.ForeignKey(
        Submission, null=True, blank=True, on_delete=models.PROTECT, related_name="draft_pr_heads"
    )
    scope_key = models.CharField(max_length=200, blank=True, default="")
    section = models.JSONField(default=dict, blank=True)
    data = models.JSONField(default=dict)
    markdown = models.TextField(blank=True)
    revision = models.PositiveIntegerField(default=1)
    updated_at = models.DateTimeField(auto_now=True)
    submitted = models.ForeignKey(
        Submission, null=True, blank=True, on_delete=models.PROTECT, related_name="source_drafts"
    )

    class Meta:
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "paper", "scope_key"],
                condition=models.Q(submitted__isnull=True, paper__isnull=False),
                name="one_active_scope_draft",
            )
        ]

    @property
    def title(self):
        return self.data.get("title") or "Untitled paper"


class Passage(FrozenRecord):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    submission = models.ForeignKey(Submission, on_delete=models.PROTECT, related_name="passages")
    key = models.CharField(max_length=64)
    spans = models.JSONField()
    quote = models.TextField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["submission", "key"], name="unique_version_passage")
        ]


class PassageComment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    passage = models.ForeignKey(Passage, on_delete=models.PROTECT, related_name="comments")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.PROTECT, related_name="replies"
    )
    root = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.PROTECT, related_name="descendants"
    )
    depth = models.PositiveIntegerField(default=0)
    text = models.TextField(max_length=5000)
    score = models.PositiveSmallIntegerField(null=True, blank=True)
    revision = models.PositiveIntegerField(default=1)
    is_deleted = models.BooleanField(default=False)
    is_hidden = models.BooleanField(default=False)
    resolved = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at", "pk"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(
                        parent__isnull=True,
                        root__isnull=True,
                        score__gte=1,
                        score__lte=5,
                        score__isnull=False,
                    )
                    | models.Q(parent__isnull=False, root__isnull=False, score__isnull=True)
                ),
                name="passage_root_requires_rating",
            ),
            models.UniqueConstraint(
                fields=["passage", "user"],
                condition=models.Q(parent__isnull=True, is_deleted=False),
                name="one_active_passage_rating",
            ),
        ]


class PassageCommentRevision(FrozenRecord):
    comment = models.ForeignKey(PassageComment, on_delete=models.PROTECT, related_name="history")
    number = models.PositiveIntegerField()
    text = models.TextField()
    score = models.PositiveSmallIntegerField(null=True)
    is_deleted = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["number"]
        constraints = [
            models.UniqueConstraint(
                fields=["comment", "number"], name="unique_passage_comment_revision"
            )
        ]


class PassageVote(models.Model):
    comment = models.ForeignKey(PassageComment, on_delete=models.PROTECT, related_name="votes")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    value = models.SmallIntegerField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["comment", "user"], name="one_passage_vote"),
            models.CheckConstraint(
                condition=models.Q(value__in=[-1, 1]), name="valid_passage_vote"
            ),
        ]


class PassageReport(models.Model):
    comment = models.ForeignKey(PassageComment, on_delete=models.PROTECT, related_name="reports")
    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    reason = models.TextField(max_length=2000)
    created_at = models.DateTimeField(default=timezone.now)
    reviewed = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["comment", "reporter"], name="one_passage_report")
        ]


class PassagePRLink(models.Model):
    thread = models.ForeignKey(PassageComment, on_delete=models.PROTECT, related_name="linked_prs")
    pull_request = models.ForeignKey(
        PullRequest, on_delete=models.PROTECT, related_name="linked_threads"
    )
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["thread", "pull_request"], name="unique_passage_pr_link"
            )
        ]


class SubmissionSource(FrozenRecord):
    """Tool attribution is append-only metadata, separate from the document hash."""

    submission = models.OneToOneField(Submission, on_delete=models.PROTECT, related_name="source")
    ai_assisted = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)


class Notification(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications"
    )
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    paper = models.ForeignKey(Paper, on_delete=models.CASCADE)
    thread = models.ForeignKey(PassageComment, null=True, blank=True, on_delete=models.CASCADE)
    pull_request = models.ForeignKey(PullRequest, null=True, blank=True, on_delete=models.CASCADE)
    kind = models.CharField(max_length=24)
    group_key = models.CharField(max_length=150)
    count = models.PositiveIntegerField(default=1)
    revision = models.PositiveIntegerField(default=1)
    unread = models.BooleanField(default=True)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-updated_at", "-pk"]
        constraints = [
            models.UniqueConstraint(fields=["user", "group_key"], name="unique_notification_group")
        ]
        indexes = [
            models.Index(fields=["user", "unread", "-updated_at"], name="notification_inbox_idx")
        ]


class DiagramArtifact(models.Model):
    """Rebuildable derived data; never part of a submission's immutable manifest."""

    key = models.CharField(max_length=64, primary_key=True)
    source = models.TextField()
    status = models.CharField(max_length=12, default="pending", db_index=True)
    svg = models.TextField(blank=True)
    error = models.CharField(max_length=250, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    available_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(default=timezone.now)
    submissions = models.ManyToManyField(Submission, related_name="diagram_artifacts")
