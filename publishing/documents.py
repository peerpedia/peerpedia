"""Canonical multi-page payloads. Legacy snapshots are never rewritten."""

import hashlib
import re
from django.conf import settings
from django.core.exceptions import ValidationError

ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
MAX_CHAPTERS = 64


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def pages(record):
    return record.chapters or [{"id": "main", "title": record.title, "markdown": record.markdown}]


def combined(chapters):
    return "\n\n".join(chapter["markdown"] for chapter in chapters)


def validate(chapters, bibliography="", *, allow_empty=False):
    from .rendering import has_images

    if not isinstance(chapters, list) or len(chapters) > MAX_CHAPTERS:
        raise ValidationError("Use up to 64 chapters.")
    if not isinstance(bibliography, str):
        raise ValidationError("references.bib must be UTF-8 text.")
    seen = set()
    for chapter in chapters:
        if not isinstance(chapter, dict) or set(chapter) != {"id", "title", "markdown"}:
            raise ValidationError("Each chapter needs an id, title, and markdown.")
        if not all(isinstance(value, str) for value in chapter.values()):
            raise ValidationError("Chapter fields must be text.")
        if not ID.fullmatch(chapter["id"]) or chapter["id"].casefold() in seen:
            raise ValidationError(
                "Chapter IDs must be unique letters, numbers, hyphens or underscores."
            )
        seen.add(chapter["id"].casefold())
        if not chapter["title"].strip() or len(chapter["title"]) > 250:
            raise ValidationError("Give each chapter a title of up to 250 characters.")
        if not allow_empty and not chapter["markdown"].strip():
            raise ValidationError(f"Write some text in {chapter['title']} before submitting.")
        if has_images(chapter["markdown"]):
            raise ValidationError("Images are not supported. Use a diagram block instead.")
    text = combined(chapters) + bibliography
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        raise ValidationError("Use valid UTF-8 text.")
    if "\x00" in text or size > settings.MAX_MARKDOWN_BYTES:
        raise ValidationError(
            "The complete paper and bibliography must be at most 1 MB, without NUL characters."
        )
    return chapters


def prepare(data, base=None):
    """Reject old-client replacement of a multi-page document instead of losing pages."""
    data = dict(data)
    if base and (base.chapters or base.bibliography) and "chapters" not in data:
        raise ValidationError(
            "This paper has chapters or a bibliography. Use the online editor or update the CLI before revising it."
        )
    chapters, bib = data.get("chapters", []), data.get("bibliography", "")
    validate(chapters, bib)
    if chapters:
        if data.get("markdown") != combined(chapters):
            raise ValidationError("Combined Markdown must exactly match the chapter files.")
    return data


def chapter_diff(before, after):
    from .comparisons import diff_lines

    old = {p["id"]: p for p in pages(before)} if before else {}
    new = {p["id"]: p for p in pages(after)}
    old_order = list(old)
    result = []
    for index, (key, page) in enumerate(new.items()):
        previous = old.get(key)
        moved = previous is not None and old_order.index(key) != index
        if previous != page or moved:
            result.append(
                {
                    "id": key,
                    "title": page["title"],
                    "kind": "Added" if not previous else "Changed",
                    "moved": moved,
                    "diff": diff_lines(previous["markdown"] if previous else "", page["markdown"]),
                }
            )
    for key, page in old.items():
        if key not in new:
            result.append(
                {
                    "id": key,
                    "title": page["title"],
                    "kind": "Deleted",
                    "diff": diff_lines(page["markdown"], ""),
                }
            )
    if (before.bibliography if before else "") != after.bibliography:
        result.append(
            {
                "id": "bibliography",
                "title": "references.bib",
                "kind": "Changed",
                "diff": diff_lines(before.bibliography if before else "", after.bibliography),
            }
        )
    return result


def archive(chapters, bibliography, markdown, info, manifest=None):
    import io
    import json
    import zipfile

    output = io.BytesIO()
    info = dict(info)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as z:
        info.update(
            chapters=[
                {"id": p["id"], "title": p["title"], "file": f"chapters/{p['id']}.md"}
                for p in chapters
            ],
            bibliography="references.bib",
        )
        z.writestr("paper.json", json.dumps(info, ensure_ascii=False, indent=2))
        if chapters:
            for page in chapters:
                z.writestr(f"chapters/{page['id']}.md", page["markdown"])
        else:
            z.writestr("paper.md", markdown)
        z.writestr("references.bib", bibliography)
        if manifest:
            z.writestr("submission.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return output.getvalue()
