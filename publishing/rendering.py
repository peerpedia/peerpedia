"""Reader controls around BananaMark HTML; syntax and numbering belong upstream."""

from html import escape
from urllib.parse import urlencode
from .bananamark import request, structure


def has_images(source):
    return request(action="scan", source=source)["images"]


def headings(source):
    return structure(source)["headings"]


def decorate(
    page,
    *,
    edit_url=None,
    source_lines=False,
    line_offset=0,
    reader_url="",
    chapter="main",
    targets=(),
):
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
        from .ui import icon

        controls = ""
        if reader_url:
            from urllib.parse import quote

            target = next(
                (t for t in targets if t["id"] == heading["id"] and t["chapter"] == chapter), None
            )
            location = "?" + urlencode({"chapter": chapter}) + "#" + quote(heading["id"])
            reference = (
                "@" + target["label"]
                if target and target.get("explicit")
                else f"[{heading['label']}]({location})"
            )
            controls += (
                '<button type="button" class="copy-reference ui-icon-button" data-passage-ignore '
                f'data-reference-url="{escape(reader_url + location, quote=True)}" '
                f'data-reference="{escape(reference, quote=True)}" '
                f'aria-label="Copy reference to {escape(heading["label"], quote=True)}" title="Copy citation or link">'
                + str(icon("link"))
                + "</button>"
            )
        if edit_url and heading.get("root"):
            link = (
                '<a class="section-edit ui-icon-button" data-passage-ignore aria-label="Edit section '
                + escape(heading["label"], quote=True)
                + '" href="'
                + escape(edit_url + "&" + urlencode({"scope": heading["id"]}), quote=True)
                + '" title="Edit section">'
                + icon("edit")
                + "</a>"
            )
            controls += link
        if controls:
            start = body.find('id="' + escape(heading["id"], quote=True) + '"')
            end = body.find(f"</h{heading['level']}>", start)
            if start >= 0 and end >= 0:
                body = body[:end] + controls + body[end:]
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
