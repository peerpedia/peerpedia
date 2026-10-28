"""Book context and reader controls around one BananaMark render result."""

from .bananamark import request


class ReferenceDocument:
    def __init__(
        self,
        chapters,
        bibliography="",
        reader_url="",
        number_sections=True,
        anchor_prefix="",
        *,
        result=None,
        render_chapter=None,
    ):
        self.sources = {p["id"]: p["markdown"] for p in chapters}
        self.pages = chapters
        self.options = dict(
            pages=chapters,
            bibliography=bibliography,
            reader=reader_url,
            numberSections=number_sections,
            prefix=anchor_prefix,
            diagrams=True,
        )
        if render_chapter is not None:
            self.options["renderChapter"] = render_chapter
        self._result = result

    @property
    def result(self):
        if self._result is None:
            self._result = request(**self.options)
        return self._result

    @property
    def targets(self):
        return self.result["targets"]

    @property
    def entries(self):
        return self.result["entries"]

    @property
    def warnings(self):
        return self.result["warnings"]

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

        if source is not None and source != self.sources[chapter]:
            section = dict(
                chapter=chapter,
                line=reference_line_offset + 1,
                end=reference_line_offset + len(source.splitlines()) + 1,
            )
            if self._result is not None and self.options.get("section") != section:
                raise ValueError("Select the section before rendering the document.")
            self.options["section"] = section
        page = next(p for p in self.result["pages"] if p["id"] == chapter)
        return decorate(
            page, edit_url=edit_url, source_lines=source_lines, line_offset=reference_line_offset
        )
