# 02. Spec: Keel v1

Date: 2026-10-12
Status: draft, open for review
Builds on: [01. Analysis](01-analysis.md)
Visual design (logo, terminals, flows): [Keel Product Design canvas](https://claude.ai/artifact/N9pXw5K2G5n5QLsXuNN5fK) (private until shared)

## Decisions so far

| Topic | Decision |
|---|---|
| Name | **Keel**. GitHub repo `keel`, local folder `Keel - Task Manager` |
| Form factor | **Terminal only, two places.** The `keel` CLI in your own terminal, and the same terminal experience in a desktop browser (`keel serve`). Both run the same commands through one shared core |
| Platforms | Desktop only. No phone or tablet layout. The graphical web screens (cards, forms, sidebar) are parked as a possible v2 |
| Themes | Light and dark in both places. Web: toggle plus `theme light\|dark\|auto`. CLI: light and dark palettes, auto-detected, overridable (section 4) |
| Database | libSQL (SQLite-compatible). v1 runs on a local file only. v2 adds a hosted database (Turso or any libSQL server) by changing one URL. v1 follows the Turso-ready rules in section 6 so that port is a config change, not a rewrite |
| Logo | Brand: direction **D**, the `› keel` wordmark with prompt chevron (browser terminal, favicon, GitHub, README). CLI: direction **A**, the hull-and-keel mark (banner art and the per-command header) |
| Review rhythm | Weeks start Monday. Weekly review on Friday, with a Friday reminder |
| Users | Single user per instance. Others self-host their own copy |
| Main capture sources | Meetings and Slack |
| License | MIT, open-source ready from the first commit |
| v1 scope | Inbox, Commitments, Today, Weekly review, plus **Clients and Projects with resume notes** (moved up from v2 because of frequent context switching). Decisions come in v2 |

## 1. Core concepts

| Concept | What it is | Short ref |
|---|---|---|
| **Client** | Who the work is for. "Personal" is just another client | slug, e.g. `acme` |
| **Project** | A piece of work for one client, with a status and a resume note | `acme/website` |
| **Context** | The project you are working in right now. New items land in it by default | shown in the prompt and status line |
| **Commitment** | A promise with a person and a due date. Direction is **owe** (I owe them) or **wait** (they owe me) | `c42` |
| **Inbox item** | A raw capture, not yet sorted | `i7` |
| **Focus** | Up to 3 commitments chosen for today | `keel focus` |
| **Resume note** | Where I am, what's next, what I was unsure about. One per project, versioned | `keel park` |
| **Person** | Someone you owe or wait on, optionally tied to a client | `@ravi` |
| **Decision** (v2) | Decision, options, why, expected outcome, confidence, review date | `d3` |

## 2. Multi-client and context switching

Working across several clients in a week (sometimes in the same day) is the main use case, not an edge case.

- **Hierarchy:** Client > Project > items. Every commitment, inbox item and decision can belong to a project. Items without a project are allowed and show up under "No project".
- **Switching is a first-class action.** `keel switch acme/website`:
  1. If you are leaving a project, Keel asks for a 60-second resume note (skippable, but the default is to write one).
  2. It sets the new context.
  3. It shows the new project's resume note, its open "I owe" items, overdue "waiting on" items and anything due in the next 3 days.
- **The context is a default, not a wall.** `+northwind/app` on any command overrides it for that one item.
- **The switch log** records every switch with a timestamp. That gives a rough "time per client" in the weekly summary with zero manual time tracking.
- **Client lens:** Today, lists and the weekly summary can be filtered by client (`keel today +acme`).
- **Stale project warning:** a project with open commitments and no switch-in or resume note for 7+ days is flagged in Today and the weekly review.

## 3. One command language, two terminals

The browser terminal accepts **exactly the same commands as the CLI**; the `keel` prefix is optional there. One parser lives in the shared core package, so both places always behave the same way.

### Tokens (todo.txt style)

| Token | Meaning | Example |
|---|---|---|
| `"text"` or bare words | Title | `send pricing deck` |
| `@name` | Person | `@ravi` |
| `+client/project` or `+client` | Project or client | `+acme/website` |
| `due:` | Due date, natural language | `due:thu`, `due:2026-10-20`, `due:+3d` |
| `from:` | Source | `from:meeting`, `from:slack`, `from:slack:https://...` |
| `#tag` | Free tag | `#legal` |
| `c42`, `p7`, `i3` | Refs to existing items | `keel done c42` |

### Commands

| Command | Does |
|---|---|
| `keel in <text>` | Capture to the inbox, no questions asked |
| `keel owe <text> @who due:<when>` | New "I owe" commitment |
| `keel wait <text> @who due:<when>` | New "waiting on" commitment |
| `keel meeting [+project]` | Meeting mode: every line you type is captured. Lines starting with `>` are "I owe", `<` are "waiting on", anything else is a note. Ends with a summary to confirm |
| `keel today [+client]` | Focus, due today, overdue, waiting-on follow-ups |
| `keel focus c42 c51 c60` | Set today's top 3 |
| `keel ls [owe\|wait\|inbox\|overdue] [+client] [@who]` | List with filters |
| `keel show <ref>` | Details and history of one item |
| `keel set <ref> key:value ...` | Edit fields: `status:`, `due:`, `@`, `+`, `title:` |
| `keel done <ref>` / `keel drop <ref>` | Close a commitment |
| `keel renegotiate <ref> due:<when>` | Move a due date and record that it was renegotiated (counts differently from a silent slip) |
| `keel nudge <ref>` | Mark a waiting-on item as followed up, with a timestamp |
| `keel triage` | Walk the inbox: turn each item into owe, wait, note or delete |
| `keel switch <project>` | Change context (see section 2) |
| `keel park` | Write the resume note for the current project and leave it |
| `keel client new <slug> "<name>"` | New client |
| `keel project new <client/slug> "<name>"` | New project |
| `keel review` | Guided weekly review |
| `keel summary [day\|week] [+client]` | Summary: done, slipped, renegotiated, waiting, time per client |
| `keel theme [light\|dark\|auto]` | Pick the color theme (see section 4) |
| `keel serve` | Start the browser terminal on localhost |
| `keel export [--json\|--md]` | Export everything. Your data is always yours |

Every write command prints the ref it created and supports `--json` output, which is what the Claude Code integration (MCP, later) builds on.

## 4. The two terminals

### Output blocks: one result, two renderers

Commands never print text directly. Each command returns a list of **blocks**, and each terminal renders them its own way:

| Block | Example use | CLI renders as | Browser renders as |
|---|---|---|---|
| `heading` | "FOCUS", "WAITING ON" | bold colored line | bold colored line |
| `list` / `table` | today, ls | aligned columns | aligned columns, refs clickable |
| `item` | one commitment | ref, title, person, project, due badge | same, ref and project clickable |
| `note` | resume note | indented lines with a bar | same |
| `bar` | time per client | block characters | the same characters |
| `success` / `warning` / `error` | "c42 created" | colored mark + text | same |
| `question` | resume-note prompts in `switch`, steps in `review`, "renegotiate?" | interactive prompt (@clack/prompts) | inline prompt in the scrollback with keyboard choices |

This keeps both terminals identical in content, and a graphical view (if it ever comes back in v2) only needs a third renderer.

### Browser terminal (desktop)

- Built from **normal HTML styled as a terminal**, not a terminal emulator like xterm.js. Text can be selected and copied, refs (`c42`, `acme/website`) and Slack links are clickable, and screen readers can read the output.
- **Autocomplete dropdown** above the prompt for commands, `@people`, `+projects`, refs and `due:` dates, with a live preview of what will be created before Enter.
- **Status line** at the bottom: context, overdue / due today / waiting counts, theme toggle.
- Keys: Tab completes, Up/Down walks history, Ctrl+L clears, Ctrl+R searches history, `?` shows help.
- Opens with the D wordmark (`› keel`) and the result of `today`.
- Desktop only, laid out for 1024px and wider.

### Light and dark

- **Browser:** a Light / Dark / Auto toggle in the status line, also settable with `theme`. Auto follows the operating system. The choice is saved in `settings`.
- **CLI:** Keel can't change the terminal's own background, so it ships two palettes and picks text colors that read well on it:
  1. `keel theme light|dark` (or `KEEL_THEME`) wins if set.
  2. Otherwise Keel detects the background (the `COLORFGBG` variable, or by asking the terminal for its background color), and falls back to dark.
  3. `NO_COLOR` turns colors off. Output to a pipe or file is always plain.
- Both palettes keep 4.5:1 contrast for all text and use the same meaning for each color: red overdue, amber due today, blue waiting, green done, orange the Keel accent.

## 5. Data model

All ids are ULIDs. Every table also gets `updated_at` and `deleted_at` (soft delete), left out below for brevity. Short refs (`c42`) come from a per-type sequence. Times are stored in UTC, dates as `YYYY-MM-DD` in the user's timezone.

```
clients        id, slug, name, color, archived_at, created_at
projects       id, client_id, slug, name, status (active|paused|done|archived),
               last_touched_at, created_at
resume_notes   id, project_id, where_i_am, next_step, unsure_about, created_at   (history kept)
people         id, handle, name, client_id?, created_at
commitments    id, ref_no, direction (owe|wait), title, person_id, project_id?,
               due_on, status (open|done|dropped), source (meeting|slack|email|claude|other),
               source_ref?, renegotiated_count, last_nudged_at?, notes, created_at, closed_at
inbox_items    id, ref_no, text, project_id?, source, created_at, triaged_at?
focus          date, slot (1..3), commitment_id
context_log    id, project_id, started_at, ended_at?
events         id, entity, entity_id, kind, payload_json, created_at   (history, undo, summaries)
settings       key, value   (theme, week start, review day, ...)
-- v2
decisions      id, ref_no, project_id?, title, options, why, expected, confidence,
               review_on, outcome?, reviewed_at?, created_at
```

## 6. Architecture

```
keel/                       (pnpm workspaces, TypeScript)
  packages/core             domain logic, command parser, output blocks, db schema + migrations
  apps/cli                  `keel` binary (Node): runs commands, renders blocks as ANSI
  apps/web                  browser terminal (Vite + React): renders blocks as HTML
  apps/server               small Hono API that runs commands for the browser; same core underneath
  apps/mcp      (later)     MCP server so Claude Code can log commitments
  docs/
```

- **One endpoint for commands.** The browser sends the command text to `POST /api/run` and gets blocks back. Autocomplete uses a read-only `GET /api/complete`. Interactive `question` blocks continue through the same endpoint with a session id.
- **Storage:** libSQL client. v1: `KEEL_DB_URL=file:~/.keel/keel.db`. v2: `libsql://<name>.turso.io` with `KEEL_DB_TOKEN`. The code path is the same either way.
- **Running modes:**
  - *Local (v1):* `keel serve` starts the API and the browser terminal on localhost only. The CLI uses the same database file through core.
  - *Hosted (v2):* deploy `apps/server` (any Node host) with the database on Turso. The CLI can point at the same Turso database, or at the hosted API with a token.
- **Auth:** v1 binds to localhost only, no login. v2 (hosted, single user): a passphrase sets a signed session cookie; the CLI uses an API token or the database token. No accounts or teams.
- **Stack:** Drizzle ORM (libSQL driver), Hono, React, commander + @clack/prompts for the CLI, chrono-node for natural dates, Vitest.

### Turso-ready rules for v1

v1 only uses a local file, but it follows these rules so moving to Turso in v2 is a config change:

1. **One client, one place.** Only `packages/core/db` creates the database client, from `KEEL_DB_URL` and `KEEL_DB_TOKEN`. Nothing else opens the file, uses its path, or imports a SQLite driver.
2. **Use `@libsql/client` from day one, not `better-sqlite3`.** The libSQL client already speaks both `file:` and `libsql://`, so the driver never changes.
3. **Async everywhere.** Every database call is awaited, even though a local file could be synchronous. Network latency in v2 then needs no refactor.
4. **Few round trips.** Multi-step writes use `batch()` or a transaction, and commands load with one query per list rather than one per row. What is fast locally stays fast over the network.
5. **Portable SQL only.** No SQLite extensions, no `ATTACH`, no reliance on PRAGMAs beyond `foreign_keys`, no file-level tricks (copying the `.db` as a backup). Backup is `keel export`.
6. **Migrations are versioned files** (Drizzle Kit), applied by `keel migrate` on start, and safe to run against a remote database.
7. **Sync-friendly data.** ULID primary keys (no autoincrement ids that could collide across devices), UTC timestamps, `updated_at` on every row, and soft deletes (`deleted_at`), so Turso embedded replicas and sync in v2 have what they need.
8. **Short refs are display-only.** `c42` comes from a per-type counter and is never used as a foreign key.
9. **A test suite that runs against both.** CI runs the core tests on a `file:` database and on an in-process `sqld` (libSQL server), so remote-only bugs show up in v1.

## 7. Screens

Designs are on the canvas. Everything is a command; the "screens" are what these commands print.

| What | Command | Browser terminal extra |
|---|---|---|
| Daily summary | `today` | refs clickable, counts in the status line |
| Project | `switch`, `show p7` | resume note as a `note` block |
| Create and edit | `owe`, `wait`, `in`, `client new`, `project new`, `set` | autocomplete with live preview |
| Commitments | `ls owe`, `ls wait` | |
| Weekly review + summary | `review`, `summary week` | step prompts inline |
| Inbox triage | `triage` | |

## 8. Critical happy paths (user stories)

**A. Capture promises during a meeting**
As someone in a client call, I want to note promises without breaking flow.
1. `keel meeting +acme/website`, in the terminal or the browser.
2. Type lines as they happen: `> pricing deck to @ravi due:thu`, `< design files from @meera due:fri`, `budget approved for phase 2`.
3. End the meeting (empty line + Enter): Keel shows 1 owe, 1 waiting, 1 note and asks to confirm.
4. The items appear in `ls` and in `today` on their due dates.

**B. Turn a Slack promise into a commitment**
As someone who promises things in Slack threads, I want them in the ledger in under 10 seconds.
1. Copy the Slack message link.
2. In either terminal: `owe send revised SOW @ravi due:mon from:slack:<link>`.
3. The browser shows a live preview (person, project from context, due date, source); the CLI echoes the same after Enter.
4. Later, `show c63` has a clickable link back to the thread.
(v2: a Slack message shortcut "Save to Keel" does steps 1 to 3 in one click.)

**C. Switch context between clients**
As someone who moves between projects several times a day, I want to restart in 2 minutes, not 30.
1. `keel switch northwind/app`.
2. Keel asks for the resume note on `acme/website`: where I am, what's next, unsure about. 60 seconds.
3. Keel shows the Northwind resume note from last time, plus open and due items.
4. Work. The switch log records the time for the weekly summary.

**D. Plan the day**
As someone with too many things on the go, I want to commit to 3 that matter.
1. `keel today`: overdue, due today, waiting-on follow-ups, stale projects.
2. `keel focus c42 c51 c60` to pick up to 3.
3. Everything else stays visible as "bonus" below the line.

**E. Create a client and a project, then edit its status**
1. `client new acme "Acme Corp"`, then `project new acme/website "Website rebuild"`.
2. `park` to write the first resume note, then add commitments with `owe` and `wait`.
3. Later: `set p7 status:paused`. Paused projects drop out of `today` but stay in the weekly review.

**F. Weekly review (Friday, 30 minutes)**
1. `keel review` walks through, in order:
   inbox to zero, every overdue item (done, renegotiate, drop), every waiting-on (nudge or close), each active project (resume note fresh?), next week's top priorities per client.
2. Ends with the week summary: done, slipped, renegotiated, time per client, open loops count.

## 9. Open-source readiness (from day one)

- MIT `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md` in the repo root.
- No personal data in the repo. Sample data uses fictional clients (Acme, Northwind). The real database lives outside the repo (`~/.keel/`) and `*.db` is gitignored.
- All config through environment variables, documented in a `.env.example`. No hardcoded paths, hosts or tokens.
- Docs written for strangers: README with a 5-minute quick start, `docs/` for design and decisions.
- Conventional commits, a CHANGELOG from the first release, GitHub Actions for lint and tests once code exists.
- Brand assets (logo SVGs, CLI banner) live in `assets/brand/` so forks and packagers can use them.

## 10. Roadmap

- **v1:** clients, projects + resume notes, context switching, inbox, commitments, today, meeting mode, weekly review + summary, CLI and browser terminal, light and dark themes, local storage (Turso-ready), export.
- **v2:** Turso / hosted mode with passphrase auth, decisions journal with review reminders, Slack message shortcut, MCP server for Claude Code, daily email digest. Maybe: graphical web screens as a third renderer.
- **Later:** calendar import (meetings become capture prompts), pre-mortem template.
- **Out of scope:** phone and tablet layouts.

## Open questions

None right now.
