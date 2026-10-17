---
name: capture
description: Save what the user says to Keel. Use when they mention something they owe someone, something they're waiting on, a deadline, a reminder, a follow-up, a task for a client or project, or ask to mark one done, move its date, nudge, tidy or add a resume note ("remind me to...", "I promised Ravi...", "waiting on Meera for...", "add these deadlines to keel", "c12 is done").
argument-hint: "[what to save, in plain words]"
allowed-tools: Bash(*keel-run.sh*)
---

# Save to Keel

Turn the user's plain words into Keel commands and run them. Keel keeps commitments (things you owe and things you're waiting on), each with a person, a due date and usually a project.

Run every command through the wrapper, which adds `--json` and prints exactly one JSON object:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/keel-run.sh" <command> <args...>
```

Below, `keel-run.sh` is short for that full quoted path.

`ok: true` means it worked: `data` is the result and `text` is what the terminal would show. `ok: false` comes with `error` and `hint`, and the exit code is 1. If the wrapper says keel is not installed, give the user its hint and stop.

If the user gave no text (`$ARGUMENTS` is empty), ask what to save.

## 1. Read before writing

Run these four, in parallel where you can:

```bash
keel-run.sh clients --all
keel-run.sh projects --all
keel-run.sh people
keel-run.sh today
```

They give you the client and project slugs, the people's handles, the project the user is working on (`today` → `data.context`), and what's already open, so you don't add a duplicate. To check one item, use `show c12` or `show p3`.

## 2. Map the words to commands

| The user says | Command |
|---|---|
| I owe, I promised, I need to send, remind me to, a deadline I must meet | `owe <what> @who due:<when> +client/project from:claude` |
| I'm waiting on, they said they'd send, chase | `wait <what> @who due:<when> +client/project from:claude` |
| an idea, a maybe, no person or date yet | `in <anything> +client/project` |
| it's done, sent, filed | `done c12` |
| we agreed a new date | `renegotiate c12 due:<when>` |
| move the date (no agreement) | `set c12 due:<when>` |
| I chased them | `nudge c12` |
| rename, change who or where | `set c12 title:"..." @who +client/project` or `set p3 title:"..." slug:<slug>` |
| a new client or project | `client new <slug> "<Name>"`, `project new <client/slug> "<Name>"` |
| a person's full name | `person rename @handle "Full Name"` |
| where I am, next step, open question for a project | `park where:"..." next:"..." unsure:"..." +client/project` |

The full grammar is in `keel-run.sh help`. The rules that matter:

- **Every `owe` and `wait` needs `@who` and `due:`.** Keel refuses one without them. For a deadline the user owes themselves, use their own handle (the person matching their name in `people`, otherwise `@me`). For a deadline owed to an organisation (a tax office, a patent office, a client), make a short handle for it (`@taxoffice`) and give it a readable name with `person rename` the first time.
- **Always pass `+client/project`.** Without it, the item lands in whatever project the user is working on, which may not be the one they meant. Use the slugs from step 1. If none fits, propose a new project and ask before creating it.
- **Dates:** `due:2026-10-20` for an exact date (prefer this when the user gives one), or `due:today`, `due:tomorrow`, `due:fri`, `due:eow`, `due:+3d`, `due:+2w`, or a quoted phrase such as `due:"next friday"`. Work out relative dates from today's date in `today`.
- **Source:** add `from:claude` to commitments you create, unless the user names another (`from:meeting`, `from:email`, `from:slack:<link>`).
- **Quote shell-sensitive words.** Put the title in one quoted argument, and quote every tag: `"#legal"`. An unquoted `#` starts a comment in the shell and the tag is silently lost.
- **Keel has no notes field on a commitment.** Keep the title short and specific. Put longer context in the project's resume note (`park ... where: next: unsure:`), or tell the user where it lives.
- **`park` on the project the user is working on takes them out of it** (`data.contextCleared: true`). Only do that if they asked. `park` on any other project keeps their context.
- **Never `switch`** unless the user asks to change project. Never delete, and never pass `--yes`. `drop` only when the user says to drop that item.

## 3. Confirm only when needed

Run the commands straight away when every item has a clear what, who, when and project.

Show the planned commands and ask first when:
- a person, date or project is missing or ambiguous;
- you would create a new client or project (new people are fine: Keel creates a person the first time a handle is used);
- you're about to change more than five items at once, or anything already done or dropped;
- the text looks confidential (passwords, keys, unreleased invention details). Keel may sync to a hosted database (`keel db`), so suggest a neutral title instead.

## 4. Report back

After running, reply with one line per item, using keel's `text` field and the ref, for example:

```
✓ c14 I owe Ravi · Thu 22 Oct · acme/website · send pricing deck
✓ c15 Waiting on Meera · Fri 23 Oct · acme/website · design files
```

If a command failed, show its `error` and `hint`, fix what you can (usually a missing `@who` or `due:`) and retry once. Don't retry a command that already worked.

## Examples (fictional)

"I promised Ravi the pricing deck by Thursday for the Acme website, and Meera owes me the design files Friday."

```bash
keel-run.sh owe "send pricing deck" @ravi due:thu +acme/website from:claude
keel-run.sh wait "design files" @meera due:fri +acme/website from:claude
```

"The Northwind contract renewal is due 1 March, I'm handling it. Tag it legal."

```bash
keel-run.sh owe "renew Northwind contract" @me due:2027-03-01 +northwind/ops from:claude "#legal"
```

"c12 is sent. And Ravi agreed to move c14 to next Wednesday."

```bash
keel-run.sh done c12
keel-run.sh renegotiate c14 due:wed
```
