#!/usr/bin/env python3
"""
Board triage for any Asana board: find the captured cards nobody has committed
to, flag them, and park them once a person approves.

The rules are board-triage-rules.md, next to this file. This is one of two
implementations; both must produce exactly the verdicts in
board-triage-fixtures.json, so change the doc, then the fixtures, then the code.

Usage:
  # Read-only: list what would be flagged (nothing is written)
  node <pm-kit>/skills/_shared/pm-python.mjs board_triage.py scan <PROJECT_GID> [--gate "July Release"] [--ignore-user GID]

  # Flag candidates (tag + explaining comment), park approved ones, or keep them
  ... board_triage.py flag <PROJECT_GID> --ids GID [GID ...]
  ... board_triage.py park <PROJECT_GID> --ids GID [GID ...]
  ... board_triage.py keep <PROJECT_GID> --ids GID [GID ...]

  # The shared fixtures, for the harness (no network, no credentials)
  ... board_triage.py fixtures <PATH>

The rules engine is pure and needs nothing beyond the standard library; only
the Asana commands import asana_ops (and through it, requests).
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone

# ── The rules (board-triage-rules.md) ──

DEFAULT_CONFIG = {
    "inboxDays": 21,
    "backlogDays": 45,
    "decisionDays": 14,
    "similarity": 0.6,
    "keepTag": "keep",
    "snoozeDays": 30,
    "recentTouchDays": 14,
    "intakeGateValues": [],
}

JUDGED = {"INBOX", "BACKLOG", "NEEDS_DECISION"}
NOT_OPEN = {"DONE", "PARKED"}
DAY_S = 24 * 60 * 60

TITLE_NOISE = {
    "a", "an", "the", "and", "or", "of", "for", "with", "to", "in", "on", "at",
    "by", "from", "into", "add", "support", "implement", "enable", "allow",
    "update", "fix", "use", "using",
}
SUFFIXES = ["ations", "ation", "ings", "ing", "ers", "er", "ies", "ied", "ed", "es", "s"]


def _stem(word):
    for suffix in SUFFIXES:
        if len(word) - len(suffix) >= 3 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def title_tokens(title):
    norm = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", title.lower())).strip()
    return {_stem(t) for t in norm.split(" ") if len(t) > 2 and t not in TITLE_NOISE}


def similarity(a, b):
    if not a or not b:
        return 0.0
    shared = len(a & b)
    return shared / (len(a) + len(b) - shared)


def _ts(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def _days(since_iso, now):
    return (now.timestamp() - _ts(since_iso)) / DAY_S


def _is_newer(a, b):
    ta, tb = _ts(a["createdAt"]), _ts(b["createdAt"])
    return ta > tb if ta != tb else a["id"] > b["id"]


def triage_board(cards, done, config=None, now=None):
    """Verdict per INBOX/BACKLOG/NEEDS_DECISION card: {flag, reason, detail, survivorId?}.

    `cards` is the whole board (committed and parked cards too, since duplicates
    are found against them); `done` the finished cards as {id, title}.
    """
    cfg = {**DEFAULT_CONFIG, **(config or {})}
    now = now or datetime.now(timezone.utc)
    tokens = {c["id"]: title_tokens(c["title"]) for c in cards}
    done_tokens = [(d["id"], title_tokens(d["title"])) for d in done]
    open_cards = [c for c in cards if c["state"] not in NOT_OPEN]

    def exemption(card):
        if card.get("release") and card["release"] in cfg["intakeGateValues"]:
            return "exempt:release"
        if card.get("hasOpenPr"):
            return "exempt:open-pr"
        keep = cfg["keepTag"].lower()
        if any(t.lower() == keep for t in card.get("tags") or []):
            return "exempt:keep"
        if card.get("keptAt") and _days(card["keptAt"], now) < cfg["snoozeDays"]:
            return "exempt:snoozed"
        touched = card.get("lastHumanActivityAt")
        if card.get("assigned") and touched and _days(touched, now) < cfg["recentTouchDays"]:
            return "exempt:active"
        return None

    def judge(card):
        exempt = exemption(card)
        if exempt:
            return {"flag": False, "reason": exempt, "detail": exempt}
        touched = card.get("lastHumanActivityAt")
        last_touch = touched or card["createdAt"]

        if card["state"] == "NEEDS_DECISION":
            entered = card.get("enteredStateAt") or card["createdAt"]
            answered = touched is not None and _ts(touched) > _ts(entered)
            if not answered and _days(entered, now) >= cfg["decisionDays"]:
                return {
                    "flag": True,
                    "reason": "unanswered-decision",
                    "detail": f"waiting on a decision since {entered[:10]}",
                }
            return {"flag": False, "reason": "fresh", "detail": "fresh"}

        mine = tokens[card["id"]]
        for done_id, done_set in done_tokens:
            if similarity(mine, done_set) >= cfg["similarity"]:
                return {
                    "flag": True,
                    "reason": "superseded",
                    "survivorId": done_id,
                    "detail": "already covered by a finished card",
                }

        for other in open_cards:
            if other["id"] == card["id"]:
                continue
            if similarity(mine, tokens[other["id"]]) < cfg["similarity"]:
                continue
            if _is_newer(card, other):
                return {
                    "flag": True,
                    "reason": "duplicate",
                    "survivorId": other["id"],
                    "detail": f'repeats "{other["title"][:80]}"',
                }

        limit = cfg["inboxDays"] if card["state"] == "INBOX" else cfg["backlogDays"]
        if _days(last_touch, now) >= limit:
            return {"flag": True, "reason": "stale", "detail": f"no activity since {last_touch[:10]}"}
        return {"flag": False, "reason": "fresh", "detail": "fresh"}

    return {c["id"]: judge(c) for c in cards if c["state"] in JUDGED}


def run_fixtures(path):
    """Every case's verdicts, restricted to the cards it asserts: {name: {id: {flag, reason, survivorId?}}}."""
    with open(path, encoding="utf-8") as f:
        spec = json.load(f)
    defaults = spec["defaults"]
    out = {}
    for case in spec["cases"]:
        now = datetime.fromisoformat(case.get("now", defaults["now"]).replace("Z", "+00:00"))
        config = {**defaults["config"], **case.get("config", {})}
        verdicts = triage_board(case["cards"], case.get("done", []), config, now)
        out[case["name"]] = {
            cid: {k: v for k, v in verdicts[cid].items() if k != "detail"}
            for cid in case["expect"]
            if cid in verdicts
        }
    return out


# ── Asana ──

FLAG_TAG = "triage:park-candidate"
PARKED_SECTION = "PARKED"
FLAG_PREFIX = "board-triage: park candidate"
KEPT_PREFIX = "board-triage: kept"
# The stories that show a person's intent about a card. Custom-field edits are
# left out on purpose: they are overwhelmingly bulk edits (see the rules doc).
HUMAN_INTENT_SUBTYPES = {
    "comment_added", "section_changed", "assigned", "unassigned", "name_changed",
    "notes_changed", "due_date_changed", "added_to_project", "marked_complete",
    "marked_incomplete",
}
# Asana's bulk-mute threshold (operating rules, Rule 3): 6+ writes go silent.
BULK = 6

TASK_FIELDS = ",".join([
    "name", "created_at", "completed", "assignee.gid", "tags.name", "permalink_url",
    "memberships.project.gid", "memberships.section.name",
    "custom_fields.name", "custom_fields.display_value",
])


def _ops():
    import asana_ops  # noqa: PLC0415 — deferred so `fixtures` needs no requests/credentials
    return asana_ops


def section_state(name):
    """Board section name -> card state: 'Needs decision' -> NEEDS_DECISION."""
    return re.sub(r"[\s-]+", "_", (name or "").strip()).upper()


def _section_of(task, project_gid):
    for m in task.get("memberships") or []:
        if (m.get("project") or {}).get("gid") == project_gid:
            return (m.get("section") or {}).get("name", "")
    return ""


def _release_of(task):
    for cf in task.get("custom_fields") or []:
        if (cf.get("name") or "").strip().lower() == "release":
            return cf.get("display_value") or None
    return None


def _story_facts(ops, task_gid, ignore_users):
    """Latest human-intent time, when it last changed section, and when a person last objected."""
    stories = ops.paginate(
        f"/tasks/{task_gid}/stories",
        opt_fields="created_at,created_by.gid,resource_subtype,text",
    )
    last_human = entered = kept = flagged = None
    for s in stories:
        at = s.get("created_at")
        text = s.get("text") or ""
        sub = s.get("resource_subtype") or ""
        if sub == "section_changed":
            entered = at
        if text.startswith(FLAG_PREFIX):
            flagged = at
            continue
        if text.startswith(KEPT_PREFIX):
            kept = at
            continue
        if text.startswith("board-triage:"):
            continue
        by = (s.get("created_by") or {}).get("gid")
        if not by or by in ignore_users or sub not in HUMAN_INTENT_SUBTYPES:
            continue
        last_human = at
    return {"lastHumanActivityAt": last_human, "enteredStateAt": entered, "keptAt": kept, "flaggedAt": flagged}


def read_board(project_gid, ignore_users=()):
    """The board as triage cards, plus the finished cards' titles."""
    ops = _ops()
    tasks = ops.paginate(f"/projects/{project_gid}/tasks", opt_fields=TASK_FIELDS)
    cards, done = [], []
    for t in tasks:
        state = section_state(_section_of(t, project_gid))
        if t.get("completed") or state == "DONE":
            done.append({"id": t["gid"], "title": t.get("name", "")})
            continue
        tags = [tg.get("name", "") for tg in t.get("tags") or []]
        card = {
            "id": t["gid"],
            "state": state,
            "title": t.get("name", ""),
            "createdAt": t["created_at"],
            "tags": tags,
            "assigned": bool(t.get("assignee")),
            "release": _release_of(t),
            "url": t.get("permalink_url"),
        }
        if state in JUDGED:
            facts = _story_facts(ops, t["gid"], set(ignore_users))
            # A flag a person answered by pulling the tag is an objection too.
            kept = facts["keptAt"]
            flagged = facts["flaggedAt"]
            if flagged and FLAG_TAG not in tags and (not kept or _ts(flagged) > _ts(kept)):
                kept = flagged
            card.update({k: v for k, v in facts.items() if v and k != "flaggedAt"})
            if kept:
                card["keptAt"] = kept
        cards.append({k: v for k, v in card.items() if v is not None})
    return cards, done


def scan(project_gid, gate, ignore_users, config=None):
    cards, done = read_board(project_gid, ignore_users)
    verdicts = triage_board(cards, done, {**(config or {}), "intakeGateValues": list(gate)})
    by_id = {c["id"]: c for c in cards}
    flagged = [
        {
            "id": cid,
            "title": by_id[cid]["title"],
            "state": by_id[cid]["state"],
            "url": by_id[cid].get("url"),
            "alreadyFlagged": FLAG_TAG in by_id[cid].get("tags", []),
            **v,
        }
        for cid, v in verdicts.items()
        if v["flag"]
    ]
    reasons = {}
    for f in flagged:
        reasons[f["reason"]] = reasons.get(f["reason"], 0) + 1
    return {"candidates": flagged, "reasons": reasons, "judged": len(verdicts)}


def _tag_gid(ops, create):
    ws = ops.resolve_workspace()
    for tag in ops.paginate(f"/workspaces/{ws}/tags", opt_fields="name"):
        if tag.get("name") == FLAG_TAG:
            return tag["gid"]
    if not create:
        return None
    resp = ops.api("POST", f"/workspaces/{ws}/tags", {"name": FLAG_TAG})
    return resp["data"]["gid"] if resp else None


def _section_gid(ops, project_gid, name):
    for s in ops.paginate(f"/projects/{project_gid}/sections", opt_fields="name"):
        if section_state(s.get("name")) == name:
            return s["gid"]
    return None


def _comment(ops, task_gid, text, silent):
    return ops.api("POST", f"/tasks/{task_gid}/stories", {"text": text}, params=silent)


def apply(action, project_gid, ids, reason):
    """flag | park | keep the given cards. Returns {id: "ok" | error}."""
    ops = _ops()
    silent = {"silent": "true"} if len(ids) >= BULK else None
    tag = _tag_gid(ops, create=action == "flag")
    parked = _section_gid(ops, project_gid, PARKED_SECTION) if action == "park" else None
    if action == "park" and not parked:
        return {i: f"no {PARKED_SECTION} section on this board — run asana-hygiene to add it" for i in ids}
    if action == "flag" and not tag:
        return {i: f"could not find or create the {FLAG_TAG} tag" for i in ids}
    out = {}
    for gid in ids:
        if action == "flag":
            ok = ops.api("POST", f"/tasks/{gid}/addTag", {"tag": tag})
            ok = ok and _comment(
                ops, gid,
                f"{FLAG_PREFIX} — {reason}. Remove the {FLAG_TAG} tag, or comment here, to keep this card. "
                "Nothing moves until a person approves.",
                silent,
            )
        elif action == "park":
            ok = ops.api("POST", f"/sections/{parked}/addTask", {"task": gid}, params=silent)
            if ok and tag:
                ops.api("POST", f"/tasks/{gid}/removeTag", {"tag": tag})
            ok = ok and _comment(
                ops, gid, f"board-triage: parked — {reason}. Move it back to INBOX or BACKLOG to revive it.", silent
            )
        else:
            if tag:
                ops.api("POST", f"/tasks/{gid}/removeTag", {"tag": tag})
            ok = _comment(ops, gid, f"{KEPT_PREFIX} — {reason}. Not flagged again for 30 days.", silent)
        out[gid] = "ok" if ok else "failed (see the log above)"
    return out


def main():
    parser = argparse.ArgumentParser(description="Board triage: flag and park unvetted cards")
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan", help="List what would be flagged; writes nothing")
    s.add_argument("project")
    s.add_argument("--gate", action="append", default=[], help="An intake-gate Release value (repeatable)")
    s.add_argument("--ignore-user", action="append", default=[], help="A bot user gid whose activity never counts")
    for name in ("flag", "park", "keep"):
        p = sub.add_parser(name)
        p.add_argument("project")
        p.add_argument("--ids", nargs="+", required=True)
        p.add_argument("--reason", required=True, help="Recorded on every card")
    f = sub.add_parser("fixtures", help="Run the shared fixtures; prints JSON")
    f.add_argument("path")
    args = parser.parse_args()

    if args.cmd == "fixtures":
        print(json.dumps(run_fixtures(args.path), indent=1))
    elif args.cmd == "scan":
        print(json.dumps(scan(args.project, args.gate, args.ignore_user), indent=1))
    else:
        result = apply(args.cmd, args.project, args.ids, args.reason)
        print(json.dumps(result, indent=1))
        sys.exit(0 if all(v == "ok" for v in result.values()) else 1)


if __name__ == "__main__":
    main()
