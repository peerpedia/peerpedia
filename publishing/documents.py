"""Canonical multi-page payloads. Legacy snapshots are never rewritten."""

import hashlib
from copy import deepcopy
from dataclasses import dataclass
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
    if not isinstance(chapters, list) or len(chapters) > MAX_CHAPTERS:
        raise ValidationError("Use up to 64 chapters.")
    if not isinstance(bibliography, str):
        raise ValidationError("The BananaMark bibliography must be UTF-8 YAML text.")
    seen = set()
    for chapter in chapters:
        if not isinstance(chapter, dict) or set(chapter) not in (
            {"id", "markdown"},
            {"id", "title", "markdown"},
        ):
            raise ValidationError(
                "Each chapter needs an id and markdown. Its title comes from its heading."
            )
        if not all(isinstance(value, str) for value in chapter.values()):
            raise ValidationError("Chapter fields must be text.")
        if not ID.fullmatch(chapter["id"]) or chapter["id"].casefold() in seen:
            raise ValidationError(
                "Chapter IDs must be unique letters, numbers, hyphens or underscores."
            )
        seen.add(chapter["id"].casefold())
        if not allow_empty and not chapter["markdown"].strip():
            raise ValidationError(f"Write some text in chapter {chapter['id']} before submitting.")
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


@dataclass(frozen=True)
class PreparedDocument:
    data: dict
    result: dict
    renderer_version: str
    base_id: object = None
    section: object = None


def prepare(data, base=None, section=None):
    """Reject old-client replacement of a multi-page document instead of losing pages."""
    data = deepcopy(data)
    if base and (base.chapters or base.bibliography) and "chapters" not in data:
        raise ValidationError(
            "This paper has chapters or a bibliography. Use the online editor or update the CLI before revising it."
        )
    chapters, bib = data.get("chapters", []), data.get("bibliography", "")
    validate(chapters, bib)
    if chapters:
        if data.get("markdown") != combined(chapters):
            raise ValidationError("Combined Markdown must exactly match the chapter files.")
    # Saved drafts may be incomplete; every publication path validates the whole
    # book and compiles its diagrams before any snapshot is written.
    from .bananamark import request

    result = request(
        pages=chapters
        or [{"id": "main", "title": data.get("title", ""), "markdown": data.get("markdown", "")}],
        bibliography=bib,
        numberSections=bool(chapters),
        diagrams=True,
    )
    titles = {page["id"]: page["title"] for page in result["pages"]}
    data["chapters"] = [
        {**page, "title": titles[page["id"]]}
        if not section or page["id"] == section.get("chapter")
        else page
        for page in chapters
    ]
    from .artifacts import renderer_version

    return PreparedDocument(
        data, result, renderer_version(), base.pk if base else None, deepcopy(section)
    )


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
                "title": "references.yaml",
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
            bibliography="references.yaml",
        )
        z.writestr("paper.json", json.dumps(info, ensure_ascii=False, indent=2))
        if chapters:
            for page in chapters:
                z.writestr(f"chapters/{page['id']}.md", page["markdown"])
        else:
            z.writestr("paper.md", markdown)
        z.writestr("references.yaml", bibliography)
        if manifest:
            z.writestr("submission.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return output.getvalue()
