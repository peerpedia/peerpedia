"""Source and metadata comparisons, independent of HTTP handlers."""

import difflib
from .subjects import METADATA_FIELDS, label


def diff_lines(base, proposed):
    # Context diff avoids rendering megabytes of unchanged source. Escaped by templates.
    lines = []
    for line in difflib.unified_diff(
        base.splitlines(keepends=True),
        proposed.splitlines(keepends=True),
        fromfile="Base version",
        tofile="Proposed version",
        n=3,
    ):
        lines.append(line.removesuffix("\n").replace("\r", " ␍"))
        if not line.endswith("\n"):
            lines.append("\\ No newline at end of file")
    return lines


def metadata_diff(base, data):
    if not base:
        return []

    def display(key, value):
        if key == "primary_category":
            return label(value)
        if key == "secondary_categories":
            return "; ".join(label(code) for code in value) or "None"
        return value

    return [
        {
            "label": {
                "primary_category": "Primary subject",
                "secondary_categories": "Cross-list subjects",
            }.get(key, key.title()),
            "before": display(key, getattr(base, key)),
            "after": display(key, data[key]),
        }
        for key in METADATA_FIELDS
        if getattr(base, key) != data[key]
    ]
