from django import forms
from django.contrib import admin
from django.contrib.auth.forms import UserChangeForm
from django.http import HttpRequest
from django.contrib.auth.admin import UserAdmin
from .models import User
from allauth.account.models import EmailAddress
from allauth.socialaccount.models import SocialAccount, SocialApp, SocialToken
from django_otp.plugins.otp_totp.models import TOTPDevice
from django_otp.plugins.otp_static.models import StaticDevice

# Secrets and recovery codes are managed only through the password-confirmed security flow.
for device_model in (TOTPDevice, StaticDevice, EmailAddress, SocialAccount, SocialApp, SocialToken):
    if admin.site.is_registered(device_model):
        admin.site.unregister(device_model)


class AccountChangeForm(UserChangeForm):
    email_verified = forms.BooleanField(required=False, label="Email verified")

    def __init__(self: "AccountChangeForm", *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self.initial["email_verified"] = self.instance.email_verified


@admin.register(User)
class PeerUserAdmin(UserAdmin):
    form = AccountChangeForm
    fieldsets = UserAdmin.fieldsets + (("Email verification", {"fields": ("email_verified",)}),)
    list_display = ("username", "email", "email_verified", "is_active", "is_staff")

    def save_model(
        self: "PeerUserAdmin", request: HttpRequest, obj: User, form: forms.ModelForm, change: bool
    ) -> None:
        super().save_model(request, obj, form, change)
        if change and ({"email", "email_verified"} & set(form.changed_data)):
            obj.emailaddress_set.exclude(email__iexact=obj.email).delete()
            # Changing the email requires proof of ownership of the new address.
            if obj.email:
                EmailAddress.objects.update_or_create(
                    user=obj,
                    email=obj.email.lower(),
                    defaults={
                        "primary": True,
                        "verified": (
                            "email" not in form.changed_data and form.cleaned_data["email_verified"]
                        ),
                    },
                )

    def has_delete_permission(self, request, obj=None):
        return False
