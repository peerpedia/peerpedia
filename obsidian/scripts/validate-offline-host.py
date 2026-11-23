"""Verify the exact packaged plugin in a throwaway Obsidian vault and profile."""
from __future__ import annotations

from contextlib import contextmanager, suppress
from hashlib import sha256
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

from playwright.sync_api import BrowserContext, Page, Route, sync_playwright


PROJECT = "双章 论文"
PLUGIN = Path(".obsidian/plugins/peerpedia")
NETWORK_POLICY = "(version 1)(allow default)(deny network*)"
EDIT = "这是搬移之后的离线改稿。"


def prepare(vault: Path, profile: Path, package: Path, fixture: Path) -> None:
    paper = vault / PROJECT
    paper.mkdir(parents=True)
    profile.mkdir()
    (profile / "obsidian.json").write_text(json.dumps({
        "vaults": {"feedba9876543210": {"path": str(vault), "ts": int(time.time() * 1000), "open": True}},
    }))
    (profile / "feedba9876543210.json").write_text(json.dumps({"width": 1100, "height": 760}))
    source = json.loads(fixture.read_text())
    chapters = source.pop("chapters")
    source.pop("markdown")
    (paper / "references.yaml").write_text(source.pop("bibliography"))
    source["bibliography"] = "references.yaml"
    source["chapters"] = [{"id": c["id"], "title": c["title"], "file": c["id"] + ".md"} for c in chapters]
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
                host = subprocess.Popen([
                    str(app / "Contents/MacOS/Obsidian"),
                    f"--user-data-dir={profile}", "--remote-debugging-port=0", "--disable-background-networking",
                    "--use-mock-keychain",
                    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
                ], stdout=output, stderr=subprocess.STDOUT, env=env, start_new_session=True)
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
    page.evaluate("""/** @param {string} file @returns {Promise<void>} */ async file => {
        const leaf = window.sourceLeaf ?? app.workspace.getLeaf();
        window.sourceLeaf = leaf;
        await leaf.setViewState({type: 'markdown', state: {file, mode: 'source', source: true}});
        app.workspace.setActiveLeaf(leaf, {focus: true});
        leaf.view.editor.focus();
    }""", file)


def renderer_processes(runtime: Path) -> list[int]:
    """Identify only real renderer processes belonging to this temporary vault."""
    argv = str(runtime / "bin/node") + " " + str(runtime / "renderer.mjs")
    processes = subprocess.check_output(["/bin/ps", "-axww", "-o", "pid=,command="], text=True)
    return [int(line.split(maxsplit=1)[0]) for line in processes.splitlines() if line.strip().endswith(argv)]


def offline(page: Page, context: BrowserContext, runtime: Path) -> list[str]:
    # The macOS policy is applied to the actual bundled executable without replacing any package files.
    probe = subprocess.check_output([
        "/usr/bin/sandbox-exec", "-p", NETWORK_POLICY, str(runtime / "bin/node"), "-e",
        "const s = require('node:net').createServer();"
        "s.on('error', /** @param {Error & {code:string}} e @returns {void} */ e => console.log(e.code));"
        "s.listen(0, '127.0.0.1', /** @returns {void} */ () => process.exit(1));",
    ], text=True, timeout=5).strip()
    assert probe == "EPERM", probe
    page.evaluate("""/** @param {{node:string, policy:string}} options @returns {void} */ ({node, policy}) => {
        const child = require('node:child_process');
        const spawn = child.spawn;
        window.packageRendererStarts = 0;
        window.pluginNodeRequests = 0;
        for (const protocol of ['node:http', 'node:https']) {
            require(protocol).request = /** @param {...unknown} _args @returns {never} */ (..._args) => {
                ++window.pluginNodeRequests;
                throw new Error('Unexpected Node network request in offline journey');
            };
        }
        child.spawn = /** @param {string} file @param {string[]} args
          * @param {object} options @returns {import('node:child_process').ChildProcess} */ (file, args, options) => {
            if (file !== node) return spawn(file, args, options);
            ++window.packageRendererStarts;
            return spawn('/usr/bin/sandbox-exec', ['-p', policy, file, ...args], options);
        };
    }""", {"node": str(runtime / "bin/node"), "policy": NETWORK_POLICY})

    requests: list[str] = []

    def deny(route: Route) -> None:
        requests.append(route.request.url)
        route.abort()

    context.route("http://**/*", deny)
    context.route("https://**/*", deny)
    context.set_offline(True)
    assert page.evaluate("navigator.onLine") is False
    return requests


def verify(page: Page, context: BrowserContext, vault: Path, package: Path, evidence: Path) -> None:
    page.set_default_timeout(8000)
    page.bring_to_front()
    print("TEST WINDOW", page.title(), page.url, flush=True)
    page.wait_for_function("window.app?.workspace?.layoutReady", polling=100)
    assert Path(page.evaluate("app.vault.adapter.getBasePath()")).resolve() == vault.resolve()
    assert page.evaluate("!app.plugins.getPlugin('peerpedia')")
    installed = vault / PLUGIN
    manifest = json.loads((package / "package-manifest.json").read_text())
    for name, digest in manifest["sha256"].items():
        assert sha256((installed / name).read_bytes()).hexdigest() == digest, name
    runtime = installed / "renderer"
    requests = offline(page, context, runtime)
    trust = page.get_by_role("button", name="Trust author and enable plugins")
    if trust.is_visible():
        trust.click()
        trust.wait_for(state="hidden")
    page.evaluate("app.plugins.enablePluginAndSave('peerpedia')")
    page.wait_for_function("!!app.plugins.getPlugin('peerpedia')")
    assert page.evaluate("app.plugins.getPlugin('peerpedia').loadData()") is None
    assert page.evaluate("app.plugins.getPlugin('peerpedia').writingScope") == {"folders": {}, "files": {}}
    print("PASS first enable in a fresh vault and profile with no saved plugin settings", flush=True)

    intro = f"{PROJECT}/intro.md"
    proof = f"{PROJECT}/proof.md"
    page.evaluate("""/** @param {{folder:string, file:string}} options @returns {Promise<void>} */
        ({folder, file}) => app.plugins.getPlugin('peerpedia').updateWritingScope({
            folders: {[folder]: true}, files: {[file]: false},
        })""", {"folder": PROJECT, "file": proof})
    assert json.loads((installed / "data.json").read_text()) == {
        "writingScope": {"folders": {PROJECT: True}, "files": {proof: False}},
    }
    assert page.evaluate("app.commands.executeCommandById('peerpedia:connect-account')")
    modal = next(window.locator(".modal").filter(has_text="连接 Peerpedia 账号") for window in context.pages
                 if window.locator(".modal").filter(has_text="连接 Peerpedia 账号").count())
    assert modal.locator('input[type="url"]').input_value() == "https://peerpedia.dev"
    modal.locator('input[type="password"]').fill("synthetic-never-submitted")
    modal.locator(".modal-header-button").click()
    modal.wait_for(state="hidden")
    open_source(page, intro)
    page.evaluate("void (window.initialEditor = sourceLeaf.view.editor.cm)")
    assert page.evaluate("app.commands.executeCommandById('peerpedia:preview-paper')")
    preview = page.locator(".peerpedia-preview")
    status = preview.get_by_role("status")
    status.get_by_text("预览已更新", exact=True).wait_for(timeout=45_000)
    frame = next(frame for frame in page.frames if frame.url == "about:srcdoc")
    assert frame.locator("svg").count() == 1
    assert frame.locator(".katex").count()
    assert page.evaluate("sourceLeaf.view.editor.cm === window.initialEditor")
    frame.locator("a[data-preview-link='?chapter=proof#thm:second']").click()
    assert preview.get_by_role("combobox").input_value() == "proof"
    assert frame.locator("svg").count() == 1
    assert frame.locator("a[data-preview-link='?chapter=intro#thm:first']").count() == 1
    print("PASS moved package draws TikZ and KaTeX and resolves both chapter links", flush=True)

    open_source(page, proof)
    page.evaluate("""/** @returns {void} */ () => {
        const editor = sourceLeaf.view.editor;
        editor.setCursor(editor.offsetToPos(editor.getValue().length));
    }""")
    # Native keyboard input exercises the regular source edit, autosave and live preview paths.
    page.keyboard.insert_text("\n\n" + EDIT)
    frame.get_by_text(EDIT, exact=True).wait_for(timeout=45_000)
    status.get_by_text("预览已更新", exact=True).wait_for()
    for _ in range(80):
        if EDIT in (vault / proof).read_text():
            break
        page.wait_for_timeout(100)
    assert EDIT in (vault / proof).read_text()
    frame.evaluate("document.fonts.ready")
    fonts = frame.evaluate("""/** @returns {string[]} */ () =>
        [...document.fonts].filter(/** @param {FontFace} f @returns {boolean} */ f => f.status === 'loaded')
            .map(/** @param {FontFace} f @returns {string} */ f => f.family)""")
    assert any(font.startswith("KaTeX") for font in fonts), fonts
    assert any(font.startswith("tikzjax") for font in fonts), fonts
    assert renderer_processes(runtime)
    assert page.evaluate("window.packageRendererStarts") > 0
    print("PASS scope-disabled chapter still edits and autosaves offline; fonts", fonts, flush=True)
    page.screenshot(path=evidence / "task-8-relocated-preview.png")

    cursor = page.evaluate("sourceLeaf.view.editor.getCursor()")
    open_link = frame.locator("a[data-preview-link='?chapter=intro#thm:first']")
    open_link.click()
    assert preview.get_by_role("combobox").input_value() == "intro"
    frame.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    assert page.evaluate("sourceLeaf.view.file.path") == proof
    assert page.evaluate("sourceLeaf.view.editor.getCursor()") == cursor
    preview.get_by_role("button", name="定位源码", exact=True).click()
    page.wait_for_function("""/** @param {string} path @returns {boolean} */ path =>
        sourceLeaf.view.file.path === path""", arg=intro)
    print("PASS preview scroll leaves source alone, explicit location opens the other chapter", flush=True)

    open_source(page, proof)
    frame.get_by_text(EDIT, exact=True).wait_for()
    page.evaluate("void (window.goodSource = sourceLeaf.view.editor.getValue())")
    page.evaluate("sourceLeaf.view.editor.setValue(window.goodSource + '\\n\\n$\\\\badCommand$')")
    status.get_by_text("显示上次成功预览", exact=False).wait_for(timeout=45_000)
    assert frame.get_by_text(EDIT, exact=True).count() == 1
    assert preview.get_by_role("button", name="定位源码", exact=True).is_disabled()
    page.evaluate("sourceLeaf.view.editor.setValue(window.goodSource)")
    status.get_by_text("预览已更新", exact=True).wait_for(timeout=45_000)
    print("PASS invalid math kept the last good preview; correcting the source recovered it", flush=True)

    # Pause one fixture-only renderer during a new diagram request, keeping the packaged bytes intact.
    (paused,) = renderer_processes(runtime)
    os.kill(paused, signal.SIGSTOP)
    try:
        page.evaluate("sourceLeaf.view.editor.setValue(window.goodSource.replace('mathbb{R}', 'mathbb{C}'))")
        status.get_by_text("Rendering timed out after 40 seconds.", exact=False).wait_for(timeout=52_000)
        assert frame.locator("svg").count() == 1
        assert frame.get_by_text(EDIT, exact=True).count() == 1
        assert preview.get_by_role("button", name="定位源码", exact=True).is_disabled()
    finally:
        # The actual timeout normally already killed the stopped process.
        if paused in renderer_processes(runtime):
            os.kill(paused, signal.SIGCONT)
    recovered = "图形超时后继续离线改稿。"
    page.evaluate("""/** @param {string} text @returns {void} */ text =>
        sourceLeaf.view.editor.setValue(window.goodSource + '\\n\\n' + text)""", recovered)
    frame.get_by_text(recovered, exact=True).wait_for(timeout=45_000)
    status.get_by_text("预览已更新", exact=True).wait_for()
    assert renderer_processes(runtime) and paused not in renderer_processes(runtime)
    print("PASS controlled diagram stall timed out after 40 seconds, retained preview and restarted the renderer", flush=True)

    assert page.evaluate("window.pluginNodeRequests") == 0
    assert "synthetic-never-submitted" not in (installed / "data.json").read_text()
    print("PASS no Node HTTP(S) requests on enable, account dialog open/cancel, source editing or preview", flush=True)
    page.evaluate("app.plugins.disablePluginAndSave('peerpedia')")
    preview.wait_for(state="detached")
    assert not page.evaluate("app.commands.commands['peerpedia:preview-paper']")
    assert EDIT in page.evaluate("sourceLeaf.view.editor.getValue()")
    for _ in range(40):
        if not renderer_processes(runtime):
            break
        time.sleep(0.1)
    assert not renderer_processes(runtime), "Preview renderer survived plugin disable"
    enabled = vault / ".obsidian/community-plugins.json"
    for _ in range(80):
        if json.loads(enabled.read_text()) == []:
            break
        page.wait_for_timeout(100)
    assert json.loads(enabled.read_text()) == []
    shutil.rmtree(installed)
    assert not installed.exists()
    assert EDIT in (vault / proof).read_text() and (vault / PROJECT / "references.yaml").exists()
    print("PASS disable and remove package, leave source and bibliography intact", flush=True)
    assert not requests, requests
    print("PASS no HTTP(S) requests from enable, source edit, or preview", flush=True)
    print("HOST", page.title(), page.evaluate("require('node:process').versions.electron"),
          page.evaluate("require('node:process').versions.node"), platform_from_node(runtime, package), flush=True)


def platform_from_node(runtime: Path, package: Path) -> str:
    executable = runtime / "bin/node"
    if not executable.exists():
        executable = package / "renderer/bin/node"
    return subprocess.check_output([
        str(executable), "-p", "process.version + ' ' + process.platform + '-' + process.arch",
    ], env={"PATH": ""}, text=True, timeout=5).strip()


def main(app: Path, package: Path, fixture: Path, evidence: Path) -> None:
    evidence.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="p8-") as path:
        root = Path(path).resolve()
        vault = root / "独立 验收库"
        profile = root / "profile"
        prepare(vault, profile, package, fixture)
        with sync_playwright() as playwright:
            with isolated_host(app, profile, root / "home", evidence / "task-8-obsidian.log") as address:
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
                    print("WINDOW", pages[0].title(), pages[0].url, pages[0].locator("body").inner_text(timeout=3000), flush=True)
                    pages[0].screenshot(path=evidence / "task-8-host-failure.png", timeout=3000)
                    raise


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, exit_on_termination)
    main(*(Path(argument).resolve() for argument in sys.argv[1:]))
