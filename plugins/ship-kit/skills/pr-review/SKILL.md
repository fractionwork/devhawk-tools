---
name: pr-review
description: >
  Review a pull request — current branch, a specific PR number, multiple PR
  numbers, or all open PRs. Runs lint + typecheck, `node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pr-audit.mjs`
  deterministic checks, the /code-review plugin, and a DevHawk convention
  audit at 75% confidence. Posts each activity as a GitHub PR comment and
  offers to apply fixes. Triggers on "review this PR", "review my changes",
  "pr review", "review pr", "review #123", "review open prs", "code review",
  "review before merge", "check this branch", or any request to review
  pending or open changes.

---

# PR Review

Five activities in sequence. Each posts a PR comment so the review trail is visible to the team.

> For scheduled background reviews, see the `pr-watch` skill — it wraps this
> skill with fingerprint-based change detection and quiet-by-default
> notification, designed for `/loop 30m /pr-watch` runs.

## Mode detection

Parse the invocation arguments to pick a mode:

| Invocation | Mode | Behavior |
|---|---|---|
| `pr-review` (no args) | **current-branch** | Run the 5 activities against the current branch. Used by authors self-reviewing or by `create-pr` pre-flight. |
| `pr-review <N>` | **single-PR** | Check out PR #N in a temporary git worktree, run the 5 activities there, post comments to PR #N, clean up. |
| `pr-review <N> <M> <O>` | **multi-PR** | One subagent per PR number, in parallel. Each subagent handles its own worktree end-to-end. |
| `pr-review open` / `pr-review all` | **all-open** | `gh pr list --state open --json number,isDraft --jq '[.[]|select(.isDraft==false)|.number]'` → one subagent per result, in parallel. |

**Drafts are not reviewed.** A draft is the author's workspace, not an offer to
review, and review comments on one spend the reviewer's attention and the
author's on unfinished work. All-open mode filters them out; an explicit
`pr-review <N>` naming a draft is the author asking, and runs. A draft that has
gone quiet is handled by `draft-drift.mjs` (labels and closes, never reviews) —
staleness is not a reason to review one.

For multi-PR and all-open modes, dispatch via the Agent tool with `subagent_type: "general-purpose"` and a prompt like *"Invoke the pr-review skill with argument `<N>` against PR #N. Report the summary back."* Each subagent runs against a single PR; the orchestrator collects the summaries.

When invoked without args by `create-pr` pre-flight, no PR exists yet — run in **no-PR mode** (see "No-PR mode" at the bottom) and capture findings for replay after the PR is created.

## Prerequisites

```bash
gh auth status
```

For **current-branch** mode:
```bash
git rev-parse --abbrev-ref HEAD  # must be a feature branch, not main/develop
PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null)
BASE=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || echo "main")
```

If no PR exists, ask: create one first (`gh pr create`) or local-only review (skip PR comments)? — *unless* this skill was invoked by `create-pr` pre-flight, in which case run in no-PR mode silently.

For **single-PR / multi-PR / all-open** modes, skip the branch check and set up a worktree (see next section). `PR_NUMBER` and `BASE` come from the PR itself.

## Resolve the toolchain first

Every command below is named by VERB, not by package manager. Resolve them once,
at the top of the run, and use the variables everywhere after:

```bash
eval "$(node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/stack-profile.mjs --env)"
```

That exports `FACTORY_INSTALL`, `FACTORY_LINT`, `FACTORY_TYPECHECK`,
`FACTORY_TEST`, `FACTORY_DB_MIGRATE_TEST`, `FACTORY_MIGRATION_TOOL` and friends
for the stack this repo actually uses. On a Next.js repo they resolve to the
`pnpm` commands this skill used to hardcode, so nothing changes; on a FastAPI
repo they resolve to `make lint` / `make types` / `make test`.

Run it inside the worktree when there is one — a project can override commands
in its own `.factory/profile.json`, and the worktree is the checkout being
reviewed.

### A PR does not get to define the commands used to review it

`.factory/profile.json` names commands this skill then `eval`s on the reviewer's
machine, and in PR-targeted modes the worktree is an **untrusted checkout**. A PR
that edits its own toolchain declaration must be reviewed with the *base*
branch's declaration, not its own. Do this before the `eval` above, inside the
worktree:

```bash
if git diff --name-only "origin/$BASE...HEAD" | grep -q '^\.factory/'; then
  echo "PR modifies .factory/ — reviewing with the base branch's toolchain."
  rm -rf .factory
  git checkout "origin/$BASE" -- .factory 2>/dev/null || true   # base may have none
fi
eval "$(node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/stack-profile.mjs --env)"
```

Restoring the file (rather than pinning `--profile`) keeps local stack inference
working, so a repo whose base carries no declaration still resolves correctly.

When this fires, **the change to `.factory/` is itself a review finding** — call
it out in Activity 4 and say what the PR wanted to change the commands to. The
same applies to that file's `auditChecks`: `pr-audit` will not load checks from
outside the kit, but a profile pointing somewhere unexpected is worth a comment.

## Worktree setup (PR-targeted modes only)

Skip this section for current-branch mode.

For each PR number to review:

```bash
N=<pr-number>
WT_DIR=$(mktemp -d -t "pr-review-${N}-XXXXXX")
git fetch origin "pull/${N}/head:pr-${N}-review"
git worktree add "$WT_DIR" "pr-${N}-review"
PR_NUMBER=$N
BASE=$(gh pr view "$N" --json baseRefName -q .baseRefName)
```

All 5 activities then run inside the worktree (`cd "$WT_DIR"`). The worktree is a fresh checkout with no installed dependencies, so install first:

```bash
( cd "$WT_DIR" && eval "$FACTORY_INSTALL" )
```

On completion (or on any error), clean up — the worktree must never leak:

```bash
git worktree remove --force "$WT_DIR"
git branch -D "pr-${N}-review" 2>/dev/null
```

For multi-PR / all-open parallel mode, each subagent owns one worktree on its own path; they don't share an install. Disk and CPU cost scales with PR count — for very large parallel runs (>5 PRs), consider warning the user.

## Activity 1: Lint + typecheck

```bash
LINT_OUTPUT=$(eval "$FACTORY_LINT" 2>&1) ; LINT_EXIT=$?
TYPE_OUTPUT=$(eval "$FACTORY_TYPECHECK" 2>&1) ; TYPE_EXIT=$?
```

Post PR comment:
```
## Lint + Typecheck
**Lint:** passed/FAILED
**Typecheck:** passed/FAILED
<details><summary>output</summary> ... </details>
```

If either failed, ask if the builder wants to fix before continuing. Don't skip the remaining activities — they catch different things.

## Activity 2: pr-audit deterministic checks

```bash
AUDIT_OUTPUT=$(node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pr-audit.mjs --base="origin/$BASE" 2>&1) ; AUDIT_EXIT=$?
```

`node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pr-audit.mjs` runs the deterministic convention checks in `scripts/audit/` against the diff vs the PR base. Exit 1 means at least one BLOCK survived (it can also signal a `--strict` WARN, though this invocation isn't `--strict`). Findings are grouped BLOCK / WARN / INFO and each is annotated `check-id · file:line · message`.

Suppressions the runner already applies:
- per-line `// audit-skip: <check-id> — <reason>` on or above the offending line
- PR-level `pr-audit: <check-id> — <reason>` in any commit message (BLOCK → WARN)

Post PR comment:

```
## pr-audit
**Result:** clean / N issue(s)
<details><summary>output</summary>$AUDIT_OUTPUT</details>
```

If `AUDIT_EXIT != 0`, ask whether the builder wants to fix the surviving BLOCKs before continuing. The /code-review pass (next activity) is still worth running — it catches different things.

## Activity 2.5: Migration rehearsal (only when migrations changed)

Skip this activity entirely unless the diff touches `lib/db/migrations/`. The static checks in Activity 2 catch shape problems (sequence breaks, destructive ops, hand-edited journal). This activity catches **the migration won't apply at all** problems — syntax errors, missing-FK references, type mismatches, conflicting constraints — by running every committed migration against a fresh test database.

```bash
TOUCHED_MIGRATIONS=$(git diff --name-only "origin/$BASE"...HEAD | grep -E '^lib/db/migrations/' || true)
if [ -z "$TOUCHED_MIGRATIONS" ]; then
  echo "(no migration changes — skipping rehearsal)"
else
  if ! docker compose -f docker/docker-compose.dev.yml ps postgres --status running >/dev/null 2>&1; then
    REHEARSAL_RESULT="SKIPPED (Docker / Postgres not running locally)"
    REHEARSAL_OUTPUT=""
  else
    REHEARSAL_OUTPUT=$(eval "$FACTORY_DB_MIGRATE_TEST" 2>&1) ; REHEARSAL_EXIT=$?
    if [ "$REHEARSAL_EXIT" -eq 0 ]; then
      REHEARSAL_RESULT="clean — every migration applied against <project>_test"
    else
      REHEARSAL_RESULT="FAILED — $FACTORY_MIGRATION_TOOL refused to apply at least one migration"
    fi
  fi
fi
```

Post PR comment ONLY when a migration was touched:

```
## Migration rehearsal
**Result:** $REHEARSAL_RESULT

<details><summary>$FACTORY_MIGRATION_TOOL output</summary>

```
$REHEARSAL_OUTPUT
```

</details>
```

If `REHEARSAL_RESULT` starts with `FAILED`, the migration will fail on prod's pre-deploy job too. Treat as a BLOCK and stop here — don't run /code-review on a branch whose migrations don't apply. Surface the SQL error message clearly in the comment so the builder can see exactly what $FACTORY_MIGRATION_TOOL rejected.

If `REHEARSAL_RESULT` starts with `SKIPPED`, post the comment anyway so the reviewer knows the rehearsal didn't run, and tell the builder to start Docker (`docker compose -f docker/docker-compose.dev.yml up -d`) + run `$FACTORY_DB_MIGRATE_TEST` locally before merging.

## Activity 3: Invoke /code-review plugin

Use the **Skill tool** to invoke the `code-review` skill:
```
Skill(skill: "code-review")
```

This runs Anthropic's 5-agent parallel analysis (CLAUDE.md compliance, bug detection, git history context, prior PR comments, code comment verification). Let it complete fully — it may produce its own output or PR comments.

After it finishes, summarize what it found and continue to Activity 4.

## Activity 4: DevHawk convention audit (75% threshold)

This is the stack-specific layer that the generic plugin doesn't cover. Read the diff (`git diff "$BASE"...HEAD`) and every changed file. Rate each finding 0-100% confidence. **Only report findings at 75%+.**

**If `$FACTORY_LANGUAGE` is not `typescript`, do not use the criteria below.**
Every one of them names a Next.js construct — Server Actions, Zod, BullMQ, the
`@/` alias — and hunting for Server Actions in a FastAPI repo produces an audit
that can only ever come back clean. Instead:

- Read the project's own `docs/conventions.md` and the other reference docs, and
  audit against **those**.
- Keep the stack-independent discipline from this activity: the 75% threshold,
  the Critical-at-50% rule, the severity bands, and the output shape below.
- Activity 2 (`pr-audit`) already ran this stack's deterministic checks — don't
  restate its findings here; look for what a rule cannot express.

On a Python/FastAPI repo the equivalents worth hunting are: a router handler
doing ORM work directly instead of going through a service, a sync DB call on an
async path, unvalidated external input reaching a query, a missing
`organization_id` filter on a tenant-scoped query, a mutation with no
state-machine guard, and user input interpolated into an LLM prompt without
isolation tags.

### Criteria (TypeScript / Next.js)

**Critical (report above 50%):**
- SQL injection or unsanitized input
- Missing auth check in Server Action or API route
- Secrets in committed code
- `any` type (should be `unknown` + narrowing)

**High (75%):**

*Auth & security*
- **Org variant only** (check `**Auth variant:**` in CLAUDE.md): missing `organizationId` filter on tenant-scoped query. Skip this check on solo-variant projects — they have no org concept. Solo-variant equivalent: missing `session.user.role === "admin"` check on admin-only mutations.
- Server Action accepts an id / role / value chosen from a UI-filtered list (e.g. `approverId`, `assigneeId`, `targetUserId`) and writes it directly to the database without first re-fetching the candidate and re-evaluating the constraint server-side. Client filtering is UX; server filtering is security. See docs/conventions.md → "Server-side re-validation".
- Server Action accepts both a parent ID (`organizationId`, `storeId`, `accountId`) and a child ID (`machineId`, `ticketId`, `versionId`) but only runs the parent access check (`assertOrgAccess`, `assertStoreAccess`) — no joined `findFirst` verifying the child belongs to that parent. A user with access to parent A can pass A + a child of B. Add the FK-joined lookup before the mutation. See docs/conventions.md → "Cross-resource binding".
- Server Action mutates a status / state-machine column without first checking that the current state is in an allowed-from-states set. Pattern to flag: `update(table).set({ status: "X" })` with no preceding `if (!ALLOWED_FROM.has(record.status))` guard. See docs/conventions.md → "State-machine fields".

*Validation*
- External input not validated with Zod.

*Server Actions & API surface*
- Server Action throws instead of returning `{ success, error }`.
- API route used for internal mutation (should be Server Action).
- `"use server"` file exports a non-async value (`type`, `interface`, `const`, class) — Next.js fails the production build with an opaque error. Move non-function exports to a plain module like `lib/action-result.ts`.

*Background jobs*
- Work >500ms inline instead of BullMQ.
- BullMQ worker registers a processor that sets a row's status to an in-flight value (`"generating"` / `"processing"`) but the queue setup file has no `worker.on("failed", …)` listener that resets the same field on permanent failure. Rows stick in the in-flight state forever after a Redis blip / process crash.

*AI*
- User-controlled string interpolated into an LLM prompt without `<data>…</data>` wrapping and a system-instruction guard. Pattern: any backtick-string passed to `generateObject` / `generateText` / `streamText` that includes a variable read from the database or form data without isolation tags. See docs/ai-patterns.md → "Prompt-injection guards".
- AI processor catch block writes a "success"/"complete" status with default content instead of an "error" status. Pattern: `try { …generateObject… } catch { …set({ status: "complete" }) }` — the catch should set `"error"` (or rethrow). Users can't distinguish silent fallback from a real AI run.

*Database & migrations*
- Migration changes a column DEFAULT (`ALTER COLUMN … SET DEFAULT …`) with no accompanying backfill `UPDATE` and no SQL comment justifying why old rows intentionally diverge. Default flips only affect new inserts; existing rows are silent split-state without an explicit choice. See docs/database-patterns.md → "Default-value changes".
- Paired add+drop migrations in the same PR (e.g. `0026_*.sql` adds `column X`, `0027_*.sql` drops `column X`). Net-zero schema change but every environment runs both forever. Squash into a single no-op or remove the pair. Legitimate renames go via expand → backfill → contract across separate PRs, not the same PR.

*Testing*
- New Server Action without corresponding `tests/integration/` file.
- New Zod schema without corresponding `tests/unit/` file.
- New critical user flow without corresponding `tests/e2e/` spec (auth, core workflow, payment).
- Zod schema **tightened** (removed `.optional()`, added `.min()`/`.max()`, narrowed enum) without a corresponding test-file update in the same PR. Existing tests using the prior shape will fail at CI; flag and ask whether `$FACTORY_TEST_INTEGRATION` was run locally.

*Conventions*
- Default export on non-page/layout/route file.
- Import not using `@/` alias.
- `<input type="file" name="X">` added to a form with no Server Action in the PR reading `formData.get("X")` / `formData.getAll("X")`. The UI silently drops uploaded files. Either wire up the file handler or remove the input.

**Medium (75%):**
- Missing loading/error boundary for new route
- Client Component that could be Server Component
- Broad `try/catch` swallowing errors
- Missing FK `onDelete` behavior
- Naming inconsistency with conventions

### Output per finding

```
**[SEVERITY] [file:line]** (confidence: N%)
Issue. Suggested fix: [concrete change]
```

### Post PR comment

```
## Convention Audit (75%+ confidence)
[N] findings across [M] files.
[findings grouped by file]
---
*DevHawk conventions. Threshold: 75%.*
```

Zero findings: post "No convention issues found. Ship it."

## Activity 5: Offer fixes

Combine findings from Activity 2 (pr-audit), Activity 3 (/code-review), and Activity 4 (convention audit). Present as numbered list:

> Which findings should I fix? (numbers, "all", or "none")

For each fix:
1. Make the edit
2. Verify `$FACTORY_TYPECHECK` passes

After all fixes:
```bash
git add -A
git commit -m "fix: address PR review findings

[one line per fix]

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push
```

Post PR comment:
```
## Fixes Applied
[N] of [M] findings addressed:
- [x] [file:line] — fixed
- [ ] [file:line] — skipped
Changes pushed.
```

## Auto-accept mode

Fix ALL findings without asking (except intentional `any` with documented reason). Post all PR comments.

## No-PR mode

When invoked with no PR (current-branch and no open PR — typically by `create-pr` pre-flight, or by a builder asking for a local review):

- Activities still run: lint + typecheck, `node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/pr-audit.mjs`, /code-review plugin, DevHawk convention audit.
- Output goes to the terminal as a structured summary instead of being posted as PR comments.
- The summary should be machine-replayable: when `create-pr` later creates the PR, it replays the captured findings as PR comments (same shapes as Activities 1–4 use) so the review trail lands on the freshly-opened PR.
- Activity 5 (offer fixes) still runs but commits/pushes without posting the "Fixes Applied" PR comment.
