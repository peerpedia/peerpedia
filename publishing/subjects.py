"""Pinned arXiv category identifiers; publishing never depends on a live arXiv request."""
import json
from pathlib import Path

TAXONOMY = json.loads((Path(__file__).parent / "data/arxiv_categories.json").read_text())
CATEGORIES = {row["code"]: row for row in TAXONOMY["categories"]}
ALIASES = {"cs.NA": "math.NA", "cs.SY": "eess.SY", "math.IT": "cs.IT", "math.MP": "math-ph", "stat.TH": "math.ST", "q-fin.EC": "econ.GN"}
METADATA_FIELDS = ("title", "authors", "abstract", "primary_category", "secondary_categories")


def label(code):
    row = CATEGORIES.get(code)
    return f'{code} — {row["name"]}' if row else "Unclassified"


def choices():
    groups = {}
    for code, row in CATEGORIES.items():
        group = row["group"]
        if row["archive"] and row["archive"] != row["group"]:
            group += " / " + row["archive"]
        groups.setdefault(group, []).append((code, label(code)))
    return list(groups.items())


def equivalent_codes(codes):
    canonical = {ALIASES.get(code, code) for code in codes}
    return [code for code in CATEGORIES if ALIASES.get(code, code) in canonical]


def filter_choices():
    broad = [("group:" + group, group + " — all subjects") for group in dict.fromkeys(row["group"] for row in CATEGORIES.values())]
    archives = [("archive:" + archive, "Physics / " + archive + " — all subjects") for archive in dict.fromkeys(row["archive"] for row in CATEGORIES.values()) if archive and sum(row["archive"] == archive for row in CATEGORIES.values()) > 1]
    return [("", "All subjects"), ("unclassified", "Unclassified"), ("Broad subjects", broad + archives), *choices()]


def filter_codes(value):
    if value in CATEGORIES:
        return equivalent_codes([value])
    kind, _, name = value.partition(":")
    if kind in {"group", "archive"}:
        codes = [code for code, row in CATEGORIES.items() if row[kind] == name]
        if codes:
            return equivalent_codes(codes)
    return None


def subject_links(primary, secondary):
    return [{"code": code, "label": label(code), "primary": index == 0} for index, code in enumerate(([primary] if primary else []) + secondary)]


def validate_subjects(primary, secondary):
    from django.core.exceptions import ValidationError
    if not isinstance(primary, str) or primary not in CATEGORIES:
        raise ValidationError("Choose a primary subject from the arXiv taxonomy.")
    if not isinstance(secondary, list) or any(not isinstance(code, str) or code not in CATEGORIES for code in secondary):
        raise ValidationError("Cross-list subjects must be a list of arXiv category codes.")
    canonical = [ALIASES.get(code, code) for code in [primary, *secondary]]
    if len(canonical) != len(set(canonical)):
        raise ValidationError("Subjects must be distinct, including aliases of the primary subject.")
