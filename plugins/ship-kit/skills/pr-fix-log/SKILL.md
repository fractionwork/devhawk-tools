---
name: pr-fix-log
description: >
  Append a plain-language entry to a repo's PR fix log (docs/pr-fix-log.md) when
  reviewing a pull request. OPT-IN — applies only to repos that already maintain
  that log (the file exists), or when the user explicitly asks to "document this
  PR", "log the PR review", or "update the PR fix log". Do nothing on repos that
  don't keep a PR fix log. As the closing step of a PR review (pr-review /
  code-review / reviewing-and-fixing a teammate's PR), reads the PR's existing
  comment + review trail and writes one entry: PR number, submitter, title,
  description, then an issue→fix table (or "Clean"). Documents only the project's
  human contributors — skips bots (dependabot / any app/* author) and release-cut
  PRs. Enforces the base-branch rule: any non-release PR targeting the deploy
  branch (e.g. main) instead of the integration branch (e.g. staging) is a
  finding — retarget it and record it.
---

# PR Fix Log

Maintain `docs/pr-fix-log.md` — a plain-language record of pull-request reviews and
the fixes applied, written so a **semi-technical** reader can understand the scope
of each change without reading code.

## Applicability (opt-in — check first)

This skill is **not** meant to run on every project. Only act when **one** of these
is true:

- the repo already has a `docs/pr-fix-log.md` (the project has adopted this log), **or**
- the user explicitly asks to document / log a PR into a fix log.

If neither holds, do nothing — most repos don't keep this log, and creating one
uninvited is noise. When in doubt, ask once whether the project wants a PR fix log
before starting one.

## Per-project configuration

Two things vary by project — read them from the repo, don't hard-code:

- **Contributor allowlist** — the human team members whose PRs get documented.
  Skip bots (`dependabot`, any `app/*` author) and release-cut PRs. Infer the list
  from the log's existing entries / recent PR authors, or ask.
  _Example — Acme documents `alex-dev`, `sam-qa`, `jordan-pm`._
- **Branch model** — the integration branch every normal PR should target vs the
  deploy branch reserved for release cuts.
  _Example — Acme: integration = `staging`, deploy = `main`._

## When to run

As the **closing step of a PR review** (after pr-review / code-review, or after you
review-and-fix a teammate's PR), or whenever explicitly asked. One entry per PR.

## FIRST: read the PR's existing comment + review trail

Before writing an entry — especially for a PR you didn't personally review this
session — **read the PR's comments and reviews** (`gh pr view <N> --json comments,reviews`).
Detailed findings usually already live there: `pr-review` posts `## Lint + Typecheck`,
`## pr-audit`, `## Convention Audit`, `## Fixes Applied`; `/code-review` posts
findings; adversarial-review agents post `SHIP / MINOR-ISSUES / BLOCKING` verdicts
with issue→fix lists. Build the entry's rows from that trail. **Never mark a PR
"Clean" without first checking its comments** — that mistake once logged a whole
backfill as "no findings" when every PR had a detailed review. Ignore boilerplate
(lint-passed, typecheck-passed); capture real bugs, scoping/security issues,
missing tests, and applied fixes.

## Base-branch rule (produces a finding — the PR is NOT Clean)

Every PR **except a release cut** must target the **integration branch**. A
non-release PR targeting the **deploy branch** ships straight to production and
skips integration — that is a finding:

1. **Retarget it to the integration branch.** If `gh pr edit` fails (some repos'
   projects-classic GraphQL), PATCH the REST API:
   `gh api -X PATCH repos/<owner>/<repo>/pulls/<N> -f base=<integration-branch>`
2. Verify it's still `MERGEABLE` and the diff is sane.
3. Record it as an issue→fix row, e.g.:
   `| Targeted the deploy branch directly — would deploy to prod, skipping integration. | Retargeted the PR base to the integration branch. |`

Only release-cut PRs may target the deploy branch. (A PR already merged can't be
retargeted — flag it retrospectively instead.)

## Entry format (exact)

Group entries under a dated round heading, newest round at the **top**:
`## YYYY-MM-DD — Review round`. Under it, **one section per PR**:

```
### PR #<number>

**Submitter:** <github login>  **Title:** <exact PR title>

**Description:** <1–3 plain-English sentences: what the PR does>

<EITHER an Issue → Fix table, OR the word Clean>
```

- **Issue → Fix table** — Markdown table with columns `Issue | Fix`, one row per
  finding you acted on (bugs fixed, tests added, the base retarget, …). Plain
  language: the problem, then what changed — not code.
- **Clean** — if there were **no findings at all**, write the single bold word
  **Clean** with a one-line reason. Never leave an empty table.
- A PR that targeted the deploy branch (and was retargeted) is **never Clean**.

Keep prod-deploy / security / follow-up context as `>` blockquote callouts below
the table, not as table rows.

## Publishing

The log lives on its own branch → PR to the integration branch (e.g. branch
`docs/pr-fix-log`). **Append** the new round above older ones; never rewrite prior
rounds. If the project mirrors the log elsewhere (another repo/path), update the
mirror to match.
