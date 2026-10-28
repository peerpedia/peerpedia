"""Run real-browser journeys against disposable PostgreSQL and a private server.

Local: .test-tools/bin/python scripts/test_browser.py --python .venv/bin/python
CI: set BROWSER_TEST_DATABASE_URL to a disposable PostgreSQL service, then run
    python scripts/test_browser.py
Ordinary DATABASE_URL and SMTP configuration are never used.
"""

import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid


@contextmanager
def database_url(scratch):
    if os.environ.get("BROWSER_TEST_DATABASE_URL"):
        # Explicit opt-in for a disposable CI service with CREATEDB permission.
        yield os.environ["BROWSER_TEST_DATABASE_URL"]
        return
    try:
        import pgserver
    except ImportError:
        raise SystemExit(
            "Run with .test-tools/bin/python (see README), or supply BROWSER_TEST_DATABASE_URL for an isolated CI database service."
        )
    server = pgserver.get_server(scratch / "postgres", cleanup_mode="stop")
    try:
        yield server.get_uri()
    finally:
        server.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Python with app and browser dependencies installed",
    )
    parser.add_argument(
        "--tests",
        nargs="+",
        default=["browser_tests.journeys"],
        help="Django test labels to run against the disposable website",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    # Preserve the virtualenv entry point; resolving its symlink bypasses the venv.
    app_python = os.path.abspath(args.python)
    if not (root / "static/vendor/bananamark/katex.min.css").is_file():
        raise SystemExit("First run: npm ci --prefix editor && npm run build --prefix editor")
    with tempfile.TemporaryDirectory(prefix="peerpedia-browser-") as folder:
        scratch = Path(folder)
        with database_url(scratch) as uri:
            env = dict(os.environ)
            env.update(
                DATABASE_URL=uri,
                DEBUG="1",
                DJANGO_SETTINGS_MODULE="browser_tests.settings",
                PEERPEDIA_BROWSER_SCRATCH=str(scratch),
                PEERPEDIA_BROWSER_DB_NAME="test_browser_" + uuid.uuid4().hex,
                PEERPEDIA_BROWSER_ARTIFACTS=str(root / ".browser-test-results" / uuid.uuid4().hex),
            )
            return subprocess.run(
                [
                    app_python,
                    "manage.py",
                    "test",
                    *args.tests,
                    "--noinput",
                    "--verbosity=2",
                ],
                cwd=root,
                env=env,
            ).returncode


if __name__ == "__main__":
    sys.exit(main())
