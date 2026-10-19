"""Fetch a pinned, integrity-checked MathJax bundle; no Node build is needed."""

import base64
import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen

URL = "https://registry.npmjs.org/mathjax/-/mathjax-3.2.2.tgz"
INTEGRITY = (
    "Bt+SSVU8eBG27zChVewOicYs7Xsdt40qm4+UpHyX7k0/O9NliPc+x77k1/FEsPsjKPZGJvtRZM1vO+geW0OhGw=="
)
DEST = Path(__file__).resolve().parent.parent / "static" / "vendor" / "mathjax"


def main():
    data = urlopen(URL, timeout=60).read()
    if base64.b64encode(hashlib.sha512(data).digest()).decode() != INTEGRITY:
        raise RuntimeError("MathJax archive integrity check failed")
    DEST.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        # Extract only named regular files, never archive paths or links.
        for member, name in [
            ("package/es5/tex-svg.js", "tex-svg.js"),
            ("package/LICENSE", "LICENSE"),
        ]:
            entry = archive.getmember(member)
            if not entry.isfile():
                raise RuntimeError("Unexpected archive entry")
            (DEST / name).write_bytes(archive.extractfile(entry).read())
    print("Installed local MathJax 3.2.2 bundle and license.")


if __name__ == "__main__":
    main()
