from unittest.mock import patch
from django.test import SimpleTestCase
from django.core.exceptions import ValidationError
from . import bananamark


class RendererTransportTests(SimpleTestCase):
    def test_unicode_line_separators_do_not_desynchronize_responses(self):
        result = bananamark.request(source="Before\u2028after\u2029end.")
        self.assertIn("Before", result["pages"][0]["html"])
        following = bananamark.request(source="After the Unicode request.")
        self.assertIn("After the Unicode request.", following["pages"][0]["html"])

    def test_transport_failure_preserves_actionable_error(self):
        with (
            patch.object(bananamark, "_process", None),
            patch("subprocess.Popen", side_effect=OSError("missing node")),
        ):
            with self.assertRaisesMessage(ValidationError, "Your draft can still be saved"):
                bananamark._request('{"source":"uncached transport test"}', "")

    def test_invalid_math_exposes_the_original_line(self):
        with self.assertRaisesMessage(ValidationError, "main.md:3"):
            bananamark.request(source="First.\n\n$\\notacommand$")

    def test_cached_results_are_not_mutated_by_callers(self):
        a = bananamark.request(source="Cached transport test.")
        a["pages"][0]["html"] = "changed"
        b = bananamark.request(source="Cached transport test.")
        self.assertNotEqual(b["pages"][0]["html"], "changed")
