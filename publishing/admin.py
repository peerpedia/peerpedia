from django.contrib import admin
from .models import Comment, Decision, ModerationEvent, Paper, Review, Submission


class ImmutableAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return False
    def has_delete_permission(self, request, obj=None):
        return False


class ModeratedAdmin(admin.ModelAdmin):
    actions = ["hide_selected", "restore_selected"]

    def has_add_permission(self, request):
        return False
    def has_delete_permission(self, request, obj=None):
        return False
    def get_readonly_fields(self, request, obj=None):
        return [field.name for field in self.model._meta.fields if field.name != "is_hidden"]

    def save_model(self, request, obj, form, change):
        if "is_hidden" in form.changed_data:
            ModerationEvent.objects.create(actor=request.user, target=f"{obj._meta.label}:{obj.pk}", reason="Hidden by administrator" if obj.is_hidden else "Restored by administrator")
        super().save_model(request, obj, form, change)

    @admin.action(description="Hide selected content")
    def hide_selected(self, request, queryset):
        for obj in queryset.filter(is_hidden=False):
            obj.is_hidden = True
            obj.save(update_fields=["is_hidden"])
            ModerationEvent.objects.create(actor=request.user, target=f"{obj._meta.label}:{obj.pk}", reason="Hidden by administrator")

    @admin.action(description="Restore selected content")
    def restore_selected(self, request, queryset):
        for obj in queryset.filter(is_hidden=True):
            obj.is_hidden = False
            obj.save(update_fields=["is_hidden"])
            ModerationEvent.objects.create(actor=request.user, target=f"{obj._meta.label}:{obj.pk}", reason="Restored by administrator")


@admin.register(Paper)
class PaperAdmin(ModeratedAdmin):
    list_display = ("__str__", "owner", "accepted_at", "is_hidden")
    list_filter = ("is_hidden",)
    search_fields = ("current__title", "current__authors")


@admin.register(Review)
class ReviewAdmin(ModeratedAdmin):
    list_display = ("paper", "user", "score", "is_hidden")


@admin.register(Comment)
class CommentAdmin(ModeratedAdmin):
    list_display = ("submission", "user", "created_at", "is_hidden")


admin.site.register(Submission, ImmutableAdmin)
admin.site.register(Decision, ImmutableAdmin)
admin.site.register(ModerationEvent, ImmutableAdmin)
