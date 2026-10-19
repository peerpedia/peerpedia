"""Optional local PostgreSQL verification with pgserver installed in a separate Python 3.12 environment.

Run: .test-tools/bin/python scripts/test_postgres.py
The app itself runs with .venv/bin/python. Test databases are isolated and temporary.
"""

import os
from pathlib import Path
import subprocess
import tempfile
import secrets
import socket
import time
import re
from urllib.request import Request, build_opener, ProxyHandler
import pgserver

root = Path(__file__).resolve().parent.parent
app_python = str(root / ".venv/bin/python")
local_http = build_opener(ProxyHandler({}))


def run(*args, env=None):
    subprocess.run(args, cwd=root, env=env, check=True)


with tempfile.TemporaryDirectory(prefix="peerpedia-pg-", dir="/tmp") as folder:
    server = pgserver.get_server(Path(folder) / "data", cleanup_mode="stop")
    try:
        uri = server.get_uri()
        env = dict(os.environ, DATABASE_URL=uri, DEBUG="1")
        run(app_python, "manage.py", "test", "--verbosity", "1", "--noinput", env=env)
        run(app_python, "manage.py", "migrate", "--noinput", env=env)
        run(app_python, "manage.py", "seed_demo", env=env)
        run(app_python, "manage.py", "verify_history", env=env)
        # Locate bundled executables without depending on a global PostgreSQL installation.
        bins = next(Path(pgserver.__file__).parent.rglob("pg_dump")).parent
        dump = str(Path(folder) / "backup.dump")
        run(str(bins / "pg_dump"), "--dbname", uri, "--format=custom", "--file", dump)
        server.psql("CREATE DATABASE peerpedia_restore_check")
        restored_uri = server.get_uri(database="peerpedia_restore_check")
        run(
            str(bins / "pg_restore"),
            "--exit-on-error",
            "--no-owner",
            "--dbname",
            restored_uri,
            dump,
        )
        run(app_python, "manage.py", "verify_history", env=dict(env, DATABASE_URL=restored_uri))
        # Verify production-mode asset manifests and HTTP serving, without Docker.
        production = dict(
            env,
            DEBUG="0",
            SECRET_KEY=secrets.token_urlsafe(60),
            ALLOWED_HOSTS="127.0.0.1,localhost",
            SITE_URL="https://research.example.org",
        )
        run(app_python, "manage.py", "collectstatic", "--noinput", env=production)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with tempfile.TemporaryFile() as logs:
            web = subprocess.Popen(
                [
                    str(root / ".venv/bin/gunicorn"),
                    "config.wsgi:application",
                    "--bind",
                    f"127.0.0.1:{port}",
                    "--workers",
                    "1",
                ],
                cwd=root,
                env=production,
                stdout=logs,
                stderr=logs,
            )
            try:
                origin = f"http://127.0.0.1:{port}"
                for attempt in range(50):
                    try:
                        with local_http.open(
                            Request(origin + "/", headers={"X-Forwarded-Proto": "https"}), timeout=2
                        ) as response:
                            html = response.read().decode()
                        break
                    except OSError as error:
                        if web.poll() is not None:
                            logs.seek(0)
                            print(logs.read().decode()[-8000:])
                            raise RuntimeError("Production web process exited")
                        if attempt == 49:
                            print(f"Last HTTP error: {error}")
                        time.sleep(0.1)
                else:
                    logs.seek(0)
                    print(logs.read().decode()[-8000:])
                    raise RuntimeError("Production web process did not become ready")
                css = re.search(r'href="(/static/site\.[a-f0-9]+\.css)"', html)
                if not css:
                    raise RuntimeError("Production page does not reference a hashed stylesheet")
                with local_http.open(
                    Request(origin + css.group(1), headers={"X-Forwarded-Proto": "https"}),
                    timeout=3,
                ) as response:
                    assert response.status == 200 and b".paper-row" in response.read()
                print("Production-mode Gunicorn and hashed static asset check passed.")
            finally:
                web.terminate()
                web.wait(timeout=10)
        print("PostgreSQL tests and independent backup/restore verification passed.")
    finally:
        server.cleanup()
