"""Vendor pinned TikZJax and fonts, adapting its DOM entry point to a worker.

The original is retained alongside the renamed derivative and upstream license.
No untrusted TeX is evaluated by this build script or by the Django server.
"""

import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen

DEST = Path(__file__).resolve().parent.parent / "static/vendor/tikzjax"
ASSETS = {
    "tikzjax-original.js.txt": (
        "https://tikzjax.com/v1/tikzjax.js",
        "48917188eb3485e7a22954d979ea36414a2c8d4fd81a7c69cd90a78c2126b21c",
    ),
    "tex.wasm": (
        "https://s3.us-east-2.amazonaws.com/tikzjax.com/3f69afb974a1e83f66a36f7618f88a38c254034b.wasm",
        "c9c33f593ed444a47fd4f2fd2566c7598b786d4f7ead84422155fdf0f7c46291",
    ),
    "core.bin": (
        "https://s3.us-east-2.amazonaws.com/tikzjax.com/b565ab0b474e8e557d954694b7379a57db669ac9.gz",
        "61f5c7f2aac2f68c9f08ddbaf10c41ea6986a498305b136e44991d12cb81d40e",
    ),
    "LICENSE.md": (
        "https://raw.githubusercontent.com/kisonecat/tikzjax/master/LICENSE.md",
        "e2d6c65a4e13a140cc3240db182b02cd1ab96c066c0d3c0b5ba4311e3afcb45a",
    ),
}
FONTS = (
    "https://registry.npmjs.org/node-tikzjax/-/node-tikzjax-1.0.5.tgz",
    "8618a24afb93c70a32a3fbe8051677edfcf11a52aa681b6b7435fba7c8150eb9",
)


def download(url, digest):
    data = urlopen(url, timeout=90).read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"Diagram asset integrity check failed: {url}")
    return data


def worker_engine(source):
    """Replace only the pinned bundle's browser entry point, not its TeX engine."""
    source = source.split("//# sourceMappingURL=")[0]
    start = source.index("if(void 0===document.currentScript)")
    end = source.index("let c=2500", start)
    source = source[:start] + source[end:]
    source = source.replace(
        's+"/3f69afb974a1e83f66a36f7618f88a38c254034b.wasm"', "self.diagramAssets.wasm"
    ).replace('s+"/b565ab0b474e8e557d954694b7379a57db669ac9.gz"', "self.diagramAssets.core")
    start = source.index("window.onload=async function()")
    end = source.index('var r=document.getElementsByTagName("script");', start)
    tail = source.index("}}.call(this,t(0).Buffer)", end)
    entry = source[start:end].replace(
        "window.onload=async function(){async function t(t){",
        "self.compileDiagram=async function(source){",
    )
    dom_start = entry.index("var r=t.childNodes")
    dom_end = entry.index("let o=await C(r)", dom_start)
    entry = (
        entry[:dom_start] + 'self.postMessage({type:"compiling"});var r=source;' + entry[dom_end:]
    )
    entry = entry.replace(
        "l=new Uint8Array(t.result,0,65536*c)",
        't.err||!t.result||t.result.length!==65536*c?(()=>{throw Error("Invalid compiler memory image")})():l=new Uint8Array(t.result,0,65536*c)',
    )
    # Bound output while the converter is writing, before concatenating huge strings.
    entry = entry.replace(
        "a+=A.toString(),t()",
        'a.length+A.length>2000000?(()=>{throw Error("Diagram output is too large")})():(a+=A.toString(),t())',
    )
    entry = entry[: entry.index("n.style.display=")] + (
        "return {html:a,width:w.paperwidth,height:w.paperheight};"
    )
    return (
        "/* Peerpedia worker adaptation of TikZJax, 2026-10-19.\n"
        " * Original: tikzjax-original.js.txt. License: LICENSE.md.\n"
        " * Adaptation source: scripts/fetch_diagrams.py in peerpedia/peerpedia. */\n"
        + source[:start]
        + entry
        + "}"
        + source[tail + 1 :]
    )


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    for name, (url, digest) in ASSETS.items():
        path = DEST / name
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            path.write_bytes(download(url, digest))
    (DEST / "peerpedia-engine.js").write_text(
        worker_engine((DEST / "tikzjax-original.js.txt").read_text())
    )
    with tarfile.open(fileobj=io.BytesIO(download(*FONTS)), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.name.startswith("package/css/") or not member.isfile():
                continue
            relative = Path(member.name.removeprefix("package/css/"))
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError("Unexpected font archive path")
            path = DEST / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(archive.extractfile(member).read())
    print("Installed pinned TikZJax worker engine, fonts and licenses.")


if __name__ == "__main__":
    main()
