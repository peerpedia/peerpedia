from html import escape
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


def has_images(source):
    def walk(tokens):
        return any(token.type == "image" or (token.children and walk(token.children)) for token in tokens)
    return walk(parser().parse(source))
