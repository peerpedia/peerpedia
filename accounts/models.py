from django.contrib.auth.models import AbstractUser
from django.db import models
from django.db.models.functions import Lower


class User(AbstractUser):
    email = models.EmailField(unique=True)
    email_verified = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(Lower("email"), name="unique_email_ci"),
            models.UniqueConstraint(Lower("username"), name="unique_username_ci"),
        ]


class RateLimit(models.Model):
    key = models.CharField(max_length=64, unique=True)
    started_at = models.DateTimeField()
    count = models.PositiveIntegerField(default=0)


class AccessToken(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="access_tokens")
    name = models.CharField(max_length=80)
    digest = models.CharField(max_length=64, unique=True)
    prefix = models.CharField(max_length=12)
    can_publish = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)
