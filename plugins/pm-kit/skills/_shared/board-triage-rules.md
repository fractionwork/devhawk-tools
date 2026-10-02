# Board triage rules

Every request a client makes is captured, and most are never touched again.
Board triage keeps the capture and clears the noise. It finds cards in INBOX,
BACKLOG and NEEDS_DECISION that nobody has committed to, **flags** them, and
after a person approves, moves them to the **PARKED** section. A card moved back
to INBOX or BACKLOG is revived.

This is not hygiene. Hygiene asks "is this board shaped right?" (fields,
sections, admins). Triage asks "is this card real work?".

This page is the single source of truth, and `board_triage.py` implements it.

## Which cards are considered

Only cards in **INBOX**, **BACKLOG** or **NEEDS_DECISION**. Committed work
(READY onwards) is never flagged; it is finished or discarded, not parked.

## Exempt, checked first, in order

| Exemption | Reason code |
|---|---|
| Its Release value is one of the project's intake-gate values | `exempt:release` |
| It has an open pull request | `exempt:open-pr` |
| It carries the keep tag (default `keep`) | `exempt:keep` |
| A person objected to an earlier flag within `snoozeDays` (default 30) | `exempt:snoozed` |
| It is assigned **and** had human activity within `recentTouchDays` (default 14) | `exempt:active` |

## Signals, checked in order. The first match flags the card.

**Human activity** means a comment, a field change or a section move by a
person. Factory and bot comments never count; neither does the triage flag
itself. With no recorded activity, the card's creation time stands in.

### 1. Unanswered decision (NEEDS_DECISION only)

In NEEDS_DECISION for `decisionDays` (default 14) or more, with no human
activity since it entered that state. Reason `unanswered-decision`.

NEEDS_DECISION cards are checked for this signal only.

### 2. Superseded (INBOX, BACKLOG)

Its title is at least `similarity` (default 0.6) alike to a **DONE** card's.
Reason `superseded`, survivor = the DONE card.

### 3. Duplicate (INBOX, BACKLOG)

Its title is at least `similarity` alike to another **open** card's: any
non-parked state except DONE. Only the **newer** card of the pair is flagged
(later `createdAt`; on a tie, the larger id), so the older one survives.
Reason `duplicate`, survivor = the other card.

### 4. Stale (INBOX, BACKLOG)

No human activity for `inboxDays` (default 21) in INBOX, or `backlogDays`
(default 45) in BACKLOG. Reason `stale`.

Otherwise the card is not flagged: reason `fresh`.

## Title similarity

1. Lowercase; replace every character outside `a-z 0-9 whitespace` with a
   space; collapse whitespace; trim.
2. Split on spaces. Drop tokens of 2 characters or fewer, and these noise words:
   `a an the and or of for with to in on at by from into add support implement
   enable allow update fix use using`.
3. Stem each token by removing the first matching suffix from `ations ation ings
   ing ers er ies ied ed es s`, but only when at least 3 characters remain.
4. Similarity is |A ∩ B| / |A ∪ B| over the two token sets. Two empty sets score 0.

The board-wide default is **0.6**, because across a whole board unrelated cards
share more words than requirements from one meeting do. A person approves
every park, so a false match costs a click, not a lost request.

## What a flag looks like

- A tag, `triage:park-candidate`.
- A comment: `board-triage: park candidate — <reason> (<detail>). Remove the tag
  or comment to keep this card.`
- Objecting (removing the tag, or any human comment after the flag) keeps the
  card and starts the snooze.

## Parking (only after a person approves)

Move to PARKED, remove the flag tag, and comment: `board-triage: parked —
<reason>. Move it back to INBOX or BACKLOG to revive it.` For a duplicate or
superseded card, the comment links the survivor.
