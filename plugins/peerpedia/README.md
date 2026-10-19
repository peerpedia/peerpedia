# Peerpedia for Codex desktop

Find a paper, understand what it says and how readers react, then revise it in
response to selected feedback. Submit a PR when you ask, or publish a new note.

## Install from GitHub

Requires Codex desktop with plugin support, Python 3.12+ and Git. Install the CLI
once in a separate environment (no Peerpedia account needed for reading):

```sh
git clone https://github.com/peerpedia/peerpedia.git "$HOME/Documents/peerpedia-source"
python3 -m venv "$HOME/.local/share/peerpedia/venv"
"$HOME/.local/share/peerpedia/venv/bin/python" -m pip install "$HOME/Documents/peerpedia-source/cli"
```

Use an existing official checkout instead of cloning over an existing directory.
The CLI must report version 0.5.0 or newer.

Register the repository marketplace with the Codex CLI:

```sh
codex plugin marketplace add peerpedia/peerpedia
```

Open the desktop Plugins directory, select the **Peerpedia** marketplace and
install **Peerpedia**. Restart the app if the new source is not shown; test in a
new chat. On Codex versions with `plugin add`, you can also install with:

```sh
codex plugin add peerpedia@peerpedia
```

For local development, register the repository's absolute path instead of the
GitHub shorthand. Plugin installation copies its folder into Codex's cache; it
does not install Python or the CLI automatically. Check the installation using
`scripts/check_setup.py` from the installed plugin folder. To update, update the
CLI from a current official checkout and refresh/reinstall the marketplace plugin.

## Try it

- “Use Peerpedia to find a paper about Galois theory, explain it, and summarize how people reacted.”
- “Propose corrections based on those comments. Let me choose which to address.”
- “Make corrections 1 and 3 locally and show me the diff.”
- “Submit these changes as a PR.”
- “Update my pending PR with this explanation.”

The library is `~/Documents/Peerpedia`, with a UUID folder for each cloned paper.
Existing edits are preserved. Private website drafts are not synchronized.

## Connect your own account for submissions

Create a token through **Access tokens** on Peerpedia. Proposal scope is enough
for revisions; enable publishing only when you want new papers. Enter the token
in your own terminal at the hidden prompt, never in a chat:

```sh
"$HOME/.local/share/peerpedia/venv/bin/peerpedia" login https://peerpedia.dev
```

Credentials are stored outside the library and plugin in the CLI's local config.
They are not encrypted at rest. The plugin does not read or print them. You must
personally accept the website submission agreement and choose each new paper's
license. All plugin submissions are declared AI-assisted. New papers publish
immediately; corrections become public PRs for the corresponding author to accept.
AI cannot post comments, rate, vote, resolve discussions or accept PRs.

If the network fails, local work remains. A lost submission response requires the
CLI's saved-payload retry, not a fresh duplicate submission. No unattended retries
or background publication are installed.

## Verification

The repository's Django/PostgreSQL suite covers public discovery, hidden-content
exclusion, CLI search and feedback, immutable PR snapshots, expired credentials,
interrupted submissions and publication. `scripts/test_plugin_unit.py` checks
setup behavior and both manifest layouts. `python scripts/check_plugin.py` validates
packaging, links and the marketplace path. Testing does not publish to Peerpedia.

The package includes a portable `plugin.json` and a compatibility
`.codex-plugin/plugin.json` for older Codex builds. No MCP server is required.
See [OpenAI's plugin packaging documentation](https://developers.openai.com/plugins/build/plugins).
