"""Scholarly Markdown: parsed blocks, safe references, and a shared BibTeX library."""

import re
from collections import Counter
from html import escape
from urllib.parse import urlencode, urlsplit, quote
from mdit_py_plugins.container import container_plugin
from .documents import digest

LABEL = r"[A-Za-z][A-Za-z0-9_:.-]{0,119}"
LABEL_END = re.compile(r"\s*\{#(" + LABEL + r")\}\s*$")
KINDS = (
    "theorem",
    "lemma",
    "proposition",
    "corollary",
    "definition",
    "example",
    "remark",
    "proof",
    "figure",
    "table",
    "equation",
    "unnumbered",
)


def label_text(value):
    match = LABEL_END.search(value)
    return (value[: match.start()].strip(), match[1]) if match else (value.strip(), "")


def install(md):
    for kind in KINDS:
        md.use(container_plugin, kind)

    def reference(state, silent):
        start = state.pos
        match = re.match(r"\[@([^\]\n]{1,1000})\]", state.src[start:])
        if match:
            if not silent:
                token = state.push("citation", "", 0)
                token.content = match[1]
            state.pos += len(match[0])
            return True
        if start and (state.src[start - 1].isalnum() or state.src[start - 1] in "_\\"):
            return False
        match = re.match(r"@(" + LABEL + r")", state.src[start:])
        if not match:
            return False
        key = match[1].rstrip(".")
        if not silent:
            token = state.push("cross_reference", "", 0)
            token.content = key
        state.pos += len(key) + 1
        return True

    md.inline.ruler.before("link", "scholarly_reference", reference)
    md.renderer.rules["citation"] = lambda tokens, idx, options, env: escape(
        "[@" + tokens[idx].content + "]"
    )
    md.renderer.rules["cross_reference"] = lambda tokens, idx, options, env: escape(
        "@" + tokens[idx].content
    )


def safe_url(value):
    try:
        parsed = urlsplit(value)
        return (
            value
            if parsed.scheme in {"http", "https"}
            and parsed.netloc
            and not any(ord(c) < 32 for c in value)
            else ""
        )
    except ValueError:
        return ""


def bibliography_entries(source):
    import bibtexparser
    from bibtexparser.bparser import BibTexParser

    warnings, entries = [], {}
    if not source.strip():
        return entries, warnings
    try:
        database = bibtexparser.loads(source, parser=BibTexParser(ignore_nonstandard_types=False))
        for item in database.entries:
            key = item["ID"]
            if key in entries:
                warnings.append(f"Duplicate bibliography key: {key}.")
                continue
            entries[key] = item
            if not item.get("title"):
                warnings.append(f"Bibliography entry {key} has no title.")
        if not entries:
            warnings.append(
                "No bibliography entries could be read. Your original .bib text is preserved."
            )
    except Exception:
        # BibTeX is data, never executed. Invalid source stays available to its author.
        warnings.append(
            "Could not read references.bib. Check its braces and string definitions; the original text is preserved."
        )
    return entries, warnings


def plain(value):
    # Common grouping braces are layout hints; arbitrary TeX commands stay literal.
    return str(value).replace("{", "").replace("}", "").strip()


class ReferenceDocument:
    def __init__(self, chapters, bibliography="", reader_url="", number_sections=True):
        from .rendering import parser, heading_tokens

        self.sources = {p["id"]: p["markdown"] for p in chapters}
        self.pages = chapters
        self.reader_url = reader_url
        self.number_sections = number_sections
        self.entries, self.warnings = bibliography_entries(bibliography)
        self.targets, self.by_label, self.tokens = [], {}, {}
        for chapter_number, chapter in enumerate(chapters, 1):
            tokens = parser().parse(chapter["markdown"])
            self.tokens[chapter["id"]] = tokens
            counts, used = Counter(), Counter()
            heading_map = {h["index"]: h for h in heading_tokens(tokens)}
            levels = [0] * 7
            stack = []
            for i, token in enumerate(tokens):
                kind, label, title = "", "", ""
                if token.type.startswith("container_"):
                    kind_name = (
                        token.type.removeprefix("container_")
                        .removesuffix("_open")
                        .removesuffix("_close")
                    )
                    if token.nesting == 1:
                        stack.append((kind_name, token))
                        if kind_name not in {"equation", "unnumbered", "proof"}:
                            kind = kind_name
                            title, label = label_text(token.info.strip()[len(kind) :])
                    elif stack:
                        stack.pop()
                if i in heading_map:
                    h = heading_map[i]
                    kind, title = "section", h["label"]
                    label = token.meta.get("explicit_label", "")
                    level = h["level"]
                    levels[level] += 1
                    levels[level + 1 :] = [0] * (6 - level)
                    number = (
                        ".".join(str(n) for n in [chapter_number, *levels[2 : level + 1]])
                        if level > 1
                        else str(chapter_number)
                    )
                    token.meta["section_number"] = number
                    token.meta["old_anchor"] = h["id"]
                elif token.type.startswith("math_block"):
                    if any(k == "unnumbered" for k, _ in stack) or r"\notag" in token.content:
                        token.meta["unnumbered"] = True
                        continue
                    kind = "equation"
                    label = token.info.strip() if re.fullmatch(LABEL, token.info.strip()) else ""
                    enclosing = next((t for k, t in reversed(stack) if k == "equation"), None)
                    if enclosing:
                        _, label = label_text(enclosing.info[len("equation") :])
                if not kind:
                    continue
                counter = "statement" if kind in KINDS[:7] else kind
                counts[counter] += 1
                number = token.meta.get("section_number", f"{chapter_number}.{counts[counter]}")
                signature = (
                    kind
                    + "\0"
                    + (
                        token.content
                        or title
                        or "\n".join(t.content for t in tokens[i + 1 : i + 4])
                    )
                )
                stem = label or (
                    token.meta["old_anchor"]
                    if kind == "section"
                    else kind + "-" + digest(signature)[:16]
                )
                used[stem] += 1
                anchor = stem if used[stem] == 1 else f"{stem}-{used[stem]}"
                if label and (label in self.by_label or used[stem] > 1):
                    self.warnings.append(
                        f"Duplicate label {label}; give every target a unique label."
                    )
                text = f"Equation ({number})" if kind == "equation" else f"{kind.title()} {number}"
                target = {
                    "id": anchor,
                    "label": label or anchor,
                    "chapter": chapter["id"],
                    "kind": kind,
                    "number": number,
                    "text": text,
                    "title": title,
                    "line": token.map[0] + 1 if token.map else 1,
                    "end_line": token.map[1] if token.map else 1,
                    "explicit": bool(label),
                    "url": reader_url
                    + "?"
                    + urlencode({"chapter": chapter["id"]})
                    + "#"
                    + quote(anchor),
                }
                self.targets.append(target)
                key = label or anchor
                if key in self.by_label:
                    self.by_label[key] = None
                    self.warnings.append(
                        f"Ambiguous reference @{key}; add unique labels before citing it."
                    )
                else:
                    self.by_label[key] = target
                token.meta["reference_target"] = target
                token.attrSet("id", anchor)
        # Resolve every chapter, so review warnings include chapters not currently open.
        for tokens in self.tokens.values():
            for token in tokens:
                for child in token.children or []:
                    if child.type == "cross_reference" and child.content not in self.by_label:
                        self.warnings.append(f"Unresolved reference @{child.content}.")
                    elif child.type == "citation":
                        for key, _ in self.citation_parts(child.content):
                            if key not in self.entries:
                                self.warnings.append(f"Missing bibliography entry {key}.")
        self.warnings = list(dict.fromkeys(self.warnings))

    @staticmethod
    def citation_parts(content):
        result = []
        for part in content.split(";"):
            key, _, locator = part.strip().lstrip("@").partition(",")
            result.append((key.strip(), locator.strip()))
        return result

    def citation(self, content, used):
        result = []
        for key, locator in self.citation_parts(content):
            item = self.entries.get(key)
            if item is None:
                result.append(
                    '<span class="broken-reference">' + escape("[@" + key + "]") + "</span>"
                )
                continue
            used.setdefault(key, item)
            title = plain(item.get("shorttitle", item.get("title", key)))
            if len(title) > 65:
                title = title[:62].rsplit(" ", 1)[0] + "…"
            names = plain(item.get("author", "")).split(" and ")
            first = names[0].split(",")[0] if "," in names[0] else names[0].split(" ")[-1]
            author = first + (" et al." if len(names) > 1 else "")
            suffix = ", ".join(v for v in [author, plain(item.get("year", "")), locator] if v)
            details = " · ".join(
                plain(item.get(k, ""))
                for k in ("title", "author", "year", "journal", "booktitle")
                if item.get(k)
            )
            result.append(
                f'<a class="citation" href="#bib-{digest(key)[:16]}" title="{escape(details, quote=True)}">{escape(title)}'
                + (f" ({escape(suffix)})" if suffix else "")
                + "</a>"
            )
        return "; ".join(result)

    def reference_list(self, used):
        if not used:
            return ""
        result = ['<section class="reference-list" aria-label="References"><h2>References</h2><ul>']
        for key, item in used.items():
            title = plain(item.get("title", key))
            url = (
                safe_url(item.get("url", "")) or safe_url("https://doi.org/" + item["doi"])
                if item.get("doi")
                else safe_url(item.get("url", ""))
            )
            heading = (
                f'<a href="{escape(url, quote=True)}">{escape(title)}</a>' if url else escape(title)
            )
            details = ". ".join(
                plain(item[k])
                for k in (
                    "author",
                    "year",
                    "journal",
                    "booktitle",
                    "publisher",
                    "volume",
                    "number",
                    "pages",
                    "note",
                )
                if item.get(k)
            )
            result.append(
                f'<li id="bib-{digest(key)[:16]}">{heading}. {escape(details)}'
                + (f' <a href="{escape(url, quote=True)}">Open work ↗</a>' if url else "")
                + "</li>"
            )
        return "".join(result) + "</ul></section>"

    def render(self, chapter, **kwargs):
        from .rendering import render_reader

        return render_reader(self.sources[chapter], references=self, chapter=chapter, **kwargs)

    def decorate(self, md, tokens, chapter, line_offset=0):
        # Reparse creates fresh token objects so preview and reader annotations do not leak.
        catalog = {
            (t.type, t.map[0]): t.meta.get("reference_target")
            for t in self.tokens[chapter]
            if t.map and t.meta.get("reference_target")
        }
        for token in tokens:
            target = catalog.get((token.type, token.map[0] + line_offset)) if token.map else None
            if target:
                token.meta["reference_target"] = target
                token.attrSet("id", target["id"])
        used = {}

        def cross(tokens, idx, options, env):
            key = tokens[idx].content
            target = self.by_label.get(key)
            if not target:
                return '<span class="broken-reference">' + escape("@" + key) + "</span>"
            url = "#" + target["id"] if target["chapter"] == chapter else target["url"]
            return f'<a class="cross-reference" href="{escape(url, quote=True)}">{escape(target["text"])}</a>'

        md.renderer.rules["cross_reference"] = lambda ts, i, opts, env: (
            '<span data-passage-math="'
            + escape("@" + ts[i].content, quote=True)
            + '">'
            + cross(ts, i, opts, env)
            + "</span>"
        )
        md.renderer.rules["citation"] = lambda ts, i, opts, env: (
            '<span data-passage-math="'
            + escape("[@" + ts[i].content + "]", quote=True)
            + '">'
            + self.citation(ts[i].content, used)
            + "</span>"
        )
        for name in ("math_block", "math_block_eqno", "math_block_label"):
            original = md.renderer.rules[name]

            def equation(ts, i, opts, env, original=original):
                target = ts[i].meta.get("reference_target")
                html = original(ts, i, opts, env)
                if not target:
                    return html
                return f'<div class="numbered-equation" id="{escape(target["id"], quote=True)}">{html}<a class="equation-number" href="#{target["id"]}" aria-label="{target["text"]}">({target["number"]})</a>{copy_button(target)}</div>'

            md.renderer.rules[name] = equation
        for kind in KINDS:

            def container(ts, i, opts, env, kind=kind):
                token = ts[i]
                if token.nesting == -1:
                    return "</section>\n"
                target = token.meta.get("reference_target")
                if target:
                    heading = escape(target["text"]) + (
                        " — " + escape(target["title"]) if target["title"] else ""
                    )
                    return f'<section class="scholarly-block {kind}" id="{escape(target["id"], quote=True)}"><div class="block-caption">{heading}{copy_button(target)}</div>'
                return f'<section class="scholarly-block {kind}">' + (
                    "<strong>Proof.</strong>" if kind == "proof" else ""
                )

            md.add_render_rule(
                "container_" + kind + "_open",
                lambda self, ts, i, opts, env, fn=container: fn(ts, i, opts, env),
            )
            md.add_render_rule(
                "container_" + kind + "_close",
                lambda self, ts, i, opts, env, fn=container: fn(ts, i, opts, env),
            )
        return used


def copy_button(target):
    return (
        '<button type="button" class="copy-reference" data-reference="'
        + escape("@" + target["label"], quote=True)
        + '" data-reference-url="'
        + escape(target["url"], quote=True)
        + '" aria-label="Copy reference to '
        + escape(target["text"], quote=True)
        + '">Copy reference</button>'
    )
