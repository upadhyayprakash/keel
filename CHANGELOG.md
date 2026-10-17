# Changelog

All notable changes to Keel. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The npm package is [`@nouisi/keel`](https://www.npmjs.com/package/@nouisi/keel).

## [Unreleased]

### Added

- A Claude Code plugin in `plugins/claude`, installable with `/plugin marketplace add upadhyayprakash/keel`: `/keel:capture` saves what you say (owe, wait, done, new dates, resume notes) through the keel CLI, and `/keel:today` answers what's on. It never deletes and always names the project.
- `@me` for promises to yourself: `owe renew passport @me due:fri` shows as "for myself" instead of "I owe" someone. You can't wait on `@me`, it isn't listed in `people`, and `person merge @yourname @me` moves promises you filed under your own name. If you already had a person with the handle `me`, it now counts as you.

### Fixed

- Dates outside the current year show their year (`Sat 16 Oct 2027`), in lists, `show`, confirmations and history. They used to show only the day and month, so a date next year looked like one this year. `show` no longer repeats the date in brackets when it's more than a week away. Dates follow Keel's clock, not the system clock.

## [0.3.1] - 2026-10-13

### Fixed

- `keel db connect` explains a wrong address ("There's no database at ...") and suggests the fix for the common Turso typo of a dash before the region instead of a dot. A rejected token says so, instead of printing a raw database error.
- `done`'s usage no longer claims it takes inbox refs; only `drop` does.

### Changed

- Docs are on [nouisi-keel.mintlify.site](https://nouisi-keel.mintlify.site), linked from the READMEs and the npm page.

## [0.3.0] - 2026-10-13

### Added

- Use Keel on several devices ([ADR 0001](docs/adr/0001-multi-device-sync.md)): `keel db connect <address>` keeps a synced local copy of a hosted libSQL database (Turso or a libSQL server) on each device. The first device copies its data up after a confirmation and a check; later devices adopt it, and local data is backed up rather than mixed. The token is stored in the macOS Keychain or the Linux keyring. Offline, reading works and changes are refused clearly. `keel db` shows where data lives; `keel db disconnect` goes back to a local copy.
- `KEEL_HOME` moves Keel's folder (database, config, backups, history).
- The Keel shell: run `keel` on its own (or `keel shell`) for a session where you type commands without the `keel` prefix. The prompt shows the project you're working on, Tab completes, ↑ recalls history across sessions, questions are asked inline, `exit` or Ctrl+D leaves.
- Autocomplete that knows every command: subcommands after `client`, `project` and `person`; the right clients for `rename`, `archive` and `unarchive`; refs that fit each command (`nudge` only offers what you're waiting on); keys and status values for `set`; and `owe`/`wait` guide you through who, when and where from. Shared by the browser terminal, the shell and zsh/bash completion.

### Fixed

- Faster on a hosted database: opening skips the migration step when nothing is new (it used to cost a write round trip every time), and changes are sent to the hosted database in one request before the local copy catches up. Measured from India to Ireland: `ls` 4.1 s to 0.9 s, a change 4.0 s to 2.5 s (under 1.1 s in the shell); much less with a nearby region.
- A hosted connection dropped while idle no longer loses a change: Keel retries once, safely, since every row's id is set before sending.
- Backup and file names use the local date, not UTC.

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

[Unreleased]: https://github.com/upadhyayprakash/keel/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/upadhyayprakash/keel/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/upadhyayprakash/keel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/upadhyayprakash/keel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/upadhyayprakash/keel/releases/tag/v0.1.0
