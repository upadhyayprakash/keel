# 0002. Authentication and encryption: passkey login for the browser terminal and Goals, encryption at rest for local data

- **Status:** Proposed
- **Date:** 2026-10-12
- **Revised:** 2026-10-16, before acceptance: passkeys first with TOTP as an optional fallback, pairing and recovery from the terminal, session rules. The first draft chose TOTP and listed passkeys as a later addition; Goals (ADR 0004, on `feat/goals`) needs a phone login that works from an installed app, so the order changed.
- **Target release:** 0.4.0 (after multi-device, [ADR 0001](0001-multi-device-sync.md)). The login ships first, on its own branch (`feat/passkeys`), and Goals build on it.

## Context

Keel holds sensitive material: who you owe what, client names, notes on what you're unsure about. Today:

- The database and the daily backups are plain files in `~/.keel`.
- `keel serve` listens on 127.0.0.1 only and checks the `Host` and `Origin` headers, so other websites and other machines can't reach it. It has no login.
- With multi-device (ADR 0001), the same data lives on several machines and in a hosted database.
- Goals (ADR 0004) put a phone app on `keel serve`, reached over a tunnel (Tailscale Funnel or a Cloudflare named tunnel) that gives it HTTPS and a stable hostname. The phone has no terminal and no authenticator app is guaranteed to be on it.

The owner first asked for TOTP. With Goals the main client becomes a phone, which favours passkeys: one tap with Face ID or a fingerprint, nothing to type, nothing to phish. This record states what each measure protects against, then chooses.

## Threat model

| Threat | Example | In scope |
|---|---|---|
| Someone reaches the browser terminal or Goals from another device | `keel serve` behind a tunnel so the phone can use it; anyone on the internet who finds the address | **Yes** |
| A laptop is lost or stolen, or a backup file leaks | Disk read on another machine; `keel-2026-10-12.json` uploaded somewhere by mistake | **Yes** |
| A phone with a live session is lost | The installed Goals app on a stolen phone | **Yes** (revoke from the terminal) |
| Someone uses your unlocked, logged-in computer | A colleague at your desk | Partly (a lock screen only) |
| Malware or another program running as you | Anything that can read your files and Keychain | No (out of reach for any app-level measure) |
| Several people sharing one Keel | Teams | No (Keel is single user; the Goals partner gets a separate, narrow link, ADR 0004) |

A key point for the design: **anything that can run `keel` as you can also read `~/.keel` directly.** A login prompt in the CLI does not protect the data from that; only encryption does, and only while the key is out of reach. The same point makes the terminal a safe place for pairing and recovery: whoever can run `keel` on the owner's machine already has everything a login would guard.

## Decision drivers

1. Protect against the in-scope threats for real, not just visibly.
2. Sign in from a phone, including an installed home-screen app, with no code to type.
3. No account with us and no new service to run.
4. Never break scripts, pipes and `--json` on the owner's own machine.
5. A lost phone must not lock the owner out of their own data, and must be easy to cut off.

## Options considered

### Logging in to the browser terminal and Goals

- **A. Passphrase only.** Simple, but phishable and reused across sites; no second factor.
- **B. TOTP (RFC 6238).** A six-digit code from any authenticator app; works offline and on any address, including a LAN IP. But it is phishable, and typing a code every time on a phone is the friction Goals is meant to remove. Kept as a fallback.
- **C. Passkeys (WebAuthn) (chosen).** Phishing-resistant, one tap on the phone, supported by current iOS, Android and desktop browsers, and by installed PWAs. Needs HTTPS on a real hostname (or localhost); the tunnel from ADR 0004 provides that. A passkey is bound to that hostname. Libraries: `@simplewebauthn/server` and `@simplewebauthn/browser` (MIT, no service).

### Protecting data at rest

- **D. Rely on full-disk encryption (FileVault, BitLocker).** Already protects a powered-off stolen laptop, but not leaked backup files, and not a disk read while unlocked.
- **E. Encrypt Keel's own files (chosen).** libSQL can encrypt the local database file (`encryptionKey`), and Keel encrypts its backups (AES-256-GCM). The key lives in the operating system's secret store.
- **F. Derive the key from a passphrase typed on every start.** Strong, but every command would ask for it, which breaks scripts and the instant-capture feel.

## Decision

### 1. Passkey login for the browser terminal and Goals

**Where login applies**

- Plain `keel serve` (127.0.0.1, no public address) stays as today: no login, `Host` and `Origin` checks only.
- `keel serve --public-url https://<name>` serves Keel behind an HTTPS tunnel or proxy. `--public-url` sets the passkey relying party (its hostname is the RP ID, the URL is the expected origin) and adds that hostname to the allowed `Host` and `Origin` values. With it, **every request needs a session**, except the sign-in and pairing pages and their API calls, whatever address the request came from (a tunnel forwards to 127.0.0.1, so the source address proves nothing). It replaces the first draft's `--behind-https-proxy`.
- `keel serve --host <address>` binds beyond localhost. It refuses to start unless login is set up (at least one passkey, or TOTP) **and** the connection is HTTPS: `--cert` and `--key`, or `--public-url` for a proxy in front. Login is then required on every request, as above.
- The rules above are enforced in the server, not left to the docs, and tested.

**Pairing a phone (from the terminal only)**

- `keel auth passkey add [--name "My iPhone"]` needs `keel serve` running with `--public-url`. It creates a one-time pairing token (256-bit random, stored only as a SHA-256 hash), valid for **10 minutes** and for **one** registration, and prints a QR code **in the terminal** (plus the link as text) for `https://<name>/pair#<token>`. The token sits after `#`, so it never reaches logs or the tunnel's request records; the pairing page posts it to the server.
- The phone opens the link and creates a passkey: discoverable credential (resident key), user verification required (Face ID, fingerprint or device PIN), attestation `none`. On success the phone is signed in and the terminal prints "Paired: <name>".
- The first device and every later one are paired the same way. There is no way to add a passkey from the browser alone, so someone who reaches the address but not the owner's machine cannot add one.

**Signing in**

- The sign-in page offers "Sign in with passkey" (a discoverable-credential request, so no username), with user verification required. The server checks the challenge (single use, 5 minutes), the origin and RP ID against `--public-url`, the signature, and the signature counter where the authenticator keeps one.
- Ten failed attempts in a minute slow further attempts down.

**Sessions**

- A session is a random 256-bit token in a cookie: `HttpOnly`, `Secure`, `SameSite=Lax` (Lax, not Strict, so opening the app from a cue notification or a link still carries the session; the existing `Origin` check keeps blocking cross-site writes), `Path=/`.
- Sessions are kept in `~/.keel/auth/sessions.json` as hashes with the passkey they came from, so they survive a restart of `keel serve` or a sleeping laptop.
- Lifetime: **30 days** for Goals, renewed on use, so the installed app rarely asks to sign in; **12 hours** for the browser terminal, which can run any command. A Goals session does not open the terminal; the terminal asks for the passkey again (one tap) when its own session is missing.
- `keel auth sessions` lists them; `keel auth sessions revoke <id>` or `--all` ends them.

**Recovery and a lost phone**

- `keel auth passkey list` shows each passkey with its name, when it was added and when it was last used. `keel auth passkey remove <name or id>` deletes it and ends every session it started.
- Lost phone: run `keel auth passkey remove` on your own machine, then `keel auth passkey add` on the new phone. No recovery codes: the terminal is the recovery path, for the reason in the threat model.
- Moving to another hostname (a new tunnel name) means pairing again, because a passkey is bound to its hostname. `keel serve` warns when `--public-url` differs from the hostname the stored passkeys were made for.

**Where it is stored**

- Passkeys (credential ID, public key, counter, transports, name, RP ID, dates) in `~/.keel/auth/passkeys.json`, per machine and **not synced** through ADR 0001: a passkey belongs to one server's hostname. Nothing in that file is a secret, but it is written with owner-only permissions (0600) because changing it would let someone add a login.

### 2. TOTP as an optional fallback

- For a browser without passkeys, or a LAN address over `--cert` and `--key` where passkeys can't work. Off by default.
- `keel auth totp enable` creates a 160-bit secret, shows a QR code **in the terminal** (plus the text secret) for the authenticator app, and asks for one code to confirm. The secret is stored in the secret store. `keel auth totp disable` turns it off. No recovery codes, as with passkeys: the terminal is the recovery path.
- Codes: SHA-1, 6 digits, 30 seconds, one step of clock drift allowed either side; a used code is refused (no replay); five wrong codes in a minute slow further attempts down.
- A TOTP sign-in gives a 12-hour session, for Goals and the terminal alike.
- `keel auth status` shows what is set up: passkeys, TOTP, live sessions, and the hostname the passkeys belong to.

### 3. Encryption at rest

- `keel encrypt` turns it on: it creates a random 256-bit key, stores it in the secret store, writes an encrypted copy of the database through export and import, checks the counts, and only then replaces the plain file (the plain file is wiped).
- It shows a **recovery key** once (24 words) and asks the owner to store it in a password manager. That key is what restores the data on a new machine or after losing the Keychain.
- Backups are written encrypted from then on. `keel export` stays plain on purpose, since it's an explicit request, and says so.
- Commands keep working without prompts, because the key comes from the secret store.

### 4. Optional lock for the shell

- `keel auth lock-shell on` makes the Keel shell ask for a TOTP code when it opens, so it needs TOTP set up (a terminal can't use a passkey). Labelled honestly in the help text: it's a lock screen for an unlocked desk, not protection of the data (encryption is). One-shot commands and scripts are not gated.

## User stories

**Use Keel from my phone, safely**

1. Set up the tunnel (Tailscale Funnel or a Cloudflare named tunnel) and run `keel serve --public-url https://keel.example.ts.net`.
2. At the laptop: `keel auth passkey add --name "My iPhone"`, scan the QR code with the phone, approve with Face ID.
3. Add Goals to the home screen. It stays signed in for 30 days of use; opening the terminal page asks for one more tap.
4. Anyone else who finds the address gets only the sign-in page, and cannot pair a device without the owner's terminal.

**I lost my phone**

1. On my own machine: `keel auth passkey remove "My iPhone"`. Its sessions end at once.
2. `keel auth passkey add` again for the new phone.

**My laptop is stolen**

1. The database and backups on it are encrypted; the key is in the Keychain, which is locked with the login password.
2. On the new machine: install Keel, `keel db connect` (ADR 0001) or restore a backup with the recovery key, then `keel encrypt` again, and pair the phone again.

**I only use Keel on this machine**

1. `keel serve` works as today, with no login, and the CLI never asks for one.

## Consequences

**Good**

- The browser terminal and Goals can safely leave localhost, which the phone and multi-device users need.
- Sign-in on the phone is one tap and can't be phished.
- A lost phone is cut off in one command; the only secret left to keep is the encryption recovery key.
- A stolen disk or leaked backup no longer exposes the data.
- Scripts, pipes and `--json` keep working unchanged on the owner's machine. No account, no service.

**Costs and risks**

- Passkeys need HTTPS on a stable hostname, so phone use depends on the owner's tunnel; a new hostname means pairing again.
- A 30-day Goals session on a stolen, unlocked phone stays open until it is revoked; the terminal session is shorter (12 hours) for that reason.
- Pairing needs `keel serve` running with `--public-url` while the owner is at the machine.
- Losing the encryption recovery key and the Keychain together means losing the encrypted data; the setup flow says this plainly and checks the owner has saved it.
- Encrypted databases can't be opened with the plain `sqlite3` tool; `keel export` remains the way out.
- Embedded replicas (ADR 0001) must support `encryptionKey`; this is to be verified before 0.4.0, and the hosted copy relies on the provider's own encryption at rest.

## Implementation outline

The login (sections 1 and 2) is built first, on `feat/passkeys`; encryption at rest and the shell lock follow.

1. Core and CLI: passkey and session stores in `~/.keel/auth/`, `keel auth passkey add|list|remove`, one-time pairing tokens, terminal QR rendering, `keel auth sessions`, `keel auth status`.
2. Server: WebAuthn registration and sign-in with `@simplewebauthn/server`, session cookies, a guard on every route except sign-in and pairing, rate limiting, `--public-url`, `--host`, `--cert`/`--key`, and the refusal rules.
3. Web: sign-in and pairing pages for the browser terminal and Goals with `@simplewebauthn/browser`, and a "signed out" state when a session ends.
4. TOTP fallback: `keel auth totp enable|disable`, the code prompt, RFC 6238 verification.
5. Tests: pairing token expiry and single use, wrong origin and RP ID, session expiry and revoke, removing a passkey ends its sessions, login required on every request with `--public-url`, refusal to bind beyond localhost without login and HTTPS, plain `keel serve` unchanged; RFC 6238 test vectors and replay refusal for TOTP.
6. Later: `keel encrypt`, encrypted backups, recovery key, `keel auth lock-shell`, with an encrypted round trip and wrong-key failure in the tests.

## Out of scope

Several users per Keel, single sign-on, syncing passkeys between Keel servers, and protection against software already running as the owner.
