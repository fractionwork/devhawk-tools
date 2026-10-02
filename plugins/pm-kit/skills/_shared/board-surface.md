# Which board tools to call

Shared by every skill that touches a project board. Read this once when a skill
points you here.

## Why this file exists

These skills are written to be tool-neutral — they describe what to do to a
board, not which MCP to do it through — so the binding from "what to do" to "which
tool" lives here, in one table, rather than being left to name similarity.

pm-kit ships its own Asana server, which uses **your own** Asana credential: every
write lands on the board as you. Other Asana MCPs (the official plugin, community
servers) may be connected too — do not use them for these skills. Prefer the
first-party `asana` MCP; fall back to `asana_ops.py` (see `asana-conventions.md` →
"Tool precedence") for anything it does not expose or when it is not connected.

**Say what you did** in your confirmation output — "Commented as you, directly on
Asana" — so the person reading does not have to guess whose name is on the write.

## The table

| capability | Asana MCP tool |
|---|---|
| list what is on the board | `list_project_tasks` |
| search the board | `search_tasks` |
| read one item | `get_task` |
| read an item's comments | `get_task_comments` |
| list the columns | *(none — sections are implicit)* |
| list assignable people | *(none)* |
| what is assigned to me | `list_my_tasks` |
| comment | `add_comment` |
| move to a column | `move_task_to_section` |
| assign | `assign_task` |
| mark finished | `complete_task` |
| capture a light INBOX card | `capture_inbox_idea` |
| board policy audit | `run_hygiene` |

## What the MCP cannot do

Structural work on an Asana board — creating custom fields, creating or removing
sections, adding enum options, creating workspace tags, changing project admins.
The MCP deliberately does not expose it. That work runs through `asana_ops.py`,
under **your** credential, in `asana-bootstrap` and `asana-hygiene`. If an audit
turns up findings that need it, say so plainly and name the skill.

A board on Linear or another tool is worked through that tool's own MCP; the
capabilities above are the ones to look for there.
