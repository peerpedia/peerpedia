# Releasing Peerpedia

The public website, CLI, editor, and plugin share a release number.
Content hashes, API paths, document formats, and database migrations use
independent versions. Do not rename those when making a software release.

## Prepare a release

Update `VERSION`, `cli/peerpedia_cli/__init__.py`, both plugin manifests,
and the editor package files. Update the release notes and download links.
Run `python scripts/check_version.py` to catch mismatched labels.

Build the CLI with Python 3.12 or newer

```sh
python -m pip install build==1.3.0 twine==6.2.0
python -m build cli --outdir dist
python -m twine check --strict dist/*
```

Install the wheel in a fresh environment and check `peerpedia --version`
and `peerpedia --help`. The package must work without the server checkout.

Merge through a pull request. Wait for the backend, browser, quality, and
security checks on the exact main commit. Create a `vX.Y.Z` GitHub release
at that commit and attach the wheel and source distribution.
Deploy using `scripts/deploy.py`, which verifies the same release gates.

Do not replace a published tag or upload different contents under an
existing package version. Make a new version instead.

## Enable PyPI publishing once

The owner needs a verified PyPI account with two-factor authentication.
In [PyPI publishing settings](https://pypi.org/manage/account/publishing/),
add a pending GitHub publisher with these values

| Field | Value |
| --- | --- |
| PyPI project name | `peerpedia-cli` |
| Owner | `peerpedia` |
| Repository | `peerpedia` |
| Workflow filename | `publish-pypi.yml` |
| Environment | `pypi` |

The pending publisher is for a new project. If the project already exists
in your account, add the publisher from that project's Publishing page instead.
See [PyPI's instructions](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/).

Create the `pypi` environment in the GitHub repository settings and configure
its deployment protections for the maintainers who may publish.
The workflow uses short-lived credentials. Do not add a PyPI password or
long-lived API token to the repository.

## Publish a CLI release on PyPI

After publishing the GitHub release, open GitHub Actions and run
**Publish CLI to PyPI** with its tag, such as `v0.1.0`.
The workflow verifies the release, builds and checks both distributions,
and publishes through the trusted publisher.

It deliberately requires the released commit to still be current `main`
with passing tests. Publish before advancing `main` to the next change.

After PyPI confirms the upload, verify installation in a clean environment

```sh
pipx install peerpedia-cli
peerpedia --version
```

Only then replace the GitHub wheel installation command in the user guides
with the shorter PyPI command. The GitHub wheel remains a useful fallback.
