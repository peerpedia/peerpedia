"""Book and URL context for BananaMark's native reference system."""

from .bananamark import request


class ReferenceDocument:
    def __init__(
        self, chapters, bibliography="", reader_url="", number_sections=True, anchor_prefix=""
    ):
        self.sources = {p["id"]: p["markdown"] for p in chapters}
        self.pages = chapters
        self.options = dict(
            pages=chapters,
            bibliography=bibliography,
            reader=reader_url,
            numberSections=number_sections,
            prefix=anchor_prefix,
        )
        self.result = request(**self.options)
        self.targets = self.result["targets"]
        self.entries = self.result["entries"]
        self.warnings = self.result["warnings"]

    def render(
        self,
        chapter,
        *,
        source_lines=False,
        edit_url=None,
        passage_annotations=False,
        passage_offset=0,
        reference_line_offset=0,
        source=None,
        **kwargs,
    ):
        from .rendering import decorate

        options = dict(self.options, diagrams=True, diagramChapter=chapter)
        if source is not None and source != self.sources[chapter]:
            options["section"] = dict(
                chapter=chapter,
                line=reference_line_offset + 1,
                end=reference_line_offset + len(source.splitlines()) + 1,
            )
        result = request(**options)
        page = next(p for p in result["pages"] if p["id"] == chapter)
        return decorate(
            page, edit_url=edit_url, source_lines=source_lines, line_offset=reference_line_offset
        )
