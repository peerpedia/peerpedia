class SecurityHeadersMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if not request.path.startswith("/admin/"):
            response["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self'; font-src 'self'; connect-src 'self'; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
            )
        response["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        return response
