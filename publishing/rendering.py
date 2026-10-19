from html import escape
from django.utils.text import slugify
from markdown_it import MarkdownIt
from mdit_py_plugins.dollarmath import dollarmath_plugin
from mdit_py_plugins.texmath import texmath_plugin


def parser():
    md = MarkdownIt("commonmark", {"html": False, "breaks": False}).enable("table").enable("strikethrough")
    md.use(dollarmath_plugin)
    md.use(texmath_plugin, delimiters="brackets")
    # texmath's default renderer returns raw TeX; escape it before inserting into HTML.
    def inline_math(self, tokens, idx, options, env):
        return '<span class="math inline">' + escape(tokens[idx].content) + '</span>'

    def block_math(self, tokens, idx, options, env):
        return '<div class="math block">' + escape(tokens[idx].content) + '</div>\n'

    md.add_render_rule("math_inline", inline_math)
    md.add_render_rule("math_block", block_math)
    md.add_render_rule("math_block_eqno", block_math)
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
        stem = "section-" + (slugify(label, allow_unicode=True)[:80] or "heading")
        anchor, suffix = stem, 2
        while anchor in used_ids:
            anchor = f"{stem}-{suffix}"
            suffix += 1
        used_ids.add(anchor)
        token.attrSet("id", anchor)
        level = int(token.tag[1])
        headings.append({'id': anchor, 'label': label, 'level': level,
                         'line': token.map[0] + 1, 'token': token, 'index': index,
                         'title': first_heading and level == 1})
        first_heading = False
    return headings


def render_reader(source, source_lines=False, edit_url=None, passage_annotations=False):
    """Render safe Markdown with the same section boundaries used by the editor."""
    md = parser()
    tokens = md.parse(source)
    if passage_annotations:
        from .passages import annotate
        annotate(md, tokens, decorate=True)
    headings = heading_tokens(tokens)
    contents = []
    for item in headings:
        if source_lines:
            item['token'].attrSet('data-source-line', str(item['line']))
        if item['label'] and not item['title']:
            contents.append({k: item[k] for k in ('id', 'label', 'level', 'line')})
        if edit_url and not item['title'] and item['token'].level == 0:
            from urllib.parse import urlencode
            from markdown_it.token import Token
            link = Token('html_inline', '', 0)
            link.content = '<a class="section-edit" aria-label="Edit section ' + escape(item['label'], quote=True) + '" href="' + escape(edit_url + '&' + urlencode({'scope': item['id']}), quote=True) + '">Edit</a>'
            tokens[item['index'] + 1].children.append(link)
    if contents:
        base_level = min(item["level"] for item in contents)
        for item in contents:
            item["depth"] = min(item["level"] - base_level, 3)
    return md.renderer.render(tokens, md.options, {}), contents


def has_images(source):
    def walk(tokens):
        return any(token.type == "image" or (token.children and walk(token.children)) for token in tokens)
    return walk(parser().parse(source))
