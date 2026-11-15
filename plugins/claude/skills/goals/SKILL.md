---
name: goals
description: Set, check on and finish the user's goals in Keel: one small thing with a finish line, a deadline, an if-then plan and a few steps (run 5 km, read a book, clear a room). Use when they say "I want to ... by ...", "set a goal", "how is my goal going", "I did step 2", "close the goal", "drop the goal", or mention a goal by name. Needs Keel 0.5.0 or newer.
argument-hint: "[what to do with a goal, in plain words]"
allowed-tools: Bash(*keel-run.sh*)
---

# Goals in Keel

A goal is something small the user can finish in days or weeks. Keel asks for what makes it likelier to get done: what **done looks like**, a **deadline**, the **one thing most likely to get in the way**, an **if-then plan** for it, and a few **steps**. Goals are not promises to a person (use the `capture` skill) and not lists (use `lists`).

Run every command through the wrapper, which adds `--json` and prints exactly one JSON object:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/keel-run.sh" <command> <args...>
```

Below, `keel-run.sh` is short for that full quoted path. `ok: true` means it worked; `ok: false` has `error` and `hint`. If the error says `Unknown command "goal"`, the user's Keel is older than 0.5.0: tell them to run `npm install -g @nouisi/keel` and stop. If keel is not installed, give the wrapper's hint and stop.

If the user gave no text (`$ARGUMENTS` is empty), run `keel-run.sh goals` and summarise.

## Reading

```bash
keel-run.sh goals             # active goals: ref (g1), title, progress, deadline
keel-run.sh goals --all       # including done and dropped
keel-run.sh goal show g1      # done means, plan, numbered steps, review of a closed goal
```

Match a goal by its title; ask if it is ambiguous. In `goal show`, steps are numbered and `data.steps[].missed` marks one whose planned day ended with it open.

## Setting a goal: gather first, never invent

In JSON mode Keel cannot ask questions, so every required part must be in the command. **These are the user's own words, so get them from the user; do not make them up.** You may propose a draft and ask them to confirm or change it.

| Part | Command key | Notes |
|---|---|---|
| name | `goal new "Run 5 km"` | small and finishable |
| what done looks like | `done:"I run 5 km in one go"` | something checkable |
| deadline | `due:2026-12-20` (or `due:+3w`, `due:"nov 8"`) | must not be in the past |
| time budget | `time:"3 runs a week"` | optional |
| one obstacle | `obstacle:"rainy mornings"` | required |
| if-then plan | `plan:"If it is raining at 7:00, then I will do 20 minutes on the treadmill"` | required, must read "If ..., then ..." |
| steps | `step:"put my shoes by the door" step:"run 1 km"` (repeat) | at least one; make the first take under 10 minutes |

```bash
keel-run.sh goal new "Run 5 km" done:"I run 5 km in one go" due:2026-12-20 time:"3 runs a week" obstacle:"rainy mornings" plan:"If it is raining at 7:00, then I will do 20 minutes on the treadmill" step:"put my shoes by the door" step:"run 1 km"
```

- Steps given this way have no time or place. Tell the user they can add a time, place and a smaller version for a bad day by setting the goal on their phone (`/goals`) or running `keel goal new` themselves, and that reminders need one.
- A deadline given in the command is kept as given. Keel's offer of a later deadline (when past goals ran late) only appears when the user sets a goal by hand, so mention it if their earlier goals ran late.

## Moving it along

| The user says | Command |
|---|---|
| I did step 2 (of the run goal) | `goal step done g1 2` |
| I'm finished with the goal | `goal done g1 happened:"..." why:"..." change:"..."` |
| I'm stopping this goal on purpose | `goal drop g1 happened:"..." why:"..." change:"..."` |

- **Closing asks three review questions** (what happened against the plan, why, what to change next time). In JSON mode pass them inline as `happened:`, `why:` and `change:`, from what the user says; ask once if they have not said any. They help Keel pad future deadlines. Leaving them out is allowed.
- **Close or drop only when the user says so**, naming the goal. A closed goal stays closed (a second close answers with a conflict).
- Never delete, and do not pass `--yes`.

## Report back

One or two lines using keel's `text`, and the next step:

```
✓ g1 Run 5 km · Sun 20 Dec · 2 steps
  First step: put my shoes by the door
```

If every step is done, say so and ask whether to close the goal.
