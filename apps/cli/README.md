# › keel

Keep your promises, priorities and project context in one terminal.

Keel tracks what you owe people and what you're waiting on, keeps today's focus to three things, and remembers where you left each project when you switch. It runs in your terminal, and the same terminal opens in your browser with `keel serve`. Your data stays in a local SQLite file.

<p align="center">
  <img src="https://raw.githubusercontent.com/upadhyayprakash/keel/main/assets/brand/png/keel-cli-welcome.png" alt="The Keel shell in a terminal: the logo, today with focus and follow-ups, and the prompt showing the project you are working on" width="560">
</p>
<p align="center"><em>The Keel shell in your terminal: just type <code>keel</code> (dark theme)</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/upadhyayprakash/keel/main/assets/brand/png/keel-browser.png" alt="keel serve in the browser, showing today: focus, waiting-on follow-ups and what's coming up" width="820">
</p>
<p align="center"><em>The same terminal in your browser with <code>keel serve</code> (light theme)</em></p>

## Install

```sh
npm install -g @nouisi/keel
```

Needs Node 20.19 or newer.

## Five-minute start

```sh
keel client new acme "Acme Corp"
keel project new acme/website "Website rebuild"
keel owe send pricing deck @ravi due:thu from:meeting
keel wait design files @meera due:fri
keel today
```

- `keel meeting` captures promises as they come up: `> ` for something you owe, `< ` for something you're waiting on.
- `keel switch northwind/app` saves a resume note for the project you're leaving and shows the one for where you're going.
- `keel review` walks you through the Friday review.
- `keel serve` opens the same terminal at http://localhost:4242, in light or dark.
- `keel` on its own opens the Keel shell: type commands without the prefix, with Tab completion and history.
- `keel help` lists everything.

The [Get started guide](https://github.com/upadhyayprakash/keel/blob/main/docs/get-started.md) explains clients, projects and the project you're working on, and walks through a normal day, a meeting and the Friday review.

## Your data

Data lives in `~/.keel/keel.db`. Set `KEEL_DB_URL` to use another file. Keel saves a daily JSON backup in `~/.keel/backups` and keeps the last 14.

```sh
keel export > keel-backup.json      # everything, as JSON
keel export --md > keel.md          # a readable snapshot
keel import keel-backup.json        # restore into an empty database
```

Add `--json` to any command for machine-readable output.

## Shell completion

```sh
echo 'eval "$(keel completion zsh)"' >> ~/.zshrc     # zsh
echo 'eval "$(keel completion bash)"' >> ~/.bashrc   # bash
```

## More

Source, docs and issues: https://github.com/upadhyayprakash/keel. MIT licensed.
