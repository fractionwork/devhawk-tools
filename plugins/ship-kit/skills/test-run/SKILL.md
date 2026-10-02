---
name: test-run
description: >
  Run this repo's tests locally and report a one-page summary — unit, api
  (integration), and e2e (Playwright). Detects the right command per suite,
  names what is blocking a run BEFORE starting it (database down, dev server not
  started, browsers not installed), and writes a concise results document.
  Browser suites run HEADLESS by default and say so; pass --headed to watch.
  Triggers on "run the tests", "run unit tests", "run e2e", "test this repo",
  "test-run", "are the tests passing", or any ad-hoc request to execute tests.

---

# Test Run

Execute the repo's tests and produce a summary somebody can read in thirty seconds.

This is the **ad-hoc / demo** path: no CI, no card, no factory. It answers "does this
work right now", and when it doesn't, it says what to fix rather than handing back a
wall of scrollback. For UAT — acceptance criteria exercised as a user rather than a
spec file — use the `uat-run` skill instead.

## Arguments

| Form | Meaning |
|---|---|
| *(none)* | Run every suite that is detected and unblocked |
| `unit` / `api` / `e2e` | Run just that suite |
| `unit api` | Run several |
| `--headed` | Show the browser for `e2e` (default is headless) |
| `--out=<path>` | Where to write the summary (default `.test-runs/test-summary.md`) |

## Step 1: Detect before you run anything

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/test-detect.mjs --summary
```

This reads package.json, the config files, and probes the ports the suites need. It
runs nothing and starts nothing. Show the user the table as-is.

Each suite comes back `ready`, `BLOCKED` (with the reason and the fix), or
`not configured`. **Never run a BLOCKED suite to see what happens** — the failure it
produces looks like broken tests and costs more time than reading the blocker did.

## Step 2: Clear the blockers

Offer to clear each one; do not do it silently, and never for a service the user did
not ask you to start.

| Blocker | Fix |
|---|---|
| nothing listening on the DB port | `docker compose up -d` (the detector names the compose file) |
| nothing listening on the app port | start the dev server in the background, wait for it to answer |
| no Playwright browsers | `<pm> exec playwright install chromium` |
| no script for the suite | say so and skip it — do not invent a command |

Starting a dev server for the user means starting it in the background and **waiting
until the port answers** before running anything against it. A suite launched against
a server still compiling fails on timeouts that read as product bugs.

If a suite stays blocked, run the others and record the skipped one in the summary.
A partial run reported as partial is useful; a partial run reported as a pass is not.

## Step 3: Run, with JSON on

Counts in the summary come from the runner's own JSON, never from reading scrollback —
a long run gets truncated and the truncated part is exactly where the failures are.

**Write results to `.test-runs/`, never to `test-results/`.** Playwright OWNS
`test-results/` and empties it at the start of every run — put a unit-test JSON there
and the e2e run silently deletes it, so the summary reports a unit suite that never
ran. Add `.test-runs/` to `.gitignore` if it is not already ignored.

Use each suite's **`execCommand`** from the detector, not its `command`. This matters
and is invisible when you get it wrong:

- `pnpm run <script> --reporter=json` — pnpm has its OWN `--reporter`, so it eats the
  flag, writes no results file, and still exits 0. The run looks fine and there is
  nothing to summarise.
- `pnpm run <script> -- --reporter=json` — the `--` reaches the runner as a positional
  test-name filter, so it silently matches nothing.

`execCommand` is the `<pm> exec <script body>` form, which takes extra flags properly.

**unit / api** (Vitest):
```bash
<execCommand> --reporter=json --outputFile=.test-runs/<suite>.json
```
For Jest, `--json --outputFile=` is the equivalent. If the runner is neither, run the
detected command plain and summarise from its output — and say in the report that the
counts came from console output rather than a machine-readable result.

**e2e** (Playwright) — headless is the default:
```bash
PLAYWRIGHT_JSON_OUTPUT_NAME=.test-runs/e2e.json \
  <execCommand> --reporter=json          # add --headed only if asked
```

Always confirm the results file actually exists before summarising. An empty or missing
one means the flags did not reach the runner — fix that rather than reporting no tests.

Long suites belong in the background so the user is not staring at a blocked terminal.
Poll for completion rather than guessing at a duration.

## Step 4: Summarise

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/_shared/test-summary.mjs \
  --vitest=unit:.test-runs/unit.json \
  --vitest=api:.test-runs/api.json \
  --playwright=e2e:.test-runs/e2e.json \
  --title="<repo> — local test run" \
  --out=.test-runs/test-summary.md
```

Pass `--headed` **only** when the browser suite actually ran headed: that flag is what
puts the "ran headless, re-run with --headed to watch" callout in the document, and
getting it wrong tells somebody a window appeared when none did. Omit any `--vitest` /
`--playwright` flag whose suite did not run.

Then show the user the table and the failures inline — do not make them open the file
to learn whether it passed. Say where the document was written.

## Step 5: Say what it means

End with one line, not a paragraph:

- all green → `PASS — <n> tests across <suites>. Summary: <path>`
- failures → lead with **what broke**, one line each, then the path
- a skipped suite → name it and why, every time

Never report a run as passing when a suite was skipped, blocked, or ran zero tests.
"No tests ran" is not a pass, and the summary document scores it that way on purpose.

## Headless is stated, always

A browser suite that ran headless looks identical in a report to one that ran headed.
Anyone about to say "watch this" in front of a room needs to know which they got, so:

- headless is the **default** — it is faster and it works over SSH;
- every browser run states which mode it used, in the terminal and in the document;
- `--headed` needs a display. On Linux without one (no `DISPLAY`, no WSLg) the browser
  silently falls back to headless — check `DISPLAY` before promising a window, and say
  so if it is unset rather than letting the user find out mid-demo.
