# 0005. Lists: lightweight plain and tracked lists that live under a project

- **Status:** Accepted (2026-11-15)
- **Date:** 2026-11-15
- **Target release:** not yet planned (after Goals, [ADR 0004](0004-goals.md), ships)

## Context

Keel tracks promises (commitments), small goals with steps (Goals) and a capture pile (the inbox). It has no place for the simple thing people keep all the time: **a list**.

Two needs keep showing up:

1. **A collection.** Things to remember or choose from, with no notion of "done": books to read, packing ideas, a reading list, names.
2. **A checklist.** Things that move through states and finish: a release checklist, a trip to-do, a grocery run. Sometimes it is **reusable**: the "D-mart" grocery list is used again every week, so it needs a reset, not a delete.

What exists today does not fit:

| Existing object | Why it is not a list |
|---|---|
| Commitment | Always has a person and a due date. Far too heavy for "buy milk" |
| Inbox item | Free text with no state, no order and no grouping, and it is meant to be emptied |
| Goal step | Has order and state, but only exists inside one goal and has no standalone use |

Lists must stay out of the way. They are not part of `today`, the focus slots or the weekly review. You open them when you need them.

## Decision drivers

1. **Lightweight.** No person, no due date, no reminders.
2. **One list type for both needs**, so a collection can become a checklist without copying anything.
3. **A list belongs to a project.** A client is a business or a person; the work, and so its artefacts, lives in projects.
4. **A place to browse.** Lists are explored by name, tag and description, with a cover to recognise them.
5. **Follow the existing rules:** ULID ids, soft deletes, `updated_at`, display-only ref numbers, and the consistency rules of [ADR 0003](0003-consistency-across-devices.md), including safe reordering from two devices.
6. **Small to store.** Keel's data is a local SQLite file, optionally synced (ADR 0001). Covers must not bloat it.

## Decision

Add two tables, `lists` and `listItems`, and a Lists area in the CLI, browser terminal and phone app. Lists link to a project, never directly to a client.

### 1. Data

All tables use the shared base columns (`id`, `createdAt`, `updatedAt`, `deletedAt`).

**`lists`**

| Column | Notes |
|---|---|
| `refNo` | Display only, unique, like other objects |
| `projectId` | Required. Every list belongs to a project (see section 3) |
| `name` | Required |
| `description` | Short, optional |
| `tags` | Text column of a few tags or topics, same convention as `commitments.tags` |
| `kind` | `plain` or `tracked` |
| `viewSort` | `manual`, `state`, `created` or `alpha`; how the list is shown, not stored order |
| `pinned` | Boolean; pinned lists come first in the gallery |
| `status` | `active` or `archived` |
| `coverKind` | `svg` or `png`, or null: no cover set, so the default placeholder is shown |
| `cover`, `coverDark` | An optional cover you set, at most 200 KB each. `coverDark` is optional; without it, `cover` is used in both themes (see section 4) |
| `resetCount`, `lastResetAt` | History of a reusable list |

`createdAt` comes from the base columns and is shown in the gallery.

**`listItems`**

| Column | Notes |
|---|---|
| `listId` | Required |
| `position` | A **fractional string key** (see section 5), not an integer |
| `text` | Required |
| `note` | Optional |
| `state` | `open`, `doing`, `blocked` or `done`; always stored, default `open` |
| `doneAt` | Set when state becomes `done` |

Indexes: lists by project and status; list items by list and position.

### 2. Plain and tracked are a display mode

- Items **always** carry a state. `kind` only decides whether the state is shown and counted.
- A `plain` list shows plain items with no checkbox and no progress. A `tracked` list shows state chips and **"4 of 7 done"** (done items over all items).
- Switching a list from `tracked` to `plain` and back loses nothing, because the state is kept.
- Four states are enough: `open`, `doing`, `blocked`, `done`. There is no `dropped` state; a lightweight list can just delete the item.

### 3. Lists live under a project: the default project

- A list always has a `projectId`. It shows as an artefact of that project and nowhere else (not on the client page, not in `today`).
- When someone adds a list to a client without naming a project, Keel uses that client's **General** project, creating it the first time it is needed.
- A list for no business at all (the D-mart groceries) goes to a **Personal** client, also created the first time it is needed, with its own **General** project.
- `projects` gets an `isDefault` boolean. Keel finds the default project by this flag, never by its name, so renaming General breaks nothing. There is at most one default project per client.
- **Default projects are shelves, not work.** They stay out of "stale project", "where was I" and context-switch views, and a client's default project is hidden from project lists until it holds a list.

### 4. Covers

Covers help you recognise a list in the gallery (cards like a course index: ref number, title, illustration, a pin star). Keel does not generate them: it cannot know what a list is about, and a runtime call to a model would need a key, cost money and fail offline.

- **Default placeholder.** A list with no cover shows one built-in image-placeholder graphic (a picture frame with a sun and mountains), in a light and a dark version that follow the theme. It is part of the app, not stored per list, so a list with no cover costs nothing in the database. The two files are `cover-placeholder.svg` and `cover-placeholder-dark.svg` (under 1 KB each; drafts in `0005-cover-test/`).
- **A cover you set.** You can set a cover on a list from an SVG or PNG file. It is stored in the database as text in `cover` (and optionally `coverDark`), with `coverKind` saying how to read it:
  - `svg`: the SVG source;
  - `png`: base64 of a PNG, minified before saving (palette-reduced and compressed).
- Where the cover comes from is up to you: your own file, or one drawn on request by Claude. A test run on 2026-11-15 drew 3 sample covers (grocery, release checklist, trip packing) in light and dark, each about 2 KB and each judged good, so SVG is a workable format and PNG is not needed. They live in `0005-cover-test/` as examples of what a set cover can look like.
- **At most 200 KB per cover**, enforced on save for either kind.
- Rendered through an `<img>` tag, never inlined into the page, so scripts in an SVG cannot run. Any SVG that is saved is **sanitized first**: no script, no event handler attributes, no external references, no `foreignObject`.
- **Storage limit:** when the sum of `length(cover) + length(coverDark)` over all lists passes **10 MB**, Keel shows a notice at save time. That is the cue to move covers to object storage (the owner has Cloudflare R2 available) in a later record. Until then they stay in the database.

### 5. Ordering and sync

- **`position` is always the stored manual order.** "Sort by state" (or created, or alpha) is a **view setting** on the list: it changes how items are shown, never their stored positions.
- Dragging an item sets the list back to `manual` and rewrites only the dragged item's `position`.
- Positions are **fractional string keys** (a key between its neighbours), not the integers Goals use. With integers, two devices reordering together would both renumber many rows and collide. With fractional keys, a drag changes one row, so two devices dragging different items merge cleanly. Two drags of the same item resolve as last arrival wins for that field (ADR 0003).
- State changes follow ADR 0003: closing an item (`done`) uses a guarded write (first close wins); other plain fields are last arrival wins per field.
- A new list or item is a new row, so adding from two devices never conflicts. Changes are recorded in `events` like everything else.

### 6. Reset

- **Reset** is available on any tracked list. It sets every item to `open`, clears `doneAt`, adds one to `resetCount`, sets `lastResetAt` and writes one `events` row.
- It is one batch of item updates. A reset racing a tick from another device can leave one item `done`; that is acceptable for a list and is visible at once.
- Reset needs a confirmation, since it changes every item.

### 7. When a list is complete

When every item in a tracked list is `done`, Keel offers **two** choices: **Reset** (keep using it) or **Archive** (finished for good). It never archives on its own, and it does not nag: the offer shows when the list is opened or the last item is ticked, and is not repeated every visit.

### 8. Surfaces

| Surface | What it has |
|---|---|
| Lists area (new, on every surface) | Gallery of cards: cover, ref number, name, progress on tracked lists, pin star; pinned first; search over name, tags and description; filter by project, tag and status |
| A list | Items with drag order, a sort control, state chips, a progress bar on tracked lists, a Reset action and an Archive action |
| Project page | A small "Lists" section with that project's lists |
| `today`, focus, weekly review | Nothing. Lists stay out of the way |

CLI: `keel list new | ls | show | add | done | state | reset | archive | pin`. JSON output follows the existing block rules. The reference and guides in `docs-site` are generated like the others.

## User story

*I keep a D-mart grocery list and a release checklist for a client.*

1. `keel list new "D-mart" --tracked --tag groceries`. There is no client, so it goes to **Personal / General**. The list shows the default cover until I set one.
2. I add 12 items on the phone, tick them off in the shop and see "9 of 12 done". The last three are `blocked`, because the shop was out of stock.
3. At home all items finish. Keel offers **Reset** or **Archive**. I choose Reset: all items return to `open` and the list is ready for next week.
4. `keel list new "v2 release" --tracked --project acme/website`. It appears only under that project, with its progress. I sort it by state to see what is blocked, then drag two items into a better order, which switches it back to manual.
5. In the Lists area I search "release" and find it by tag, or by pinning the two lists I use most.

## Consequences

**Good**

- One object covers collections and checklists, with no data lost when switching between them.
- Lists stay lightweight and do not disturb `today`, commitments or the weekly review.
- Placing every list under a project keeps the client and project pages the single place work is found.
- Fractional positions make reordering from several devices safe.
- Covers add no service and cost nothing until you set one: the default is built into the app, and set covers live in the database with a clear trigger and a ready exit (object storage).

**Costs and risks**

- A default project and a Personal client are extra rows that are not "real" work. The `isDefault` flag and the view exclusions are needed, or they will leak into stale-project and context views.
- Fractional string keys are a little harder to read and debug than integers, and need a small helper (key between two keys, with occasional rebalancing).
- Storing covers in the database grows the file and the sync payload. The 200 KB cap and the 10 MB notice limit that, but 50 covers at the cap is already 10 MB.
- SVG covers are an injection surface. Sanitizing on save and rendering through `<img>` are both required, not optional.
- A list with no cover looks the same as every other uncovered list in the gallery, so recognising lists then depends on the name, tags and pin.
- A reset racing another device's tick can leave one item done.

## Implementation outline

1. Core: schema and migration (`pnpm db:generate`) for `lists`, `listItems` and `projects.isDefault`; fractional key helper; commands with guards; default project and Personal client creation.
2. CLI: `keel list` commands; docs in `docs-site/scripts/generate.ts`.
3. Cover: built-in placeholder (light and dark), setting a cover from a file, size cap, sanitizer and the 10 MB notice.
4. Browser terminal and phone app: Lists gallery, list view, drag order, state chips, Reset and Archive offer.
5. Project page: "Lists" section; hide default projects from stale-project and context views.
6. Tests: item state guards and sort-view behaviour; reorder from two devices; reset; default-project creation and exclusions; cover size cap and sanitizer (script, handler, external reference); 10 MB notice.

## Out of scope

- Moving covers to object storage (a later record, triggered at 10 MB).
- Generating covers automatically from a list's name or tags, or shipping a library of motifs (decided against: Keel cannot know what a list is about).
- Reminders, due dates, assignees, recurring lists and sharing a list with another person.
- Promoting a list item to a commitment (possible later, like inbox triage).
- Nested items, sub-lists and templates beyond Reset.
- A `reusable` flag that remembers the Reset or Archive choice.

## Implementation notes (2026-11-15)

Added when the decision was built. The decision above stands; these are the places the build went further or chose differently.

- **The phone offers drag only in manual order.** The stored order and the API do not care (`POST /api/lists/<ref>/items/<id>/move` and `list order` work from any view, and set the list back to manual, as decided). A finger drag in a sorted view would be a guess about where to put the item among rows that are not in stored order, so the sort buttons hide the handles and say to switch back to Manual.
- **PNG covers are checked and size-capped, not re-compressed.** A PNG must be a real PNG of at most 200 KB; Keel does not palette-reduce it, since that needs an image tool Keel does not ship. SVG covers are cleaned by an allow-list (drawing elements and attributes only).
- **Where a list goes with no project named.** The project you are working on, as `owe` and `in` do, then Personal / General when you are in none. `+client` alone is that client's General project, `+personal` is Personal. The confirmation names the project and says how to move the list.
- **A dark cover must be the same kind as the light one** (both SVG or both PNG), because a list has one `coverKind`.
- **Reset needs a confirmation** at the CLI (`--yes` skips it, and JSON mode needs `--yes`) and a second tap on the phone.
- **The Reset or Archive offer** shows when the last item is ticked, and as a one-line hint on `list show` while the list is complete. It is not stored, so it is never a nag and never acts on its own.
- **Equal position keys** (two devices adding at the end at once) are tolerated: the tie breaks on the item id, and the first drag renumbers the list.
- **Limits** so one list stays sensible: 1000 items, 5 tags of up to 30 characters, 120 characters for a name, 300 for a description, 500 for an item.
- **Export version 3** carries lists, their items and `projects.isDefault`. Versions 1 and 2 still import.
- **Tracked lists on the phone are not kept offline.** Unlike Goals they show "Keel is not reachable" when `keel serve` is away; ADR 0003 allows no offline writes, and lists did not need a last-seen copy to be useful.
