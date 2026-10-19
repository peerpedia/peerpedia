import json
from datetime import timedelta
from unittest.mock import patch
from urllib.error import URLError

from django.test import TestCase, SimpleTestCase
from django.urls import reverse
from django.utils import timezone

from .diagram_cache import enqueue, sanitize
from .management.commands.process_diagrams import claim, process_one
from .models import DiagramArtifact
from .services import publish
from .test_support import consenting_user

SOURCE = "```tikzpicture\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n```"
RESULT = {
    "html": '<div><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg></div>',
    "width": 20,
    "height": 30,
}


class SVGValidationTests(SimpleTestCase):
    def test_active_markup_external_urls_and_css_are_removed(self):
        raw = (
            '<svg onload="bad()"><script>bad()</script><foreignObject><iframe/></foreignObject>'
            '<image href="https://bad.test"/><path id="p" d="M0 0" fill="url(https://bad.test)"/>'
            '<use href="#p"/><use href="https://bad.test"/>'
            '<text style="font-family:cmmi10">A</text>'
            '<path fill="u\\72l(https://bad.test)"/></svg>'
        )
        svg = sanitize(dict(RESULT, html=raw))
        for forbidden in (
            "onload",
            "script",
            "foreignObject",
            "iframe",
            "image",
            "https:",
            "u\\72l",
        ):
            self.assertNotIn(forbidden, svg)
        self.assertIn('href="#p"', svg)
        self.assertIn("data:font/ttf;base64,", svg)
        self.assertIn('font-family="cmmi10"', svg)

    def test_declarations_dimensions_foreign_roots_and_nested_svg(self):
        for raw in [
            '<!DOCTYPE svg [<!ENTITY x "boom">]><svg>&x;</svg>',
            "<svg/><svg/>",
            '<svg xmlns="https://bad.test"/>',
            "<svg><svg></svg></svg>",
        ]:
            with self.assertRaises(ValueError):
                sanitize(dict(RESULT, html=raw))
        for size in (float("nan"), float("inf"), -1, 10001, "10"):
            with self.assertRaises(ValueError):
                sanitize(dict(RESULT, width=size))


class DiagramCacheTests(TestCase):
    def setUp(self):
        self.user = consenting_user("diagram", "diagram@example.org", "test", email_verified=True)

    def publish(self, source=SOURCE):
        return publish(
            self.user,
            {
                "license": "CC-BY-4.0",
                "primary_category": "math.GT",
                "secondary_categories": [],
                "title": "Diagrams",
                "authors": "Author",
                "abstract": "Abstract",
                "markdown": source,
                "explanation": "Initial",
            },
        )

    def test_enqueue_is_deduplicated_and_does_not_change_frozen_snapshots(self):
        first = self.publish()
        second = self.publish(SOURCE + "\n\n" + SOURCE)
        enqueue(first.current)
        self.assertEqual(DiagramArtifact.objects.count(), 1)
        artifact = DiagramArtifact.objects.get()
        self.assertEqual(artifact.submissions.count(), 2)
        self.assertEqual(first.current.hash, first.current.calculate_hash())
        self.assertEqual(second.current.hash, second.current.calculate_hash())
        with patch("publishing.diagram_cache.VERSION", "new-compiler"):
            enqueue(first.current)
        self.assertEqual(DiagramArtifact.objects.count(), 2)

    def test_ready_reader_and_image_work_without_javascript_and_obey_visibility(self):
        paper = self.publish()
        item = DiagramArtifact.objects.get()
        item.svg, item.status = sanitize(RESULT), "ready"
        item.save()
        html = self.client.get(reverse("read_paper", args=[paper.pk]))
        self.assertContains(html, '<img loading="lazy"')
        self.assertContains(html, 'data-diagram-state="ready"')
        url = reverse("diagram_svg", args=[item.key])
        image = self.client.get(url)
        self.assertEqual(image.status_code, 200)
        self.assertIn("sandbox", image["Content-Security-Policy"])
        self.assertEqual(self.client.get(url, HTTP_IF_NONE_MATCH=image["ETag"]).status_code, 304)
        paper.is_hidden = True
        paper.save()
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(
            self.client.get(reverse("diagram_status", args=[item.key])).status_code, 404
        )

    def test_missing_image_is_polled_without_browser_compilation(self):
        paper = self.publish()
        html = self.client.get(reverse("read_paper", args=[paper.pk]))
        self.assertContains(html, "data-saved-url=")
        item = DiagramArtifact.objects.get()
        self.assertEqual(self.client.get(reverse("diagram_svg", args=[item.key])).status_code, 404)
        self.assertEqual(
            self.client.get(reverse("diagram_status", args=[item.key])).json()["status"], "pending"
        )

    @patch("publishing.management.commands.process_diagrams.open_renderer")
    def test_worker_saves_result_and_does_not_recompile_ready_job(self, mocked):
        self.publish()
        mocked.return_value.__enter__.return_value.read.return_value = json.dumps(
            {"result": RESULT}
        ).encode()
        self.assertTrue(process_one())
        self.assertFalse(process_one())
        self.assertEqual(DiagramArtifact.objects.get().status, "ready")
        self.assertEqual(mocked.call_count, 1)

    @patch(
        "publishing.management.commands.process_diagrams.open_renderer",
        side_effect=URLError("unavailable"),
    )
    def test_outage_retries_are_bounded_and_stale_claims_recover(self, mocked):
        self.publish()
        for attempt in range(3):
            DiagramArtifact.objects.update(available_at=timezone.now() - timedelta(seconds=1))
            self.assertTrue(process_one())
        item = DiagramArtifact.objects.get()
        self.assertEqual((item.status, item.attempts), ("error", 3))
        self.assertFalse(process_one())
        item.status, item.attempts = "processing", 1
        item.updated_at = timezone.now() - timedelta(minutes=3)
        item.save()
        self.assertEqual(claim().attempts, 2)
        self.assertIsNone(claim())

    @patch("publishing.management.commands.process_diagrams.open_renderer")
    def test_bad_tex_is_terminal_and_next_job_can_continue(self, mocked):
        self.publish()
        mocked.return_value.__enter__.return_value.read.return_value = (
            b'{"error":"TeX could not compile."}'
        )
        self.assertTrue(process_one())
        self.assertEqual(DiagramArtifact.objects.get().status, "error")
        self.assertFalse(process_one())

    def test_source_and_per_submission_limits_do_not_queue_unbounded_work(self):
        self.publish("```tikz\n" + "a" * 33000 + "\n```")
        self.assertEqual(DiagramArtifact.objects.get().status, "error")
        self.assertFalse(process_one())
        paper = self.publish("\n\n".join(f"```tikz\n{i}\n```" for i in range(34)))
        self.assertEqual(paper.current.diagram_artifacts.count(), 32)
        self.assertContains(
            self.client.get(reverse("read_paper", args=[paper.pk])), "32 distinct diagrams"
        )
