"""Render checked-in teaching examples through the ordinary paper renderer."""

from functools import lru_cache
from pathlib import Path
from urllib.parse import quote

from django import template
from django.urls import reverse

from publishing.references import ReferenceDocument

register = template.Library()
EXAMPLES = (
    "basics",
    "link",
    "code",
    "math",
    "unnumbered",
    "references",
    "theorem",
    "citation",
    "citation_details",
    "table",
    "cd",
    "tikzcd",
    "tikzpicture",
)
DIRECTORY = Path(__file__).resolve().parents[1] / "data" / "help_examples"


@lru_cache(maxsize=len(EXAMPLES))
def example_data(name):
    if name not in EXAMPLES:
        raise template.TemplateSyntaxError(f"Unknown help example {name!r}")
    source = (DIRECTORY / f"{name}.md").read_text(encoding="utf-8")
    bibliography = ""
    if name in {"citation", "citation_details"}:
        bibliography = (DIRECTORY / "bibliography.bib").read_text(encoding="utf-8")
        if name == "citation":
            bibliography = bibliography.split("\n@book{hatcher2002", 1)[0].strip() + "\n"
    document = ReferenceDocument(
        [{"id": "example", "title": "Example", "markdown": source}],
        bibliography=bibliography,
        anchor_prefix=f"help-{name}-",
    )
    for target in document.targets:
        target["url"] = reverse("help_writing") + "#" + quote(target["id"])
    rendered, _ = document.render("example")
    if document.warnings:
        raise template.TemplateSyntaxError("Invalid help example: " + "; ".join(document.warnings))
    return {"name": name, "source": source, "bibliography": bibliography, "rendered": rendered}


@register.inclusion_tag("publishing/includes/help_example.html")
def help_example(name):
    return example_data(name)
