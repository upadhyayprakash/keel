# 0002. Authentication and encryption: TOTP for the browser terminal, encryption at rest for local data

- **Status:** Proposed
- **Date:** 2026-10-12
- **Target release:** 0.4.0 (after multi-device, [ADR 0001](0001-multi-device-sync.md))

## Context

Keel holds sensitive material: who you owe what, client names, notes on what you're unsure about. Today:

- The database and the daily backups are plain files in `~/.keel`.
- `keel serve` listens on 127.0.0.1 only and checks the `Host` and `Origin` headers, so other websites and other machines can't reach it. It has no login.
- With multi-device (ADR 0001), the same data lives on several machines and in a hosted database.

The owner asked for authentication with a TOTP app (Authy, Google Authenticator, 1Password). Before choosing where it goes, this record states what each measure actually protects against.

## Threat model

| Threat | Example | In scope |
|---|---|---|
| Someone reaches the browser terminal from another device | `keel serve` opened to the network so a phone can use it; someone else on the same Wi-Fi tries it | **Yes** |
| A laptop is lost or stolen, or a backup file leaks | Disk read on another machine; `keel-2026-10-12.json` uploaded somewhere by mistake | **Yes** |
| Someone uses your unlocked, logged-in computer | A colleague at your desk | Partly (a lock screen only) |
| Malware or another program running as you | Anything that can read your files and Keychain | No (out of reach for any app-level measure) |
| Several people sharing one Keel | Teams | No (Keel is single user) |

A key point for the design: **anything that can run `keel` as you can also read `~/.keel` directly.** A login prompt in the CLI does not protect the data from that; only encryption does, and only while the key is out of reach.

## Decision drivers

1. Protect against the in-scope threats for real, not just visibly.
2. Work with any standard authenticator app, offline, no account with us.
3. Never break scripts, pipes and `--json` on the owner's own machine.
4. A lost phone or Keychain must not lock the owner out of their own data.
5. No new service to run.

## Options considered

### Logging in to the browser terminal

- **A. Passphrase only.** Simple, but phishable and reused across sites; no second factor.
- **B. TOTP (RFC 6238) (chosen).** A six-digit code from any authenticator app; works offline; widely understood; the owner asked for it.
- **C. Passkeys (WebAuthn).** Phishing-resistant and the strongest option, but browsers only allow them on HTTPS with a real domain (or localhost), which a LAN address like `192.168.1.20` lacks. A good later addition, recorded here so it isn't forgotten.

### Protecting data at rest

- **D. Rely on full-disk encryption (FileVault, BitLocker).** Already protects a powered-off stolen laptop, but not leaked backup files, and not a disk read while unlocked.
- **E. Encrypt Keel's own files (chosen).** libSQL can encrypt the local database file (`encryptionKey`), and Keel encrypts its backups (AES-256-GCM). The key lives in the operating system's secret store.
- **F. Derive the key from a passphrase typed on every start.** Strong, but every command would ask for it, which breaks scripts and the instant-capture feel.

## Decision

### 1. TOTP login for the browser terminal

- `keel auth enable` creates a 160-bit secret, shows a QR code **in the terminal** (plus the text secret) for the authenticator app, asks for one code to confirm, and prints **ten single-use recovery codes**. The secret is stored in the secret store; recovery codes are stored only as hashes (scrypt).
- With auth on, the browser terminal opens on a code prompt. A correct code starts a session: a random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` over HTTPS), valid for 12 hours, kept in server memory.
- Codes: SHA-1, 6 digits, 30 seconds, one step of clock drift allowed either side; a code that was already used is refused (no replay). Five wrong codes in a minute slow further attempts down.
- **Mandatory beyond localhost:** `keel serve --host <address>` refuses to start unless auth is enabled **and** the connection is HTTPS (`--cert` and `--key`, or `--behind-https-proxy` for a tunnel such as Tailscale or Cloudflare). On localhost, auth is optional.
- `keel auth disable` and `keel auth reset` (new secret, new recovery codes) need a valid code or a recovery code.

### 2. Encryption at rest

- `keel encrypt` turns it on: it creates a random 256-bit key, stores it in the secret store, writes an encrypted copy of the database through export and import, checks the counts, and only then replaces the plain file (the plain file is wiped).
- It shows a **recovery key** once (24 words) and asks the owner to store it in a password manager. That key is what restores the data on a new machine or after losing the Keychain.
- Backups are written encrypted from then on. `keel export` stays plain on purpose, since it's an explicit request, and says so.
- Commands keep working without prompts, because the key comes from the secret store.

### 3. Optional lock for the shell

- `keel auth lock-shell on` makes the Keel shell ask for a code when it opens. Labelled honestly in the help text: it's a lock screen for an unlocked desk, not protection of the data (encryption is). One-shot commands and scripts are not gated.

## User stories

**Use the browser terminal from my phone at home, safely**

1. `keel auth enable` → scan the QR code with Authy → type the code → save the recovery codes.
2. `keel serve --host 0.0.0.0 --behind-https-proxy` behind Tailscale (or `--cert`/`--key`).
3. On the phone, open the address → enter the six-digit code → the terminal, for 12 hours.
4. Someone else on the network gets only the code prompt, and is slowed down after five wrong guesses.

**My laptop is stolen**

1. The database and backups on it are encrypted; the key is in the Keychain, which is locked with the login password.
2. On the new machine: install Keel, `keel db connect` (ADR 0001) or restore a backup with the recovery key, then `keel encrypt` again.

**I lost my phone**

1. Log in to the browser terminal with a recovery code (single use), or run `keel auth reset` in the terminal on your own machine with a recovery code.
2. Scan the new QR code on the new phone.

## Consequences

**Good**

- The browser terminal can safely leave localhost, which multi-device users will want.
- A stolen disk or leaked backup no longer exposes the data.
- Scripts, pipes and `--json` keep working unchanged on the owner's machine.
- Works with any authenticator app; no account, no service.

**Costs and risks**

- Two secrets for the owner to keep safe: the recovery codes and the recovery key. Losing the recovery key and the Keychain together means losing the encrypted data; the setup flow says this plainly and checks the owner has saved it.
- TOTP can be phished (unlike passkeys); acceptable for a single-user tool, with passkeys noted as a follow-up.
- Encrypted databases can't be opened with the plain `sqlite3` tool; `keel export` remains the way out.
- Embedded replicas (ADR 0001) must support `encryptionKey`; this is to be verified before 0.4.0, and the hosted copy relies on the provider's own encryption at rest.

## Implementation outline

1. Core: `encryptionKey` passed to the client when present; encrypted backup format (versioned header, AES-256-GCM, key from the secret store).
2. CLI: `keel auth enable|disable|reset|status|lock-shell`, `keel encrypt`, terminal QR rendering, recovery codes and recovery key.
3. Server: TOTP verification, session cookies, rate limiting, `--host`, `--cert`/`--key`, `--behind-https-proxy`, refusal rules.
4. Web: a code prompt before the terminal, and a "locked" state when the session ends.
5. Tests: RFC 6238 test vectors, replay refusal, rate limiting, refusal to bind beyond localhost without auth and HTTPS, encrypted round trip, wrong-key failure.

## Out of scope

Several users per Keel, single sign-on, and protection against software already running as the owner.
