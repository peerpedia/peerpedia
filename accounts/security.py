import hashlib
from datetime import timedelta
from functools import wraps
from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.db.models import Q
from django.shortcuts import redirect, render
from django.utils import timezone
from .models import RateLimit, User


def consume_limit(scope, identity, limit, seconds):
    key = hashlib.sha256(f"{scope}:{identity}".encode()).hexdigest()
    now = timezone.now()
    with transaction.atomic():
        record, _ = RateLimit.objects.get_or_create(key=key, defaults={"started_at": now})
        record = RateLimit.objects.select_for_update().get(pk=record.pk)
        if record.started_at < now - timedelta(seconds=seconds):
            record.started_at, record.count = now, 0
        if record.count >= limit:
            return False
        record.count += 1
        record.save()
    return True


def limited(scope, limit=10, seconds=900, account_field=None):
    def decorate(view):
        @wraps(view)
        def wrapped(request, *args, **kwargs):
            if request.method == "POST":
                # Production is reachable only through Caddy, which replaces X-Real-IP.
                address = request.META.get("REMOTE_ADDR", "")
                if not settings.DEBUG:
                    address = request.META.get("HTTP_X_REAL_IP", address)
                identity = (
                    f"user:{request.user.pk}" if request.user.is_authenticated else f"ip:{address}"
                )
                allowed = consume_limit(scope, identity, limit, seconds)
                if allowed and account_field:
                    identifier = request.POST.get(account_field, "").strip().casefold()[:254]
                    account_id = (
                        User.objects.filter(
                            Q(username__iexact=identifier) | Q(email__iexact=identifier)
                        )
                        .values_list("pk", flat=True)
                        .first()
                    )
                    account = f"user:{account_id}" if account_id else f"name:{identifier}"
                    # Both sign-in routes and both username/email spellings share a bucket.
                    account_scope = "password_login" if scope in {"login", "admin_login"} else scope
                    account_limit = 20 if account_scope == "password_login" else limit
                    allowed = consume_limit(
                        account_scope + ":account", account, account_limit, seconds
                    )
                if not allowed:
                    response = render(
                        request,
                        "error.html",
                        {
                            "heading": "Please try again later",
                            "detail": "Too many attempts. Wait a few minutes before trying again.",
                        },
                        status=429,
                    )
                    response["Retry-After"] = str(seconds)
                    return response
            return view(request, *args, **kwargs)

        return wrapped

    return decorate


def verified_required(view):
    @login_required
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if not request.user.email_verified:
            messages.info(request, "Verify your email before publishing or participating.")
            return redirect("verification_needed")
        return view(request, *args, **kwargs)

    return wrapped
