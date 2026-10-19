"""Exercise the production Caddy trust boundary in an isolated Docker network."""

from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
IMAGE = "caddy:2-alpine"


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def main():
    name = "peerpedia-proxy-test-" + uuid.uuid4().hex[:10]
    # This disposable network emulates a Cloudflare edge; it is never published.
    docker("network", "create", "--internal", "--subnet", "173.245.48.0/24", name)
    try:
        with tempfile.TemporaryDirectory() as directory:
            config = (ROOT / "deploy/Caddyfile").read_text()
            config = config.replace("{$DOMAIN}", "http://:9080")
            config = config.replace("web:8000", "127.0.0.1:9081")
            config += '\nhttp://:9081 {\n respond "{header.X-Real-IP}"\n}\n'
            path = Path(directory) / "Caddyfile"
            path.write_text(config)
            docker(
                "run",
                "-d",
                "--name",
                name,
                "--network",
                name,
                "--ip",
                "173.245.48.2",
                "-v",
                f"{path}:/etc/caddy/Caddyfile:ro",
                IMAGE,
            )
            for attempt in range(30):
                try:
                    docker("exec", name, "wget", "-qO-", "http://127.0.0.1:9080")
                    break
                except subprocess.CalledProcessError:
                    if attempt == 29:
                        raise
                    time.sleep(0.2)
            spoof_headers = [
                "--header",
                "CF-Connecting-IP: 198.51.100.25",
                "--header",
                "X-Forwarded-For: 198.51.100.26",
                "--header",
                "X-Real-IP: 198.51.100.27",
            ]
            direct = docker("exec", name, "wget", "-qO-", *spoof_headers, "http://127.0.0.1:9080")
            assert direct == "127.0.0.1", f"Untrusted client spoofed its IP: {direct}"
            for visitor in ("198.51.100.25", "2001:db8::25"):
                proxied = docker(
                    "run",
                    "--rm",
                    "--network",
                    name,
                    "--ip",
                    "173.245.48.3",
                    "--entrypoint",
                    "wget",
                    IMAGE,
                    "-qO-",
                    "--header",
                    f"CF-Connecting-IP: {visitor}",
                    "--header",
                    "X-Real-IP: 198.51.100.27",
                    "--header",
                    "X-Forwarded-For: 198.51.100.26",
                    "http://173.245.48.2:9080",
                )
                assert proxied == visitor, f"Trusted proxy lost visitor IP: {proxied}"
            print("Proxy checks passed: direct spoof rejected; IPv4/IPv6 visitors preserved.")
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        subprocess.run(["docker", "network", "rm", name], capture_output=True)


if __name__ == "__main__":
    main()
