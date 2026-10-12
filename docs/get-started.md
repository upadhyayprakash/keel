# Get started with Keel

Keel keeps three things in one place: the promises you make and the ones made to you, the few things that matter today, and where you left each project. You use it by typing short commands, in your terminal or in the browser.

This guide takes about ten minutes, from install to your first Friday review.

## 1. The ideas behind it

| Word | What it means |
|---|---|
| **Client** | Who the work is for, or a whole area of your life: `acme`, `northwind`, `personal`. It only groups projects. |
| **Project** | One piece of work under a client, written `client/project`: `acme/website`. |
| **Working on** | The project you are in right now. There is always zero or one. New items land in it unless you name another project. Your first project becomes it automatically, and `switch` changes it. (In the code and the spec this is called the *context*.) |
| **Commitment** | A promise with a person and a due date. **owe** is something you promised someone. **wait** is something someone promised you. |
| **Inbox** | Anything you haven't decided about yet. You sort it later with `triage`. |
| **Focus** | Up to three commitments you pick for today. |
| **Resume note** | Three short answers saved when you leave a project: where you are, what's next, what you're unsure about. Shown when you come back. |
| **Ref** | The short name of an item: `c12` is a commitment, `p3` a project, `i5` an inbox item. Use refs in commands: `done c12`. |

## 2. Install

You need Node.js 20.19 or newer. Check with:

```sh
node --version
```

If it's missing or older, install the current LTS from [nodejs.org](https://nodejs.org), or with a version manager such as `nvm` or `fnm`.

Then install Keel:

```sh
npm install -g @nouisi/keel
keel --version
keel
```

`keel` on its own opens the **Keel shell**: you type commands without the `keel` prefix, Tab completes, ↑ brings back earlier commands, and `exit` (or Ctrl+D) leaves. It opens on your `today`. Everything in this guide works in the shell too; just leave out `keel`.

> If `npm install -g` fails with `EACCES`, your Node install wants root for global packages. Install Node through a version manager instead (recommended), rather than using `sudo`.

## 3. Set up your clients and projects

Create a client, then a project inside it. The slug (`acme`) is what you type; the name in quotes is for display.

```sh
keel client new acme "Acme Corp"
keel project new acme/website "Website rebuild"
keel project new acme/app "Mobile app"

keel client new northwind "Northwind"
keel project new northwind/portal "Customer portal"
```

After the first `project new`, Keel tells you `You are now working on acme/website`. List everything with `keel projects` (the `●` marks the one you're in).

Tip: use clients for every area you juggle, not only paying ones: `client new personal "Personal"` with `personal/job-search`, or `client new oss "Open source"` with `oss/keel`. The weekly summary shows your time per client, so this gives you an honest picture.

## 4. A normal day

Start with:

```sh
keel today
```

You see the project you're working on, your focus, what you owe that's due or late, what you're waiting on that needs a follow-up, what's coming up in the next three days, and projects going quiet.

**Capture a promise you made:**

```sh
keel owe send pricing deck @ravi due:thu
```

- `@ravi` is the person. New people are created as you go.
- `due:` takes `today`, `tomorrow`, `mon` to `sun`, `eow` (end of week), `+3d`, `+2w` or a date like `2026-10-20`.
- It lands in the project you're working on. Add `+northwind/portal` to put it somewhere else.
- Optional: `from:meeting`, `from:slack:<link to the message>`, `#tag`.

Keel answers with the ref: `✓ c1 I owe Ravi · Thu 15 Oct · acme/website`.

**Capture a promise made to you:**

```sh
keel wait design files @meera due:fri
```

**Capture anything else, without deciding now:**

```sh
keel in ask Ravi about the phase 2 budget
```

**Pick today's focus** (up to three refs):

```sh
keel focus c1 c4
```

**Close the loop:**

```sh
keel done c1                    # kept
keel renegotiate c4 due:mon     # you agreed a new date (counts differently from a silent slip)
keel nudge c2                   # you chased someone about something you're waiting on
keel drop c7                    # no longer needed
keel set c3 title:"send revised deck" due:fri @priya
```

**Look things up:**

```sh
keel ls                 # everything open
keel ls owe             # or: wait, overdue, done, inbox
keel ls +acme @ravi     # filter by client or project, and person
keel show c1            # details and history
keel show p1            # a project, its resume note and open items
```

## 5. Switching projects

```sh
keel switch northwind/portal
```

Keel asks three questions about the project you're leaving. Answer in a few words, or press Enter to skip one:

```
│ Where are you?   pricing page copy half done
│ What's next?     send the deck to Ravi
│ Unsure about?    whether phase 2 is approved
```

Then it shows the resume note you left on `northwind/portal` last time, plus its open items. That's the point: you restart in two minutes instead of thirty.

Stopping for the day? `keel park` saves a resume note and leaves you in no project. Pause a project with `keel set p2 status:paused`.

## 6. In a meeting

```sh
keel meeting +acme/website "weekly sync"
```

Then type a line whenever something comes up:

```
› > pricing deck to @ravi due:thu
› < design files from @meera due:fri
› budget approved for phase 2
›
```

- A line starting with `>` is something you owe.
- A line starting with `<` is something you're waiting on.
- Anything else is a note and goes to the inbox.
- An empty line ends the meeting. Keel shows what it captured and asks before saving.

A line Keel can't read (say, a missing date) is never lost: it's kept as a note.

## 7. Friday review

```sh
keel review
```

It takes about 30 minutes and walks you through six steps: empty the inbox, decide on every overdue item, follow up on what you're waiting on, check each project's resume note, set next week's priority for each client, and read the week summary. `today` shows a reminder from Friday until you've done it.

Any time, `keel summary` (or `summary day`, `summary last`) shows promises kept, renegotiated and slipped, your kept rate, and time per client from your switches.

## 8. The browser terminal

```sh
keel serve
```

Open http://localhost:4242. It's the same terminal with the same commands, plus autocomplete as you type, a preview of a new commitment before you press Enter, clickable refs, and a light, dark or auto theme switch at the bottom. It only listens on your own machine. Stop it with Ctrl+C.

## 9. Tab completion in your shell

```sh
echo 'eval "$(keel completion zsh)"' >> ~/.zshrc    # zsh (the macOS default)
echo 'eval "$(keel completion bash)"' >> ~/.bashrc  # bash
```

Open a new terminal. Tab now completes commands, `@people`, `+projects`, refs (with their titles) and `due:` dates (with the actual day).

## 10. Your data

- Everything lives in one file: `~/.keel/keel.db`. Point Keel elsewhere with `KEEL_DB_URL=file:/path/to/keel.db`.
- Keel writes a full backup to `~/.keel/backups/` the first time you use it each day, and keeps the last 14.
- `keel export > keel-backup.json` saves everything. `keel import keel-backup.json` restores it into an empty database.
- `keel export --md > keel.md` gives a readable snapshot of every client, project, resume note and commitment.
- Add `--json` to any command for output that scripts can read.
- Colors: `keel theme light`, `keel theme dark` or `keel theme auto` (the default, which asks your terminal).

## Fixing and tidying up

```sh
keel client rename acme "Acme Inc"          # display name
keel client rename acme slug:acme-inc       # the short name; paths become acme-inc/...
keel set p1 title:"Website v2" slug:site    # a project's name and slug
keel client archive acme                    # finished with a client: hide it, keep everything
keel client unarchive acme                  # bring it back
keel project delete p3                      # delete a project and its commitments
keel client delete acme                     # delete a client with all its projects
keel people                                 # everyone you've mentioned with @
keel person rename @ravi "Ravi Kumar"       # show a full name
keel person merge @rav @ravi                # fix a typo'd handle: move everything to @ravi
```

Deleting always shows what goes with it and asks you to type the name to confirm. Deleted items disappear from Keel, but your daily backups from before still have them.

## Cheat sheet

| Command | Does |
|---|---|
| `today` | What matters now |
| `owe <what> @who due:<when>` | Something you promised |
| `wait <what> @who due:<when>` | Something promised to you |
| `in <anything>` | Capture now, decide later |
| `focus c1 c4` | Today's top three |
| `done c1` · `drop c1` | Close a commitment |
| `renegotiate c1 due:mon` · `nudge c2` | Agreed new date · followed up |
| `ls [owe\|wait\|overdue\|done\|inbox]` | Lists, with `+client` and `@who` filters |
| `show c1` · `show p1` | Details |
| `switch client/project` · `park` | Change project · stop for now |
| `meeting [+client/project]` | Capture during a meeting |
| `triage` | Sort the inbox |
| `review` · `summary` | Friday review · kept rate and time |
| `client new` · `project new` · `projects` | Set up and list |
| `client rename\|archive\|delete` · `project delete` | Tidy up |
| `people` · `person rename\|merge` | People and their names |
| `serve` | Browser terminal |
| `help` | Everything else |

## Update or uninstall

```sh
npm install -g @nouisi/keel@latest   # update
npm uninstall -g @nouisi/keel        # remove (your data in ~/.keel stays)
```

Found a bug or have an idea? Open an issue at https://github.com/upadhyayprakash/keel/issues.
