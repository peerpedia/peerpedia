from django.contrib import admin
from .models import Comment, Decision, ModerationEvent, Paper, Review, Submission
from .models import Passage, PassageComment, PassageCommentRevision, PassageReport
from .models import SubmissionSource, AgreementAcceptance, PaperLicense, RightsRequest


class ImmutableAdmin(admin.ModelAdmin):
    list_per_page = 30

    def get_readonly_fields(self, request, obj=None):
        return [field.name for field in self.model._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


class ModeratedAdmin(admin.ModelAdmin):
    actions = ["hide_selected", "restore_selected"]
    list_per_page = 30

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_readonly_fields(self, request, obj=None):
        return [field.name for field in self.model._meta.fields if field.name != "is_hidden"]

    def save_model(self, request, obj, form, change):
        if "is_hidden" in form.changed_data:
            ModerationEvent.objects.create(
                actor=request.user,
                target=f"{obj._meta.label}:{obj.pk}",
                reason="Hidden by administrator" if obj.is_hidden else "Restored by administrator",
            )
        super().save_model(request, obj, form, change)

    @admin.action(description="Hide selected content")
    def hide_selected(self, request, queryset):
        for obj in queryset.filter(is_hidden=False):
            obj.is_hidden = True
            obj.save(update_fields=["is_hidden"])
            ModerationEvent.objects.create(
                actor=request.user,
                target=f"{obj._meta.label}:{obj.pk}",
                reason="Hidden by administrator",
            )

    @admin.action(description="Restore selected content")
    def restore_selected(self, request, queryset):
        for obj in queryset.filter(is_hidden=True):
            obj.is_hidden = False
            obj.save(update_fields=["is_hidden"])
            ModerationEvent.objects.create(
                actor=request.user,
                target=f"{obj._meta.label}:{obj.pk}",
                reason="Restored by administrator",
            )


@admin.register(Paper)
class PaperAdmin(ModeratedAdmin):
    list_display = ("__str__", "owner", "accepted_at", "is_hidden")
    list_filter = ("is_hidden",)
    search_fields = ("current__title", "current__authors")
    list_select_related = ("current", "owner")


@admin.register(Review)
class ReviewAdmin(ModeratedAdmin):
    list_display = ("paper", "user", "score", "is_hidden")
    list_filter = ("is_hidden", "score")
    search_fields = ("paper__current__title", "user__username", "text")
    list_select_related = ("paper__current", "user")


@admin.register(Comment)
class CommentAdmin(ModeratedAdmin):
    list_display = ("submission", "user", "created_at", "is_hidden")
    list_filter = ("is_hidden",)
    search_fields = ("submission__title", "user__username", "text")
    list_select_related = ("submission", "user")


@admin.register(Submission)
class SubmissionAdmin(ImmutableAdmin):
    list_display = ("title", "public_id", "contributor_name", "created_at")
    search_fields = ("title", "authors", "hash", "contributor_name")
    ordering = ("-created_at",)


@admin.register(Decision)
class DecisionAdmin(ImmutableAdmin):
    list_display = ("submission", "action", "actor", "created_at")
    list_filter = ("action",)
    search_fields = ("submission__title", "actor__username")
    list_select_related = ("submission", "actor")
    ordering = ("-created_at",)


@admin.register(ModerationEvent)
class ModerationEventAdmin(ImmutableAdmin):
    list_display = ("reason", "actor", "target", "created_at")
    search_fields = ("reason", "actor__username", "target")
    list_select_related = ("actor",)
    ordering = ("-created_at",)


@admin.register(PassageComment)
class PassageCommentAdmin(ModeratedAdmin):
    list_display = ("comment_excerpt", "paper_title", "user", "score", "is_hidden", "is_deleted")
    list_filter = ("is_hidden", "is_deleted")
    search_fields = ("text", "user__username", "passage__quote", "passage__submission__title")
    list_select_related = ("passage__submission", "user")

    @admin.display(description="Comment")
    def comment_excerpt(self, obj):
        return obj.text[:100] + ("…" if len(obj.text) > 100 else "")

    @admin.display(description="Paper", ordering="passage__submission__title")
    def paper_title(self, obj):
        return obj.passage.submission.title


@admin.register(PassageReport)
class PassageReportAdmin(admin.ModelAdmin):
    list_display = ("reason", "comment_excerpt", "reporter", "created_at", "reviewed")
    list_filter = ("reviewed",)
    actions = ("hide_reported",)
    list_per_page = 30
    search_fields = ("reason", "comment__text", "reporter__username")
    list_select_related = ("comment", "reporter")
    ordering = ("reviewed", "-created_at")

    @admin.display(description="Reported comment")
    def comment_excerpt(self, obj):
        return obj.comment.text[:100] + ("…" if len(obj.comment.text) > 100 else "")

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_readonly_fields(self, request, obj=None):
        return [f.name for f in self.model._meta.fields if f.name != "reviewed"]

    @admin.action(description="Hide reported comments and mark reports reviewed")
    def hide_reported(self, request, queryset):
        from django.db import transaction

        with transaction.atomic():
            comments = PassageComment.objects.filter(
                pk__in=queryset.values("comment_id"), is_hidden=False
            )
            for comment in comments:
                comment.is_hidden = True
                comment.save(update_fields=["is_hidden"])
                ModerationEvent.objects.create(
                    actor=request.user,
                    target=f"{comment._meta.label}:{comment.pk}",
                    reason="Hidden after reviewing a passage report",
                )
            queryset.update(reviewed=True)


@admin.register(Passage)
class PassageAdmin(ImmutableAdmin):
    list_display = ("quote_excerpt", "submission", "created_at")
    search_fields = ("quote", "submission__title")
    list_select_related = ("submission",)

    @admin.display(description="Quotation")
    def quote_excerpt(self, obj):
        return obj.quote[:120] + ("…" if len(obj.quote) > 120 else "")


@admin.register(PassageCommentRevision)
class PassageCommentRevisionAdmin(ImmutableAdmin):
    list_display = ("comment_excerpt", "number", "score", "is_deleted", "created_at")
    search_fields = ("text", "comment__user__username")

    @admin.display(description="Comment text")
    def comment_excerpt(self, obj):
        return obj.text[:100] + ("…" if len(obj.text) > 100 else "")


@admin.register(SubmissionSource)
class SubmissionSourceAdmin(ImmutableAdmin):
    list_display = ("submission", "ai_assisted", "created_at")
    list_filter = ("ai_assisted",)
    search_fields = ("submission__title", "submission__contributor_name")
    list_select_related = ("submission",)


@admin.register(AgreementAcceptance)
class AgreementAcceptanceAdmin(ImmutableAdmin):
    list_display = ("user", "version", "created_at")
    search_fields = ("user__username",)


@admin.register(PaperLicense)
class PaperLicenseAdmin(ImmutableAdmin):
    list_display = ("paper", "actor", "license_code", "created_at")
    search_fields = ("actor__username", "paper__current__title")


@admin.register(RightsRequest)
class RightsRequestAdmin(admin.ModelAdmin):
    list_display = ("name", "work_url", "created_at", "resolved")
    list_filter = ("resolved",)
    ordering = ("resolved", "-created_at")
    readonly_fields = ("name", "email", "work_url", "details", "created_at")

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
