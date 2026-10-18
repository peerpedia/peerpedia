from django.conf import settings


def project_info(request):
    return {
        "repository_url": settings.PROJECT_REPOSITORY_URL,
        "developer_name": settings.DEVELOPER_NAME,
        "developer_url": settings.DEVELOPER_URL,
        "site_url": settings.SITE_URL,
    }
