"""Check that the public release labels agree without importing Django."""

import ast
import json
from pathlib import Path
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def check():
    version = (ROOT / "VERSION").read_text().strip()
    module = ast.parse((ROOT / "cli/peerpedia_cli/__init__.py").read_text())
    cli_version = next(
        ast.literal_eval(node.value)
        for node in module.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets
        )
    )
    assert cli_version == version, "CLI version differs from VERSION"
    metadata = tomllib.loads((ROOT / "cli/pyproject.toml").read_text())
    assert (
        metadata["tool"]["setuptools"]["dynamic"]["version"]["attr"] == "peerpedia_cli.__version__"
    )
    for path in (
        "plugins/peerpedia/plugin.json",
        "plugins/peerpedia/.codex-plugin/plugin.json",
        "editor/package.json",
        "editor/package-lock.json",
    ):
        assert json.loads((ROOT / path).read_text())["version"] == version, path
    lock = json.loads((ROOT / "editor/package-lock.json").read_text())
    assert lock["packages"][""]["version"] == version, "npm lock root package version"
    for path, heading in (
        ("README.md", f"# Peerpedia {version}"),
        ("cli/README.md", f"# Peerpedia CLI {version}"),
    ):
        assert (ROOT / path).read_text().splitlines()[0] == heading, path
    releases = [
        line for line in (ROOT / "CHANGELOG.md").read_text().splitlines() if line.startswith("## ")
    ]
    assert releases[0] == f"## {version}", "Current release notes are missing"
    for path in ("cli/LICENSE", "plugins/peerpedia/LICENSE"):
        assert (ROOT / path).read_bytes() == (ROOT / "LICENSE").read_bytes(), path
    print(f"Release labels and software licenses agree at {version}.")


if __name__ == "__main__":
    check()
