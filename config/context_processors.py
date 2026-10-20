from django.conf import settings


def project_info(request):
    from publishing.notifications import visible

    from publishing.licensing import acceptance

    unread = (
        visible(request.user).filter(unread=True).count() if request.user.is_authenticated else 0
    )
    return {
        "unread_notifications": unread,
        "needs_agreement": request.user.is_authenticated
        and request.user.email_verified
        and not acceptance(request.user),
        "project_version": settings.PROJECT_VERSION,
        "repository_url": settings.PROJECT_REPOSITORY_URL,
        "developer_name": settings.DEVELOPER_NAME,
        "developer_url": settings.DEVELOPER_URL,
        "site_url": settings.SITE_URL,
        "google_login_enabled": settings.GOOGLE_LOGIN_ENABLED,
    }
