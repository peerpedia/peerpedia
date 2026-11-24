"""Benchmark production browser Workers inside a disposable offline Obsidian host."""

import json
from pathlib import Path
import runpy
import sys
from tempfile import TemporaryDirectory
import time
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
app, package, evidence = (Path(arg).resolve() for arg in sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
base = runpy.run_path(str(root / "obsidian/scripts/validate-offline-host.py"))
with TemporaryDirectory(prefix="peerpedia-benchmark-") as temporary:
    work = Path(temporary)
    vault, profile = work / "vault", work / "profile"
    base["prepare"](vault, profile, package, root / "obsidian/tests/fixtures/render-paper.json")
    with (
        sync_playwright() as pw,
        base["isolated_host"](app, profile, work / "home", evidence / "host.log") as address,
    ):
        context = pw.chromium.connect_over_cdp(address).contexts[0]
        for _ in range(130):
            pages = [p for p in context.pages if p.url.endswith("/index.html")]
            if pages:
                break
            time.sleep(0.15)
        assert pages, "Host did not open the test vault"
        page = pages[0]
        page.wait_for_function("window.app?.workspace?.layoutReady")
        assert Path(page.evaluate("app.vault.adapter.getBasePath()")).resolve() == vault.resolve()
        requests = base["offline"](page, context, package)
        baseline = {worker.url for worker in page.workers}
        page.evaluate((root / "obsidian/dist/benchmark.js").read_text())
        results = page.evaluate(
            "/** @returns {Promise<object[]>} */ async () => await peerpediaBenchmark()"
        )
        assert not requests
        assert page.evaluate("packageRendererStarts === 0 && pluginNodeRequests === 0")
        for _ in range(100):
            if {worker.url for worker in page.workers} <= baseline:
                break
            time.sleep(0.05)
        assert {worker.url for worker in page.workers} <= baseline, "Benchmark leaked Workers"
        (evidence / "results.json").write_text(json.dumps(results, indent=2))
        print(json.dumps(results, indent=2))
