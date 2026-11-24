"""Serve the unmodified publishing API on loopback using a temporary PostgreSQL cluster.

The parent controls acceptance through a private pipe. No test control URL is mounted.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import parse_qs, urlparse
from uuid import UUID
from wsgiref.simple_server import make_server


def serve() -> None:
    home = Path.home().resolve()
    uri = urlparse(os.environ["DATABASE_URL"])
    sockets = parse_qs(uri.query).get("host", [])
    if (
        home.parent != Path("/tmp").resolve()
        or not home.name.startswith("peerpedia-journey-")
        or uri.hostname
        or len(sockets) != 1
        or Path(sockets[0]).resolve() != home / "data"
    ):
        raise RuntimeError("Expected the socket of the temporary journey database")
    root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(root))
    import django

    django.setup()
    from django.core.management import call_command
    from django.core.wsgi import get_wsgi_application
    from django.db import connections
    from accounts.tokens import issue_token
    from publishing.models import Paper, PullRequest, Submission
    from publishing.services import decide
    from publishing.test_support import consenting_user

    call_command("migrate", interactive=False, verbosity=0)
    owner = consenting_user("journey-writer", "journey@example.invalid", email_verified=True)
    _, token = issue_token(owner, "Disposable integration token", can_publish=True)
    with make_server("127.0.0.1", 0, get_wsgi_application()) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            print(
                json.dumps(
                    dict(
                        origin=f"http://127.0.0.1:{server.server_port}", username=owner.username, token=token
                    )
                ),
                flush=True,
            )
            for line in sys.stdin:
                command = json.loads(line)
                if command == "counts":
                    print(
                        json.dumps(
                            dict(
                                papers=Paper.objects.count(),
                                proposals=PullRequest.objects.count(),
                                snapshots=Submission.objects.count(),
                            )
                        ),
                        flush=True,
                    )
                else:
                    decide(owner, UUID(command["accept"]), "accepted")
                    print('{"accepted":true}', flush=True)
        finally:
            server.shutdown()
            worker.join()
            connections.close_all()


def main() -> None:
    import pgserver

    with TemporaryDirectory(prefix="peerpedia-journey-", dir="/tmp") as directory:
        cluster = pgserver.get_server(Path(directory) / "data", cleanup_mode="stop")
        try:
            env = dict(
                PATH=os.environ["PATH"],
                HOME=directory,
                DATABASE_URL=cluster.get_uri(),
                PYTHONDONTWRITEBYTECODE="1",
                DJANGO_SETTINGS_MODULE="config.settings",
                DEBUG="1",
                ALLOWED_HOSTS="127.0.0.1",
            )
            python = os.environ.get("PEERPEDIA_TEST_PYTHON", sys.executable)
            subprocess.run([python, __file__, "--serve"], env=env, check=True)
        finally:
            cluster.cleanup()


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        serve()
    else:
        main()
