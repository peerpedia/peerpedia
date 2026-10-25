"""Reject manifest changes that the production lock file does not satisfy."""

from pathlib import Path
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name


def requirements(text):
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            yield Requirement(line)


def check(manifest, lock):
    pins = {}
    errors = []
    for requirement in requirements(lock):
        specs = list(requirement.specifier)
        if len(specs) != 1 or specs[0].operator != "==" or "*" in specs[0].version:
            errors.append(f"Lock entry must pin one exact version: {requirement}")
            continue
        pins[canonicalize_name(requirement.name)] = specs[0].version
    for requirement in requirements(manifest):
        if requirement.marker and not requirement.marker.evaluate():
            continue
        version = pins.get(canonicalize_name(requirement.name))
        if version is None:
            errors.append(f"Missing lock entry: {requirement.name}")
        elif version not in requirement.specifier:
            errors.append(f"{requirement} conflicts with locked version {version}")
    return errors


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    errors = check(
        (root / "requirements.txt").read_text(), (root / "requirements.lock").read_text()
    )
    if errors:
        raise SystemExit("\n".join(errors))
    print("Production lock satisfies all direct dependency requirements.")
