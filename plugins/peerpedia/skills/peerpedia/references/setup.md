# Setup

Requires Python 3.12+ and Git. CLI installation is separate from plugin installation.
The plugin makes no paid-service purchases and runs no installation hooks.

If the CLI is unavailable, install it in a dedicated environment. Use an official
Peerpedia checkout supplied by the user, or clone the official repository into an
unused source directory. Never overwrite an existing checkout or library folder.
For a first installation on macOS:

```sh
git clone https://github.com/peerpedia/peerpedia.git "$HOME/Documents/peerpedia-source"
python3 -m venv "$HOME/.local/share/peerpedia/venv"
"$HOME/.local/share/peerpedia/venv/bin/python" -m pip install "$HOME/Documents/peerpedia-source/cli"
"$HOME/.local/share/peerpedia/venv/bin/peerpedia" --version
```

If `python3` is older than 3.12, use an available newer Python interpreter for the
venv; otherwise explain the missing prerequisite rather than changing system Python.
For upgrades, use a clean updated official checkout and pip install --upgrade its
`cli` directory into the same dedicated environment. Re-run check_setup.py.

Reading and searching do not need authentication. For writes, ask the user to
create their own token on https://peerpedia.dev/accounts/tokens/ ("Access tokens" on the website). Use proposal-only scope unless they also want new publications.
The user enters the token in their own terminal at the hidden prompt:

```sh
"$HOME/.local/share/peerpedia/venv/bin/peerpedia" login https://peerpedia.dev
```

Do not read or print `~/.config/peerpedia/credentials.json`. Do not put a token in a
command argument, plugin file, paper folder, Git commit or chat. For managed AI
runners, secrets may instead supply both PEERPEDIA_TOKEN and the matching
PEERPEDIA_SERVER. Do not redirect a token to another origin.

If a token is expired/revoked, reconnect using a replacement token through the same
hidden prompt. A pending push stays intact and can then be retried when requested.
Login reports scope and agreement status; an unaccepted agreement requires the
human to visit the website. The plugin must not accept it on their behalf.
