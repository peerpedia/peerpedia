"""Reader controls around BananaMark HTML; syntax and numbering belong upstream."""

from collections.abc import Iterable
from typing import Any
from urllib.parse import quote, urlencode
from .bananamark import request, structure


def has_images(source):
    return request(action="scan", source=source)["images"]


def headings(source):
    return structure(source)["headings"]


def decorate(
    page: dict[str, Any],
    *,
    edit_url: str | None = None,
    source_lines: bool = False,
    line_offset: int = 0,
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
        if heading.get("title") and not source_lines:
            continue
        anchor, label = heading["id"], heading["label"]
        line = heading.get("line")
        item = {
            "id": anchor,
            "label": (heading["number"] + " " if heading["number"] else "") + label,
            "level": heading["level"],
            "line": line - line_offset if line else None,
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
        if edit_url and heading.get("root"):
            item["edit_url"] = edit_url + "&" + urlencode({"scope": anchor})
        contents.append(item)
    if contents:
        base = min(h["level"] for h in contents)
        for item in contents:
            item["depth"] = min(item["level"] - base, 3)
    return page["html"], contents


def render_reader(source, *, references=None, chapter="main", **kwargs):
    from .references import ReferenceDocument

    refs = references or ReferenceDocument(
        [{"id": chapter, "title": "", "markdown": source}], number_sections=False
    )
    return refs.render(chapter, source=source, **kwargs)


def render_markdown(source):
    return render_reader(source)[0]
