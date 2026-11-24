"""Exercise only the three release assets in a disposable Obsidian profile."""

from pathlib import Path
from tempfile import TemporaryDirectory
import json
import runpy
import shutil
from time import perf_counter, sleep
from playwright.sync_api import ConsoleMessage, Error, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".preview/official-channel"
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "prototype-result.json").unlink(missing_ok=True)
helpers = runpy.run_path(str(ROOT / "obsidian/scripts/validate-offline-host.py"))
fixture = json.loads((ROOT / "obsidian/tests/fixtures/render-paper.json").read_text())
input_document = {
    "pages": fixture["chapters"],
    "bibliography": fixture["bibliography"],
    "diagrams": True,
    "staticUrl": "./",
}
with TemporaryDirectory(prefix="peerpedia-three-files-") as directory:
    home = Path(directory).resolve()
    vault, profile = home / "vault", home / "profile"
    vault.mkdir()
    profile.mkdir()
    plugin = vault / ".obsidian/plugins/peerpedia-community-prototype"
    plugin.mkdir(parents=True)
    for name in ("main.js", "manifest.json", "styles.css"):
        shutil.copyfile(ROOT / "obsidian/prototype/dist/plugin" / name, plugin / name)
    assert sorted(p.name for p in plugin.iterdir()) == ["main.js", "manifest.json", "styles.css"]
    (vault / ".obsidian/community-plugins.json").write_text("[]")
    (profile / "obsidian.json").write_text(
        json.dumps({"vaults": {"aabbccddeeff0011": {"path": str(vault), "ts": 1, "open": True}}})
    )
    with helpers["isolated_host"](
        Path("/Applications/Obsidian.app"), profile, home / "home", OUT / "prototype-host.log"
    ) as address:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(address)
            context = browser.contexts[0]
            for _ in range(100):
                pages = [item for item in context.pages if item.url.endswith("/index.html")]
                if pages:
                    break
                sleep(0.15)
            if not pages:
                raise RuntimeError("No vault window")
            page = pages[0]
            page.wait_for_function(
                'typeof app !== "undefined" && app?.workspace?.layoutReady', timeout=25000
            )
            requests: list[str] = []

            def deny(route: Route) -> None:
                requests.append(route.request.url)
                route.abort()

            context.route("http://**/*", deny)
            context.route("https://**/*", deny)
            context.set_offline(True)
            errors: list[str] = []

            def on_page_error(error: Error) -> None:
                errors.append(str(error))

            page.on("pageerror", on_page_error)

            def on_console(message: ConsoleMessage) -> None:
                if message.type == "error":
                    print("CONSOLE", message.text, flush=True)

            page.on("console", on_console)
            trust = page.get_by_role("button", name="Trust author and enable plugins")
            if trust.is_visible():
                trust.click()
                trust.wait_for(state="hidden")
            page.evaluate(
                """/** @returns {Promise<void>} */ async () => {await app.plugins.loadManifests();await app.plugins.enablePluginAndSave('peerpedia-community-prototype');}"""
            )
            page.wait_for_function(
                "app.plugins.plugins['peerpedia-community-prototype'] !== undefined", timeout=10000
            )
            baseline_workers = {worker.url for worker in page.workers}
            start = perf_counter()
            result = page.evaluate(
                """/** @param {object} input @returns {Promise<object>} */ async input => await app.plugins.plugins['peerpedia-community-prototype'].render(input)""",
                input_document,
            )
            (OUT / "prototype-render.json").write_text(json.dumps(result))
            elapsed = perf_counter() - start
            for item in result["pages"]:
                assert "<svg" in item["html"], item["id"]
                assert "bm-tikz-source" not in item["html"], item["id"]
            assert "Theorem 1.1" in result["pages"][0]["html"]
            assert "Theorem 2.1" in result["pages"][1]["html"]
            assert "?chapter=proof#thm:second" in result["pages"][0]["html"]
            assert "Author 2020" in result["pages"][1]["html"]
            invalid = {
                "source": r"""```tikz
\begin{tikzpicture}\badCommand\end{tikzpicture}
```""",
                "diagrams": True,
            }
            error = page.evaluate(
                """/** @param {object} input @returns {Promise<string>} */ async input => {try {await app.plugins.plugins['peerpedia-community-prototype'].render(input);return '';}catch(error){return String(error);}}""",
                invalid,
            )
            assert "Undefined control sequence" in error, error
            loop = {
                "source": r"""```tikz
\begin{tikzpicture}\loop\iftrue\repeat\end{tikzpicture}
```""",
                "diagrams": True,
            }
            timeout_start = perf_counter()
            timeout_error = page.evaluate(
                """/** @param {object} input @returns {Promise<string>} */ async input => {try {await app.plugins.plugins['peerpedia-community-prototype'].render(input);return '';}catch(error){return String(error);}}""",
                loop,
            )
            timeout_elapsed = perf_counter() - timeout_start
            assert "took more than 8 s" in timeout_error, timeout_error
            assert 7 <= timeout_elapsed <= 16, timeout_elapsed
            changed = json.loads(json.dumps(input_document))
            changed["pages"][0]["markdown"] = changed["pages"][0]["markdown"].replace(
                "circle (1)", "circle (1.1)"
            )
            recovered = page.evaluate(
                """/** @param {object} input @returns {Promise<object>} */ async input => await app.plugins.plugins['peerpedia-community-prototype'].render(input)""",
                changed,
            )
            assert "<svg" in recovered["pages"][0]["html"]
            page.evaluate(
                """/** @param {object} input @returns {Promise<object>} */ async input => await app.plugins.plugins['peerpedia-community-prototype'].render(input)""",
                input_document,
            )
            safe = page.evaluate(
                """/** @returns {Promise<object>} */ async () => await app.plugins.plugins['peerpedia-community-prototype'].safeWriteProbe()"""
            )
            assert safe == {
                "a": "replacement",
                "b": "original",
                "lateWrite": "late external",
                "directoryReplacementRejected": True,
            }, safe
            page.evaluate(
                """/** @returns {Promise<void>} */ async () => await app.plugins.plugins['peerpedia-community-prototype'].show()"""
            )
            frame = page.frame_locator("iframe.peerpedia-prototype-frame")
            frame.locator("article svg").first.wait_for()
            page.screenshot(path=str(OUT / "prototype-preview.png"))
            fonts = frame.locator("body").evaluate(
                """/** @param {HTMLElement} body @returns {Promise<boolean>} */ async body => {await body.ownerDocument.fonts.ready;return body.ownerDocument.fonts.check('16px KaTeX_Main')&&body.ownerDocument.fonts.check('16px tikzjax-cmmi10');}"""
            )
            assert fonts
            assert not errors, errors
            secrets = page.evaluate(
                """/** @returns {boolean} */ () => {app.secretStorage.setSecret('peerpedia-prototype-dummy','disposable-value');return app.secretStorage.getSecret('peerpedia-prototype-dummy')==='disposable-value';}"""
            )
            assert secrets
            assert not requests, requests
            summary = {
                "invalidTikzRejected": True,
                "timeoutSeconds": round(timeout_elapsed, 3),
                "recoveredAfterTimeout": True,
                "secretStorageRoundTrip": secrets,
                "embeddedFontsLoaded": fonts,
                "networkRequests": requests,
                "threeFiles": True,
                "offlineBrowser": True,
                "elapsedSeconds": round(elapsed, 3),
                "pages": len(result["pages"]),
                "safeWriteSwap": safe,
                "pageErrors": errors,
            }
            (OUT / "prototype-result.json").write_text(json.dumps(summary, indent=2))
            print(json.dumps(summary, indent=2))
            page.evaluate(
                """/** @returns {Promise<void>} */ async () => await app.plugins.disablePlugin('peerpedia-community-prototype')"""
            )
            for _ in range(50):
                if not ({worker.url for worker in page.workers} - baseline_workers):
                    break
                sleep(0.1)
            print(
                "BASELINE_WORKERS",
                baseline_workers,
                "AFTER_UNLOAD",
                [worker.url for worker in page.workers],
                flush=True,
            )
            remaining = {worker.url for worker in page.workers} - baseline_workers
            assert not remaining, "Prototype workers survived unload"
            summary["prototypeWorkersAfterUnload"] = len(remaining)
            summary["hostWorkersRetained"] = len(page.workers)
            summary["complete"] = True
            (OUT / "prototype-result.json").write_text(json.dumps(summary, indent=2))
            browser.close()
