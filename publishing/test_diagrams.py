from django.test import SimpleTestCase, override_settings
from django.urls import reverse

from .passages import blocks
from .rendering import render_markdown, render_reader


class DiagramRenderingTests(SimpleTestCase):
    def test_fences_are_opt_in_and_escaped(self):
        payload = '</code></pre><script>alert(1)</script><img src="https://bad.test/">'
        for language in ("tikzcd", "tikzpicture", "tikz"):
            source = f"```{language}\n{payload}\n```"
            result = render_markdown(source)
            self.assertIn("data-diagram", result)
            self.assertNotIn("<script>", result)
            self.assertNotIn("<img", result)
            self.assertIn("&lt;script&gt;", result)
            self.assertEqual(blocks(source)[0]["text"], payload + "\n")
            reader, _ = render_reader(source, passage_annotations=True)
            self.assertIn('data-passage-kind="code"', reader)
        self.assertNotIn("data-diagram", render_markdown("```latex\n\\begin{tikzcd}\n```"))
        self.assertNotIn("data-diagram", render_markdown("`\\begin{tikzpicture}`"))

    def test_cd_stays_math_and_source_is_preserved(self):
        source = "$$\n\\begin{CD} A @>f>> B \\end{CD}\n$$"
        result = render_markdown(source)
        self.assertIn('class="math block"', result)
        self.assertIn("@&gt;f&gt;&gt;", result)
        self.assertNotIn("data-diagram", result)

    @override_settings(DEBUG=True)
    def test_only_worker_policy_allows_wasm(self):
        worker = self.client.get(reverse("diagram_worker"))
        self.assertEqual(worker.status_code, 200)
        self.assertIn("'wasm-unsafe-eval'", worker["Content-Security-Policy"])
        self.assertNotIn("'unsafe-eval'", worker["Content-Security-Policy"])
        self.assertIn("self.diagramAssets=", worker.content.decode())
        self.assertEqual(worker["Cache-Control"], "no-cache")
        page = self.client.get(reverse("help"))
        self.assertNotIn("wasm-unsafe-eval", page["Content-Security-Policy"])
        self.assertEqual(self.client.post(reverse("diagram_worker")).status_code, 405)
