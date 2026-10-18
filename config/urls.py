from django.contrib import admin
from django.urls import include, path
from accounts.security import limited

admin.site.login = limited("admin_login", limit=10, seconds=900)(admin.site.login)

urlpatterns = [path("admin/", admin.site.urls), path("api/v1/", include("publishing.api")), path("accounts/", include("accounts.urls")), path("", include("publishing.urls"))]
admin.site.site_header = "Peerpedia administration"
admin.site.site_title = "Peerpedia"
admin.site.index_title = "Moderation and accounts"
