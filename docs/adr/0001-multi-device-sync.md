# 0001. Multi-device: a synced local replica of a hosted libSQL database

- **Status:** Proposed
- **Date:** 2026-10-12
- **Target release:** 0.3.0

## Context

Keel stores everything in one SQLite file on one machine (`~/.keel/keel.db`). People who work on more than one computer (a work laptop and a personal one, say) need the same commitments, projects and resume notes on each, or promises slip on whichever machine they didn't check.

What exists in 0.2.0:

- **Copy once:** `keel export` on one device, `keel import` on another. A snapshot; the two copies drift apart immediately.
- **Share one hosted database by hand:** set `KEEL_DB_URL=libsql://...` and `KEEL_DB_TOKEN=...` on every device. It works (CI runs the core tests against a libSQL server), but the token sits in plain text in a shell profile, nothing moves existing data across, and every command waits on the network.

Keel was built for this step from the start (spec section 6, the Turso-ready rules): one place opens the database, all access is async, writes go through `batch()`, SQL is portable, ids are ULIDs and refs are display-only.

## Decision drivers

1. **Speed stays local.** Commands like `today` and `ls` must feel as instant as they do now.
2. **No conflicts to resolve.** A single person rarely edits the same item on two devices at once; Keel should never ask them to merge.
3. **The secret never lands in a file.** Not in shell profiles, config files, logs, `--json` output or exports.
4. **Reading works offline.** On a train, `today` still shows the day.
5. **Nothing is lost silently.** If a change can't be saved, the user is told on the spot.
6. **Small surface.** One new command family, no new server for us to run.

## Options considered

### A. Every device talks to the hosted database directly

`createClient({ url: 'libsql://...', authToken })`, as the environment variables already allow.

- Good: simplest; one source of truth; nothing new to build in storage.
- Bad: every command pays a network round trip (roughly 50 to 200 ms, more on poor connections); nothing works offline, not even `today`.

### B. A local replica that syncs with the hosted database (chosen)

libSQL embedded replicas: `createClient({ url: 'file:~/.keel/keel.db', syncUrl: 'libsql://...', authToken })`. Reads are served from the local file. Writes are sent to the hosted primary and then visible locally ("read your own writes"). Keel syncs on start and after each write, and `keel serve` also syncs on a timer.

- Good: local-speed reads; reading works offline; a single primary means no merge conflicts; uses a capability of the client library Keel already depends on.
- Bad: writes need a connection (see Consequences); the local file is a replica managed by the library, so it must not be edited by other tools.

### C. Sync the SQLite file through iCloud, Dropbox or similar

- Rejected: file-sync services copy whole files and can interleave writes from two machines, which corrupts SQLite databases. No conflict story at all.

### D. Our own sync protocol (event log or CRDTs, merged on each device)

- Rejected for now: true offline writes, but a large amount of subtle code (merge rules per field, tombstones, clock skew) and a sync server to run. Out of proportion for a single-user tool. Revisit only if offline writes become a real need and option B's library support doesn't cover it.

## Decision

Adopt **option B**, with these product rules:

1. **Connecting is explicit:** `keel db connect <libsql-url>` asks for the token with hidden input, verifies it, and stores it in the operating system's secret store (macOS Keychain; the Secret Service keyring on Linux). The URL (not secret) goes in `~/.keel/config.json`.
2. **First device moves the data:** if the hosted database is empty and the local one isn't, Keel offers to copy local data up (`export`/`import` path, one batch, counts verified afterwards).
3. **Further devices adopt it:** if the hosted database has data, Keel shows the counts and asks to use it. If that device also has local data, Keel never merges the two: it saves the local data as a JSON backup first and says where.
4. **Offline writes are refused clearly** in 0.3.0: "You're offline, so this wasn't saved." Reads keep working from the replica.
5. **Environment variables still win:** `KEEL_DB_URL` / `KEEL_DB_TOKEN` override the stored configuration, for CI and scripts.
6. **Daily backups continue** on every device, as plain JSON in the local backups folder.

## User story

*As someone with a work laptop and a personal one, I want the same promises on both, so nothing slips whichever machine I open.*

**Once, on the first device**

1. Create a free database at turso.tech (or `turso db create keel`) and a token for it.
2. `keel db connect libsql://keel-you.turso.io`
3. `Token (hidden): ********` → `✓ Connected to keel-you.turso.io`
4. `The hosted database is empty. Copy your data there? 4 clients, 31 commitments, 12 resume notes. Y/n` → `✓ Copied and checked.`
5. `Now synced. Your token is in the macOS Keychain.` The banner and the browser header say `synced` instead of `local`.

**On the second device**

1. `npm install -g @nouisi/keel`
2. `keel db connect libsql://keel-you.turso.io`, then the token.
3. `Found 4 clients and 31 commitments. Use them on this device? Y/n`
4. (If this device had its own data: `This device has local data too (1 client, 3 commitments). Saved it to ~/.keel/backups/keel-local-2026-10-14.json before switching.`)
5. `keel today` shows the same day as on the first device.

**Day to day**

- Every command works as before, at local speed.
- Offline: `today`, `ls`, `show` work; `owe`, `done` and other writes say they weren't saved.
- `keel db` shows where data lives, the last sync time and where the token is kept. It never prints the token.
- `keel db disconnect` removes the token from this device and leaves a local copy, so the device keeps working on its own.
- Lost a laptop: create a new token in Turso (invalidating the old one) and run `keel db connect` again on the devices you still have.

## Consequences

**Good**

- The same Keel on every device with no change to commands or speed.
- No merge conflicts, because there is one primary.
- The token is never written to a file Keel controls.
- The browser terminal (`keel serve`) gets multi-device for free, since it uses the same storage.

**Costs and risks**

- Writes need a connection. Mitigation: a clear message and `in` capture can be retried; offline writes can follow later if libSQL's offline-write support matures (a new ADR would record that).
- A third-party service (Turso) holds the data. Mitigations: any libSQL server works, including a self-hosted `sqld`; Turso encrypts data at rest; the token is scoped to the one database; `keel export` keeps the data portable.
- Local backups and the replica are unencrypted files on the device, as they are today. Encryption at rest is a separate decision.
- A secret-store dependency per OS. Where none is available, Keel says so and falls back to a file readable only by the user (mode 600), with a warning.

## Implementation outline

1. `packages/core`: open the database with `syncUrl` when configured; sync after writes; surface "offline" as a `KeelError`.
2. `apps/cli`: `keel db`, `keel db connect`, `keel db disconnect`; secret-store helper (`security` on macOS, `secret-tool` on Linux); config file; storage label `synced`.
3. Copy-up and adopt flows reuse `exportJson` and `import` (one batch, verified counts).
4. Tests: replica against a local `sqld` in CI (the libsql-server job already exists), connect/adopt/refuse-to-merge flows, token never present in output or exports.
5. Docs: a "Use Keel on several devices" section in the Get started guide; this record moves to Accepted.

## Out of scope

Opening the browser terminal from another device over the internet (a phone, a borrowed computer). That needs a login, and belongs with the authentication decision, which will get its own record.

## Open questions

1. Confirm option B over option A (local speed and offline reads, versus the simplest possible setup).
2. Confirm that refusing offline writes is acceptable for 0.3.0.
3. Confirm paste-the-URL-and-token as the connect step, with a friendlier pairing code as a later improvement.
