"""Only used by scripts/test_browser.py, never by a deployed application."""

import os
from pathlib import Path
from config.settings import *  # noqa: F403

scratch = Path(os.environ["PEERPEDIA_BROWSER_SCRATCH"])
if not scratch.is_dir() or DATABASES["default"]["ENGINE"] != "django.db.backends.postgresql":
    raise RuntimeError("Use scripts/test_browser.py to provision an isolated browser run.")
DATABASES["default"]["TEST"] = {"NAME": os.environ["PEERPEDIA_BROWSER_DB_NAME"]}
DATABASES["default"]["CONN_MAX_AGE"] = 0
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
EMAIL_HOST = ""
EMAIL_HOST_USER = ""
EMAIL_HOST_PASSWORD = ""
DEFAULT_FROM_EMAIL = "Peerpedia tests <noreply@example.org>"
STATIC_ROOT = scratch / "static"
MEDIA_ROOT = scratch / "media"
FILE_UPLOAD_TEMP_DIR = str(scratch)
SECRET_KEY = "isolated-browser-tests-only"
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "testserver"]
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0
