# 01. Analysis: how high-output people manage commitments

Date: 2026-10-12
Status: draft, open for clarifications and additions

## The problem

Working on many things at once, every day, causes four failures:

1. **Missed promises.** Something was promised to someone ("I'll send it Friday") and it slipped.
2. **Wrong priorities.** Time drains into low-priority work that feels urgent.
3. **Lost context.** Coming back to a project costs 30 minutes of "where was I?", and delivery quality drops.
4. **Bad judgement.** Decisions made in a rush, with no record of why, are hard to learn from.

People who handle lots of parallel work well are not more disciplined. They have stopped trusting memory for four kinds of things: **promises, priorities, context and decisions**, and each one gets its own system.

## 1. Promises: one trusted ledger

- **Capture everything as it happens** (David Allen, *Getting Things Done*). A promise made in a call is written down within seconds. An untracked promise is an open loop that keeps nagging in the background.
- **Two separate lists: "I owe" and "Waiting on".** Founders mostly drop the second one: something was delegated, nobody followed up, and it died quietly.
- **Every commitment has a person and a date.** "Follow up with Ravi" is not a commitment. "Send Ravi the pricing deck by Thursday" is.

## 2. Priorities: decide once, not all day

- **A daily cap of 3 things that matter.** Everything else counts as a bonus. This keeps busywork from crowding out the important work.
- **Urgent vs. important** (the Eisenhower matrix). Low-priority work usually feels urgent, which is why it wins by default.
- **Time blocks for deep work.** Quality output comes from protected stretches of time, not from squeezing it in between messages.
- **A weekly review (30 to 60 minutes).** This habit keeps everything else working: clear the inbox, check every open commitment, renegotiate the ones that can't be kept, pick next week's priorities. Most systems fail because this step gets skipped.

## 3. Context: the resume note

- When leaving a project, spend 60 seconds writing: **where I am, what's next, what I was unsure about.**
- Coming back then takes 2 minutes instead of 30. It is the same idea as a handoff doc for an AI coding session, applied to yourself.

## 4. Decisions: a decision journal

For anything that matters, record:

- the decision and the options considered
- why this option was chosen
- what you expect to happen
- confidence (for example 70%)
- a date to review it

Supporting practices:

- **One-way vs. two-way doors** (Jeff Bezos). Decide reversible things fast. Slow down only for the irreversible ones.
- **A pre-mortem.** "It is six months later and this failed. Why?" It catches bad calls before you make them.
- **Judge the decision, not the outcome.** The journal protects against hindsight bias: a good decision can have a bad outcome, and the other way round (Annie Duke, *Thinking in Bets*; Shane Parrish, Farnam Street).

## Proposed app shape

A small local app with a single database, built around those four kinds of things.

| View | Purpose |
|---|---|
| **Inbox** | One-keystroke capture, sorted out later |
| **Commitments** | I owe / Waiting on, each with a person, a due date and where it came from (call, email, Slack) |
| **Today** | Max 3 priorities, plus anything due or overdue |
| **Projects** | Each one has a pinned resume note and the last-touched date |
| **Decisions** | A log with expected outcome, confidence and a review date that comes back to you |
| **Weekly review** | A guided checklist that walks through every open loop |

**Claude Code integration (idea).** A small CLI or MCP server so that at the end of a session Claude can be told "log that I promised X to Y by Friday" and it lands in the same database.

## Open questions

1. **Form factor:** local web app (Vite + React + SQLite), a terminal CLI, or both sharing one database?
2. **Capture sources:** where do commitments usually come from? Meetings, email, Slack, Claude sessions?
3. **v1 scope:** all six views, or start with Inbox + Commitments + Today + Weekly review and add Decisions and Projects next?
4. **Name (decided 2026-10-12):** **Keel**. A keel keeps a boat steady and on course.

## References

- David Allen, *Getting Things Done* (capture, clarify, organize, reflect, engage)
- Cal Newport, *Deep Work* (time blocking)
- Eisenhower matrix (urgent vs. important)
- Annie Duke, *Thinking in Bets* (decision quality vs. outcome)
- Shane Parrish, Farnam Street (decision journal)
- Jeff Bezos, shareholder letters (one-way and two-way doors)
