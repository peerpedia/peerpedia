"""Run native external-save, restart, formal preview and project-error regressions in a disposable vault."""
from __future__ import annotations

from contextlib import contextmanager
from hashlib import sha256
from importlib import import_module
import json
from pathlib import Path
import signal
import sys
from tempfile import TemporaryDirectory
import time
from typing import Any, Iterator

from playwright.sync_api import Page, Playwright, sync_playwright

host = import_module("validate-offline-host")
PROJECT = host.PROJECT


@contextmanager
def window(playwright: Playwright, app: Path, profile: Path, vault: Path, scratch: Path, log: Path) -> Iterator[Page]:
    (profile / "DevToolsActivePort").unlink(missing_ok=True)
    with host.isolated_host(app, profile, scratch, log) as address:
        ctx = playwright.chromium.connect_over_cdp(address).contexts[0]
        for _ in range(120):
            pages = [candidate for candidate in ctx.pages if candidate.url.endswith("index.html")]
            if pages:
                break
            time.sleep(0.1)
        page = pages[0]
        page.set_default_timeout(12000)
        page.wait_for_function("window.app?.workspace?.layoutReady")
        assert Path(page.evaluate("app.vault.adapter.getBasePath()")).resolve() == vault
        requests = host.offline(page, ctx, vault / host.PLUGIN / "renderer")
        trust = page.get_by_role("button", name="Trust author and enable plugins")
        if trust.is_visible():
            trust.click()
        page.evaluate("app.plugins.enablePluginAndSave('peerpedia')")
        page.wait_for_function("!!app.plugins.getPlugin('peerpedia')?.projectStore")
        for auxiliary in ctx.pages:
            if auxiliary != page and auxiliary.url == "about:blank":
                auxiliary.close()
        page.bring_to_front()
        yield page
        assert not requests, requests


def records(page: Page) -> list[dict[str, Any]]:
    return page.evaluate("""/** @param {string} root @returns {Promise<object[]>} */ async root => {
        const store = app.plugins.getPlugin('peerpedia').projectStore;
        const result = [];
        for (const record of await store.recovery(root)) result.push(await store.recoveryFiles(root, record.transactionId));
        return result.flat();
    }""", PROJECT)


def overlap(page: Page, vault: Path, chapter: str, base: str, member: bool = True) -> None:
    path = vault / PROJECT / chapter
    host.open_source(page, PROJECT + "/" + chapter)
    page.wait_for_function("/** @param {string} s @returns {boolean} */ s => sourceLeaf.view.editor.getValue() === s", arg=base)
    page.evaluate("""/** @returns {void} */ () => {
        const editor = sourceLeaf.view.editor;
        editor.setSelection({line: 0, ch: 0}, editor.offsetToPos(editor.getValue().length));
        editor.focus();
    }""")
    local, external = "LOCAL " + chapter, "EXTERNAL " + chapter
    page.keyboard.insert_text("LOCAL ")
    page.keyboard.insert_text(chapter)
    assert page.evaluate("[sourceLeaf.view.editor.getValue(), sourceLeaf.view.data, sourceLeaf.view.dirty]") == [local, base, True]
    assert path.read_text() == base
    path.write_text(external)
    if member:
        action = page.get_by_role("button", name="Review versions", exact=True).last
        action.wait_for(timeout=6000)
        action.click()
        modal = page.locator(".modal").last
        modal.locator("pre").first.wait_for(state="attached")
        texts = modal.locator("pre").all_text_contents()
        assert {base, local, external} <= set(texts), texts
        page.keyboard.press("Escape")
        print("PASS native divergence", chapter, repr(base), repr(local), repr(external), flush=True)
    page.wait_for_timeout(2500)


def errors(page: Page, vault: Path) -> None:
    for folder, detail in [("invalid", "unexpected_field"), ("nested", "child/paper.json")]:
        directory = vault / folder
        before = {p.relative_to(directory): p.read_bytes() for p in directory.rglob("*") if p.is_file()}
        page.evaluate("""/** @param {string} root @returns {Promise<void>} */ async root => {
            await app.workspace.getLeavesOfType('peerpedia-project')[0].view.selectRoot(root);
        }""", folder)
        panel = page.locator(".peerpedia-project-panel")
        assert detail in panel.get_by_role("alert").inner_text()
        assert panel.get_by_role("button", name="Open paper.json").is_visible()
        assert {p.relative_to(directory): p.read_bytes() for p in directory.rglob("*") if p.is_file()} == before
        print("PASS project error", panel.get_by_role("alert").inner_text(), flush=True)


def preview(page: Page, vault: Path) -> None:
    article = "## Original {@sec:old .red}*\n\n" + r"$\boxed{x}$" + "\n\n" + r"$$\begin{array}{|c|c|}\hline a&b\\\hline\end{array}$$" + "\n\n" + (
        "\x60\x60\x60math {@eq:diagram}\n" + r"\begin{tikzcd} A\arrow[r] & B\end{tikzcd}" + "\n\x60\x60\x60\n")
    (vault / PROJECT / "intro.md").write_text(article)
    (vault / PROJECT / "proof.md").write_text("# Proof\n\nSee @sec:old.")
    host.open_source(page, PROJECT + "/intro.md")
    page.wait_for_function("/** @param {string} text @returns {boolean} */ text => sourceLeaf.view.editor.getValue() === text", arg=article)
    assert page.evaluate("app.commands.executeCommandById('peerpedia:manage-paper')")
    panel = page.locator(".peerpedia-project-panel")
    panel.get_by_role("button", name="Rename chapter").first.click()
    form = page.locator(".modal").last
    form.get_by_label("Chapter title", exact=True).fill("Revised")
    form.get_by_role("button", name="Preview source changes").click()
    assert form.locator("pre").last.inner_text() == "## Revised {@sec:old .red}*"
    form.get_by_role("button", name="Confirm source changes").click()
    form.wait_for(state="hidden")
    assert (vault / PROJECT / "intro.md").read_text() == article.replace("Original", "Revised")
    host.open_source(page, PROJECT + "/intro.md")
    assert page.evaluate("app.commands.executeCommandById('peerpedia:preview-paper')")
    reading = page.locator(".peerpedia-preview")
    reading.get_by_role("status").get_by_text("Preview updated", exact=True).wait_for(timeout=45000)
    frame = next(f for f in page.frames if f.url == "about:srcdoc")
    assert "Revised" in frame.locator("h2").first.inner_text()
    geometry = frame.evaluate("""/** @returns {object} */ () => {
        const box = getComputedStyle(document.querySelector('.fbox'));
        const line = getComputedStyle(document.querySelector('.vertical-separator'));
        const tag = getComputedStyle(document.querySelector('.bm-tikz-layout'));
        return {box:box.borderTopStyle, width:box.borderTopWidth, line:line.borderRightStyle, margin:line.marginLeft,
          space:tag.getPropertyValue('--bm-tikz-tag-space').trim(), grid:tag.gridTemplateColumns};
    }""")
    assert geometry["box"] == geometry["line"] == "solid" and geometry["width"] != "0px", geometry
    assert geometry["margin"].startswith("-") and geometry["space"].endswith("em") and len(geometry["grid"].split()) == 3, geometry
    reading.get_by_role("combobox").select_option("proof")
    target = frame.locator("a[data-preview-link*='chapter=intro']")
    target.wait_for()
    target.click()
    assert reading.get_by_role("combobox").input_value() == "intro"
    print("PASS two formal chapters after confirmed title edit; boxed equation, ruled array, tagged TikZ", geometry, flush=True)
    assert len(records(page)) == 2, records(page)
    print("PASS clean external updates and plugin title write created no extra recovery records", flush=True)
    errors(page, vault)


def main(app: Path, package: Path, fixture: Path, evidence: Path) -> None:
    evidence.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="ppf-") as scratch, sync_playwright() as playwright:
        root = Path(scratch).resolve()
        vault, profile = root / "独立 验收库", root / "profile"
        host.prepare(vault, profile, package, fixture)
        paper = vault / PROJECT
        (paper / "intro.md").write_text("")
        (paper / "proof.md").write_text("SHARED")
        (paper / "spare.md").write_text("")
        (vault / "invalid").mkdir()
        config = json.loads((paper / "paper.json").read_text())
        (vault / "invalid/paper.json").write_text(json.dumps(dict(config, unexpected_field=True)))
        (vault / "nested/child").mkdir(parents=True)
        for path in ["nested/paper.json", "nested/child/paper.json"]:
            (vault / path).write_text(json.dumps(config))
        for item in ["main.js", "renderer/renderer.mjs", "package-manifest.json"]:
            assert (vault / host.PLUGIN / item).read_bytes() == (package / item).read_bytes()
        print("PACKAGE", package, "manifest SHA256", sha256((package / "package-manifest.json").read_bytes()).hexdigest(), flush=True)
        with window(playwright, app, profile, vault, root / "home1", evidence / "final-native-host1.log") as page:
            page.evaluate("""/** @param {string} root @returns {Promise<void>} */ root => app.plugins.getPlugin('peerpedia')
              .updateWritingScope({folders:{[root]:true}, files:{[root+'/proof.md']:false}})""", PROJECT)
            overlap(page, vault, "intro.md", "")
            overlap(page, vault, "proof.md", "SHARED")
            overlap(page, vault, "spare.md", "", False)
            assert len(records(page)) == 2
            (paper / "intro.md").write_bytes(b"CRLF\r\nbase")
            host.open_source(page, PROJECT + "/intro.md")
            page.wait_for_function("sourceLeaf.view.editor.getValue() === 'CRLF\\nbase'")
            page.keyboard.insert_text("saved ")
            page.wait_for_timeout(3000)
            assert "saved " in (paper / "intro.md").read_text()
            assert len(records(page)) == 2
            print("PASS unrelated nonmember, CRLF load and ordinary native autosave created no records", flush=True)
        with window(playwright, app, profile, vault, root / "home2", evidence / "final-native-host2.log") as page:
            saved = records(page)
            assert len(saved) == 2, saved
            for entry in saved:
                versions = {v["label"]: v["text"] for v in entry["versions"]}
                name = entry["path"]
                assert versions["Before"] == ("" if name == "intro.md" else "SHARED")
                assert versions["Editor draft"] == "LOCAL " + name and versions["External changes"] == "EXTERNAL " + name
            print("PASS fresh host retrieves all three versions for both chapters", flush=True)
            preview(page, vault)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, host.exit_on_termination)
    main(*(Path(arg).resolve() for arg in sys.argv[1:]))
