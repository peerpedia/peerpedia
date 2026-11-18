"""Reader controls around BananaMark HTML; syntax and numbering belong upstream."""

from collections.abc import Iterable
from typing import Any
from urllib.parse import quote, urlencode
from .bananamark import request


def has_images(source):
    return request(action="scan", source=source)["images"]


def decorate(
    page: dict[str, Any],
    *,
    reader_url: str = "",
    chapter: str = "main",
    targets: Iterable[dict[str, Any]] = (),
) -> tuple[str, list[dict[str, Any]]]:
    explicit_labels = {
        target["id"]: target["label"]
        for target in targets
        if reader_url and target["chapter"] == chapter and target.get("explicit")
    }
    contents = []
    for heading in page["headings"]:
        if heading.get("title"):
            continue
        anchor, label = heading["id"], heading["label"]
        item = {
            "id": anchor,
            "label": (heading["number"] + " " if heading["number"] else "") + label,
            "level": heading["level"],
        }
        if reader_url:
            location = "?" + urlencode({"chapter": chapter}) + "#" + quote(anchor)
            item.update(
                heading_label=label,
                reference_url=reader_url + location,
                reference="@" + explicit_labels[anchor]
                if anchor in explicit_labels
                else f"[{label}]({location})",
            )
        contents.append(item)
    if contents:
        base = min(h["level"] for h in contents)
        for item in contents:
            item["depth"] = min(item["level"] - base, 3)
    return page["html"], contents


def render_reader(source: str) -> tuple[str, list[dict[str, Any]]]:
    from .references import ReferenceDocument

    refs = ReferenceDocument(
        [{"id": "main", "title": "", "markdown": source}], number_sections=False
    )
    return refs.render("main")


def render_markdown(source: str) -> str:
    return render_reader(source)[0]
