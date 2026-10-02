#!/usr/bin/env bash
# SessionStart hook — inject the PM operating rules as session context.
#
# Replaces the old installer behaviour of splicing this prose into the user's
# ~/.claude/CLAUDE.md between marker comments. That was worse in three ways: the
# rules couldn't version or roll back with the tooling that owns them, a re-run
# had to surgically patch a user-owned file (which broke once), and uninstalling
# the tooling left the prose behind.
#
# Deliberately terse. This fires on EVERY session in EVERY repo for anyone who
# has pm-kit installed, including sessions that touch no board at all, so it
# pays for itself only by staying short. The full text — rationale, source-line
# formats, per-system muting flags — lives in skills/_shared/operating-rules.md
# and is read on demand by the skills that need it.
#
# The rules that can be enforced in code are enforced in the MCP server, not
# here (see _require_source / _bulk_silent in skills/_shared/asana_mcp.py). This
# hook covers the residual case: a human or model reasoning about board work
# without having loaded a skill.

set -u

read -r -d '' RULES <<'EOF' || true
## PM operating rules (pm-kit)

Applies to every project-board operation, without being asked:

1. **Source attribution.** When research — a meeting transcript, an email, a Slack
   thread, or the codebase — informs a card change (create / rename / description
   / status move), do BOTH: put a `Source: …` line in the description, AND post a
   comment quoting the evidence. Descriptions get rewritten; the comment is the
   audit trail. pm-kit's Asana MCP requires a `source` argument on state-changing
   tools, so this is enforced there rather than left to memory.

2. **Mute bulk notifications.** Batches of 6+ card transitions mute notifications
   (Asana `silent=true`, Linear `notifySubscribers: false`, batch
   endpoints); say that you muted. Single operations notify normally. For batches
   of ≤5, ask.

Never call a PM MCP's raw `create_task*` / `create_story` / `create_issue`
directly — use the `add-card` skill, which applies field, section, duplicate and
attribution rules at creation time.

Full text: `${CLAUDE_PLUGIN_ROOT}/skills/_shared/operating-rules.md`
EOF

# jq is not a dependency of this kit, so build the JSON with a runtime the kit
# already needs. NODE FIRST: pm-kit's Asana server is launched with node, so it
# is on every working machine — whereas `python3` is absent from a python.org
# install on native Windows (only `python.exe`), and there the name can even
# resolve to the Microsoft Store stub, which prints nothing and exits non-zero.
# Each candidate's output is captured and printed only if it produced some, so
# a stub can never emit half a hook; with no runtime at all this prints nothing
# rather than malformed JSON, which would surface as a hook error every session.
emit() {  # <interpreter> <code>
  command -v "$1" >/dev/null 2>&1 || return 1
  local out
  out="$(RULES="$RULES" "$1" -c "$2" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

PY='
import json, os
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": os.environ["RULES"],
    }
}))'

node_emit() {
  command -v node >/dev/null 2>&1 || return 1
  local out
  out="$(RULES="$RULES" node -e '
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: process.env.RULES },
}));' 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

node_emit || emit python3 "$PY" || emit python "$PY" || true
