"""Browser integration tests: actual forms, cookies, CSRF, JS and PostgreSQL."""

from publishing.test_support import consenting_user

import os
from pathlib import Path
import re
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.core import mail
from django.db import connections
from django.test import override_settings
from playwright.sync_api import expect, sync_playwright
from accounts.models import User
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice
from publishing.models import Draft, Paper, Review, Submission, PassageComment
from publishing.services import publish, propose

PASSWORD = "Browser-Only-Password-938!"
SOURCE = "# Browser paper\n\nOriginal proof. Inline $x^2$.\n\n$$\nx=1\n$$\n\n```python\nvalue = '$notmath$'\n```\n"
REVISED = SOURCE.replace("Original proof.", "Corrected proof.")


@override_settings(DEBUG=True)
class BrowserJourneys(StaticLiveServerTestCase):
    host = "127.0.0.1"

    def setUp(self):
        self.owner = consenting_user("owner", "owner@example.org", PASSWORD, email_verified=True)
        self.contributor = consenting_user(
            "contributor", "contributor@example.org", PASSWORD, email_verified=True
        )
        # Stop Playwright before Django flushes the test database. Its sync API
        # keeps an asyncio loop running on this thread while the browser is open.
        self.playwright = sync_playwright().start()
        self.addCleanup(self.playwright.stop)
        self.browser = self.playwright.chromium.launch()
        self.addCleanup(self.browser.close)
        self.context = self.browser.new_context(
            viewport={"width": 1365, "height": 900}, service_workers="block"
        )
        self.context.set_default_timeout(10000)
        self.context.tracing.start(screenshots=True, snapshots=True, sources=True)
        self.page_errors = []
        self.external_requests = []
        self.context.route("**/*", self.local_requests_only)
        self.context.on(
            "page",
            lambda page: page.on("pageerror", lambda error: self.page_errors.append(str(error))),
        )
        self.page = self.context.new_page()
        self.addCleanup(self.finish_browser)
        self.origin = self.settings(SITE_URL=self.live_server_url)
        self.origin.enable()
        self.addCleanup(self.origin.disable)

    def local_requests_only(self, route):
        if urlsplit(route.request.url).netloc == urlsplit(self.live_server_url).netloc:
            route.continue_()
        else:
            self.external_requests.append(route.request.url)
            route.abort()

    def tearDown(self):
        self.assertEqual(self.page_errors, [], "Browser JavaScript errors")
        self.assertEqual(self.external_requests, [], "Unexpected external browser traffic")

    def finish_browser(self):
        result = self._outcome.result
        failed = any(test.id() == self.id() for test, _ in result.failures + result.errors)
        try:
            if failed:
                folder = Path(os.environ["PEERPEDIA_BROWSER_ARTIFACTS"]) / self._testMethodName
                folder.mkdir(parents=True, exist_ok=True)
                self.page.screenshot(path=str(folder / "page.png"), full_page=True)
                self.context.tracing.stop(path=str(folder / "trace.zip"))
                print(f"Browser failure evidence: {folder}")
            else:
                self.context.tracing.stop()
        finally:
            self.context.close()

    def login(self, username="owner", password=PASSWORD):
        self.page.goto(self.live_server_url + "/accounts/login/")
        self.page.get_by_label("Username or email").fill(username)
        self.page.get_by_label("Password:", exact=True).fill(password)
        self.page.get_by_role("button", name="Sign in", exact=True).click()
        expect(self.page.get_by_role("button", name="Sign out")).to_be_visible()

    def fixture_paper(self):
        return self.database_call(
            lambda: publish(
                self.owner,
                {
                    "license": "CC-BY-4.0",
                    "primary_category": "math.NT",
                    "secondary_categories": [],
                    "title": "Browser paper",
                    "authors": "Ada Example",
                    "abstract": "A private-to-metadata abstract.",
                    "markdown": SOURCE,
                    "explanation": "Initial publication.",
                },
            )
        )

    def database_call(self, function):
        # Keep synchronous ORM work outside Playwright's asyncio thread, without
        # disabling Django's async-safety checks. Never return lazy querysets.
        def call():
            try:
                return function()
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(call).result()

    def upload(self, source=SOURCE, proposal=False):
        self.page.get_by_label("Title:", exact=True).fill("Browser paper")
        self.page.get_by_label("Authors:", exact=True).fill("Ada Example")
        self.page.get_by_label("Abstract:", exact=True).fill("A private-to-metadata abstract.")
        self.page.get_by_label("Primary subject:", exact=True).select_option("math.NT")
        self.page.get_by_label("Markdown document").set_input_files(
            {"name": "paper.md", "mimeType": "text/markdown", "buffer": source.encode()}
        )
        if proposal:
            self.page.get_by_label("What changed?").fill("Correct the proof.")
        self.page.get_by_role("button", name=re.compile("Preview (submission|paper)")).click()

    def assert_math(self):
        expect(self.page.locator("mjx-container svg")).to_have_count(2)
        expect(self.page.locator("mjx-merror, [data-mml-node='merror']")).to_have_count(0)
        expect(self.page.locator("pre code")).to_have_text("value = '$notmath$'\n")
        expect(self.page.locator("pre code mjx-container")).to_have_count(0)

    def assert_no_page_overflow(self):
        # Search results can already match while the next page's styles are
        # loading. Wait for the layout condition, retaining geometry on failure.
        # wait_for_function evaluates its predicate inside the page and can
        # conflict with our strict CSP. Poll through the automation evaluation
        # context instead, without bypassing CSP for any application scripts.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.page.evaluate(
                "() => document.documentElement.scrollWidth <= window.innerWidth + 1"
            ):
                break
            self.page.wait_for_timeout(50)
        layout = self.page.evaluate("""() => ({
            viewport: innerWidth, width: document.documentElement.scrollWidth,
            overflowing: [...document.querySelectorAll('body *')].filter(element =>
                element.getBoundingClientRect().right > innerWidth + 1
            ).map(element => ({tag: element.tagName, id: element.id, classes: element.className,
                right: element.getBoundingClientRect().right})).slice(0, 15)
        })""")
        self.assertLessEqual(layout["width"], layout["viewport"] + 1, str(layout))

    def test_author_license_choice_requires_human_agreement(self):
        from accounts.models import User
        from publishing.models import AgreementAcceptance
        from publishing.licensing import VERSION

        new_user = self.database_call(
            lambda: User.objects.create_user(
                "license-author", "license@example.org", PASSWORD, email_verified=True
            )
        )
        self.login("license-author")
        self.page.goto(self.live_server_url + "/publish/")
        expect(self.page.get_by_role("heading", name="Before you contribute")).to_be_visible()
        self.assertFalse(
            self.database_call(lambda: AgreementAcceptance.objects.filter(user=new_user).exists())
        )
        self.page.get_by_label("I have read and accept", exact=False).check()
        self.page.get_by_role("button", name="Accept agreement and continue").click()
        self.assertEqual(
            self.database_call(lambda: AgreementAcceptance.objects.get(user=new_user).version),
            VERSION,
        )
        self.upload()
        expect(self.page.get_by_label("Content license:", exact=True)).to_have_value("")
        self.page.get_by_label("Content license:", exact=True).select_option("CC-BY-NC-ND-4.0")
        self.page.get_by_label("I have authority to submit", exact=False).check()
        self.page.get_by_role("button", name="Publish paper", exact=True).click()
        expect(self.page.get_by_role("link", name="CC BY-NC-ND 4.0", exact=True)).to_be_visible()
        paper = self.database_call(lambda: Paper.objects.get(owner=new_user))
        self.assertEqual(self.database_call(lambda: paper.current.license_code), "CC-BY-NC-ND-4.0")
        self.page.get_by_role("link", name="Edit paper", exact=True).click()
        self.page.locator(".cm-content").fill(REVISED)
        expect(self.page.locator("#save-status")).to_have_text("Saved")
        self.page.locator("#paper-details summary").click()
        self.page.get_by_label("What changed?", exact=True).fill("Correct the proof.")
        self.page.get_by_role("button", name="Review changes", exact=True).click()
        expect(self.page.get_by_role("link", name="CC BY-NC-ND 4.0", exact=True)).to_be_visible()
        expect(self.page.get_by_label("Content license:", exact=True)).to_have_count(0)
        self.page.get_by_label("I have authority to submit", exact=False).check()
        self.page.get_by_role("button", name="Submit PR", exact=True).click()
        self.assertEqual(
            self.database_call(lambda: Submission.objects.filter(paper=paper).count()), 2
        )
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.page.goto(self.live_server_url + "/licenses/")
        self.assert_no_page_overflow()

    def test_upload_preview_publish_reader_and_download(self):
        self.login()
        self.page.get_by_role("link", name="Upload a paper", exact=True).click()
        self.upload()
        expect(self.page.get_by_role("heading", name="Review your upload")).to_be_visible()
        self.assertEqual(self.database_call(Paper.objects.count), 0)
        self.assert_math()
        self.page.get_by_label("Content license:", exact=True).select_option("CC-BY-4.0")
        self.page.get_by_label("I have authority to submit", exact=False).check()
        self.page.get_by_role("button", name="Publish paper", exact=True).click()
        expect(self.page.get_by_role("heading", name="Browser paper", exact=True)).to_be_visible()
        self.assertEqual(self.database_call(Paper.objects.count), 1)
        short_hash = self.database_call(lambda: Paper.objects.get().current.short_hash)
        metadata_url = self.page.url
        with self.page.expect_download() as event:
            self.page.get_by_role("link", name="Download Markdown", exact=True).click()
        self.assertEqual(Path(event.value.path()).read_bytes(), SOURCE.encode())
        self.page.get_by_role("link", name="Read paper", exact=True).click()
        expect(self.page).to_have_url(metadata_url + "read/")
        self.assert_math()
        expect(self.page.locator(".site-header, .site-footer")).to_have_count(0)
        expect(self.page.get_by_role("link", name="Peerpedia home")).to_be_visible()
        expect(self.page.get_by_role("button", name="Discussions", exact=True)).to_be_visible()
        self.page.go_back()
        expect(self.page.get_by_role("heading", name="Abstract", exact=True)).to_be_visible()
        self.page.get_by_role("link", name="History", exact=True).click()
        expect(self.page.get_by_text(short_hash, exact=True)).to_be_visible()

    def test_proposal_diff_conversation_acceptance_and_preserved_history(self):
        paper = self.fixture_paper()
        original_id = paper.current_id
        self.login("contributor")
        self.page.goto(f"{self.live_server_url}/papers/{paper.pk}/")
        self.page.get_by_role("link", name="Upload a change", exact=True).click()
        self.upload(REVISED, proposal=True)
        expect(self.page.get_by_role("region", name="Markdown source differences")).to_contain_text(
            "+Corrected proof."
        )
        self.assertEqual(self.database_call(Submission.objects.count), 1)
        self.page.get_by_label("I have authority to submit", exact=False).check()
        self.page.get_by_role("button", name="Publish submission", exact=True).click()
        expect(self.page.locator(".submission-heading .status")).to_have_text("Pending")
        submission_url = self.page.url
        frozen_hash = self.page.locator(".hash-info dd code").first.inner_text()
        expect(self.page.get_by_role("button", name="Accept submission")).to_have_count(0)
        expect(
            self.page.get_by_role("region", name="Markdown source differences")
        ).not_to_be_visible()
        self.page.get_by_text("View Markdown changes", exact=True).click()
        expect(self.page.locator(".source-diff .deletion")).to_contain_text(
            ["---", "-Original proof."]
        )
        expect(self.page.locator(".source-diff .addition")).to_contain_text(
            ["+++", "+Corrected proof."]
        )
        self.page.get_by_label("Add to the conversation").fill("Please check the corrected proof.")
        self.page.get_by_role("button", name="Post comment").click()
        expect(self.page.locator("#conversation .review")).to_contain_text(
            "Please check the corrected proof."
        )
        self.page.get_by_role("button", name="Sign out").click()
        self.login()
        self.page.goto(submission_url)
        self.page.get_by_role("button", name="Accept submission").click()
        expect(self.page.locator(".submission-heading .status")).to_have_text("Accepted")
        expect(self.page.locator(".hash-info dd code").first).to_have_text(frozen_hash)
        self.database_call(paper.refresh_from_db)
        self.assertNotEqual(paper.current_id, original_id)
        self.assertEqual(self.database_call(lambda: paper.current.hash), frozen_hash)
        self.page.goto(f"{self.live_server_url}/papers/{paper.pk}/?tab=history")
        expect(self.page.get_by_role("link", name="Read this version")).to_have_count(2)
        self.page.get_by_role("link", name="Read this version").last.click()
        expect(self.page.locator(".markdown-body")).to_contain_text("Original proof.")
        self.page.goto(f"{self.live_server_url}/papers/{paper.pk}/read/")
        expect(self.page.locator(".markdown-body")).to_contain_text("Corrected proof.")

    def test_review_required_text_edit_and_browse_rating(self):
        paper = self.fixture_paper()
        self.login("contributor")
        self.page.goto(f"{self.live_server_url}/papers/{paper.pk}/")
        for score in range(1, 6):
            self.page.locator(".paper-star").nth(score - 1).hover()
            for index in range(5):
                expect(self.page.locator(".paper-star svg").nth(index)).to_have_css(
                    "fill", re.compile(r"^rgb\(") if index < score else "rgba(0, 0, 0, 0)"
                )
        self.page.locator('label.paper-star[title="5 stars"]').click()
        expect(self.page.get_by_label("5 stars", exact=True)).to_be_checked()
        self.page.get_by_label("Your review:", exact=True).hover()
        for star in self.page.locator(".paper-star svg").all():
            expect(star).to_have_css("fill", re.compile(r"^rgb\("))
        self.page.get_by_role("button", name="Publish review").click()
        self.assertFalse(
            self.page.get_by_label("Your review:", exact=True).evaluate(
                "element => element.validity.valid"
            )
        )
        self.assertEqual(self.database_call(Review.objects.count), 0)
        self.page.get_by_label("Your review:", exact=True).fill("A useful and clear proof.")
        self.page.get_by_role("button", name="Publish review").click()
        expect(self.page.locator(".rating-summary")).to_contain_text("5.0")
        self.page.get_by_label("5 stars", exact=True).press("ArrowLeft")
        expect(self.page.get_by_label("4 stars", exact=True)).to_be_checked()
        self.page.get_by_label("Your review:", exact=True).fill(
            "Useful, with one remaining question."
        )
        self.page.get_by_role("button", name="Save review").click()
        expect(self.page.locator("#reviews .review")).to_have_count(1)
        expect(self.page.locator(".rating-summary")).to_contain_text("4.0")
        self.assertEqual(self.database_call(Review.objects.count), 1)
        self.page.get_by_role("link", name="Browse", exact=True).click()
        self.page.get_by_label("Sort by").select_option("rating")
        self.page.get_by_role("button", name="Apply", exact=True).click()
        expect(self.page.locator(".paper-row .rating-cell")).to_contain_text("4.0")

    def test_administration_navigation_and_readonly_history(self):
        paper = self.fixture_paper()
        self.database_call(
            lambda: User.objects.filter(pk=self.owner.pk).update(is_staff=True, is_superuser=True)
        )
        self.login()
        expect(
            self.page.get_by_role("heading", name="Two-factor authentication", exact=True)
        ).to_be_visible()
        self.page.get_by_label("Confirm your password:", exact=True).fill(PASSWORD)
        self.page.get_by_role("button", name="Set up authenticator", exact=True).click()
        expect(self.page.locator("svg.segno")).to_be_visible()
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.assert_no_page_overflow()
        device = self.database_call(
            lambda: TOTPDevice.objects.get(user=self.owner, confirmed=False)
        )
        self.page.get_by_label("Authenticator or recovery code:", exact=True).fill(
            f"{totp(device.bin_key):06d}"
        )
        self.page.get_by_role("button", name="Confirm authenticator", exact=True).click()
        expect(
            self.page.get_by_role("heading", name="Save your recovery codes", exact=True)
        ).to_be_visible()
        expect(self.page.locator(".auth-panel li code")).to_have_count(8)
        self.page.get_by_role("link", name="I saved my codes · Continue", exact=True).click()
        self.page.set_viewport_size({"width": 1365, "height": 900})
        self.page.get_by_role("link", name="Admin", exact=True).click()
        expect(self.page.get_by_role("heading", name="Care for the community.")).to_be_visible()
        expect(self.page.get_by_role("link", name=re.compile("Reported comments"))).to_be_visible()
        self.page.get_by_role("link", name=re.compile("Paper snapshots")).click()
        expect(self.page.get_by_role("link", name="Browser paper", exact=True)).to_be_visible()
        self.page.get_by_role("link", name="Browser paper", exact=True).click()
        expect(self.page.get_by_text(paper.current.hash, exact=True)).to_be_visible()
        expect(self.page.locator('input[name="_save"]')).to_have_count(0)
        self.page.get_by_role("link", name="Administration", exact=True).click()
        self.page.set_viewport_size({"width": 390, "height": 844})
        expect(self.page.get_by_role("heading", name="Moderation", exact=True)).to_be_visible()
        self.assert_no_page_overflow()
        self.assertTrue(
            self.page.evaluate(
                "document.querySelector('#user-tools').getBoundingClientRect().bottom <= document.querySelector('#header').getBoundingClientRect().bottom"
            )
        )
        self.page.get_by_role("link", name="Peerpedia home", exact=True).click()
        expect(self.page.get_by_role("heading", name="Research, in revision.")).to_be_visible()

    def test_editor_autosave_preview_reload_and_submission(self):
        paper = self.fixture_paper()
        original_hash = paper.current.hash
        self.login()
        self.page.goto(self.live_server_url + f"/papers/{paper.pk}/edit/")
        source = self.page.locator(".cm-content")
        expect(source).to_be_visible()
        revised = SOURCE.replace("Original proof.", "Autosaved proof with a new explanation.")
        source.fill(revised)
        expect(self.page.locator("#save-status")).to_have_text("Saved")
        expect(self.page.locator("#draft-preview")).to_contain_text("Autosaved proof")
        draft = self.database_call(lambda: Draft.objects.get(owner=self.owner, paper=paper))
        self.assertEqual(draft.markdown, revised)
        self.page.reload()
        expect(self.page.locator(".cm-content")).to_contain_text("Autosaved proof")
        self.page.locator("#paper-details summary").click()
        self.page.get_by_label("What changed?", exact=True).fill(
            "Clarify the proof from the online editor."
        )
        self.page.get_by_role("button", name="Review changes", exact=True).click()
        expect(self.page.get_by_role("heading", name="Review your changes")).to_be_visible()
        self.page.get_by_label("I have authority to submit", exact=False).check()
        self.page.get_by_role("button", name="Submit PR", exact=True).click()
        expect(
            self.page.get_by_text("Clarify the proof from the online editor.", exact=True)
        ).to_be_visible()
        self.assertEqual(
            self.database_call(lambda: Paper.objects.get(pk=paper.pk).current.hash), original_hash
        )
        self.assertEqual(
            self.database_call(lambda: Draft.objects.get(pk=draft.pk).submitted.markdown), revised
        )

    def test_editor_two_tab_conflict_and_offline_recovery(self):
        paper = self.fixture_paper()
        self.login()
        self.page.goto(self.live_server_url + f"/papers/{paper.pk}/edit/")
        expect(self.page.locator(".cm-content")).to_be_visible()
        draft_url = self.page.url
        second = self.context.new_page()
        second.goto(draft_url)
        expect(second.locator(".cm-content")).to_be_visible()
        self.page.locator(".cm-content").fill("# Browser paper\n\nFirst tab correction.")
        expect(self.page.locator("#save-status")).to_have_text("Saved")
        second.locator(".cm-content").fill("# Browser paper\n\nSecond tab correction.")
        expect(second.locator("#conflict")).to_be_visible()
        self.assertIn(
            "First tab correction",
            self.database_call(lambda: Draft.objects.get(owner=self.owner, paper=paper).markdown),
        )
        second.once("dialog", lambda dialog: dialog.accept())
        second.get_by_role("button", name="Keep this copy", exact=True).click()
        expect(second.locator("#save-status")).to_have_text("Saved")
        self.assertIn(
            "Second tab correction",
            self.database_call(lambda: Draft.objects.get(owner=self.owner, paper=paper).markdown),
        )
        # Fail only this tab's save requests. The real recovery listener writes
        # browser storage; the test never injects a fabricated recovery record.
        second.route("**/save/", lambda route: route.abort())
        second.locator(".cm-content").fill("# Browser paper\n\nRecover this unsaved explanation.")
        expect(second.locator("#save-status")).to_have_text("Couldn’t save")
        self.assertNotIn(
            "Recover this",
            self.database_call(lambda: Draft.objects.get(owner=self.owner, paper=paper).markdown),
        )
        second.unroute("**/save/")
        second.once("dialog", lambda dialog: dialog.accept())
        second.reload()
        expect(second.locator("#recovery")).to_be_visible()
        second.get_by_role("button", name="Restore recovery copy", exact=True).click()
        expect(second.locator("#save-status")).to_have_text("Saved")
        self.assertIn(
            "Recover this unsaved explanation",
            self.database_call(lambda: Draft.objects.get(owner=self.owner, paper=paper).markdown),
        )
        second.close()

    def test_selected_sentence_discussion_reply_vote_and_history(self):
        paper = self.fixture_paper()
        self.login()
        self.page.goto(self.live_server_url + f"/papers/{paper.pk}/read/")
        block = self.page.locator('[data-passage-kind="text"]').filter(has_text="Original proof.")
        expect(block).to_be_visible()
        # Browser Selection is the actual input to the annotation UI. Select
        # just a sentence, leaving adjacent text and equation outside it.
        block.evaluate("""element => {
            const text = [...element.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.includes('Original proof.'));
            const start = text.textContent.indexOf('Original proof.');
            const range = document.createRange(); range.setStart(text,start); range.setEnd(text,start+15);
            const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
        }""")
        self.page.locator("#passage-selection").click()
        panel = self.page.locator("#discussion-panel")
        expect(panel.locator("blockquote")).to_have_text("Original proof.")
        panel.get_by_role("button", name="4 stars", exact=True).click()
        panel.get_by_label("Rate this passage and explain why").fill(
            "Please explain this implication."
        )
        panel.get_by_role("button", name="Post comment", exact=True).click()
        root = panel.locator(".discussion-comment").filter(
            has_text="Please explain this implication."
        )
        expect(root).to_be_visible()
        root.get_by_role("button", name="Helpful: 0", exact=True).click()
        expect(root.get_by_role("button", name="Helpful: 1", exact=True)).to_be_visible()
        root.get_by_role("button", name="Reply", exact=True).click()
        root.get_by_label("Reply to owner").fill("Here is a more detailed question.")
        root.get_by_role("button", name="Post reply", exact=True).click()
        expect(panel.get_by_text("Here is a more detailed question.", exact=True)).to_be_visible()
        root.locator("summary").click()
        root.get_by_role("button", name="Edit", exact=True).click()
        root.get_by_label("Edit your comment").fill("Clarify the implication and its assumptions.")
        root.get_by_role("button", name="Save changes", exact=True).click()
        edited = panel.locator(".discussion-comment").filter(
            has_text="Clarify the implication and its assumptions."
        )
        expect(edited).to_be_visible()
        edited.locator("summary").click()
        edited.get_by_role("button", name="History", exact=True).click()
        expect(edited.locator(".discussion-history")).to_contain_text(
            "Please explain this implication."
        )
        self.assertEqual(
            self.database_call(
                lambda: PassageComment.objects.filter(parent__isnull=True).get().passage.quote
            ),
            "Original proof.",
        )
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.assert_no_page_overflow()

    def test_signup_verification_logout_and_password_recovery(self):
        self.page.goto(self.live_server_url + "/")
        self.page.get_by_role("link", name="Create account", exact=True).click()
        self.page.get_by_label("Username:", exact=True).fill("newreader")
        self.page.get_by_label("Email:", exact=True).fill("newreader@example.org")
        self.page.get_by_label("Password:", exact=True).fill(PASSWORD)
        self.page.get_by_label("Password confirmation:", exact=True).fill(PASSWORD)
        self.page.get_by_role("button", name="Create account", exact=True).click()
        expect(self.page.get_by_role("heading", name="Check your inbox")).to_be_visible()
        self.page.get_by_role("link", name="Upload a paper", exact=True).click()
        expect(self.page.get_by_role("heading", name="Check your inbox")).to_be_visible()
        self.assertEqual(len(mail.outbox), 1)
        verification = re.search(r"http://\S+", mail.outbox[-1].body).group()
        self.page.goto(verification)
        self.assertFalse(
            self.database_call(lambda: User.objects.get(username="newreader").email_verified)
        )
        self.page.get_by_role("button", name="Verify email", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("Email verified")
        self.page.get_by_role("button", name="Sign out", exact=True).click()
        self.page.get_by_role("link", name="Sign in", exact=True).click()
        self.page.get_by_role("link", name="Forgot your password?").click()
        self.page.get_by_label("Email:", exact=True).fill("newreader@example.org")
        self.page.get_by_role("button", name="Send reset link").click()
        expect(self.page).to_have_url(self.live_server_url + "/accounts/password-reset/sent/")
        self.assertEqual(len(mail.outbox), 2)
        reset = re.search(r"http://\S+", mail.outbox[-1].body).group()
        self.page.goto(reset)
        new_password = "Changed-Browser-Password-742!"
        self.page.get_by_label("New password:", exact=True).fill(new_password)
        self.page.get_by_label("New password confirmation:", exact=True).fill(new_password)
        self.page.get_by_role("button", name="Reset password", exact=True).click()
        expect(self.page).to_have_url(self.live_server_url + "/accounts/reset/done/")
        self.login("newreader", new_password)
        self.page.goto(reset)
        expect(self.page.get_by_role("heading", name="This link has expired")).to_be_visible()

    def test_mobile_search_reader_math_and_expandable_diff(self):
        paper = self.fixture_paper()
        change = self.database_call(
            lambda: propose(
                self.contributor,
                paper.pk,
                paper.current_id,
                {
                    "license": "CC-BY-4.0",
                    "primary_category": "math.NT",
                    "secondary_categories": [],
                    "title": "Browser paper",
                    "authors": "Ada Example",
                    "abstract": "A private-to-metadata abstract.",
                    "markdown": REVISED,
                    "explanation": "Correct the proof.",
                },
            )
        )
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.page.goto(self.live_server_url + "/")
        self.page.get_by_role("searchbox", name="Search papers", exact=True).fill("Ada")
        self.page.get_by_role("button", name="Search", exact=True).click()
        expect(self.page.locator(".paper-row")).to_have_count(1)
        expect(self.page.get_by_text("A private-to-metadata abstract.", exact=True)).to_have_count(
            0
        )
        self.assert_no_page_overflow()
        self.page.get_by_role("link", name="Read paper", exact=True).click()
        self.assert_math()
        self.assert_no_page_overflow()
        self.page.go_back()
        expect(self.page.get_by_role("searchbox", name="Search papers", exact=True)).to_have_value(
            "Ada"
        )
        self.page.get_by_role("link", name="Browser paper", exact=True).click()
        expect(self.page.get_by_role("heading", name="Abstract", exact=True)).to_be_visible()
        self.assert_no_page_overflow()
        self.page.goto(f"{self.live_server_url}/submissions/{change.pk}/")
        self.page.get_by_text("View Markdown changes", exact=True).click()
        expect(self.page.get_by_role("region", name="Markdown source differences")).to_be_visible()
        self.assert_no_page_overflow()
        self.page.goto(self.live_server_url + "/")
        self.page.get_by_role("searchbox", name="Search papers", exact=True).fill(
            "no-matching-paper"
        )
        self.page.get_by_role("button", name="Search", exact=True).click()
        expect(self.page.get_by_role("heading", name="No papers found")).to_be_visible()

    def test_reader_contents_scroll_mobile_keyboard_and_icons(self):
        paragraph = "A paragraph long enough to give each section a real reading position.\n\n"
        source = "# Reading test\n\nIntroduction.\n\n## First section\n\n" + paragraph * 18
        source += "### A proof\n\n" + paragraph * 18 + "## Last section\n\n"
        source += "| Group | Field |\n| --- | --- |\n| C2 | Q |\n\n" + paragraph * 18
        paper = self.database_call(
            lambda: publish(
                self.owner,
                {
                    "license": "CC-BY-4.0",
                    "primary_category": "math.NT",
                    "secondary_categories": [],
                    "title": "Reading test",
                    "authors": "Ada",
                    "abstract": "Reader navigation test.",
                    "markdown": source,
                    "explanation": "Initial publication.",
                },
            )
        )
        reader_url = f"{self.live_server_url}/papers/{paper.pk}/read/"
        self.page.goto(reader_url)
        navigation = self.page.get_by_role("navigation", name="Table of contents")
        expect(navigation).to_be_visible()
        expect(navigation.get_by_role("link")).to_have_count(3)
        first = navigation.get_by_role("link", name="First section", exact=True)
        first.click()
        expect(first).to_have_attribute("aria-current", "location")
        self.page.locator("#section-a-proof").evaluate("element => element.scrollIntoView()")
        expect(navigation.get_by_role("link", name="A proof", exact=True)).to_have_attribute(
            "aria-current", "location"
        )
        self.page.reload()
        # Reload restores the scroll position, which may differ from the URL fragment.
        expect(navigation.get_by_role("link", name="A proof", exact=True)).to_have_attribute(
            "aria-current", "location"
        )
        self.assertTrue(
            self.page.locator("table").evaluate(
                'element => { const table = element.getBoundingClientRect(); const main = element.closest("main").getBoundingClientRect(); return Math.abs((table.left + table.right) - (main.left + main.right)) < 2; }'
            )
        )
        icon = self.page.locator('link[rel="icon"][type="image/svg+xml"]').get_attribute("href")
        self.assertEqual(self.context.request.get(self.live_server_url + icon).status, 200)
        self.assertIn(
            "img-src 'self'",
            self.context.request.get(reader_url).headers["content-security-policy"],
        )
        self.page.set_viewport_size({"width": 390, "height": 844})
        expect(navigation).not_to_be_visible()
        self.page.locator(".reader-contents summary").click()
        expect(navigation).to_be_visible()
        self.page.keyboard.press("Escape")
        expect(navigation).not_to_be_visible()
        self.page.keyboard.press("Enter")
        last = navigation.get_by_role("link", name="Last section", exact=True)
        last.click()
        expect(navigation).not_to_be_visible()
        expect(self.page.locator('[data-section="section-last-section"]')).to_have_attribute(
            "aria-current", "location"
        )
        expect(self.page.locator("#section-last-section")).to_be_focused()
        self.assertGreaterEqual(self.page.locator("#section-last-section").bounding_box()["y"], 60)
        self.assert_no_page_overflow()
        self.page.set_viewport_size({"width": 320, "height": 740})
        self.assert_no_page_overflow()
        self.page.emulate_media(media="print")
        expect(self.page.locator(".reader-sidebar")).not_to_be_visible()
        self.page.emulate_media(media="screen")
        no_script = self.browser.new_context(java_script_enabled=False)
        try:
            page = no_script.new_page()
            page.goto(reader_url)
            page.get_by_role("link", name="Last section", exact=True).click()
            expect(page).to_have_url(reader_url + "#section-last-section")
            expect(page.locator("#section-last-section")).to_be_in_viewport()
        finally:
            no_script.close()

    def test_access_token_creation_one_time_display_and_revocation(self):
        self.login()
        self.page.get_by_role("link", name="Access tokens", exact=True).click()
        self.page.get_by_label("Name:", exact=True).fill("Local assistant")
        self.page.get_by_label("Confirm your password:", exact=True).fill(PASSWORD)
        self.page.get_by_role("button", name="Create token", exact=True).click()
        expect(self.page.get_by_role("heading", name="Copy your token now")).to_be_visible()
        raw = self.page.locator("#new-token").inner_text()
        identity = self.context.request.get(
            self.live_server_url + "/api/v1/me/", headers={"Authorization": "Bearer " + raw}
        )
        self.assertEqual(identity.status, 200)
        self.assertEqual(identity.json()["scopes"], ["propose"])
        self.page.goto(self.live_server_url + "/accounts/tokens/")
        expect(self.page.locator("#new-token")).to_have_count(0)
        self.page.get_by_role("button", name="Revoke Local assistant", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("Access token revoked")
        self.assertEqual(
            self.context.request.get(
                self.live_server_url + "/api/v1/me/", headers={"Authorization": "Bearer " + raw}
            ).status,
            401,
        )

    def test_subject_upload_cross_list_filter_and_mobile(self):
        self.login()
        self.page.goto(self.live_server_url + "/publish/")
        self.page.get_by_text("Cross-list subjects (optional)", exact=True).click()
        self.page.get_by_label("Find a cross-list subject").fill("hep-th")
        expect(self.page.get_by_label("math.GR — Group Theory", exact=True)).not_to_be_visible()
        self.page.get_by_label("hep-th — High Energy Physics - Theory", exact=True).check()
        self.page.get_by_label("Find a cross-list subject").fill("unmatched-filter")
        expect(
            self.page.get_by_label("hep-th — High Energy Physics - Theory", exact=True)
        ).to_be_visible()
        self.upload()
        expect(
            self.page.get_by_role("link", name="math.NT — Number Theory · Primary")
        ).to_be_visible()
        expect(
            self.page.get_by_role("link", name="hep-th — High Energy Physics - Theory", exact=True)
        ).to_be_visible()
        self.page.get_by_label("Content license:", exact=True).select_option("CC-BY-4.0")
        self.page.get_by_label("I have authority to submit", exact=False).check()
        self.page.get_by_role("button", name="Publish paper", exact=True).click()
        expect(
            self.page.get_by_role("link", name="hep-th — High Energy Physics - Theory", exact=True)
        ).to_be_visible()
        self.page.get_by_role(
            "link", name="hep-th — High Energy Physics - Theory", exact=True
        ).click()
        expect(self.page.get_by_label("Subject", exact=True)).to_have_value("hep-th")
        expect(self.page.get_by_role("link", name="Browser paper", exact=True)).to_be_visible()
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.page.get_by_role("searchbox", name="Search papers", exact=True).fill("Ada")
        self.page.get_by_label("Sort by").select_option("rating")
        self.page.get_by_role("button", name="Search", exact=True).click()
        expect(self.page.get_by_label("Subject", exact=True)).to_have_value("hep-th")
        expect(self.page.get_by_role("link", name="Browser paper", exact=True)).to_be_visible()
        self.assert_no_page_overflow()
        self.page.get_by_label("Subject", exact=True).select_option("math.PR")
        self.page.get_by_role("button", name="Apply", exact=True).click()
        expect(self.page.get_by_role("heading", name="No papers found")).to_be_visible()

    @override_settings(
        GOOGLE_LOGIN_ENABLED=True,
        SOCIALACCOUNT_PROVIDERS={
            "google": {
                "APP": {
                    "client_id": "browser-test-client",
                    "secret": "browser-test-secret",
                    "key": "",
                },
                "SCOPE": ["openid", "email", "profile"],
                "OAUTH_PKCE_ENABLED": True,
            }
        },
    )
    def test_google_signin_button_privacy_and_account_settings(self):
        from urllib.parse import parse_qs

        # Intercept the first hop: Chromium does not route every hop in a redirected
        # request. Fetch only our POST, record its Location, and stop before Google.
        destinations = []

        def capture_google_redirect(route):
            response = route.fetch(max_redirects=0)
            self.assertEqual(response.status, 302)
            destinations.append(response.headers["location"])
            route.fulfill(
                status=200, content_type="text/html", body="<h1>Google test destination</h1>"
            )

        route_url = self.live_server_url + "/accounts/google/login/"
        self.context.route(route_url, capture_google_redirect)
        self.page.goto(self.live_server_url + "/accounts/login/")
        expect(self.page.get_by_role("button", name="Continue with Google")).to_be_visible()
        self.page.get_by_role("button", name="Continue with Google").click()
        expect(self.page.get_by_role("heading", name="Google test destination")).to_be_visible()
        self.context.unroute(route_url, capture_google_redirect)
        self.assertEqual(len(destinations), 1)
        self.assertEqual(urlsplit(destinations[0]).hostname, "accounts.google.com")
        query = parse_qs(urlsplit(destinations[0]).query)
        self.assertEqual(
            query["redirect_uri"], [self.live_server_url + "/accounts/google/login/callback/"]
        )
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(set(query["scope"][0].split()), {"openid", "email", "profile"})
        self.page.goto(
            self.live_server_url + "/accounts/google/login/callback/?state=wrong&code=invalid"
        )
        expect(
            self.page.get_by_role("heading", name="Sign-in could not be completed")
        ).to_be_visible()
        self.login("owner")
        self.page.get_by_role("link", name="Account", exact=True).click()
        expect(self.page.get_by_role("heading", name="Sign-in options")).to_be_visible()
        self.page.get_by_label("Confirm your password").fill("wrong-password")
        self.page.get_by_role("button", name="Connect Google").click()
        expect(
            self.page.get_by_text("Incorrect password. Google was not connected.")
        ).to_be_visible()
        self.page.goto(self.live_server_url + "/privacy/")
        expect(self.page.get_by_role("heading", name="Privacy", exact=True)).to_be_visible()
