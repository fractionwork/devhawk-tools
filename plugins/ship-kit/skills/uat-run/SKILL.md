---
name: uat-run
description: >
  Run user-acceptance testing against a running app: drive a real browser
  through each acceptance criterion as a user would and return a per-criterion
  pass / fail / unclear verdict with evidence and screenshots. Reads criteria
  from a file, a card, the active card, or the prompt — never invents them. Read-only by default — it
  validates, it never mutates — with sign-in as the one opt-in exception.
  Headless by default and says so; --headed shows the window. Triggers on "run
  uat", "uat this", "acceptance test", "check the acceptance criteria",
  "uat-run", or "demo the uat agent".

---

# UAT Run

Prove — or fail to prove — that each acceptance criterion actually holds in a running
app, the way a person would check it: open the thing, look, and say what you saw.

No database and no card store required, so it runs anywhere there is a browser and a URL.

## What makes this different from `test-run`

`test-run` executes spec files somebody wrote. This executes **acceptance criteria**,
which are sentences in a card, against a live app. There is nothing to author first,
which is why it is the one that demos from a standing start.

## Arguments

| Form | Meaning |
|---|---|
| `--url=<base>` | The running app. Required (or detected — see Step 1) |
| `--headed` | Show the browser window (default: headless) |
| `--criteria=<file>` | Read criteria from a file, one per line |
| `--sign-in` | Permit authentication (see below) |
| `--out=<path>` | Summary path (default `.test-runs/uat-summary.md`) |

## Step 1: Find the app and the criteria

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/test-detect.mjs --suite=uat
```

That reports the app port it expects and whether anything is answering on it. If the
app is down, offer to start the dev server and **wait for the port to answer** — a UAT
run against a server still compiling produces failures that read as product bugs.

Criteria come from the first of these that exists:

1. `--criteria=<file>` — one criterion per line, blank lines and `- ` bullets ignored
2. the active card (`.devhawk-work.json`), whose acceptance criteria are the checklist
3. the user's prompt

**Read the criteria; never restate them.** Whichever source they come from, echo each
one back VERBATIM and confirm before running. Paraphrasing a criterion changes what is
being tested, and the verdict then answers a question nobody asked.

If no source produces criteria, **stop and ask**. A UAT run with no criteria has nothing
to report, and inventing them produces a document that looks like a verdict and is not
one. Never write acceptance criteria for the user here: authoring them is a `flesh` /
board activity with a human in it, and a criterion this skill invented would be one it
then marks itself as passing.

## Step 2: State the browser mode before you start

Headless is the default: faster, and it works over SSH. But a headless run and a headed
run produce identical documents, so say which one this is, out loud, before it starts:

> Running UAT **headless** — no window will appear. Re-run with `--headed` to watch.

`--headed` needs a display. Check `DISPLAY` (or `WAYLAND_DISPLAY`) first; unset on Linux
means the browser silently falls back to headless. Say so rather than letting somebody
discover it mid-demo.

## Step 3: Drive the browser, one criterion at a time

Use the browser tools available in the session (a Playwright-style browser MCP). For
**each** criterion in turn:

1. navigate to where the criterion can be observed;
2. read the page — the accessibility snapshot is better evidence than a screenshot,
   because it names the elements rather than showing pixels;
3. capture one screenshot as the artifact;
4. reach exactly one verdict.

| Verdict | When |
|---|---|
| **pass** | You observed it holding, and you captured evidence of it |
| **fail** | You observed it NOT holding, or hit an error/blocker |
| **unclear** | Unreachable, ambiguous, or only provable by mutating data |

When in doubt, `unclear`. Never guess a `pass`, and never record a `pass` with empty
evidence — evidence is the entire product of this run. Quote what you actually saw
(titles, headings, labels, row text), not what the criterion said you would see.

### Read-only: you validate, you never mutate

Do not actuate a control that writes data — **save, delete, submit, create, update,
confirm, pay**, or any form submit. Navigate, read, screenshot. If a criterion can only
be proven by a write, that is an `unclear` with the reason, not a guess.

### Sign-in is the one exception, and it is opt-in

An app behind a login is otherwise untestable — every criterion past the front door
comes back `unclear`, which is indistinguishable from a broken feature. So when the
user passes `--sign-in` and supplies credentials:

- you MAY fill and submit **the sign-in form**, and sign out and back in;
- use exactly the credentials given — never invent one, guess one, or reuse one found
  in the repository;
- everything above stays refused: sign-in is not permission to submit other forms;
- never enter those credentials anywhere but the app's own sign-in form.

Ask for credentials rather than hunting for them, and use a disposable account on a
non-production environment. Say in the report that the run authenticated.

## Step 4: Write the verdicts, then the summary

Write `.test-runs/uat.json` — **not** `test-results/`, which Playwright empties at the
start of every run:

```json
{ "criteria": [ { "criterion": "...", "verdict": "pass|fail|unclear",
                  "evidence": "...", "screenshot": "..." } ], "trace": "..." }
```

Echo each `criterion` **verbatim** so the verdicts line up with the card. Any
`screenshot` / `trace` path must be a real file you actually wrote.

When the criteria came from a card, say so in the report and name the card, so the
evidence can be matched to the thing it was supposed to prove. Do NOT move the card,
comment on it, or record a verdict against it: this run is advisory, and a board that
changed because somebody rehearsed a demo is worse than one that did not.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/test-summary.mjs \
  --uat=uat:.test-runs/uat.json \
  --title="<app> — UAT" \
  --out=.test-runs/uat-summary.md      # add --headed ONLY if it ran headed
```

## Step 5: Report

Show the per-criterion table inline — the user should not have to open a file to learn
the verdict. Then one line:

- all pass → `UAT PASS — <n>/<n> criteria. Summary: <path>`
- any fail → lead with the failing criterion and what you saw
- any unclear → say **why** it was unclear; "unclear" with no reason is not a result

An overall `fail` is a human decision, not an automatic rejection: this evidences the
handoff, it does not gate anything. Say what you observed and let a person decide.

## When there is no browser

If no browser tool is available in the session, stop and say so. Every criterion would
resolve to `unclear`, and a document full of `unclear` looks like a tested app that is
broken rather than an untested one. That distinction is the whole reason this refuses.
