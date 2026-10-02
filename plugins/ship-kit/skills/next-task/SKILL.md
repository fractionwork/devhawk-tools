---
name: next-task
description: >
  Pick the next task from the project's PM system (Asana, Jira, Linear via MCP,
  or local backlog.md), assign it, create a branch, show an implementation plan,
  and start building after approval. Triggers on "what's next", "next task",
  "pick a task", "what should I work on", "grab a card", or any request to find
  and start the next piece of work.

---

# Next Task

Pick the next card, assign it, branch, plan, build.

## Step 1: Detect PM system

Check which MCP tools are available (try in this order):
- **Asana**: pm-kit's first-party `asana` MCP — detected by the presence of its tools (`list_my_tasks`, `list_project_tasks`, …). If it isn't connected, tell the user to run `/pm-setup` (pm-kit); don't reach for pm-kit's scripts, a sibling plugin's files are not addressable. Never use other Asana MCPs (the official plugin / community / claude.ai connectors are superseded).
- **Jira**: `mcp__claude_ai_Atlassian_Rovo__atlassianUserInfo`
- **Linear**: Linear MCP tools (connected via `https://mcp.linear.app/mcp` — OAuth, 21+ tools for issues, projects, cycles, workflow states)
- **Azure DevOps**: `azure-devops-mcp` tools if connected (Microsoft-backed, PAT auth, work items, sprints, boards)
- **None of the above**: fall back to `backlog.md` in project root

If multiple PMs are connected, ask which one to use. Cache the choice.

## Step 2: Check for in-flight work

Read `.devhawk-work.json` (project root). If it exists and has an active card:

> You have **[card title]** in progress on branch `[branch]`.
> Continue that, or pick something new?

AskUserQuestion — header: "In flight", options: "Continue" / "Pick new (park current)" / "Mark current done"

"Continue" → skip to Step 8 (plan/build from existing card).
"Pick new" → warn the builder to finish one thing at a time. If they insist, stash the current card context.
"Mark done" → invoke `card-done` flow, then continue to Step 3.

## Step 3: Discover project + columns

**Asana:**
```
get_projects → pick the project (ask if multiple)
get_project_sections → map section names to logical states
```

**Jira:**
```
getVisibleJiraProjects → pick the project
getTransitionsForJiraIssue (on any issue) → discover available statuses
```

Map discovered columns to 6 logical states using fuzzy match:
- `backlog`: "Backlog", "Icebox", "Unstarted"
- `ready`: "TODO", "Ready", "Refined", "Sprint", "Selected for Development", "To Do" (Jira category)
- `inProgress`: "In Progress", "Active", "Doing", "WIP"
- `review`: "Review", "In Review", "PR Review", "Code Review", "Ready for Review"
- `testing`: "Ready for Testing", "QA", "Testing"
- `done`: "Done", "Complete", "Shipped", "Ready for Release"

If ambiguous, ask once and cache in `.devhawk-work.json`.

## Step 4: Query for next card

Priority order — first match wins:

1. Cards assigned to me in `ready` (TODO) column
2. Unassigned cards in `ready` (TODO) column
3. Cards assigned to me in `backlog` column (only if `ready` is empty)
4. Unassigned cards in `backlog` column (only if `ready` is empty)

**Important:** The `backlog` column contains unrefined tasks. Only pick from it when `ready` is empty, and warn the builder: "No refined tasks in TODO. Pulling from BACKLOG — this task may need refinement before starting."

Within each tier, sort by:
- **Fraction Priority** field first (P0 before P1 before P2 before P3)
- Then **Story Points** ascending (smallest first — flow over throughput)
- Then epic order (E1 before E2)

If Fraction Priority/Story Points fields aren't populated, fall back to epic order + creation date.

Use **Fraction Task Type** to distinguish EPIC definition cards (skip — not work items) from Stories/Bugs/Chores/Spikes (workable units). Under the flat-task policy every task is top-level; the epic it belongs to is the `Feature` field, not a parent. No subtask traversal.

**Asana** (flat — all tasks top-level):

`list_project_tasks(project_gid)` returns the project's incomplete top-level tasks — each with its `section`, `assignee`, and custom fields — which is the whole pool; there are no subtasks to traverse, because the board is flat by policy (Asana can't move a subtask between sections, so a subtask could never flow INBOX → DONE). Filter to the target section client-side.

```
1. Fetch the project's incomplete tasks, then filter to the target section:
   list_project_tasks(project_gid)   # returns name, section, assignee, custom fields
   → keep those whose section == the ready/target section

2. Drop EPIC definition cards (Fraction Task Type == EPIC) — they document a Feature, they aren't work.

3. Read Feature / Theme / Story Points / Priority from custom fields (not from the name).

4. Filter: assigned-to-me first, then unassigned, then smallest Story Points.
```

If you encounter legacy subtasks (a task with `num_subtasks > 0`, or candidates missing from the board), the project hasn't been migrated — run `/asana-hygiene` (pm-kit) to elevate them, then re-query. (Use `list_project_tasks` for the pool rather than Asana's Premium search endpoint, which is often disabled — `search_tasks` sidesteps it by filtering task names locally.)

**Jira:**
```
searchJiraIssuesUsingJql("project = X AND status = Ready AND assignee = currentUser() ORDER BY priority, created")
searchJiraIssuesUsingJql("project = X AND status = Ready AND assignee is EMPTY ORDER BY priority, created")
```
JQL returns Stories and Sub-tasks flat by default. Do NOT add `issuetype = Story` — that excludes sub-tasks. If the query has an issuetype filter, ensure it includes `OR issuetype = Sub-task`.

**Linear:** use Linear MCP search tools to query issues by state, assignee, and priority. Sub-issues are first-class in Linear with their own workflow state — no traversal needed. The state filter already covers them.

**Azure DevOps:** use ADO MCP to query work items by state, assigned to, iteration path. ADO's work-item query language returns all types flat (Epic → Feature → Story → Task). The state filter covers all nesting levels — sub-tasks are in scope without special traversal.

**backlog.md** (see `${CLAUDE_PLUGIN_ROOT}/skills/_shared/backlog-format.md` for the full spec):

Stories are `### [EX-SY] Title (N SP) @assignee — STATUS` headings. Priority inherits from the epic heading `## E[N]: Name [P0-P3]`.

Filter: skip DONE/REVIEW/TESTING. Sort: assigned-to-me → P0→P3 → smallest SP → epic order.

When starting: change `— TODO` to `— WIP`, `@unassigned` to `@[builder]`.

Legacy fallback: if no `### [E` headings exist, parse flat `- [ ]` bullets.

If nothing found in any tier, tell the builder: "Backlog is empty. Create new cards or refine existing ones."

## Step 5: Show the card

> **[Card ID]: [Title]**
> [Description / acceptance criteria]
> Points: [N] · Epic: [name] · Priority: [P0/P1/P2] · Release: [Phase N]

AskUserQuestion — header: "This one?", options: "Yes, start" / "Skip, show next" / "Show backlog"

## Step 6: Assign + move to In Progress

**Asana (top-level task):** assign, then move section — both via our MCP:

1. Assign: `assign_task(task_gid="<cardId>", assignee="me", source="starting work — <card title>")`
2. Move to WIP: `move_task_to_section(task_gid="<cardId>", section="WIP", source="starting work — <card title>")` (resolves the section by name within the card's project — no section ID lookup).

If no PM MCP is connected, tell the user to run `/pm-setup` (pm-kit) rather than proceeding — do NOT silently skip the move, because a card left out of WIP is invisible to everyone else.

**Asana:** every task is top-level (flat-task policy), so just move the task to the WIP section and assign it to self (as above). No parent epic to touch — the task's `Feature` field already records which epic it belongs to.

**Jira:** `editJiraIssue(assignee)` + `transitionJiraIssue` to In Progress status. Works the same for Stories and Sub-tasks.

**backlog.md:** change `@unassigned` to `@[builder]`, change `— TODO` to `— WIP`

Comment on the card: "Starting work. Branch: `feature/[card-id]-[slug]`"

## Step 7: Create branch

```bash
BASE=$(git rev-parse --verify origin/develop 2>/dev/null && echo develop || echo main)
BRANCH="feature/[card-id]-[slug-from-title]"
git fetch origin "$BASE"
git checkout -b "$BRANCH" "origin/$BASE"
```

## Step 8: Write context file

Save to `.devhawk-work.json`:
```json
{
  "pm": "asana|jira|linear|ado|backlog",
  "cardId": "...",
  "cardTitle": "...",
  "cardUrl": "...",
  "parentTaskId": null,
  "branch": "feature/...",
  "projectId": "...",
  "sectionMap": {
    "backlog": "section-id",
    "ready": "section-id",
    "inProgress": "section-id",
    "review": "section-id",
    "testing": "section-id",
    "done": "section-id"
  },
  "startedAt": "2026-04-21T..."
}
```

`parentTaskId`: set to the epic/parent task ID if the selected card is a subtask. `null` if top-level. Used by `card-done` to reconcile with the parent when closing out (e.g. check if all subtasks of the epic are done → mark epic complete).
```

## Step 9: Plan the work

Read the card details (description, acceptance criteria, subtasks). Derive implementation steps using the `feature-build` checklist pattern:

> **Plan for [Card ID]: [Title]**
> 1. Schema: [tables/fields if needed]
> 2. Server: [actions/routes]
> 3. UI: [pages/components]
> 4. Tests: [what to test]

AskUserQuestion — header: "Plan", options: "Build it" / "Change plan" / "Ask a question"

"Build it" → proceed to Step 10.
"Change plan" → revise, re-present.
"Ask a question" → answer, then re-present.

## Step 10: Build

Follow the `feature-build` implementation checklist. The active card context in `.devhawk-work.json` enables feature-build's PM awareness (commit comments on the card).

When the builder says "create pr" or "done building", the `create-pr` skill picks up the card context and moves it to Review.
