"""Book context and reader controls around one BananaMark render result."""

from typing import Any
from .bananamark import request
from .rendering import decorate


class ReferenceDocument:
    def __init__(
        self: "ReferenceDocument",
        chapters: list[dict[str, str]],
        bibliography: str = "",
        reader_url: str = "",
        number_sections: bool = True,
        anchor_prefix: str = "",
        *,
        result: dict[str, Any] | None = None,
    ) -> None:
        self.options = dict(
            pages=chapters,
            bibliography=bibliography,
            reader=reader_url,
            numberSections=number_sections,
            prefix=anchor_prefix,
            diagrams=True,
        )
        self._result = result

    @property
    def result(self: "ReferenceDocument") -> dict[str, Any]:
        if self._result is None:
            self._result = request(**self.options)
        return self._result

    @property
    def targets(self: "ReferenceDocument") -> list[dict[str, Any]]:
        return self.result["targets"]

    @property
    def warnings(self: "ReferenceDocument") -> list[str]:
        return self.result["warnings"]

    def render(self: "ReferenceDocument", chapter: str) -> tuple[str, list[dict[str, Any]]]:
        page = next(p for p in self.result["pages"] if p["id"] == chapter)
        return decorate(
            page, reader_url=self.options["reader"], chapter=chapter, targets=self.targets
        )
