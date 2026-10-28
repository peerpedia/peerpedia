from django.test import SimpleTestCase
from django.core.exceptions import ValidationError
from .rendering import render_markdown
from .passages import blocks


class DiagramRenderingTests(SimpleTestCase):
    def test_native_tikz_is_compiled_and_preserves_passage_source(self):
        source = "```tikz\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n```"
        html = render_markdown(source)
        self.assertIn("<svg", html)
        self.assertIn("bm-tikz-rendered", html)
        self.assertNotIn("bm-tikz-source", html)
        self.assertIn('data-passage-kind="equation"', html)
        self.assertIn(r"\begin{tikzpicture}", blocks(source)[0]["text"])

    def test_invalid_diagram_is_an_error_not_a_published_placeholder(self):
        with self.assertRaises(ValidationError):
            render_markdown("```tikz\n\\begin{tikzpicture}\\invalidcommand\\end{tikzpicture}\n```")

    def test_cd_and_blackboard_bold_use_native_math(self):
        html = render_markdown(r"$\mathbb{Z}$")
        self.assertIn("katex", html)
        self.assertIn("<math", html)
