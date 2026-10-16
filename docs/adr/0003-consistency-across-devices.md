# 0003. Consistency across devices: guarded writes now, CRDT-ready data for later

- **Status:** Proposed
- **Date:** 2026-10-13
- **Target release:** 0.3.2 (guarded writes and the fixes below). The CRDT part only applies if offline writes are ever added, in a later record.

## Context

The question that started this: should Keel use CRDTs (conflict-free replicated data types), and for which features?

Keel is a single-user tool. It has no live editing, no shared cursors and no websockets, and it doesn't need any. But since 0.3.0 ([ADR 0001](0001-multi-device-sync.md)) the same person can use Keel on several devices: a work laptop, a personal laptop, a shell left open all day, `keel serve` in a browser tab. Two of those can change the same commitment, project or client. The owner's requirement is strict: **the data must never end up in an inconsistent state, and no change may be lost or overwritten without saying so.**

### What a CRDT is for

A CRDT is a data structure that several copies can change *independently*, with no coordinator, and that always merges to the same result whichever order the changes arrive in. Examples: a counter where each device keeps its own tally (merged by adding), a set where adds and removes are tagged so a merge knows which wins, a "last writer wins" field stamped with a clock, and text CRDTs (Yjs, Automerge) for character-level co-editing.

CRDTs pay off when copies **diverge**: when two devices both accept writes without talking to each other (offline, or peer to peer) and must merge later.

### How Keel syncs today

- One hosted libSQL database (Turso or `sqld`) is the **single primary**. Every write goes straight to it in one `batch()`, which is one atomic transaction ([`store.ts`](../../packages/core/src/store.ts)).
- Each device reads from a local replica. The replica syncs when Keel opens, after each write, before a command if the last sync is over 10 seconds old, and every 30 seconds in `keel serve`.
- **Offline writes are refused.** Reads keep working from the replica.

So the copies never diverge: there is exactly one ordered history of writes, kept by the primary. **That is the problem CRDTs solve, and Keel doesn't have it today.** Adding a CRDT layer now would add a merge step that never has anything to merge.

### The problem Keel does have: writes decided on a stale copy

A command reads from the local replica, decides what to do, then writes to the primary. The replica can be seconds (or, in a long shell session that just woke from sleep, minutes) behind what another device already wrote. A write based on that old view can overwrite or contradict a newer one, and nothing notices. This is the classic *lost update*. It is solved with **compare-and-set (optimistic concurrency) at the primary**, not with CRDTs.

An audit of the 0.3.1 code found these concrete cases:

| # | Where | What can happen today | Severity |
|---|---|---|---|
| 1 | `done` / `drop` ([`edit.ts:36`](../../packages/core/src/commands/edit.ts)) | Laptop drops c42. The desktop's copy still shows c42 open, so `done c42` passes the "already closed?" check and overwrites *dropped* with *done*. Both events are logged; the kept rate counts it as kept. | High: silent overwrite of a state change |
| 2 | `renegotiate` ([`edit.ts:66`](../../packages/core/src/commands/edit.ts)) | The new count is computed on the device (`renegotiatedCount + 1`). Two renegotiations from two stale copies both write 1 → 2, so one is lost. | Medium: wrong number in the review |
| 3 | New refs ([`store.ts:116`](../../packages/core/src/store.ts)) | `nextRef` is `max(ref_no) + 1` on the local copy. `owe` on two devices close together both pick c43; the second fails with a raw UNIQUE error. | Medium: a confusing error |
| 4 | Retry after a dropped connection ([`store.ts:81`](../../packages/core/src/store.ts)) | After a connection error, a UNIQUE error on retry is taken to mean "the first attempt landed". If another device took the ref instead (case 3), the change is **lost silently**, and the command then shows the other device's commitment as if it were the new one. | **High: silent loss** |
| 5 | Context log ([`projects.ts:58`, `:72`, `:131`](../../packages/core/src/commands/projects.ts)) | `switch` closes the one open log row it read. Switching on two devices close together leaves an open row that never closes, so `summary` keeps adding time to that client forever. | Medium: wrong time per client |
| 6 | New people ([`store.ts:250`](../../packages/core/src/store.ts)) | `owe ... @meera` on two devices, both seeing no @meera yet: both insert, the second fails on the unique handle. Same pattern for `client new` / `project new` / `set slug:`. | Low: a raw error, nothing lost |
| 7 | Edits to deleted or merged rows | `set c42 title:...` on a copy that hasn't seen `c42`'s deletion updates a deleted row: the user sees "updated", the change is invisible. `owe ... @rav` after `person merge @rav @ravi` on another device attaches the commitment to the merged-away person. | Medium: silent, misleading success |
| 8 | Same field on two devices (`set c42 due:fri` vs `due:mon`) | The later arrival at the primary wins. Updates are per field, so *different* fields from two devices both survive. | Acceptable, if the user is told (see Decision) |

Things that are already safe: creating commitments, inbox items, resume notes, context log rows and events (each is a new row with a ULID, so two devices can't collide on the row), `focus` (per-slot upserts, the whole top 3 is meant to be replaced), and soft deletes (the row stays, so a delete is never undone by a stale write).

## Decision drivers

1. **No silent loss and no silent overwrite.** Every write either applies to the state the user saw, or the user is told what changed and nothing is half-applied.
2. **Never ask the user to merge** (kept from ADR 0001). When a conflict has an obvious answer, Keel applies it; otherwise it refuses with a clear message.
3. **No extra round trip on the normal path.** ADR 0001 worked hard to get a change down to about 1 second from Asia to Europe; consistency must not double that.
4. **Small surface.** No new server, no new service, no native extension in the npm package.
5. **Keep the door open for offline writes**, so that adding them later is a new record, not a rewrite.

## Options considered

### A. Do nothing; the single primary is enough

- Good: no work.
- Bad: cases 1, 2, 4, 5 and 7 above are real today. Rejected.

### B. Adopt CRDTs now (Automerge or Yjs documents, or cr-sqlite in SQLite)

Each device keeps its own full copy, accepts writes offline, and merges with the others through CRDT rules.

- Good: offline writes; a well-studied merge model.
- Bad: solves divergence, which Keel doesn't have while writes go to one primary. Doesn't solve Keel's real cases: CRDTs can't keep a value unique (refs c43, client slugs, @handles) or enforce "a closed commitment can't be closed again" without coordination, and those are exactly the rules that matter here. Text CRDTs are built for character-by-character co-editing, which Keel will never do (notes are replaced whole; resume notes are new rows). cr-sqlite means a native extension in every install and would replace the hosted libSQL primary that ADR 0001 just adopted. Large, subtle code (per-field merge rules, tombstone cleanup, clocks) for a single user. Rejected for now.

### C. Read from the primary before every write

Write commands do their reads against the hosted database instead of the replica, or sync first.

- Good: simple; shrinks the stale window to the time between the read and the write.
- Bad: adds one or more network round trips to every change (0.3 to 1 second each from Asia to Europe), and still leaves a small window, so the guards in D are needed anyway. Rejected.

### D. Guarded writes at the primary, plus CRDT-ready data rules (chosen)

Every write that depends on what the device read says so, and the primary refuses it if that is no longer true. Writes that don't depend on a read (new rows) are made collision-free. The data model follows a few extra rules so that a later offline mode can merge with CRDT semantics without a schema rewrite.

- Good: closes every case above; no extra round trip unless there actually is a conflict; small; keeps libSQL and Turso.
- Bad: each write command needs its guard written and tested; a guard needs a small amount of SQL care (see the implementation outline).

## Decision

Adopt **option D**.

### 1. Guarded writes (optimistic concurrency)

- Every update to an existing row carries a **guard**: the condition the command checked on its copy. For example, `done` updates `WHERE id = ? AND status = 'open' AND deleted_at IS NULL`; `set c42 due:fri` updates `WHERE id = ? AND deleted_at IS NULL`. Guards check the facts the command relied on, not the whole row, so a `nudge` on one device and a `set title:` on another don't conflict.
- If a guarded update changes no rows, **the whole batch is rolled back** (the event row, a new person, a context log change: nothing is half-applied).
- Keel then syncs the copy and **runs the command once more on the fresh data**. Most conflicts resolve themselves this way (the ref was just taken, the person now exists). If the command's own checks now fail, the user gets its usual message plus where it came from:

  ```
  ! c42 was dropped on another device at 14:05. Nothing changed.
  ```

- Interactive commands (`switch` with a resume-note prompt, `meeting`, `triage`, `review`) don't ask their questions twice: on a conflict they keep the answers already given and only retry the write; if the retry also fails, they show what changed and keep the typed text so nothing is lost.
- Counters are changed in SQL, never computed on the device: `renegotiated_count = renegotiated_count + 1`.

### 2. Collision-free creation

- Refs are assigned **by the primary inside the insert**: `ref_no = (SELECT coalesce(max(ref_no), 0) + 1 FROM commitments)`. The primary applies writes one at a time, so two devices can never get the same ref. The command reads its row back by id to learn the ref.
- People are created with `INSERT ... ON CONFLICT(handle) DO NOTHING`, then looked up by handle, so two devices adding @meera end up with one @meera.
- Slug clashes (`client new`, `project new`, `set slug:`) get the friendly "already exists" message whether the clash was seen on the copy or found by the primary.
- The retry after a dropped connection no longer *assumes* the first attempt landed: it checks for its own row by id, and only then reports success (fixes case 4).

### 3. Rules for each kind of data

| Data | Rule when two devices touch it |
|---|---|
| New rows (commitments, inbox, resume notes, events, context log) | Both kept. Never a conflict. |
| Status of a commitment (`done`, `drop`, `set status:`) | **First wins.** A second close is refused with what happened. Reopening (`set status:open`) is explicit and guarded on the current status. |
| Plain fields (title, due, person, project, name, slug, project status) | **Last arrival wins, per field.** Different fields from two devices both apply. The overwritten value stays in the `events` history (`show c42`). |
| Counters (`renegotiated_count`) | Added at the primary, never lost. |
| Delete or archive vs. an edit | **Delete wins.** The edit is refused: "c42 was deleted on another device." Soft deletes mean backups still hold it. |
| Merged people | A merged-away handle is treated as missing; `owe @rav` after a merge asks for the handle again with a hint pointing to `@ravi`. |
| Focus (today's top 3) | The last `focus` replaces the whole list, as it does today. |
| Context (`working on`) and its time log | One context for the person, shared by all devices (you are on one device at a time). `switch`/`park` close **every** open log row, not just the one they read, so time can't run on forever (fixes case 5). |

### 4. CRDT-ready data rules (added to spec section 6)

These cost almost nothing now and keep offline writes possible later:

1. **Field-level writes only.** Never write a whole row back; update only the fields that changed (already true; now a rule).
2. **Counters are derivable from events.** `renegotiated_count` must always equal the number of `renegotiated` events, so an offline mode can rebuild it by merging event logs (a grow-only counter).
3. **Append-only where the history is the point.** Resume notes, events and the context log are only ever added to (already true).
4. **Tombstones, never hard deletes** (already rule 7 in section 6).
5. **Times on rows are for display, not for ordering.** Device clocks drift; conflicts are ordered by arrival at the primary. If offline writes ever need ordering, they get a hybrid logical clock then.
6. **Tags become a set**, not a space-joined string, before anything merges them (they're only ever replaced whole today, so this can wait for the offline record).

### 5. Where CRDTs would fit, if offline writes come

For the record, so a later ADR starts from here. The likely shape is an **outbox of commands** rather than CRDT documents: offline, Keel queues the commands typed (`done c42`, `owe ...`), and on reconnect replays them against the primary through the same guards. Keel's commands are already the user's intent, so replaying them gives the same "first wins / last wins / delete wins" rules above without a second merge system. Where state does have to merge, the CRDT mapping is:

| Keel data | CRDT shape |
|---|---|
| Commitments, inbox items, resume notes, events | Grow-only set keyed by ULID |
| Plain fields | Last-writer-wins register per field (hybrid logical clock) |
| `renegotiated_count` | Grow-only counter (or derived from events) |
| Tags | Observed-remove set |
| Deletes, archives | Tombstones, delete wins |
| Commitment status | Not a plain register: a small state machine where closing wins over editing and the first close wins |
| Refs, slugs, @handles | **No CRDT can do this.** Offline items get a provisional ref (`c?`) and the real one on sync |
| Free text (titles, notes) | Whole-value register. Not a text CRDT: no co-editing |

## User story

*I keep a shell open on my desktop all day and use my laptop in meetings. I want whatever I do on either to be the truth, and never to undo what I did on the other.*

1. In a meeting, on the laptop: `drop c42` → `✓ c42 dropped`.
2. Back at the desktop, the shell has been open since morning. `done c42` →
   `! c42 was dropped on another device at 14:05. Nothing changed.`
3. `owe pricing deck @ravi due:thu` on the desktop while the laptop captures `owe budget @meera due:fri`: both save, as c43 and c44. No error.
4. `set c43 due:fri` on the laptop and `set c43 title:"Send revised deck"` on the desktop: both changes apply.
5. `set c43 due:fri` on one and `set c43 due:mon` on the other: the later one wins, and `show c43` lists both moves.

## Consequences

**Good**

- No silent loss and no silent overwrite across devices, which ADR 0001 left open.
- The normal path is unchanged: still one request per change. A conflict costs one sync and one retry.
- Fixes a real silent-loss bug (case 4) and a summary-time bug (case 5) that exist today.
- No new dependency, server or native code.
- Offline writes stay possible later, with the rules and the CRDT mapping above as the starting point.

**Costs and risks**

- Every write command needs its guard, and tests for its conflict path. A new command without a guard can reintroduce the problem: the tests below include a check that every update in `commands/` has a guard.
- "Last arrival wins" for plain fields means a stale `set` can still replace a newer value of the *same* field. It is recorded in the history, not lost, and it's the behaviour a single person expects ("I typed it last").
- The guard mechanism (below) relies on SQLite's `changes()` behaving the same in a libSQL remote batch as in a local file. This must be proved by a test against `sqld` before release.

## Implementation outline

1. `packages/core/src/store.ts`:
   - `guarded(update)`: wraps an update with a guard statement right after it that fails the batch when the update changed no rows. Mechanism: a one-column table `write_guard(ok INTEGER CHECK (ok = 1))` and `INSERT INTO write_guard VALUES (changes())`, deleted again at the end of the batch. A failed CHECK aborts the batch, and `batch()` is a transaction, so nothing applies. One round trip, as now.
   - A `Conflict` error carrying what changed; `Keel.run` catches it, syncs, and runs the command once more.
   - Refs assigned inside the insert; people inserted with `ON CONFLICT DO NOTHING`.
   - Retry after a connection error checks for its own row by id instead of trusting a UNIQUE error.
2. `packages/core/src/commands/`: guards for `done`, `drop`, `renegotiate`, `nudge`, `set`, `focus`, `switch`, `park`, client/project rename, archive and delete, `person rename` and `merge`, `triage`; counters in SQL; close all open context log rows.
3. Migration: the `write_guard` table.
4. Tests: two replicas of one `sqld` in CI (the libsql-server job exists), with one replica deliberately not synced, for each case 1 to 7; the `changes()` guard in a remote batch; a lint-style test that every `update(...)` in `commands/` goes through `guarded`.
5. Docs: spec section 6 gains the CRDT-ready rules; the "Use Keel on several devices" guide gets a short "Using two devices at once" note; this record moves to Accepted.

## Out of scope

- Offline writes. They need their own record; section 5 is its starting point.
- Live updates between devices (pushing a change to an open shell or browser the moment it happens). Not needed: the guards make a stale view safe, and the 10 and 30 second syncs keep it fresh enough.
- Several people sharing one Keel.

## Resolved questions

Settled with the owner on 2026-10-13, as recommended above:

1. **Context is per person, shared by all devices** (as today), with the log fix above. Devices don't keep their own "working on".
2. **`done` vs `drop` on two devices: the first close wins.** The second is refused with what happened, rather than "done always wins", which would flatter the kept rate.
3. **Edit vs delete: delete wins.** The edit is refused and named in the message.
