"""Verify the exact packaged plugin in a throwaway Obsidian vault and profile."""

from __future__ import annotations

from contextlib import contextmanager, suppress
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from types import FrameType
from typing import Iterator, NoReturn

from playwright.sync_api import BrowserContext, Locator, Page, Route, expect, sync_playwright


PROJECT = "双章 论文"
PLUGIN = Path(".obsidian/plugins/peerpedia")
EDIT = "这是搬移之后的离线改稿。"


def prepare(vault: Path, profile: Path, package: Path, fixture: Path) -> None:
    paper = vault / PROJECT
    paper.mkdir(parents=True)
    profile.mkdir()
    (profile / "obsidian.json").write_text(
        json.dumps(
            {
                "vaults": {
                    "feedba9876543210": {
                        "path": str(vault),
                        "ts": int(time.time() * 1000),
                        "open": True,
                    }
                },
            }
        )
    )
    (profile / "feedba9876543210.json").write_text(json.dumps({"width": 1100, "height": 760}))
    source = json.loads(fixture.read_text())
    chapters = source.pop("chapters")
    source.pop("markdown")
    (paper / "references.yaml").write_text(source.pop("bibliography"))
    source["bibliography"] = "references.yaml"
    source["chapters"] = [
        {"id": c["id"], "title": c["title"], "file": c["id"] + ".md"} for c in chapters
    ]
    for chapter in chapters:
        (paper / (chapter["id"] + ".md")).write_bytes(chapter["markdown"].encode())
    (paper / "paper.json").write_text(json.dumps(source))
    (vault / ".obsidian").mkdir()
    (vault / ".obsidian/community-plugins.json").write_text("[]")
    (vault / ".obsidian/app.json").write_text('{"livePreview":false}')
    (vault / ".obsidian/core-plugins.json").write_text('{"sync":false,"publish":false}')
    shutil.copytree(package, vault / PLUGIN)


def exit_on_termination(signum: int, _frame: FrameType | None) -> NoReturn:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise SystemExit(128 + signum)


@contextmanager
def defer_termination() -> Iterator[None]:
    pending: int | None = None

    def defer(signum: int, _frame: FrameType | None) -> None:
        nonlocal pending
        pending = signum

    previous = signal.signal(signal.SIGTERM, defer)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)
        if pending is not None:
            exit_on_termination(pending, None)


def stop_host(host: subprocess.Popen[bytes]) -> None:
    with suppress(ProcessLookupError):
        os.killpg(host.pid, signal.SIGTERM)
    with suppress(subprocess.TimeoutExpired):
        host.wait(timeout=5)
    # A child can outlive the group leader or ignore SIGTERM.
    with suppress(ProcessLookupError):
        os.killpg(host.pid, signal.SIGKILL)
    host.wait(timeout=5)


@contextmanager
def isolated_host(app: Path, profile: Path, home: Path, log: Path) -> Iterator[str]:
    home.mkdir()
    env = dict(os.environ, HOME=str(home))

    with log.open("w") as output:
        host: subprocess.Popen[bytes] | None = None
        try:
            # Let Popen hand us the detached group before unwinding on SIGTERM.
            with defer_termination():
                host = subprocess.Popen(
                    [
                        str(app / "Contents/MacOS/Obsidian"),
                        f"--user-data-dir={profile}",
                        "--remote-debugging-port=0",
                        "--disable-background-networking",
                        "--use-mock-keychain",
                        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
                    ],
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    env=env,
                    start_new_session=True,
                )
            address = profile / "DevToolsActivePort"
            for _ in range(100):
                if host.poll() is not None:
                    raise RuntimeError(f"Isolated Obsidian exited. See {log}.")
                if address.exists():
                    yield "http://127.0.0.1:" + address.read_text().splitlines()[0]
                    return
                time.sleep(0.15)
            raise RuntimeError(f"Isolated Obsidian did not open its test interface. See {log}.")
        finally:
            if host is not None:
                with defer_termination():
                    stop_host(host)


def open_source(page: Page, file: str) -> None:
    page.evaluate(
        """/** @param {string} file @returns {Promise<void>} */ async file => {
        const leaf = window.sourceLeaf ?? app.workspace.getLeaf();
        window.sourceLeaf = leaf;
        await leaf.setViewState({type: 'markdown', state: {file, mode: 'source', source: true}});
        app.workspace.setActiveLeaf(leaf, {focus: true});
        leaf.view.editor.focus();
    }""",
        file,
    )


def offline(page: Page, context: BrowserContext, _runtime: Path) -> list[str]:
    page.evaluate("""/** @returns {void} */ () => {
        window.packageRendererStarts = 0;
        window.pluginNodeRequests = 0;
        for (const protocol of ['node:http', 'node:https']) {
            require(protocol).request = /** @param {...unknown} _args @returns {never} */ (..._args) => {
                ++window.pluginNodeRequests;
                throw new Error('Unexpected Node network request in offline journey');
            };
        }
        require('node:child_process').spawn = /** @param {...unknown} _args @returns {never} */ (..._args) => {
            ++window.packageRendererStarts;
            throw new Error('A community plugin must not start an external renderer');
        };
    }""")
    requests: list[str] = []

    def deny(route: Route) -> None:
        requests.append(route.request.url)
        route.abort()

    context.route("http://**/*", deny)
    context.route("https://**/*", deny)
    context.set_offline(True)
    assert page.evaluate("navigator.onLine") is False
    return requests


def bibliography_modal(context: BrowserContext, title: str) -> Locator:
    for _ in range(100):
        for page in context.pages:
            form = page.locator(".modal").filter(
                has=page.locator(".modal-title").get_by_text(title, exact=True)
            )
            if form.count() and form.is_visible():
                return form
        time.sleep(0.1)
    raise AssertionError(f"Bibliography dialog did not open: {title}")


def verify_bibliography(page: Page, context: BrowserContext, vault: Path, evidence: Path) -> None:
    assert page.evaluate("app.commands.executeCommandById('peerpedia:manage-paper')")
    page.get_by_role("button", name="References", exact=True).click()
    form = bibliography_modal(context, "References")
    expect(form.get_by_role("button")).to_have_count(2)
    expect(form.locator(".peerpedia-reference")).to_have_text("A BookAuthor, A · 2020@book")
    form.get_by_role("searchbox").fill("missing")
    expect(form.locator(".peerpedia-bibliography-list li")).to_be_hidden()
    form.get_by_role("searchbox").fill("book")
    expect(form.locator(".peerpedia-bibliography-list li")).to_be_visible()
    form.page.screenshot(path=str(evidence / "bibliography-list.png"))
    form.get_by_role("button", name="Edit YAML source", exact=True).click()
    source = bibliography_modal(context, "Edit references.yaml")
    path = vault / PROJECT / "references.yaml"
    original = path.read_bytes()
    draft = source.get_by_role("textbox", name="YAML source")
    draft.fill("book: [broken")
    source.get_by_role("button", name="Save source file").click()
    expect(source.get_by_role("alert")).to_contain_text("Unable to read bibliography YAML")
    expect(draft).to_have_value("book: [broken")
    assert path.read_bytes() == original
    added = original.decode() + "extra: {type: book, title: Added in source}\n"
    draft.fill(added)
    source.get_by_role("button", name="Save source file").click()
    source.wait_for(state="hidden")
    assert path.read_text() == added
    page.get_by_role("button", name="References", exact=True).click()
    form = bibliography_modal(context, "References")
    expect(form.locator(".peerpedia-bibliography-list li")).to_have_count(2)
    form.get_by_role("button", name="Rename citation key: book", exact=True).click()
    rename = bibliography_modal(context, "Rename @book")
    rename.get_by_role("textbox", name="New citation key").fill("renamed-book")
    rename.get_by_role("button", name="Find citations", exact=True).click()
    expect(rename.locator(".peerpedia-citation-impact")).to_contain_text("proof.md")
    rename.get_by_role("button", name="Confirm rename", exact=True).click()
    rename.wait_for(state="hidden")
    assert "renamed-book:" in path.read_text()
    assert "[@renamed-book]" in (vault / PROJECT / "proof.md").read_text()
    page.get_by_role("button", name="References", exact=True).click()
    form = bibliography_modal(context, "References")
    form.get_by_role("button", name="Edit YAML source", exact=True).click()
    source = bibliography_modal(context, "Edit references.yaml")
    removed = path.read_text().replace("extra: {type: book, title: Added in source}\n", "")
    source.get_by_role("textbox", name="YAML source").fill(removed)
    source.get_by_role("button", name="Save source file").click()
    source.wait_for(state="hidden")
    assert path.read_text() == removed
    print(
        "PASS bibliography source add/remove, validation, search and safe citation rename",
        flush=True,
    )


def verify(page: Page, context: BrowserContext, vault: Path, package: Path, evidence: Path) -> None:
    page.set_default_timeout(15000)
    page.bring_to_front()
    page.wait_for_function("window.app?.workspace?.layoutReady", polling=100)
    assert Path(page.evaluate("app.vault.adapter.getBasePath()")).resolve() == vault.resolve()
    installed = vault / PLUGIN
    assets = ["main.js", "manifest.json", "styles.css"]
    assert sorted(p.name for p in installed.iterdir()) == assets
    for name in assets:
        assert (installed / name).read_bytes() == (package / name).read_bytes()
    requests = offline(page, context, installed)
    trust = page.get_by_role("button", name="Trust author and enable plugins")
    if trust.is_visible():
        trust.click()
        trust.wait_for(state="hidden")
    baseline_workers = {worker.url for worker in page.workers}
    page.evaluate("app.plugins.enablePluginAndSave('peerpedia')")
    page.wait_for_function("!!app.plugins.getPlugin('peerpedia')")
    assert page.evaluate("app.plugins.getPlugin('peerpedia').loadData()") is None
    print("PASS first enable from exactly three files in a fresh vault", flush=True)

    page.evaluate("""/** @returns {void} */ () => {
        app.setting.open();
        app.setting.openTabById('peerpedia');
    }""")
    page.get_by_placeholder("Folder path (blank for vault root)").fill("writing-scope-probe")
    page.get_by_role("button", name="Add rule", exact=True).first.click()
    page.wait_for_function(
        "app.plugins.getPlugin('peerpedia').writingScope.folders['writing-scope-probe'] === true"
    )
    page.get_by_text("writing-scope-probe", exact=True).wait_for()
    page.screenshot(path=str(evidence / "community-settings.png"))
    page.evaluate("app.setting.close()")
    print("PASS searchable settings render and refresh after adding a folder rule", flush=True)

    intro = f"{PROJECT}/intro.md"
    proof = f"{PROJECT}/proof.md"
    page.evaluate(
        """/** @param {string} folder @returns {Promise<void>} */ folder =>
        app.plugins.getPlugin('peerpedia').updateWritingScope({folders:{[folder]:true},files:{}})
    """,
        PROJECT,
    )
    open_source(page, intro)
    page.evaluate("void (window.initialEditor = sourceLeaf.view.editor.cm)")
    assert page.evaluate("app.commands.executeCommandById('peerpedia:preview-paper')")
    preview = page.locator(".peerpedia-preview")
    status = preview.get_by_role("status")
    status.get_by_text("Preview updated", exact=True).wait_for(timeout=45000)
    frame = next(frame for frame in page.frames if frame.url == "about:srcdoc")
    assert frame.locator("svg").count() == 1
    assert frame.locator(".katex").count()
    assert page.evaluate("sourceLeaf.view.editor.cm === window.initialEditor")
    frame.locator("a[data-preview-link='?chapter=proof#thm:second']").click()
    assert preview.get_by_role("combobox").input_value() == "proof"
    assert frame.locator("svg").count() == 1
    assert frame.locator("a[data-preview-link='?chapter=intro#thm:first']").count() == 1
    print("PASS shared book rendering, TikZ, KaTeX and cross-chapter links", flush=True)

    open_source(page, proof)
    page.evaluate("""/** @returns {void} */ () => {
        const editor=sourceLeaf.view.editor;
        editor.setCursor(editor.offsetToPos(editor.getValue().length));
    }""")
    page.keyboard.insert_text("\n\n" + EDIT)
    frame.get_by_text(EDIT, exact=True).wait_for(timeout=45000)
    status.get_by_text("Preview updated", exact=True).wait_for()
    for _ in range(80):
        if EDIT in (vault / proof).read_text():
            break
        page.wait_for_timeout(100)
    assert EDIT in (vault / proof).read_text()
    frame.evaluate("document.fonts.ready")
    fonts = frame.evaluate("""/** @returns {boolean} */ () =>
        document.fonts.check('16px KaTeX_Main') && document.fonts.check('16px tikzjax-cmmi10')""")
    assert fonts
    page.screenshot(path=str(evidence / "community-preview.png"))
    assert not requests, requests
    assert page.evaluate("window.pluginNodeRequests") == 0
    assert page.evaluate("window.packageRendererStarts") == 0
    print("PASS no HTTP(S) requests from enable, source edit, or preview", flush=True)

    verify_bibliography(page, context, vault, evidence)
    assert not requests, requests

    before = {
        path.name: path.read_bytes() for path in (vault / PROJECT).iterdir() if path.is_file()
    }
    page.evaluate("app.plugins.disablePlugin('peerpedia')")
    for _ in range(80):
        if not ({worker.url for worker in page.workers} - baseline_workers):
            break
        page.wait_for_timeout(100)
    assert not ({worker.url for worker in page.workers} - baseline_workers), (
        "Plugin workers survived unload"
    )
    assert before == {
        path.name: path.read_bytes() for path in (vault / PROJECT).iterdir() if path.is_file()
    }
    print("PASS unload releases workers and preserves manuscript files", flush=True)

    # Additional capabilities are tested in this disposable profile only.
    repository = Path(__file__).resolve().parents[2]
    probe = evidence / "host-probe.js"
    subprocess.run(
        [
            str(repository / "obsidian/node_modules/.bin/esbuild"),
            str(repository / "obsidian/scripts/host-file-probe.ts"),
            "--bundle",
            "--platform=node",
            "--format=iife",
            "--global-name=PeerpediaHostProbe",
            f"--outfile={probe}",
        ],
        check=True,
        capture_output=True,
    )
    page.add_script_tag(content=probe.read_text())
    capabilities = page.evaluate(
        """/** @param {string} root @returns {Promise<object>} */ root =>
        PeerpediaHostProbe.probeHost(app,root)""",
        str(vault),
    )
    assert capabilities["normalWrite"] and capabilities["staleReadRejected"], capabilities
    assert capabilities["hostSecretRoundTrip"] and capabilities["hostSecretRemoved"], capabilities
    assert capabilities["credentialPersistence"] == "secret-storage", capabilities
    (evidence / "host-api-comparison.json").write_text(json.dumps(capabilities, indent=2))
    (evidence / "community-result.json").write_text(
        json.dumps(
            {
                "complete": True,
                "threeFiles": True,
                "offline": True,
                "nativeEditorPreserved": True,
                "embeddedFonts": True,
                "pluginWorkersAfterUnload": 0,
                "externalRendererStarts": 0,
                "capabilities": capabilities,
            },
            indent=2,
        )
    )
    print("PASS official secret storage and host file API comparison", flush=True)


def main(app: Path, package: Path, fixture: Path, evidence: Path) -> None:
    evidence.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="p8-") as path:
        root = Path(path).resolve()
        vault = root / "独立 验收库"
        profile = root / "profile"
        prepare(vault, profile, package, fixture)
        with sync_playwright() as playwright:
            with isolated_host(
                app, profile, root / "home", evidence / "task-8-obsidian.log"
            ) as address:
                browser = playwright.chromium.connect_over_cdp(address, timeout=15_000)
                context = browser.contexts[0]
                for _ in range(100):
                    pages = [page for page in context.pages if page.url.endswith("/index.html")]
                    if pages:
                        break
                    time.sleep(0.15)
                if not pages:
                    raise RuntimeError("No Obsidian vault window appeared.")
                try:
                    verify(pages[0], context, vault, package, evidence)
                except Exception:
                    print(
                        "WINDOW",
                        pages[0].title(),
                        pages[0].url,
                        pages[0].locator("body").inner_text(timeout=3000),
                        flush=True,
                    )
                    pages[0].screenshot(path=evidence / "task-8-host-failure.png", timeout=3000)
                    raise


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, exit_on_termination)
    main(*(Path(argument).resolve() for argument in sys.argv[1:]))
