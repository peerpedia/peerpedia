# Browser-renderer benchmarks

These benchmarks run the production `BrowserRendererClient` and embedded renderer
inside a disposable, offline Obsidian profile. They no longer package or measure
the retired Node subprocess renderer.

After installing the build dependencies and creating a three-file plugin package
as described in `../docs/installation.md`, run from the repository root:

```sh
obsidian/node_modules/.bin/tsx obsidian/bench/build.ts
.test-tools/obsidian-ci/bin/python obsidian/bench/run.py /Applications/Obsidian.app /absolute/path/to/peerpedia /absolute/path/to/benchmark-evidence
```

The runner checks its vault path, blocks HTTP(S) and external renderer processes,
and verifies that benchmark Workers have stopped before closing the host. It does
not enable the supplied plugin or access a real account. The three-file package
is copied only to prepare the standard disposable host fixture.

`results.json` contains analysis and render measurements for 1, 8, 32 and 64
synthetic chapters. Render rounds are cold Worker, unchanged document, and one
chapter edited. The cancellation case submits eight edits through the actual
preview controller and reports completion after a pause. The analysis RSS field
is the entire Obsidian host process, not isolated plugin memory. Timings exclude
iframe layout and are single samples, not an established performance budget or
proof of improvement over an earlier version.

The fixture intentionally exercises repeated text and equations. Real TikZ and
font delivery are covered by the offline host acceptance test; invalid TikZ and
timeout/recovery remain covered by the shared-renderer prototype harness.
