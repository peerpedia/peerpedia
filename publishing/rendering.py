from html import escape
from django.utils.text import slugify
from markdown_it import MarkdownIt
from mdit_py_plugins.dollarmath import dollarmath_plugin
from mdit_py_plugins.texmath import texmath_plugin


def parser(saved_diagrams=None):
    md = (
        MarkdownIt("commonmark", {"html": False, "breaks": False})
        .enable("table")
        .enable("strikethrough")
    )
    from .references import install

    install(md)
    md.use(dollarmath_plugin)
    md.use(texmath_plugin, delimiters="brackets")

    # texmath's default renderer returns raw TeX; escape it before inserting into HTML.
    def inline_math(self, tokens, idx, options, env):
        return '<span class="math inline">' + escape(tokens[idx].content) + "</span>"

    def block_math(self, tokens, idx, options, env):
        return '<div class="math block">' + escape(tokens[idx].content) + "</div>\n"

    original_fence = md.renderer.rules["fence"]
    diagram_keys = set()

    def diagram_fence(tokens, idx, options, env):
        token = tokens[idx]
        if token.info.strip() not in {"tikzcd", "tikzpicture", "tikz"}:
            return original_fence(tokens, idx, options, env)
        attrs, output, message = "", "", "Diagram waiting to compile."
        if saved_diagrams is not None:
            from django.urls import reverse
            from .diagram_cache import key_for, MAX_DIAGRAMS

            key = key_for(token.content)
            diagram_keys.add(key)
            item = saved_diagrams.get(key)
            url = reverse("diagram_status", args=[key])
            attrs = f' data-saved-url="{url}"'
            message = "Preparing diagram…"
            if item and item.status == "ready":
                attrs += ' data-diagram-state="ready"'
                output = (
                    '<img loading="lazy" alt="TeX diagram" src="'
                    + reverse("diagram_svg", args=[key])
                    + '">'
                )
            elif len(diagram_keys) > MAX_DIAGRAMS:
                attrs += ' data-diagram-state="error"'
                message = "Keep each paper below 32 distinct diagrams."
            elif item and item.status == "error":
                attrs += ' data-diagram-state="error"'
                message = item.error
        hidden = " hidden" if output else ""
        source_details = (
            '<details class="diagram-source"><summary>Diagram source</summary><pre><code>'
            + escape(token.content)
            + "</code></pre></details>"
            if saved_diagrams is None
            else ""
        )
        return (
            '<figure class="tex-diagram" data-diagram' + attrs + ">"
            '<div class="diagram-output" role="img" aria-label="TeX diagram">' + output + "</div>"
            '<p class="diagram-status" role="status"'
            + hidden
            + ">"
            + escape(message)
            + "</p>"
            + source_details
            + "</figure>\n"
        )

    md.renderer.rules["fence"] = diagram_fence
    md.add_render_rule("math_inline", inline_math)
    md.add_render_rule("math_block", block_math)
    md.add_render_rule("math_block_eqno", block_math)
    md.add_render_rule("math_block_label", block_math)
    # Images are excluded even when an old/imported document contains one.
    md.renderer.rules["image"] = lambda *args: ""
    return md


def render_markdown(source):
    return parser().render(source)


def heading_tokens(tokens):
    """Assign shared reader/editor anchors, including duplicate heading suffixes."""
    headings = []
    used_ids = set()
    first_heading = True
    for index, token in enumerate(tokens):
        if token.type != "heading_open":
            continue
        inline = tokens[index + 1]
        label = "".join(
            " " if child.type in {"softbreak", "hardbreak"} else child.content
            for child in inline.children or []
            if child.type not in {"image", "html_inline"}
        ).strip()
        from .references import label_text

        label, explicit = label_text(label)
        if explicit and inline.children and inline.children[-1].type == "text":
            inline.children[-1].content = label_text(inline.children[-1].content)[0]
            token.meta["explicit_label"] = explicit
        explicit = explicit or token.meta.get("explicit_label", "")
        stem = "section-" + (slugify(label, allow_unicode=True)[:80] or "heading")
        stem = explicit or stem
        anchor, suffix = stem, 2
        while anchor in used_ids:
            anchor = f"{stem}-{suffix}"
            suffix += 1
        used_ids.add(anchor)
        token.attrSet("id", anchor)
        level = int(token.tag[1])
        headings.append(
            {
                "id": anchor,
                "label": label,
                "level": level,
                "line": token.map[0] + 1,
                "token": token,
                "index": index,
                "title": first_heading and level == 1,
            }
        )
        first_heading = False
    return headings


def render_reader(
    source,
    source_lines=False,
    edit_url=None,
    passage_annotations=False,
    saved_diagrams=None,
    references=None,
    chapter="main",
    passage_offset=0,
    reference_line_offset=0,
):
    """Render safe Markdown with the same section boundaries used by the editor."""
    md = parser(saved_diagrams)
    tokens = md.parse(source)
    if passage_annotations:
        from .passages import annotate

        annotate(md, tokens, decorate=True, offset=passage_offset)
    headings = heading_tokens(tokens)
    used = references.decorate(md, tokens, chapter, reference_line_offset) if references else {}
    contents = []
    for item in headings:
        target = item["token"].meta.get("reference_target")
        scope = item["id"]
        if target:
            item["id"] = target["id"]
            if not item["title"] and references.number_sections:
                item["label"] = target["number"] + " " + item["label"]
                from markdown_it.token import Token

                text = Token("html_inline", "", 0)
                text.content = (
                    '<span class="section-number">' + escape(target["number"]) + " </span>"
                )
                tokens[item["index"] + 1].children.insert(0, text)
        if target and not item["title"]:
            from .references import copy_button
            from markdown_it.token import Token

            button = Token("html_inline", "", 0)
            button.content = copy_button(target)
            tokens[item["index"] + 1].children.append(button)
        if source_lines:
            item["token"].attrSet("data-source-line", str(item["line"]))
        if item["label"] and not item["title"]:
            contents.append({k: item[k] for k in ("id", "label", "level", "line")})
        if edit_url and not item["title"] and item["token"].level == 0:
            from urllib.parse import urlencode
            from .ui import icon
            from markdown_it.token import Token

            link = Token("html_inline", "", 0)
            link.content = (
                '<a class="section-edit ui-icon-button" aria-label="Edit section '
                + escape(item["label"], quote=True)
                + '" href="'
                + escape(edit_url + "&" + urlencode({"scope": scope}), quote=True)
                + '" title="Edit section">'
                + icon("edit")
                + "</a>"
            )
            tokens[item["index"] + 1].children.append(link)
    if contents:
        base_level = min(item["level"] for item in contents)
        for item in contents:
            item["depth"] = min(item["level"] - base_level, 3)
    body = md.renderer.render(tokens, md.options, {})
    if references:
        body += references.reference_list(used)
    return body, contents


def has_images(source):
    def walk(tokens):
        return any(
            token.type == "image" or (token.children and walk(token.children)) for token in tokens
        )

    return walk(parser().parse(source))
