from django.conf import settings
from django.urls import reverse


class SecurityHeadersMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if not request.path.startswith("/admin/"):
            form_action = "'self'"
            # Browsers apply form-action to redirects too. Only auth forms may go to Google.
            if settings.GOOGLE_LOGIN_ENABLED and request.path in {
                reverse("login"),
                reverse("signup"),
                reverse("google_login"),
                reverse("socialaccount_connections"),
            }:
                form_action += " https://accounts.google.com"
            response["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self'; font-src 'self'; connect-src 'self'; "
                f"object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action {form_action}"
            )
        response["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        return response
