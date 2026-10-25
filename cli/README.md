# Peerpedia CLI 0.1.0

Read research notes, edit Markdown on your computer, and submit proposed changes
to [Peerpedia](https://peerpedia.dev). Public reading needs no account.

## Install

You need Python 3.12 or newer. The client works on macOS, Linux, and Windows
and has no runtime dependencies. You do not need Django, a database, or Git.

With [pipx](https://pipx.pypa.io/stable/installation/) installed, run

```sh
pipx install peerpedia-cli
peerpedia --version
```

The output should be `peerpedia 0.1.0`. The package is published on
[PyPI](https://pypi.org/project/peerpedia-cli/).

You can also download the `.whl` file from the
[GitHub release](https://github.com/peerpedia/peerpedia/releases/tag/v0.1.0)
and run `pipx install PATH_TO_DOWNLOADED_FILE`.

Without pipx, use a Python environment

```sh
python3 -m venv ~/.venvs/peerpedia
source ~/.venvs/peerpedia/bin/activate
python -m pip install peerpedia-cli
peerpedia --help
```

On Windows PowerShell, create and activate it with

```powershell
py -m venv "$env:USERPROFILE\.venvs\peerpedia"
& "$env:USERPROFILE\.venvs\peerpedia\Scripts\Activate.ps1"
```

Then run the same `python -m pip install` command. Activate the environment again
when opening a new terminal.

## Read a paper

```sh
peerpedia search "Galois" --server https://peerpedia.dev
peerpedia clone PAPER_ID my-paper --server https://peerpedia.dev
cd my-paper
peerpedia feedback --json
```

Replace `PAPER_ID` with an ID from the search results. A newly started site may
have no papers yet. Cloning downloads the Markdown and metadata for local editing.
You can also use a snapshot's reading URL to download that exact version.

## Propose an edit

Create your own access token through the website's
[Access tokens page](https://peerpedia.dev/accounts/tokens/).
Enter it at the hidden prompt

```sh
peerpedia login https://peerpedia.dev
```

Edit the downloaded Markdown, then run these commands from its folder

```sh
peerpedia diff
peerpedia push -m "Explain the missing step in the proof"
```

The push opens a public PR for the corresponding author to review.
It does not overwrite the accepted paper.

Read the [complete command-line guide](https://peerpedia.dev/help/cli/) for
new papers, chapters, and updates to an existing PR.
Never put tokens in command arguments, source files, issues, or chat messages.

## License

The client uses the MIT license. Research papers retain their own licenses.
