# Changelog

All notable changes to Keel. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The npm package is [`@nouisi/keel`](https://www.npmjs.com/package/@nouisi/keel).

## [Unreleased]

### Added

- The Keel shell: run `keel` on its own (or `keel shell`) for a session where you type commands without the `keel` prefix. The prompt shows the project you're working on, Tab completes, ↑ recalls history across sessions, questions are asked inline, `exit` or Ctrl+D leaves.
- Autocomplete that knows every command: subcommands after `client`, `project` and `person`; the right clients for `rename`, `archive` and `unarchive`; refs that fit each command (`nudge` only offers what you're waiting on); keys and status values for `set`; and `owe`/`wait` guide you through who, when and where from. Shared by the browser terminal, the shell and zsh/bash completion.

## [0.2.0] - 2026-10-12

### Added

- `client rename`, `client archive` / `unarchive` and `client delete`. Archived clients and their projects are hidden from lists (`clients --all` and `projects --all` show them); their open commitments stay visible until closed.
- `project delete`, and `set p7 slug:<new>` to change a project's slug.
- `people`, `person rename @ravi "Ravi Kumar"` and `person merge @rav @ravi`.
- Deleting shows what goes with it and asks you to type the name to confirm. `--yes` skips the question for scripts; `--json` without `--yes` never deletes. Deletes are soft, so backups from before still hold everything.
- Screenshots of the CLI and the browser terminal in the READMEs.

### Changed

- Output says "working on acme/website" instead of "context", and `today` on an empty database shows the first two commands to run.

## [0.1.0] - 2026-10-12

The first release: one command language in your terminal and in the browser.

### Added

- Commitments: `owe` and `wait` with a person, due date (natural language), project, source (meeting, Slack link, ...) and tags. `done`, `drop`, `renegotiate` (agreed new date, counted separately from a silent slip), `nudge` and `set`.
- Inbox: `in` captures anything, `triage` walks it.
- `today`: focus (up to 3, set with `focus`), due and late, waiting-on follow-ups, coming up, quiet projects, this week's priorities and a Friday review reminder.
- Clients and projects with resume notes. `switch` asks for a note on the way out and shows the one for where you're going. `park` saves a note and leaves.
- `meeting` mode: `>` for owe, `<` for waiting, anything else is a note. Confirms before saving.
- Weekly `review` (Friday, six steps) and `summary day|week|last` with the kept rate and time per client.
- `keel serve`: the same terminal in the browser, with autocomplete, a live preview of new commitments, clickable refs and a light, dark or auto theme.
- Light and dark palettes in the CLI. Auto mode asks the terminal for its background color (OSC 11), after `KEEL_THEME` and `COLORFGBG`.
- `--json` on every command: `{ ok, data, text }` or `{ ok: false, error, hint }`, with a non-zero exit code on failure.
- `export` (JSON) and `export --md` (readable snapshot), `import` to restore into an empty database, and a daily automatic backup that keeps the last 14.
- Shell completion for zsh and bash: `keel completion zsh|bash`.
- Storage on libSQL: a local SQLite file by default, ready for a libSQL server or Turso later. CI runs the core tests on a file and on a libSQL server.

[Unreleased]: https://github.com/upadhyayprakash/keel/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/upadhyayprakash/keel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/upadhyayprakash/keel/releases/tag/v0.1.0
