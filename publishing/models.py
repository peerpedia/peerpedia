import hashlib
import json
import uuid
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone


class Paper(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="papers")
    current = models.ForeignKey("Submission", null=True, blank=True, on_delete=models.PROTECT, related_name="current_for")
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
    contributor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="submissions")
    contributor_name = models.CharField(max_length=150)
    base = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="proposals")
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

    @property
    def subjects(self):
        from .subjects import subject_links
        return subject_links(self.primary_category, self.secondary_categories)

    def manifest(self):
        manifest = {
            "format": f"peerpedia-submission-v{self.manifest_version}", "submission_id": str(self.pk), "paper_id": str(self.paper_id),
            "contributor_id": self.contributor_id, "contributor_name": self.contributor_name,
            "base_hash": self.base.hash if self.base_id else None,
            "title": self.title, "authors": self.authors, "abstract": self.abstract,
            "markdown_sha256": hashlib.sha256(self.markdown.encode("utf-8")).hexdigest(),
            "explanation": self.explanation, "submitted_at": self.created_at.isoformat(),
        }

        if self.manifest_version >= 2:
            manifest.update(primary_category=self.primary_category, secondary_categories=self.secondary_categories)
        return manifest

    def calculate_hash(self):
        payload = json.dumps(self.manifest(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def save(self, *args, **kwargs):
        if self._state.adding:
            if self.manifest_version == 2:
                from .subjects import validate_subjects
                validate_subjects(self.primary_category, self.secondary_categories)
                self.secondary_categories = sorted(self.secondary_categories)
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


class Decision(FrozenRecord):
    ACTIONS = [("accepted", "Accepted"), ("rejected", "Rejected"), ("withdrawn", "Withdrawn")]
    submission = models.OneToOneField(Submission, on_delete=models.PROTECT, related_name="decision")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    action = models.CharField(max_length=12, choices=ACTIONS)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.CheckConstraint(condition=models.Q(action__in=["accepted", "rejected", "withdrawn"]), name="valid_decision")]


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
            models.CheckConstraint(condition=models.Q(score__gte=1, score__lte=5), name="valid_review_score"),
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
        constraints = [models.CheckConstraint(condition=~models.Q(text=""), name="nonempty_comment")]


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
        constraints = [models.UniqueConstraint(fields=["user", "key"], name="unique_api_push_per_user")]


class PullRequest(models.Model):
    """A conversation whose head points at an immutable submitted snapshot."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    paper = models.ForeignKey(Paper, on_delete=models.PROTECT, related_name="pull_requests")
    contributor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    head = models.OneToOneField(Submission, on_delete=models.PROTECT, related_name="head_of")
    created_at = models.DateTimeField(default=timezone.now)


class PullRequestCommit(FrozenRecord):
    request = models.ForeignKey(PullRequest, on_delete=models.PROTECT, related_name="commits")
    submission = models.OneToOneField(Submission, on_delete=models.PROTECT, related_name="pr_commit")
    number = models.PositiveIntegerField()
    section = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["number"]
        constraints = [models.UniqueConstraint(fields=["request", "number"], name="unique_pr_commit_number")]


class Draft(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="drafts")
    paper = models.ForeignKey(Paper, null=True, blank=True, on_delete=models.PROTECT)
    base = models.ForeignKey(Submission, null=True, blank=True, on_delete=models.PROTECT, related_name="draft_bases")
    pull_request = models.ForeignKey(PullRequest, null=True, blank=True, on_delete=models.PROTECT)
    pr_head = models.ForeignKey(Submission, null=True, blank=True, on_delete=models.PROTECT, related_name="draft_pr_heads")
    scope_key = models.CharField(max_length=200, blank=True, default="")
    section = models.JSONField(default=dict, blank=True)
    data = models.JSONField(default=dict)
    markdown = models.TextField(blank=True)
    revision = models.PositiveIntegerField(default=1)
    updated_at = models.DateTimeField(auto_now=True)
    submitted = models.ForeignKey(Submission, null=True, blank=True, on_delete=models.PROTECT, related_name="source_drafts")

    class Meta:
        ordering = ["-updated_at"]
        constraints = [models.UniqueConstraint(fields=["owner", "paper", "scope_key"], condition=models.Q(submitted__isnull=True, paper__isnull=False), name="one_active_scope_draft")]

    @property
    def title(self):
        return self.data.get("title") or "Untitled paper"
