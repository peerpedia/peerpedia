from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from .models import User
from django_otp.plugins.otp_totp.models import TOTPDevice
from django_otp.plugins.otp_static.models import StaticDevice

# Secrets and recovery codes are managed only through the password-confirmed security flow.
for device_model in (TOTPDevice, StaticDevice):
    if admin.site.is_registered(device_model):
        admin.site.unregister(device_model)


@admin.register(User)
class PeerUserAdmin(UserAdmin):
    fieldsets = UserAdmin.fieldsets + (("Email verification", {"fields": ("email_verified",)}),)
    list_display = ("username", "email", "email_verified", "is_active", "is_staff")

    def has_delete_permission(self, request, obj=None):
        return False
