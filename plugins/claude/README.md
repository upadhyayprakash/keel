# Keel for Claude Code

Save promises, follow-ups and deadlines to [Keel](https://nouisi-keel.mintlify.site) by telling Claude in plain words, and ask Claude what's on.

## Install

Keel itself first (Node 20.19 or newer):

```bash
npm install -g @nouisi/keel
```

Then, in Claude Code:

```bash
/plugin marketplace add upadhyayprakash/keel
/plugin install keel@keel
```

## Use

| Skill | What it does |
|---|---|
| `/keel:capture <plain words>` | Turns what you say into `owe`, `wait`, `in`, `done`, `renegotiate`, `nudge`, `set` and `park` commands and runs them |
| `/keel:today [+client or @person]` | Reads today, what's due or late, what you're waiting on, or one project's resume note. Read only |

Claude also uses them without the slash command when you say things like "remind me to send Ravi the deck Thursday" or "what do I owe Meera?".

```text
/keel:capture I promised Ravi the pricing deck by Thursday for the Acme website, and Meera owes me the design files Friday

✓ c14 I owe Ravi · Thu 22 Oct · acme/website
✓ c15 Waiting on Meera · Fri 23 Oct · acme/website
```

## How it works

- Every call goes through `scripts/keel-run.sh`, which finds `keel` (on your PATH, or in nvm) and adds `--json`. The JSON fields are Keel's [public contract](https://nouisi-keel.mintlify.site/reference/json).
- It works on whatever database `keel` uses: the local file, or the synced copy from `keel db connect`. Set `KEEL_HOME` or `KEEL_DB_URL` to point it elsewhere.
- Promises to yourself go to `@me` ("for myself"; needs Keel 0.3.2 or newer to show that way).
- Commitments it creates are marked `from:claude`, so you can tell them apart in `show`.
- It always names the project (`+client/project`), so nothing lands in the wrong one.
- It never deletes, never switches your project unless you ask, and asks before creating clients or projects, before large batches, and when a person, date or project is unclear.

## Try it on a scratch database

```bash
KEEL_HOME=/tmp/keel-try claude
```

Everything Claude saves in that session goes to `/tmp/keel-try`, not your real data.
