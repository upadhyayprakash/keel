---
name: lists
description: Keep and change the user's lists in Keel: a grocery list, a packing list, a release checklist, a reading list. Use when they say "add milk to my grocery list", "put X on the packing list", "tick off ...", "start a list for ...", "what's on my ... list", "reset the grocery list", "archive the trip list", or mention a list by name. Needs Keel 0.5.0 or newer.
argument-hint: "[what to do with a list, in plain words]"
allowed-tools: Bash(*keel-run.sh*)
---

# Lists in Keel

A list is things kept together under a project: either **plain** (a collection, no boxes: ideas, a reading list) or **tracked** (a checklist where each item is open, doing, blocked or done, with "4 of 7 done"). Lists have no person and no due date; they are not promises, so use the `capture` skill for those and the `goals` skill for goals.

Run every command through the wrapper, which adds `--json` and prints exactly one JSON object:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/keel-run.sh" <command> <args...>
```

Below, `keel-run.sh` is short for that full quoted path. `ok: true` means it worked (`data` is the result, `text` what the terminal would show); `ok: false` has `error` and `hint`. If the error says `Unknown command "list"`, the user's Keel is older than 0.5.0: tell them to run `npm install -g @nouisi/keel` and stop. If keel is not installed, give the wrapper's hint and stop.

If the user gave no text (`$ARGUMENTS` is empty), run `keel-run.sh list` and summarise.

## 1. Read before writing

```bash
keel-run.sh list                 # every active list: ref (l3), name, kind, progress, project, tags
keel-run.sh list show l3         # one list with its numbered items
```

Match the list the user means by name (case does not matter). If two lists could be it, or none fits, say so and ask. **Item numbers come from `list show` and change when items are added or removed, so always `list show` right before acting on numbers**, and match items by their text, not by a number you remember.

## 2. Map the words to commands

| The user says | Command |
|---|---|
| start a list for X (things to tick off, finish, reuse) | `list new "<name>" --tracked +client/project` |
| start a list for X (ideas, a collection, to read) | `list new "<name>" +client/project` |
| add milk and eggs to the grocery list | `list add l1 item:"milk" item:"eggs"` |
| I got the milk / tick off milk and eggs | `list done l1 1 2` |
| the eggs are out of stock / I'm on the release notes | `list state l1 2 blocked` (or `doing`, `open`) |
| change milk to oat milk / note: the blue one | `list edit l1 1 "oat milk" note:"the blue one"` |
| take bread off | `list rm l1 3` |
| put the passport first | `list order l1 4 to 1` |
| show it sorted by state / A to Z | `list set l1 sort:state` (or `alpha`, `created`, `manual`) |
| rename it, describe it, tag it, make it tracked | `list set l1 name:"..." desc:"..." kind:tracked "#tag"` |
| pin it / unpin it | `list pin l1`, `list unpin l1` |
| we're done with it for good | `list archive l1` (`list unarchive l1` brings it back) |
| move it to the Acme website project | `list move l1 +acme/website` |
| what's on my packing list | `list show l2`, then answer from it |

The grammar is in `keel-run.sh help`. The rules that matter:

- **Say where a new list goes.** With no `+...`, a list lands in the project the user is working on, which may be a work project. For personal things (groceries, packing, books) pass `+personal`. For a project's checklist pass `+client/project`, using the slugs from `keel-run.sh projects`. `+acme` alone means Acme's General project.
- **Tracked or plain:** use `--tracked` when they talk about ticking off, finishing or reusing (shopping, checklists, packing); plain for collections. Switching later loses nothing (`list set l1 kind:tracked`).
- **Quote every title and item**, and quote tags: `"#groceries"`. An unquoted `#` starts a comment in the shell and the tag is silently lost. Add several items with one `item:` each: `list add l1 item:"milk" item:"eggs"`. (Plain quoted words do not work: the shell removes the quotes, so `"milk" "eggs"` would become one item, "milk eggs".)
- **Ticking is not removing.** `list done` keeps the item; only `list rm` removes it, and only when the user says to take it off.
- **When every item of a tracked list is done**, Keel prints a hint offering Reset or Archive. Tell the user and ask which; never choose for them.
- **Reset** (`list reset l1 --yes`) puts every item back to open, for a list used again. In JSON mode it needs `--yes`, so only run it when the user asked to reset that list, and say how many items were reset.
- **Delete** (`list delete l1 --yes`) removes the list and its items. Only when the user explicitly asks to delete that list, after you have said what it holds. If they just mean "I'm done with it", archive instead.
- Never switch the user's project, and never delete or reset on your own initiative. Covers (`list cover`) need a file path from the user; don't invent one.

## 3. Confirm only when needed

Run the commands straight away when the list and items are clear. Ask first when the list is ambiguous, you would create a new list the user did not ask for, you would change more than five items at once, or the user asked for something destructive without naming the list.

## 4. Report back

One short line per change, using keel's `text`, and the progress when it is tracked:

```
✓ Added 2 items to l1 · 7 items
✓ 2 items done in l1 · 5 of 7 done
```

## Examples (fictional)

"Start a D-mart grocery list: milk, eggs, bread."

```bash
keel-run.sh list new "D-mart groceries" --tracked +personal "#groceries" item:"milk" item:"eggs" item:"bread"
```

"I bought the eggs and bread." (after `list show l1` showed eggs as 2 and bread as 3)

```bash
keel-run.sh list done l1 2 3
```

"Put the v2 release checklist under Acme's website, and add 'write changelog'."

```bash
keel-run.sh list new "v2 release" --tracked +acme/website
keel-run.sh list add l2 item:"write changelog"
```
