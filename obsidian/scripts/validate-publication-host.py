"""Isolated Obsidian, synthetic loopback TLS, session-only synthetic account."""

from __future__ import annotations
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib, json, runpy, socket, ssl, subprocess, sys, tempfile, time
from pathlib import Path
from threading import Thread
from typing import Any
from uuid import UUID
from playwright.sync_api import Page, Locator, BrowserContext, sync_playwright

root = Path(__file__).resolve().parents[2]
app, package, evidence = (Path(arg).resolve() for arg in sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
base = runpy.run_path(str(root / "obsidian/scripts/validate-offline-host.py"))
raw = json.loads((root / "obsidian/tests/fixtures/manifests/v4.json").read_text())
requests: list[str] = []
posts: list[tuple[str, bytes]] = []
commits: dict[str, tuple[bytes, dict[str, Any]]] = {}
token = "synthetic-host-only-593c83"
username = "isolated-writer"
proposal_owner = username
proposal_status = "pending"


def digest(source: str) -> str:
    return hashlib.sha256(source.encode()).hexdigest()


def receipt(payload: dict[str, Any], ordinal: int) -> dict[str, Any]:
    row = deepcopy(raw)
    m = row["manifest"]
    m["submission_id"] = str(UUID(int=ordinal))
    if payload["paper_id"]:
        row.update(status="pending", pull_request=dict(id=str(UUID(int=99)), snapshot=ordinal - 1))
    for key in (
        "title",
        "authors",
        "abstract",
        "explanation",
        "primary_category",
        "secondary_categories",
        "license",
        "base_hash",
    ):
        m[key] = payload[key]
    m.update(
        contributor_name=username,
        markdown_sha256=digest(payload["markdown"]),
        bibliography_sha256=digest(payload["bibliography"]),
        chapters=[
            dict(id=c["id"], title=c["title"], markdown_sha256=digest(c["markdown"]))
            for c in payload["chapters"]
        ],
    )
    row.update(
        chapters=payload["chapters"],
        markdown=payload["markdown"],
        bibliography=payload["bibliography"],
        ai_assisted=payload["ai_assisted"],
    )
    row["hash"] = digest(json.dumps(m, sort_keys=True, ensure_ascii=False, separators=(",", ":")))
    row["snapshot_identifier"] = "240229." + row["hash"][:12]
    return row


class Handler(BaseHTTPRequestHandler):
    def log_message(self: Handler, format: str, *args: object) -> None:
        pass

    def reply(self: Handler, value: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self: Handler) -> None:
        requests.append(self.path)
        if self.path == "/api/v1/me/":
            if self.headers.get("Authorization") != "Bearer " + token:
                self.reply({"detail": "raw fixture request data"}, 401)
                return
            self.reply(
                dict(
                    username=username,
                    expires_at="2099-01-01T00:00:00Z",
                    scopes=["publish", "propose"],
                    agreement=dict(url="/agreement/", version="1", accepted=True),
                )
            )
        elif self.path == "/api/v1/licenses/":
            self.reply(dict(licenses=[dict(code="CC-BY-4.0", label="CC BY 4.0", url="/license/")]))
        elif self.path == "/api/v1/categories/":
            self.reply(dict(categories=[dict(code="math.AG", name="Algebraic Geometry")]))
        elif self.path == f"/api/v1/papers/{raw['manifest']['paper_id']}/" and commits:
            current = next(iter(commits.values()))[1]
            self.reply(
                dict(
                    paper_id=current["manifest"]["paper_id"],
                    paper_identifier=current["paper_identifier"],
                    current=current,
                )
            )
        elif self.path.endswith("/prs/"):
            last = list(commits.values())[-1][1]
            pr = last["pull_request"]
            self.reply(
                dict(
                    paper_id=raw["manifest"]["paper_id"],
                    next=None,
                    prs=[
                        dict(
                            id=pr["id"],
                            head_id=last["manifest"]["submission_id"],
                            head_hash=last["hash"],
                            contributor=proposal_owner,
                            status=proposal_status,
                        )
                    ]
                    if pr
                    else [],
                )
            )
        elif self.path.startswith("/api/v1/submissions/"):
            for _, row in commits.values():
                if self.path == f"/api/v1/submissions/{row['manifest']['submission_id']}/":
                    self.reply(row)
                    return
            self.reply({}, 404)
        else:
            self.reply({}, 500)

    def do_POST(self: Handler) -> None:
        assert self.path == "/api/v1/push/" and self.headers.get("Authorization") == "Bearer " + token
        body = self.rfile.read(int(self.headers["Content-Length"]))
        posts.append((self.headers["Idempotency-Key"], body))
        key = posts[-1][0]
        replay = key in commits
        if not replay:
            payload = json.loads(body)
            if payload.get("expected_head"):
                previous = list(commits.values())[-1][1]
                assert previous["hash"] == payload["expected_head"]
                previous["status"] = "superseded"
            commits[key] = (body, receipt(payload, len(commits) + 1))
        assert commits[key][0] == body
        if len(posts) == 1:
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
        else:
            self.reply(commits[key][1], 200 if replay else 201)


def modal(context: BrowserContext, title: str) -> Locator:
    for _ in range(130):
        for page in context.pages:
            form = page.locator(".modal").filter(has_text=title)
            if form.count() and form.is_visible():
                return form
        time.sleep(0.1)
    raise AssertionError(str([(p.url, p.locator("body").inner_text()[-850:]) for p in context.pages]))


def command(page: Page, name: str) -> None:
    assert page.evaluate(
        "/** @param {string} id @returns {boolean} */ id => app.commands.executeCommandById(id)",
        "peerpedia:" + name,
    )


with tempfile.TemporaryDirectory(prefix="r5-host-") as tmp:
    work = Path(tmp)
    cert, key = work / "cert.pem", work / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-keyout",
            str(key),
            "-out",
            str(cert),
        ],
        check=True,
        capture_output=True,
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    origin = f"https://127.0.0.1:{server.server_port}"
    Thread(target=server.serve_forever, daemon=True).start()
    vault, profile = work / "vault", work / "profile"
    fixture = work / "document.json"
    fixture.write_text(
        json.dumps(
            dict(
                title="Isolated host submission",
                authors="Test author",
                abstract="A synthetic paper.",
                primary_category="math.AG",
                secondary_categories=[],
                license="CC-BY-4.0",
                markdown="",
                chapters=[
                    dict(id="intro", title="Intro", markdown="# Intro\n\nOriginal text"),
                    dict(id="proof", title="Proof", markdown="# Proof\n\n" + r"$\frac{a}{b}$" + "\n\n```math {@eq:diagram}\n"
                         + r"\begin{tikzcd} A\arrow[r] & B\end{tikzcd}" + "\n```"),
                ],
                bibliography="",
            )
        )
    )
    base["prepare"](vault, profile, package, fixture)
    reserved_fixture = vault / "Reserved member"
    reserved_fixture.mkdir()
    (reserved_fixture / "paper.json").write_text(json.dumps(
        {"title":"Reserved fixture","authors":"Fixture","abstract":"Synthetic","bibliography":"notes/.PeerPedia/refs.yaml"}
    ))
    helper = vault / base["PLUGIN"] / "native/keychain"
    helper.rename(helper.with_name("original-keychain"))
    # A denied Security framework operation returns this exact helper response.
    helper.write_text("#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{\"ok\":false}'\n")
    helper.chmod(0o700)
    with (
        sync_playwright() as pw,
        base["isolated_host"](app, profile, work / "home", evidence / "host-process.log") as address,
    ):
        browser = pw.chromium.connect_over_cdp(address)
        context = browser.contexts[0]
        for _ in range(130):
            pages = [p for p in context.pages if p.url.endswith("/index.html")]
            if pages:
                break
            time.sleep(0.15)
        page = pages[0]
        page.bring_to_front()
        page.set_default_timeout(15000)
        page.wait_for_function("window.app?.workspace?.layoutReady")
        assert Path(page.evaluate("app.vault.adapter.getBasePath()")).resolve() == vault.resolve()
        page.evaluate("window.r5Https = require('node:https').request")
        chrome = base["offline"](page, context, vault / base["PLUGIN"] / "renderer")
        page.evaluate(
            """/** @param {{origin:string, ca:string}} config @returns {void} */ config => {
          window.blockedSiteAttempts = 0;
          require('node:https').request = /** @param {URL} url @param {object} options @param {Function} callback @returns {object} */ (url,options,callback) => {
            if (url.origin!==config.origin) { window.blockedSiteAttempts++; throw new Error("off-origin"); }
            return window.r5Https(url,{...options,ca:config.ca},callback);
          };
        }""",
            dict(origin=origin, ca=cert.read_text()),
        )
        trust = page.get_by_role("button", name="Trust author and enable plugins")
        if trust.is_visible():
            trust.click()
        page.evaluate("app.plugins.enablePluginAndSave('peerpedia')")
        base["open_source"](page, base["PROJECT"] + "/intro.md")
        command(page, "manage-paper")
        panel = page.locator(".peerpedia-project-panel")
        panel.get_by_role("button", name="Submit to Peerpedia").wait_for()
        assert not requests
        command(page, "connect-account")
        form = modal(context, "Connect Peerpedia account")
        form.get_by_label("Site URL").fill(origin)
        form.get_by_label("Access token").fill("invalid-synthetic-token")
        form.get_by_role("button", name="Connect and verify account").click()
        form.get_by_role("status").get_by_text(
            "Account verification failed (HTTP 401).", exact=True
        ).wait_for()
        assert "raw fixture request data" not in form.inner_text()
        form.page.screenshot(path=str(evidence / "account-error.png"))
        form.get_by_label("Access token").fill(token)
        form.get_by_role("button", name="Connect and verify account").click()
        form.get_by_text("The token is available for this session only.", exact=True).wait_for()
        form.get_by_text("Publishing agreement 1: Accepted", exact=True).wait_for()
        form.page.screenshot(path=str(evidence / "account.png"))
        helper.unlink()
        form.locator("input[type=password]").fill(token)
        form.get_by_role("button", name="Connect and verify account").click()
        form.get_by_text("The token is available for this session only.", exact=True).wait_for()
        print("PASS displayed session-only storage for a rejected helper operation and missing helper")
        form.page.keyboard.press("Escape")
        panel.get_by_role("button", name="Submit to Peerpedia").click()
        form = modal(context, "Submit to Peerpedia")
        form.get_by_label("Explanation").fill("Host confirmation")
        form.get_by_label("AI assisted").check()
        form.get_by_role("button", name="Preview submission").click()
        confirm = form.get_by_role("button", name="Confirm submission", exact=True)
        confirm.or_(form.get_by_role("alert")).wait_for(timeout=50_000)
        assert confirm.is_visible(), form.inner_text()
        form.get_by_text("Rendered manuscript", exact=True).click()
        assert form.locator("iframe").count() == 1, "Confirmation must use the themed manuscript reader"
        frame = form.frame_locator("iframe")
        frame.get_by_text("Original text", exact=True).wait_for()
        chapters = form.get_by_label("Manuscript chapter")
        chapters.select_option(label="Proof")
        equation = frame.locator(".katex-mathml").first
        equation.wait_for(state="attached")
        geometry = equation.evaluate("""/** @param {Element} node @returns {object} */ node => {
            const doc = node.ownerDocument, style = getComputedStyle(node);
            const tag = getComputedStyle(doc.querySelector('.bm-tikz-layout'));
            return {position:style.position, overflow:style.overflow,
              rule:getComputedStyle(doc.querySelector('.frac-line')).borderBottomWidth,
              grid:tag.gridTemplateColumns, svg:!!doc.querySelector('.bm-tikz-layout svg')};
        }""")
        assert geometry["position"] == "absolute" and geometry["overflow"] == "hidden", geometry
        assert geometry["rule"] != "0px" and len(geometry["grid"].split()) == 3 and geometry["svg"], geometry
        form.locator("iframe").screenshot(path=evidence / "confirmation-math.png")
        print("PASS themed confirmation fraction and tagged diagram", geometry, flush=True)
        chapters.select_option(label="Intro")
        manuscript = vault / base["PROJECT"] / "intro.md"

        def edit(body: str) -> None:
            page.evaluate(
                "/** @param {string} s @returns {void} */ s => window.sourceLeaf.view.editor.setValue(s)",
                body,
            )
            for _ in range(120):
                if manuscript.read_text() == body:
                    return
                time.sleep(0.1)
            raise AssertionError("autosave")

        edit("# Intro\n\nConfirmed host edit")
        frame.get_by_text("Original text", exact=True).wait_for()
        confirm.click()
        form.get_by_text("The manuscript changed.", exact=False).wait_for()
        assert not posts
        form.page.screenshot(path=str(evidence / "confirm.png"))
        confirm.click()
        form.get_by_role("alert").wait_for()
        assert len(posts) == 1 and len(commits) == 1
        first = json.loads(posts[0][1])
        assert "Confirmed host edit" in first["markdown"] and first["ai_assisted"]
        form.page.keyboard.press("Escape")
        panel.get_by_role("button", name="Review pending submission").wait_for()
        edit("# Intro\n\nUnsubmitted later edit")
        panel.get_by_role("button", name="Review pending submission").click()
        form = modal(context, "Submit to Peerpedia")
        form.get_by_role("button", name="Retry saved submission").wait_for()
        assert "Unsubmitted later edit" not in form.inner_text()
        form.page.screenshot(path=str(evidence / "retry.png"))
        form.get_by_role("button", name="Retry saved submission").click()
        form.get_by_text("The site confirmed your submission.", exact=False).wait_for()
        assert (
            len(commits) == 1
            and len(posts) == 2
            and posts[0] == posts[1]
            and "Unsubmitted later edit" in manuscript.read_text()
        )
        state = manuscript.parent / ".peerpedia-obsidian"
        record = json.loads((state / "binding.json").read_text())["binding"]
        assert record["origin"] == origin and record["acceptedBase"]["hash"] == receipt(first, 1)["hash"]
        assert not (state / "submit-pending.json").exists()
        assert all(token.encode() not in f.read_bytes() for f in state.rglob("*") if f.is_file())
        assert not chrome and page.evaluate("window.pluginNodeRequests === 0 && window.blockedSiteAttempts === 0")
        print(
            "PASS Obsidian submit + changed revision requires a second confirmation; 2 identical POSTs, 1 snapshot; native later edit retained"
        )
        print(
            "GET",
            requests,
            "POST digest",
            digest(posts[0][1].decode()),
            "render starts",
            page.evaluate("window.packageRendererStarts"),
        )
        form.page.keyboard.press("Escape")
        retained_edit = manuscript.read_text()
        panel.get_by_text("Local files: Changed", exact=True).wait_for()
        edit(first["chapters"][0]["markdown"])
        panel.get_by_text("Local files: Match the working version", exact=True).wait_for()
        form.page.screenshot(path=evidence / "working-match.png")
        proof = manuscript.with_name("proof.md")
        proof.rename(proof.with_suffix(".held"))
        panel.get_by_text("Local files: Unavailable (source file missing)", exact=True).wait_for()
        panel.get_by_text("Source file missing", exact=True).wait_for()
        proof.with_suffix(".held").rename(proof)
        panel.get_by_text("Local files: Match the working version", exact=True).wait_for()
        print("PASS custom source paths match the working snapshot; missing member remains actionable")
        edit(retained_edit)
        panel.get_by_text("Local files: Changed", exact=True).wait_for()
        for intent in ("Create a new proposal", "Add a snapshot to the open proposal"):
            panel.get_by_role("button", name="Submit to Peerpedia").click()
            form = modal(context, "Submit to Peerpedia")
            select = form.get_by_label("Submission type")
            select.wait_for()
            assert select.locator("option:checked").inner_text() == intent
            if intent == "Create a new proposal":
                post_count = len(posts)
                form.get_by_role("button", name="Preview submission").click()
                form.get_by_role("alert").filter(has_text="Enter an explanation").wait_for()
                assert len(posts) == post_count
                form.get_by_role("button", name="Review again").click()
            form.get_by_label("Explanation").fill(intent)
            form.get_by_role("button", name="Preview submission").click()
            confirm = form.get_by_role("button", name="Confirm submission", exact=True)
            confirm.wait_for()
            text = form.text_content() or ""
            assert token not in text and not any(key in text for key, _ in posts)
            assert not any(
                field in text for field in ("payloadJson", "base_hash", "expected_head", "paper_id")
            )
            if intent == "Create a new proposal":
                confirm.click()
                form.get_by_text("The site confirmed your submission.", exact=False).wait_for()
                form.page.keyboard.press("Escape")
                edit("# Intro\n\nUpdated chapter for the proposal.")
                continue
            diff = form.get_by_text("Changes from the previous version", exact=True).locator("..")
            diff.locator("summary").first.click()
            chapter_diff = diff.locator("details").first
            chapter_diff.locator("summary").first.click()
            before_after = chapter_diff.inner_text()
            assert (
                "Unsubmitted later edit" in before_after
                and "Updated chapter for the proposal." in before_after
            )
            form.page.screenshot(path=str(evidence / "append-review.png"))
            expected_head = list(commits.values())[-1][1]["hash"]
            assert '"markdown":' not in before_after and expected_head not in text, (
                "Review shows raw chapter JSON or a full predecessor hash"
            )
            assert (
                form.get_by_role("link", name="Open proposal on Peerpedia").get_attribute("href")
                == origin + "/prs/" + str(UUID(int=99)) + "/"
            )
            assert token not in text and "Confirmed host edit" not in before_after
            confirm.click()
            form.get_by_text("The site confirmed your submission.", exact=False).wait_for()
            assert json.loads(posts[-1][1])["expected_head"] == expected_head
            assert list(commits.values())[-1][1]["pull_request"]["snapshot"] == 2
            print(
                "PASS human-readable chapter changes and proposal snapshot; exact predecessor sent only with confirmed append"
            )
        form.page.keyboard.press("Escape")
        for proposal_owner, proposal_status, reason in [
            ("different-writer", "pending", "belongs to different-writer"),
            (username, "withdrawn", "is withdrawn"),
        ]:
            panel.get_by_role("button", name="Submit to Peerpedia").click()
            form = modal(context, "Submit to Peerpedia")
            form.get_by_text(reason, exact=False).wait_for()
            assert form.get_by_label("Submission type").locator("option:checked").inner_text() == "Create a new proposal"
            form.page.screenshot(path=evidence / ("proposal-" + proposal_status + ".png"))
            form.page.keyboard.press("Escape")
        print("PASS closed and other-owned proposal explanations")
        proposal_owner, proposal_status = username, "pending"
        old = list(commits.values())[1][1]
        request_count = len(requests)
        panel.get_by_role("button", name="Import from Peerpedia").click()
        form = modal(context, "Import paper from Peerpedia")
        form.get_by_label("Site URL").fill(origin)
        form.get_by_label("Paper, snapshot, or version reading link").fill(origin + "/submissions/" + old["manifest"]["submission_id"] + "/")
        form.get_by_label("New folder in the vault", exact=False).fill("Historical")
        assert len(requests) == request_count
        form.get_by_role("button", name="Import paper", exact=True).click()
        form.wait_for(state="hidden")
        panel.get_by_text("Local files: Match the working version", exact=True).wait_for()
        history = vault / "Historical/.peerpedia-obsidian"
        saved = json.loads((history / "binding.json").read_text())["binding"]
        assert saved["workingBase"]["hash"] == old["hash"] and saved["activePr"] is None
        assert saved["proposalSource"]["id"] == old["pull_request"]["id"] and saved["proposalSource"]["number"] == 1
        panel.get_by_role("button", name="Check remote version").click()
        panel.get_by_text("Linked proposal: pending", exact=True).wait_for()
        panel.get_by_text("The linked proposal has a snapshot that has not been merged.", exact=True).wait_for()
        tip = json.loads((history / "binding-history/1.json").read_text())
        assert "binding" not in tip and "checkedAt" in tip
        assert len(requests) == request_count + 4
        page.screenshot(path=evidence / "historical-proposal.png")
        print("PASS historical import retained snapshot 1; manual check observed snapshot 2 and wrote only its timestamp")
        page.bring_to_front()
        base["open_source"](page, "Historical/chapters/intro.md")
        page.evaluate("""/** @returns {void} */ () => {
            const editor = window.sourceLeaf.view.editor;
            editor.setValue("# Native completion\\n\\n:::");
            editor.setCursor(editor.offsetToPos(editor.getValue().length));
            editor.focus();
        }""")
        page.keyboard.press("Control+Space")
        for _ in range(100):
            choices = [tab.get_by_text("::: theorem", exact=True) for tab in context.pages
                       if tab.get_by_text("::: theorem", exact=True).is_visible()]
            if choices:
                break
            time.sleep(0.1)
        assert choices, [(tab.url, tab.locator("body").inner_text()[-500:]) for tab in context.pages]
        suggestion = choices[0]
        suggestion.page.screenshot(path=evidence / "native-completion.png")
        suggestion.click()
        assert page.evaluate("sourceLeaf.view.editor.getValue().endsWith('::: theorem\\n\\n:::')")
        page.keyboard.press("Meta+z")
        assert page.evaluate("sourceLeaf.view.editor.getValue().endsWith(':::')")
        assert len(requests) == request_count + 4
        print("PASS native source-mode theorem completion, acceptance and one-step undo without a site request")
        panel.get_by_role("button", name="Open paper", exact=True).click()
        form = modal(context, "Open paper")
        form.get_by_label("Folder in the vault", exact=False).fill(reserved_fixture.name)
        form.get_by_role("button", name="Open", exact=True).click()
        panel.get_by_role("alert").filter(has_text="Unsafe project path").wait_for()
        page.screenshot(path=evidence / "reserved-member.png")
        assert len(requests) == request_count + 4
        print("PASS ordinary project open refused reserved membership using an absent synthetic path")
        assert not chrome and page.evaluate("window.pluginNodeRequests === 0 && window.blockedSiteAttempts === 0")
        print("PASS zero guarded Chromium, unexpected Node HTTP or off-origin HTTPS attempts")
    server.shutdown()
