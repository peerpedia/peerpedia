from collections import Counter
from html.parser import HTMLParser
from urllib.parse import unquote

from django.test import SimpleTestCase
from django.urls import reverse

from .references import ReferenceDocument
from .templatetags.help_examples import EXAMPLES


class Anchors(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.fragments = [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "a" and attrs.get("href", "").startswith("#"):
            self.fragments.append(unquote(attrs["href"][1:]))


class HelpExampleTests(SimpleTestCase):
    def test_writing_guide_has_real_outputs_and_unambiguous_links(self):
        response = self.client.get(reverse("help_writing"))
        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        for name in EXAMPLES:
            self.assertIn(f'id="example-{name}"', body)
        self.assertIn("<strong>symmetry</strong>", body)
        self.assertIn('id="help-references-eq:area"', body)
        self.assertIn("bm-env-theorem", body)
        self.assertIn("bm-env-proof", body)
        self.assertIn("<table ", body)
        self.assertEqual(body.count('class="bm-tikz-body"'), 2)
        self.assertNotIn('<svg viewBox="0 0 260 180"', body)
        self.assertNotIn('class="broken-reference"', body)
        anchors = Anchors()
        anchors.feed(body)
        self.assertEqual([key for key, count in Counter(anchors.ids).items() if count > 1], [])
        self.assertTrue(set(anchors.fragments) <= set(anchors.ids))
        self.assertIn('href="#help-citation-bib-', body)
        self.assertIn('href="#help-citation_details-bib-', body)

    def test_preview_prefix_preserves_source_labels_and_default_rendering(self):
        source = "## Area {@sec:area}\n\nSee @sec:area.\n"
        chapters = [{"id": "main", "title": "Example", "markdown": source}]
        plain = ReferenceDocument(chapters)
        prefixed = ReferenceDocument(chapters, anchor_prefix="demo-")
        self.assertEqual(prefixed.warnings, [])
        self.assertEqual(prefixed.targets[0]["label"], "sec:area")
        self.assertIn('id="area"', plain.render("main")[0])
        self.assertIn('href="#demo-area"', prefixed.render("main")[0])
        self.assertIn('id="demo-area"', prefixed.render("main")[0])
