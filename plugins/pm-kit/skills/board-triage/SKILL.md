---
name: board-triage
description: >
  Clean up an Asana board's INBOX, BACKLOG and NEEDS_DECISION so it shows only
  vetted work: find cards nobody has committed to (stale, duplicates, already
  covered by a finished card, decisions nobody answered), flag them, and move
  the ones a person approves to the PARKED section, where they stay captured
  and searchable. Triggers on "triage the board", "clean up the inbox", "clean
  up the backlog", "park stale cards", "board triage", "what can we park".

---

# Board triage

Keeps every request a client made, and clears the noise off the working board.
The rules are `${CLAUDE_PLUGIN_ROOT}/skills/_shared/board-triage-rules.md`; read
it before explaining a verdict.

This is **not** hygiene. `asana-hygiene` asks "is this board shaped right?";
triage asks "is this card real work?".

**Nothing is parked without a person saying yes.** Flagging is reversible and
visible on the card; parking only happens after approval.

## Step 1: Pick the project

Find the project (the Asana MCP's project list, or ask).

## Step 2: Scan (read-only)

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pm-python.mjs board_triage.py scan <PROJECT_GID> \
  --gate "<intake-gate Release value>" --ignore-user <bot user gid>
```

- `--gate` (repeatable): Release values that are committed work; those cards are
  never flagged. Ask the person which releases are in play if you don't know.
- `--ignore-user` (repeatable): bot accounts (e.g. the factory's) whose comments
  must not count as a person touching the card.

It prints JSON: `candidates` (each with `reason`, `detail`, and for duplicates
the surviving card's id), a `reasons` breakdown, and how many cards it judged.
It writes nothing.

## Step 3: Show the list and get a decision

Group the candidates by reason, with title, age/detail and link. For a
duplicate or superseded card, show the card that survives next to it. Ask the
person which to **park**, which to **keep**, and which to leave **flagged** for
the client or team to see first.

## Step 4: Act on what they approved

```bash
# Tag + explaining comment, so the team can object on the card itself
node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pm-python.mjs board_triage.py flag <PROJECT_GID> --ids <GID> [...] --reason "<why>"
# Move to PARKED, drop the tag, comment how to revive
node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pm-python.mjs board_triage.py park <PROJECT_GID> --ids <GID> [...] --reason "<why>"
# Drop the tag; the card isn't flagged again for 30 days
node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pm-python.mjs board_triage.py keep <PROJECT_GID> --ids <GID> [...] --reason "<why>"
```

- `--reason` is written on every card. Make it the actual reason (the rule and
  who approved it), per the operating rules' source attribution.
- Batches of 6 or more cards are sent with notifications muted. Say so.
- `park` needs a **PARKED** section. If the board lacks one, run
  `asana-hygiene` first; it adds the standard sections.

## Step 5: Report

What was parked, kept and left flagged, by reason, and how to undo: move a
parked card back to INBOX or BACKLOG.
