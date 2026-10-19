"""Content-addressed, rebuildable diagram jobs and strict static-SVG validation."""

import base64
import hashlib
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from django.conf import settings

# Bump when engine/core, fonts or sanitization changes. Never mutate old artifacts.
VERSION = "tikzjax-b565ab0b-20261019-saved-svg-v2"
MAX_SOURCE = 32768
MAX_DIAGRAMS = 32
SVG = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG)


def key_for(source):
    return hashlib.sha256((VERSION + "\0" + source).encode()).hexdigest()


def sources(markdown):
    from .rendering import parser

    return list(
        dict.fromkeys(
            token.content
            for token in parser().parse(markdown)
            if token.type == "fence" and token.info.strip() in {"tikz", "tikzcd", "tikzpicture"}
        )
    )


def enqueue(submission):
    from .models import DiagramArtifact

    for source in sources(submission.markdown)[:MAX_DIAGRAMS]:
        oversized = len(source.encode()) > MAX_SOURCE
        artifact, _ = DiagramArtifact.objects.get_or_create(
            key=key_for(source),
            defaults={
                "source": source if not oversized else "",
                "status": "error" if oversized else "pending",
                "error": "Keep each diagram below 32 KB." if oversized else "",
            },
        )
        artifact.submissions.add(submission)


def saved_for(submission):
    return {item.key: item for item in submission.diagram_artifacts.defer("svg", "source")}


def sanitize(result):
    """Discard executable content, then embed only trusted local fonts for img use."""
    raw = result.get("html")
    width, height = result.get("width"), result.get("height")
    if not isinstance(raw, str) or len(raw.encode()) > 2000000:
        raise ValueError("Diagram output is too large.")
    if any(
        not isinstance(n, (int, float)) or not math.isfinite(n) or not 0 < n <= 10000
        for n in (width, height)
    ):
        raise ValueError("Invalid diagram dimensions.")
    # Reject declarations before XML parsing; external entities are never expanded.
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)", raw, re.I):
        raise ValueError("Unsupported SVG declaration.")
    try:
        matches = re.findall(r"<svg\b.*?</svg>", raw, re.S)
        if len(matches) != 1:
            raise ValueError("Expected one diagram.")
        root = ET.fromstring(matches[0])
    except ET.ParseError as exc:
        raise ValueError("Invalid diagram output.") from exc

    def tag(name):
        if name.startswith("{" + SVG + "}"):
            return name.split("}", 1)[1]
        return name if "}" not in name else ""

    if tag(root.tag) != "svg" or len(list(root.iter())) > 10000:
        raise ValueError("Unsupported diagram output.")
    allowed = set(
        "g path text tspan defs clipPath use rect circle ellipse line polyline polygon linearGradient radialGradient stop".split()
    )
    attributes = set(
        "id d points transform x y x1 y1 x2 y2 cx cy r rx ry width height viewBox fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity font-family font-size font-style font-weight text-anchor dominant-baseline clip-path clip-rule offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod".split()
    )
    fonts = set()

    def clean(node):
        for child in list(node):
            if tag(child.tag) not in allowed:
                node.remove(child)
            else:
                clean(child)
        node.tag = "{" + SVG + "}" + tag(node.tag)
        for name, value in list(node.attrib.items()):
            del node.attrib[name]
            if name == "style":
                font = re.fullmatch(r"font-family:\s*([a-z][a-z0-9]{1,30});?\s*", value, re.I)
                if font:
                    node.set("font-family", font[1])
                continue
            if name in {"href", "{http://www.w3.org/1999/xlink}href"}:
                if re.fullmatch(r"#[\w:-]+", value):
                    node.set("href", value)
                continue
            if name not in attributes or re.search(r"[\\\x00-\x1f\x7f]", value):
                continue
            if re.search(r"url\s*\(", value, re.I) and not re.fullmatch(r"url\(#[\w:-]+\)", value):
                continue
            node.set(name, value)
        font = node.get("font-family")
        if font:
            if not re.fullmatch(r"[a-z][a-z0-9]{1,30}", font, re.I):
                del node.attrib["font-family"]
            else:
                fonts.add(font)

    clean(root)
    root.set("viewBox", f"-72 -72 {width} {height}")
    root.set("width", str(round(width * 1.9, 3)))
    root.set("height", str(round(height * 1.9, 3)))
    if len(fonts) > 32:
        raise ValueError("Too many diagram fonts.")
    font_css = []
    for font in sorted(fonts):
        path = Path(settings.BASE_DIR) / "static/vendor/tikzjax/bakoma/ttf" / (font + ".ttf")
        if not path.is_file():
            raise ValueError("Unsupported diagram font.")
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        font_css.append(f"@font-face{{font-family:{font};src:url(data:font/ttf;base64,{data})}}")
    if font_css:
        style = ET.Element("{" + SVG + "}style")
        style.text = "".join(font_css)
        root.insert(0, style)
    rendered = ET.tostring(root, encoding="unicode")
    if len(rendered.encode()) > 4000000:
        raise ValueError("Diagram output is too large.")
    return rendered
