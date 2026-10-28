"""Transport to BananaMark; no Markdown syntax is implemented in Python."""

import atexit
import json
import os
import selectors
import subprocess
import threading
import time
from functools import lru_cache
from urllib.request import Request, ProxyHandler, build_opener
from django.conf import settings
from django.core.exceptions import ValidationError

_lock = threading.Lock()
_process = None
_owner = None


def close():
    global _process
    if _process is not None:
        _process.kill()
        _process.wait()
        _process = None


atexit.register(close)


@lru_cache(maxsize=24)
def _request(payload, endpoint):
    global _process, _owner
    try:
        if endpoint:
            req = Request(
                endpoint.rstrip("/") + "/render",
                data=payload.encode(),
                headers={"Content-Type": "application/json"},
            )
            with build_opener(ProxyHandler({})).open(req, timeout=35) as response:
                raw = response.read(16_000_001)
        else:
            with _lock:
                if _owner != os.getpid():
                    _process = None
                    _owner = os.getpid()
                if _process is None or _process.poll() is not None:
                    _process = subprocess.Popen(
                        [
                            os.environ.get("NODE_BINARY", "node"),
                            str(settings.BASE_DIR / "editor/render-server.mjs"),
                            "--stdio",
                        ],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        cwd=settings.BASE_DIR,
                    )
                try:
                    _process.stdin.write(payload.encode() + b"\n")
                    _process.stdin.flush()
                    raw = b""
                    deadline = time.monotonic() + 35
                    with selectors.DefaultSelector() as selector:
                        selector.register(_process.stdout, selectors.EVENT_READ)
                        while not raw.endswith(b"\n"):
                            if not selector.select(max(0, deadline - time.monotonic())):
                                raise TimeoutError("Renderer timed out")
                            chunk = os.read(_process.stdout.fileno(), 65536)
                            if not chunk:
                                raise OSError("Renderer stopped")
                            raw += chunk
                            if len(raw) > 16_000_000:
                                raise OSError("Rendered document is too large")
                except Exception:
                    close()
                    raise
        if len(raw) > 16_000_000:
            raise OSError("Rendered document is too large")
        result = json.loads(raw)
    except (OSError, ValueError) as error:
        raise ValidationError(
            "The article renderer is unavailable. Your draft can still be saved."
        ) from error
    if "error" in result:
        error = result["error"]
        raise ValidationError(
            "%(detail)s",
            code=error.get("code") or "bananamark",
            params={
                "detail": error["message"],
                "line": error.get("line"),
                "column": error.get("column"),
                "file": error.get("file"),
            },
        )
    return result["result"]


def request(**data):
    data.setdefault("staticUrl", settings.STATIC_URL)
    return json.loads(json.dumps(_request(json.dumps(data), settings.BANANAMARK_URL)))


def structure(source):
    return request(action="structure", source=source, numberSections=False)["pages"][0]
