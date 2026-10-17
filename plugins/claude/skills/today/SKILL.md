---
name: today
description: Read the user's Keel and answer what's on: today's focus, what's due or late, what they're waiting on, upcoming deadlines, or everything open for one client, project or person. Use for "what's on today", "what do I owe Ravi", "what's due this month", "where was I on acme/website". Read only.
argument-hint: "[optional: +client, +client/project, @person, or a question]"
allowed-tools: Bash(*keel-run.sh*)
---

# What's on in Keel

Answer from Keel's data. This skill only reads; to add or change anything, use the `capture` skill.

Run commands through the wrapper, which adds `--json`:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/keel-run.sh" <command> <args...>
```

Below, `keel-run.sh` is short for that full quoted path.

Pick what the question needs:

| Question | Command |
|---|---|
| what's on, today, this morning | `today` (or `today +client`) |
| everything I owe / I'm waiting on | `ls owe`, `ls wait` |
| late items | `ls overdue` |
| for one client, project or person | `ls +acme`, `ls +acme/website`, `ls @ravi` |
| one item or one project, with history or resume note | `show c12`, `show p3` |
| upcoming deadlines over a period | `ls owe` and `ls wait`, then filter by `dueOn` yourself |
| how the week went | `summary week` |
| what's in the inbox | `ls inbox` |

If the user named nothing (`$ARGUMENTS` is empty), run `today`.

Reply briefly. Lead with what needs action (late, due today, focus), then what's coming, then what they're waiting on. Use refs (`c12`) so the user can act on them, and dates as weekday and day (`Thu 22 Oct`). For a project, show its resume note (where, next, unsure) first. Don't paste raw JSON.

Never run a command that changes data from this skill.
