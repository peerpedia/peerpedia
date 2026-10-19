from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from .models import User


@admin.register(User)
class PeerUserAdmin(UserAdmin):
    fieldsets = UserAdmin.fieldsets + (("Email verification", {"fields": ("email_verified",)}),)
    list_display = ("username", "email", "email_verified", "is_active", "is_staff")

    def has_delete_permission(self, request, obj=None):
        return False
