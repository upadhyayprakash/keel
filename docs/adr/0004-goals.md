# 0004. Goals: a goal mode in Keel, with a phone app served by `keel serve`

- **Status:** Accepted (2026-10-16)
- **Date:** 2026-10-16
- **Target release:** 0.5.0 (after the login in [ADR 0002](0002-authentication-and-encryption.md), revised for passkeys, ships in 0.4.0)

## Context

Keel keeps promises and priorities steady. It has no way to set and finish a small personal goal: something with a finish line, days to a few weeks away, with 3 to 15 steps, in any area of life (a first 5K, clearing out a room, a side project).

People rarely fail at such goals for lack of a list. They fail because the goal is vague, they never start, momentum dies in the middle, one missed day turns into quitting, or the last 10% drifts. A small set of well-tested methods fixes most of this, and Goals builds them into the flow so they are hard to skip:

| Method | Where it shows in Goals |
|---|---|
| A specific finish line and deadline (goal-setting research) | "Done means..." and a deadline, required |
| Planning fallacy | The deadline is padded using how late past goals ran |
| Time budget ("appetite", Shape Up) | "Time you will give it" |
| One obstacle and an if-then plan (WOOP, implementation intentions, the strongest checked finding) | "If [obstacle], then I will [action]", required to save |
| Next actions with a when/where cue, a tiny first step (GTD) | Steps with cue chips; the first one marked |
| Showing the smaller area of progress (Koo and Fishbach 2012) | "4 of 12 done" early, "2 left" past halfway |
| "Never miss twice" (Lally et al. 2010) | After a missed cue, offer the step's minimum version |
| Accountability, with a person in the loop | One partner per goal who sees progress and checks in |
| After-action review | Close as done or dropped on purpose, then 3 questions |

Goals has to work on a phone, where these moments happen: the cue at 7:00 before a run, the missed day, the partner's note. Keel today is a CLI and a browser terminal that `keel serve` keeps on localhost.

### What the phone needs from a server

1. **The app over HTTPS, at a stable address.** Browsers only install a PWA and allow push on HTTPS, and a LAN address does not qualify.
2. **The data, without the database token on the phone.** A libSQL token covers the whole database.
3. **A push at the planned time.** A closed web app cannot schedule its own notification; a server sends it through the browser's push service.
4. **A page for the partner**, who is not a Keel user and must see only one goal.

## Decision drivers

1. **No new hosted service.** Keel stays self-hostable from npm and GitHub: anyone who runs `keel serve` has Goals.
2. **One data model** for the CLI, the browser terminal and the phone, under the rules of [ADR 0003](0003-consistency-across-devices.md).
3. **The partner sees one goal and nothing else.**
4. **Keel's look, with as few new tokens as possible.**
5. **Nothing that works today breaks**: the CLI, `keel serve` and the browser terminal.
6. Keep the door open to a hosted service later without a rewrite.

## Options considered

### Where the server lives

- **A. A hosted edge app** (for example Cloudflare Workers with cron for push). Always on, so cue pushes arrive while the laptop sleeps. But it is a second runtime and a new service to keep, and every self-hoster needs an account with it. Rejected for now.
- **B. `keel serve` over a tunnel (chosen).** Goals are routes in Keel's existing Hono server. A tunnel such as Tailscale Funnel or a named Cloudflare Tunnel gives it HTTPS and a stable name; that is the owner's setup, not code. It runs on a laptop today and on any always-on machine (a Raspberry Pi, a home server, a small VM) with no code change. Cost: while the machine sleeps, some things stop (see Consequences).

### Where the app shell lives

- **C. A PWA hosted on a static host** (for example Cloudflare Pages). A polished install address. But the user's server still needs HTTPS, cue pushes still depend on that server being awake, the app and the API sit on different sites (Safari blocks cross-site cookies, so login needs tokens and CORS), and every user runs whatever build was deployed last. Deferred: it belongs with a hosted backend, in a later record.
- **D. The PWA bundled into `@nouisi/keel` and served by `keel serve` (chosen),** the same way the browser terminal is today. One origin, so login is one `HttpOnly` cookie.

### Data access from the phone

- **E. Turso straight from the browser.** Puts a whole-database token on the phone. Rejected.
- **F. Local SQLite in the browser only.** No CLI, no partner. Rejected.
- **G. A small HTTP API in `keel serve` (chosen).** The PWA only ever calls `/api/goals/...`; its base address is one setting, so a hosted app shell could later point at any Keel server.

## Decision

Adopt **B, D and G**.

### 1. Pieces

| Piece | What it is |
|---|---|
| `packages/core` | Goal model and commands; schema and migration; guarded writes per ADR 0003 |
| `apps/cli` | `keel goal new | list | show | done`; goals in `keel today` and the weekly review |
| `apps/server` | `/api/goals/...` for the owner, `/api/partner/...` for partners, web push sending and the cue scheduler |
| `apps/goals` (new) | The phone app: Vite and React, web manifest, service worker, styled only from `@keel/core/ui` palettes. Built into the npm package next to `apps/web` and served at `/goals` |
| `apps/web` | Unchanged |

### 2. Data

New tables, plural camelCase like the existing ones, all with ULID ids, soft deletes and the ADR 0003 rules:

| Table | Holds |
|---|---|
| `goals` | Title, "done means", deadline, appetite, obstacle, if-then plan, status (`active`, `done`, `dropped`), closed at |
| `goalSteps` | Goal, position, text, cue time and place, optional minimum version, first-step flag, status (`open`, `done`) |
| `goalReviews` | Goal, planned vs. happened, why, what to change; used to pad the next deadline |
| `goalPartners` | Goal, partner name, hashed link token, hashed PIN, check-in points, revoked at |
| `goalNotes` | Goal, partner, text, created at (append-only) |
| `pushSubscriptions` | Device endpoint and keys for web push, created and last used |

Status changes follow ADR 0003: **first close wins** for a step or a goal, plain fields are **last arrival wins** per field, a new note or review is a new row. Changes are recorded in `events` like everything else.

Goals need no hosted database: `keel serve` reaches the data the same way the CLI does, so a local SQLite file works. A hosted libSQL database (ADR 0001) stays optional, for using the CLI on several machines.

### 3. Login

The owner signs in with a **passkey**, from ADR 0002 as revised (passkeys first, TOTP as an optional fallback). The first phone is paired from the terminal with a one-time QR code; the installed app keeps a 30-day session. `keel serve` still refuses to listen beyond localhost unless login is on and the connection is HTTPS. Goals do not ship before that login.

### 4. Partner access

- The owner invites one partner per goal. Keel creates a 128-bit link token and a 6-digit PIN; the owner shares the link and, separately, the PIN. Only hashes are stored.
- `/api/partner/...` is the one public part of the server. A valid token and PIN give read access to that goal only (title, deadline, progress, last step done) and the right to send a short note. Wrong PINs are rate-limited.
- The owner can revoke the link at any time; closing the goal ends it.

### 5. Reminders

- Web push with VAPID keys (the `web-push` library, no service). The keys are created on first use and kept with Keel's other secrets.
- While `keel serve` runs, a scheduler checks each minute for cues that are due and sends them, with "Done" and "Do the fallback" actions.
- On start or wake, cues missed in the last 12 hours are sent as **one** catch-up push, never one per cue.
- Partner check-ins (start, halfway, missed twice, done) are queued and sent when the server next runs.

### 6. Tokens

Two additions to `ui` in `packages/core/src/palettes.ts`, written to CSS variables in `theme.ts` like the others:

| Token | Light | Dark | Use |
|---|---|---|---|
| `accentTint` | `#FEEDDD` | `#312624` | Status chips ("first tiny step", "Missed yesterday") |
| `waitTint` | `#DEEBFD` | `#212F43` | Partner and check-in cards |

Text on both keeps at least 4.5:1 (`accent` 4.53, `today` 4.54, `wait` 5.56 in light; 6.47, 8.78, 7.50 in dark). The dark values are computed and get checked in the browser. Screen titles use JetBrains Mono bold; Space Grotesk stays for the wordmark. Bottom sheets dim the page with dark `page` at 50%.

## User story

*I want to run 5 km without stopping by 8 November, and I want a friend to keep me honest.*

1. At the laptop: `keel auth passkey add`, scan the QR code with the phone, approve with Face ID, and add Goals to the home screen.
2. On the phone: "New goal". Done means "I run 5 km in one go". Deadline 8 November; Keel suggests 15 November because past goals ran 30% late. Obstacle "rainy mornings", plan "If it is raining at 7:00, then I will do 20 minutes on the treadmill." Four steps, each with a cue.
3. "Add a partner": Keel gives a link and a PIN. I send the link in one message and the PIN in another.
4. Saturday 7:00, the laptop is awake: the phone shows "Run 1 km at the park". I tap Done.
5. Monday the laptop slept through 7:00. When it wakes, one push: "You planned Run 1.5 km at 7:00. Do the 10-minute version?"
6. Two misses in a row: my partner gets a check-in prompt and sends "Keep the Saturday run!"
7. 9 November: "Close goal", Done, three questions. The next goal's deadline padding uses the answers.

## Consequences

**Good**

- Goal methods with good evidence, built into Keel's own model, for the CLI and the phone alike.
- No new service, no new runtime: self-hosting Goals is `keel serve` plus a tunnel.
- The phone never holds a database token; the partner never reaches anything but one goal.
- One HTTP API between the app and the data keeps a hosted app or backend possible later.

**Costs and risks**

- **While the machine running `keel serve` sleeps:** the app opens with the last-seen goals marked as not live; marking a step done is refused with "Keel is not reachable" (ADR 0003 allows no offline writes); cue pushes are missed until the catch-up on wake; the partner page does not load. Early cues, the ones most worth having, are the most likely to be missed on a laptop. The docs say so and point to an always-on machine for on-time cues.
- A passkey is tied to the server's hostname; moving Keel to another host or tunnel name means pairing the phone again.
- The partner route is Keel's first public route. It needs its own tests: no access to anything but one goal, hashed tokens and PINs, rate limits, revocation.
- iOS delivers web push only to an app added to the home screen, on iOS 16.4 or newer.
- The npm package grows by the size of the phone app.

## Implementation outline

1. Prerequisite: ADR 0002 revised for passkeys, and its login built and released (`feat/passkeys`).
2. Tokens: `accentTint` and `waitTint` in `palettes.ts` and `theme.ts`.
3. `apps/goals`: Vite and React skeleton, manifest, service worker with an offline shell, built into `apps/cli/dist/goals` by the CLI build like `apps/web`.
4. Core: schema and migration (`pnpm db:generate`), goal commands with guards, deadline padding from past reviews.
5. CLI: `keel goal` commands, goals in `today` and `review`, docs in `docs-site/scripts/generate.ts`.
6. Server: owner and partner APIs, push subscription, scheduler and catch-up.
7. Tests: the guard and conflict cases for goals and steps; partner isolation, PIN rate limit and revocation; scheduler and catch-up timing; contrast of the new tokens.

## Out of scope

- A hosted app shell or hosted backend (options A and C); a later record if Keel ever hosts data for others.
- Offline writes from the phone; ADR 0003 section 5 is the starting point.
- More than one partner per goal, groups, public goals, money stakes, streaks and badges, recurring habits.
- Explaining the methods inside the app (a "why" note next to each one) is wanted, but not yet designed; it gets its own record.
