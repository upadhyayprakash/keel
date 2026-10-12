<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/keel-wordmark-dark.svg">
    <img src="assets/brand/keel-wordmark.svg" alt="keel" height="64">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/OWNER/keel/actions/workflows/ci.yml"><img src="https://github.com/OWNER/keel/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

# Keel

A personal app for tracking promises, priorities, project context and decisions, so nothing promised is missed and focus stays on what matters. Built for people who juggle several clients and projects in the same week.

The name: a keel keeps a boat steady and on course. Keel does the same for the day: steady focus, kept promises, sound decisions.

Status: early development (v0.1). The CLI and the browser terminal work locally, including meeting capture, triage, the weekly review and summaries. See the roadmap in the spec.

## What it will do

- **Commitments:** "I owe" and "Waiting on", each with a person and a due date.
- **Today:** at most 3 priorities, plus anything due or overdue.
- **Clients and projects:** switch context in one command, with a resume note waiting for you.
- **Weekly review:** a guided walk through every open loop, ending with a week summary.
- **Terminal first, in two places:** the `keel` CLI, and the same terminal in your desktop browser (`keel serve`), with light and dark themes.
- **Your data, your database:** a local SQLite file, or a hosted libSQL database such as Turso.

## Quick start

Needs Node 20.19+ and pnpm 9.

```bash
pnpm install
pnpm keel client new acme "Acme Corp"
pnpm keel project new acme/website "Website rebuild"
pnpm keel owe send pricing deck @ravi due:thu from:meeting
pnpm keel today
```

Browser terminal (desktop, localhost only):

```bash
pnpm build          # builds apps/web once
pnpm keel serve     # http://localhost:4242
```

Your data lives in `~/.keel/keel.db` (change it with `KEEL_DB_URL`, see `.env.example`). Run `pnpm keel help` for every command.

To get a global `keel` command: `cd apps/cli && pnpm link --global`.

## Development

```bash
pnpm test           # all tests
pnpm typecheck
pnpm dev:server     # API on :4242, in one terminal
pnpm dev:web        # browser terminal with hot reload on :5173, in another
pnpm db:generate    # new migration after editing packages/core/src/db/schema.ts
```

| Package | What it is |
|---|---|
| `packages/core` | Commands, parser, output blocks, database schema and migrations |
| `apps/cli` | The `keel` command, renders blocks as terminal text |
| `apps/server` | Small local API behind `keel serve` |
| `apps/web` | The browser terminal |

## Docs

- [01. Analysis](docs/01-analysis.md): how high-output people manage commitments, and the proposed app shape
- [02. Spec](docs/02-spec.md): v1 scope, data model, command language, architecture and user flows

## License

[MIT](LICENSE)
