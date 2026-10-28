"""Reader controls around BananaMark HTML; syntax and numbering belong upstream."""

from html import escape
from urllib.parse import urlencode
from .bananamark import request, structure


def has_images(source):
    return request(action="scan", source=source)["images"]


def headings(source):
    return structure(source)["headings"]


def decorate(page, *, edit_url=None, source_lines=False, line_offset=0):
    body, contents = page["html"], []
    for heading in page["headings"]:
        if heading.get("title"):
            continue
        line = heading.get("line")
        item = {k: heading[k] for k in ("id", "label", "level")}
        item["line"] = line - line_offset if line else None
        if heading["number"]:
            item["label"] = heading["number"] + " " + item["label"]
        contents.append(item)
        if line and line_offset:
            body = body.replace(
                f'data-source-line="{line}"', f'data-source-line="{line - line_offset}"'
            )
        if edit_url and heading.get("root"):
            from .ui import icon

            link = (
                '<a class="section-edit ui-icon-button" data-passage-ignore aria-label="Edit section '
                + escape(heading["label"], quote=True)
                + '" href="'
                + escape(edit_url + "&" + urlencode({"scope": heading["id"]}), quote=True)
                + '" title="Edit section">'
                + icon("edit")
                + "</a>"
            )
            start = body.find('id="' + escape(heading["id"], quote=True) + '"')
            end = body.find(f"</h{heading['level']}>", start)
            if start >= 0 and end >= 0:
                body = body[:end] + link + body[end:]
    if contents:
        base = min(h["level"] for h in contents)
        for item in contents:
            item["depth"] = min(item["level"] - base, 3)
    return body, contents


def render_reader(source, *, references=None, chapter="main", **kwargs):
    from .references import ReferenceDocument

    refs = references or ReferenceDocument(
        [{"id": chapter, "title": "", "markdown": source}], number_sections=False
    )
    return refs.render(chapter, source=source, **kwargs)


def render_markdown(source):
    return render_reader(source)[0]
