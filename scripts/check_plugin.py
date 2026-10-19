"""Validate self-contained plugin packaging and marketplace references, without installing it."""

import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def validate(root=ROOT):
    plugin = root / "plugins/peerpedia"
    portable = json.loads((plugin / "plugin.json").read_text())
    legacy = json.loads((plugin / ".codex-plugin/plugin.json").read_text())
    for key in ("name", "version", "description"):
        assert portable[key] == legacy[key], f"Manifest mismatch: {key}"
    assert portable["extensions"]["com.openai"]["requires_local_executor"]
    assert legacy["requires_local_executor"]
    market = json.loads((root / ".agents/plugins/marketplace.json").read_text())
    entry = next(p for p in market["plugins"] if p["name"] == portable["name"])
    assert (root / entry["source"]["path"]).resolve() == plugin.resolve()
    assert entry["policy"]["authentication"] == "ON_USE"
    assert (plugin / legacy["skills"]).is_dir()
    for manifest in (portable["extensions"]["com.openai"], legacy):
        for field in ("composerIcon", "logo"):
            asset = (plugin / manifest["interface"][field]).resolve()
            assert asset.is_relative_to(plugin.resolve()) and asset.is_file()
    skill = plugin / "skills/peerpedia/SKILL.md"
    for path in (plugin / "skills").rglob("*.md"):
        for target in re.findall(r"\]\(([^)]+)\)", path.read_text()):
            if "://" in target or target.startswith("#"):
                continue
            linked = (path.parent / target.split("#")[0]).resolve()
            assert linked.is_relative_to(plugin.resolve()) and linked.is_file(), target
    assert skill.read_text().startswith("---\nname: peerpedia\n")
    print("Plugin manifests, marketplace, assets and skill references validated.")


if __name__ == "__main__":
    validate()
