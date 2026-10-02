---
name: create-pr
description: >
  Create a pull request for the current branch. Targets the repo's configured
  default branch, rebases from it first, then creates the PR via gh.
  Triggers on "create pr", "open pr", "submit pr", "make a pr", "pull request",
  "push and pr", "draft pr", "wip pr", or any request to create a pull request.

---

# Create PR

## Step 1: Detect current branch + target

```bash
CURRENT=$(git rev-parse --abbrev-ref HEAD)

# The repo's CONFIGURED default branch is the canonical PR target — it's where
# the team integrates and where scheduled Actions register.
DEFAULT=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null)
# Fallback when gh is unavailable: read origin/HEAD.
[ -z "$DEFAULT" ] && DEFAULT=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
```

If `CURRENT` equals the default branch (or `main`/`master`), stop — PRs aren't created from the integration branch.

**Target branch logic** (in order):
1. If the builder explicitly named a target ("PR into main", "merge to staging") → use that
2. Else target the repo's **default branch** (`$DEFAULT`)
3. Fallback only when `$DEFAULT` can't be determined — probe the remote and take the first that exists, `staging > develop > main`:
```bash
git fetch origin --prune
for b in staging develop main; do
  git rev-parse --verify "origin/$b" >/dev/null 2>&1 && TARGET="$b" && break
done
```

**Never infer the target from the mere existence of `develop`.** A `develop` branch that still exists is not evidence that it is still used — teams retire it without deleting the ref, and a PR merged into a retired branch looks successful while shipping nothing. Ask the repo what its default is; that setting is what the team actually maintains.

**Exception:** only target `main` directly if the builder explicitly says so.

**Draft or ready?** Default to a **ready** (non-draft) PR. Open a **draft** when the builder signals the work isn't review-ready — "draft pr", "wip pr", "open as draft", "not ready for review" — or when they elect at Step 2.5c to proceed past High findings rather than fix them first. This decision is load-bearing downstream: a draft's card stays in WIP, a ready PR's card goes to READY FOR REVIEW (Step 4c). Getting it wrong is exactly what clogs the review column.

```bash
DRAFT=""              # ready PR (default)
# DRAFT="--draft"     # set when the builder asked for a draft/WIP PR, or opted to defer known High findings
```

Show the builder: *"PR: `[current]` → `[target]` (`[draft | ready]`)"*

## Step 1.5: Branch-base check (refuse stacked-on-PR branches)

Refuse to create a PR for a branch whose merge-base with `origin/$TARGET` is not on `$TARGET`'s first-parent trunk — that almost always means the branch was created from another open PR's tip, and the resulting PR will become unmergeable when the upstream squash-merges.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/branch-base-check.mjs --strict --base="$TARGET"
```

If the script exits non-zero, **stop and surface the message to the builder**. Do NOT call `gh pr create`. The script's output names the guessed source branch and gives the cherry-pick recipe. Two possible recoveries:

- **Re-base the work onto `origin/$TARGET`** — `git switch -c <new-branch> origin/$TARGET`, cherry-pick the relevant commits, push, run the skill again from the new branch.
- **Stack intentionally** — if the dependency on the upstream PR is real and the merge order is coordinated, set `ALLOW_STACKED=1` for this run and target the PR base to the upstream branch (not `$TARGET`). Note the dependency in the PR body so reviewers know the merge order.

Skip this step entirely if `${CLAUDE_PLUGIN_ROOT}/skills/_shared/branch-base-check.mjs` doesn't exist (older seed snapshot — surface a one-line note that the gate is missing and continue).

## Step 2: Rebase from target

Ensure the branch is up to date before creating the PR:

```bash
git fetch origin "$TARGET"
git rebase "origin/$TARGET"
```

If the rebase has conflicts:
- Stop and tell the builder which files conflict
- Do NOT force-push or abort without asking
- Ask: "Resolve conflicts, or merge instead of rebase?"

If rebase succeeds cleanly, force-push to update the remote branch (the rebase rewrote history):
```bash
git push --force-with-lease
```

If the branch hasn't been pushed yet:
```bash
git push -u origin "$CURRENT"
```

## Step 2.5: Pre-flight review (full audit)

After the rebase + push but before `gh pr create`, run the full pr-review activities locally so the PR is opened with a known-good audit baseline. The PR doesn't exist yet, so findings are captured locally; once the PR is created in Step 3, the captured findings are replayed as PR comments.

### 2.5a. Deterministic gates (hard-block)

These two gates are non-negotiable. If either fails, stop and surface to the builder.

```bash
eval "$(node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/stack-profile.mjs --env)"
CHECK_OUTPUT=$(eval "$FACTORY_GATE" 2>&1) ; CHECK_EXIT=$?
AUDIT_OUTPUT=$(node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pr-audit.mjs --base="origin/$TARGET" 2>&1) ; AUDIT_EXIT=$?
```

- **`$FACTORY_GATE` (the repo's full local gate) — Exit ≠ 0:** stop, show `$CHECK_OUTPUT`. Do NOT call `gh pr create`.
- **`node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pr-audit.mjs` — Exit ≠ 0 (BLOCK survives):** stop, show `$AUDIT_OUTPUT`, and ask the builder to either (a) fix the BLOCK, (b) add a per-line `// audit-skip: <check-id> — <reason>`, or (c) add `pr-audit: <check-id> — <reason>` to a commit message to demote it to WARN. Do NOT call `gh pr create`.

### 2.5b. Heavy review activities (capture, then gate)

If both deterministic gates pass, run the heavier review activities. The PR doesn't exist yet → run `pr-review` in **no-PR mode** so it captures findings to the terminal as a structured summary (no GitHub PR comments — the PR doesn't exist).

```
Skill(skill: "pr-review")  # no args → current-branch + no-PR mode
```

This runs the /code-review plugin (5-agent analysis) and the DevHawk convention audit @ 75%. Capture the resulting findings — they will be replayed as PR comments after `gh pr create` succeeds.

### 2.5c. Gate decision

Inspect the captured findings:

| Worst finding | Action |
|---|---|
| Critical | **Block.** Show findings; ask the builder to fix before creating the PR. |
| High | **Block + offer override.** Show findings; ask: "Fix first, or create PR with these as known issues noted in the body?" |
| Medium only | **Warn + proceed.** Show findings; continue to Step 3 (do not pause for confirmation). |
| None | **Proceed silently.** |

When the builder elects to proceed past High findings, add a "Known issues" section to the PR body (Step 3) listing each finding with file:line.

### 2.5d. Capture for replay

Persist the captured findings (lint + typecheck output, `pr:audit` output, /code-review summary, DevHawk audit findings) in shell variables so they can be replayed as PR comments after Step 3. The replay uses the same comment shapes as `pr-review` Activities 1–4 — same headings (`## Lint + Typecheck`, `## pr-audit`, etc.), same details blocks. Reviewers see a freshly-opened PR with the full audit trail already posted.

## Step 3: Create the PR

Resolve the PM card FIRST (Step 4a/4b below) so its URL can go into the body at
creation. Do not defer it to a follow-up edit — see the note under the snippet.

The heredoc is quoted (`<<'EOF'`), so **nothing in the body expands** — write the
checklist as prose, not as `$FACTORY_*`. Keep it quoted: a PR summary routinely
contains backticks and `$(…)`, and an unquoted heredoc would try to run them.

```bash
gh pr create $DRAFT --base "$TARGET" --title "[title]" --body "$(cat <<'EOF'
Card: [card URL, or "none — <reason>"]

## Summary
[2-3 bullets from the commit messages on this branch]

## Changes
[list of files changed, grouped by type: schema, actions, UI, tests]

## Test plan
- [ ] Typecheck passes
- [ ] Test suite passes
- [ ] Tested in browser (if UI changes)

---
Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Title:** derive from the branch name or commit messages. Keep under 70 chars. Use conventional format: `feat:`, `fix:`, `chore:`, `refactor:`.

**Body:** auto-generate from `git log "$TARGET"..HEAD --oneline`. Group changes by type. Include a test-plan checklist.

**Draft:** `$DRAFT` (set in Step 1) makes this open as a draft. Don't hardcode `--draft` here — carry the Step 1 decision so the card routing in Step 4c, which reads `gh pr view --json isDraft`, matches how the PR was actually opened.

**The `Card:` line belongs in the body AT CREATION — first line, before the summary.** It used to be added in Step 4d, after `gh pr create`, which meant any interrupted or partially-followed run left the PR permanently unlinked. That is not hypothetical: an audit of one project's board matched 17 in-review cards against 557 PRs and could link only 10 by card ID. Two features had shipped to production and sat mislabelled for three and a half months because nothing tied them to the PR that delivered them.

A title match works today and rots; an ID in the body stays greppable:

```bash
gh pr list --state all --limit 200 --json number,title,body \
  --jq ".[] | select(.body | contains(\"$CARD_ID\"))"
```

Write `none — <reason>` when a PR genuinely has no card (release promotion, revert, tooling). An empty line is indistinguishable from a forgotten one.

Show the PR URL to the builder.

## Step 3.5: Replay captured audit findings as PR comments

Step 2.5 already ran the full pr-review activities in no-PR mode and captured the findings. Now that the PR exists, post the captured findings as PR comments — same shapes pr-review uses:

- `## Lint + Typecheck` — `$FACTORY_GATE` summary + collapsed output.
- `## pr-audit` — pr-audit result + collapsed output.
- *(code-review plugin output)* — the plugin posts its own comments when it runs against a PR; if it ran in no-PR mode and produced terminal output only, summarize the findings in a follow-up `## Code Review` comment.
- `## Convention Audit (75%+ confidence)` — DevHawk findings, grouped by file.

Use `gh pr comment <PR_NUMBER> --body "$BODY"` for each. The builder ends up with a freshly-opened PR that already has the full audit trail — reviewers don't need to wait for a separate `pr-review` invocation.

Do NOT re-run the activities. They produce the same output against the same code; replay is sufficient.

## Step 4: PM card transition (always)

Every PR should correspond to a PM card so the board reflects reality. This step is **not optional** — either move the active card or ask which one to move.

### 4a. Find the active card

Check for `.devhawk-work.json`. If it exists with a `cardId`/`cardUrl`, use that.

### 4b. No active card → ask, don't skip

If `.devhawk-work.json` doesn't exist or has no active card:

> No active PM card found. Which card does this PR represent?
> 1. Provide a card ID or URL (Asana / Linear) — I'll move it to READY FOR REVIEW
> 2. Create a new card now — invoke `add-card` skill (in BACKLOG, then transition through TODO → WIP → READY FOR REVIEW)
> 3. Skip PM tracking for this PR (rare — explain why in PR body)

Wait for the answer. If they pick (1), record it in `.devhawk-work.json` so `card-done` can close it after merge.

### 4c. Move card — destination depends on DRAFT status

**A draft PR's card does NOT go to READY FOR REVIEW.** A draft is waiting on the
author, not a reviewer; parking it in the review column makes that column
useless for anyone scanning for work to pick up. One project accumulated six
cards sitting in READY FOR REVIEW behind draft PRs before anyone noticed.

```bash
IS_DRAFT=$(gh pr view --json isDraft -q .isDraft)
```

| PR state | Card destination |
|---|---|
| draft (`--draft`, or `isDraft: true`) | **WIP** / In Progress — move it forward when the PR comes out of draft |
| ready for review | READY FOR REVIEW |

Use the canonical section/state name (board convention — pm-kit's `asana-conventions.md` carry the full standard):

- **Asana:** move to the section via our MCP (it resolves the section by name within the card's project — no need to look up a section ID):
  ```
  move_task_to_section(task_gid="<cardId>", section="<WIP | READY FOR REVIEW>",
                       source="PR #<n> opened — <title>")
  ```
  If no PM MCP is connected, say so and skip the move rather than guessing — then tell the user to run `/pm-setup` (pm-kit). Do not try to reach pm-kit's scripts directly; a sibling plugin's files are not addressable.
  ```
  PUT /api/v3/stories/<id>  {"workflow_state_id": <state_id>}
  ```
- **Linear:** transition issue to **In Progress** for a draft, **In Review** once undrafted, via Linear MCP.

If the card is in INBOX or BACKLOG (skipped over TODO/WIP), surface that to the builder before moving — usually means the card lifecycle was bypassed and they may want to confirm the right card.

### 4d. Comment on card with PR details

```
PR created: [PR title] ([PR URL])

Changes:
- [file-level summary grouped by type: schema, actions, UI, tests]

Testing:
- [basic test steps from acceptance criteria]
- [ ] typecheck passes
- [ ] lint passes
- [ ] tested in browser (if UI)
```

### 4e. Verify the card link actually made it into the PR body

The `Card:` line goes in at creation (Step 3) — this step only confirms it landed, and repairs it if the run reached `gh pr create` by another path:

```bash
gh pr view --json body -q .body | head -1   # expect: Card: <url>  (or "none — <reason>")
```

If it's missing, `gh pr edit --body` it in now. This bidirectional link is what makes `card-done` work cleanly after merge, and it's the only durable way to match a PR to its card months later.
