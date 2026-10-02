# ship-kit — building and shipping code

ship-kit gives Claude a steady routine for building software, from picking up a task to closing it
out:

**pick the next task → build it → write tests → open a pull request → review it → close the card**

Every step is optional and works on its own — use the whole routine, or just *"run the tests"*.
Describe what you want in plain words and Claude picks the right step.

## Before you start

- **Your project is a git repository.** Start Claude Code inside the project's folder.
- **GitHub sign-in, for the pull-request steps.** Opening, reviewing and watching pull requests uses
  the GitHub CLI. If you skipped the GitHub sign-in during setup, run this once in your terminal:
  ```bash
  gh auth login
  ```
  Choose **GitHub.com**, then **HTTPS**, then **Login with a web browser**.
- **Somewhere your tasks live** — only needed for "what's next" and closing cards:
  - an **Asana** board, through [pm-kit](pm-kit.md),
  - **Linear** or **Jira**, if you have connected them to Claude Code, or
  - a plain **`backlog.md`** file in your project — ask Claude to *"start a backlog.md for this
    project"*.

### Optional extras — worth adding

Two free plugins from Anthropic make ship-kit better. In Claude Code:

```
/plugin marketplace add anthropics/claude-plugins-official
/plugin install code-review@claude-plugins-official
/plugin install playwright@claude-plugins-official
```

(If the first line says the marketplace is already added, that's fine.) Then restart Claude Code.

- **code-review** — pull-request reviews run a deeper, multi-angle review instead of a simple read
  of the changes.
- **playwright** — lets Claude drive a real web browser, which `/uat-run` needs.

## What you can ask for

| Command | What it does | Say something like |
|---|---|---|
| `/next-task` | Picks the next card from your board, assigns it to you, creates a branch, shows a plan, and starts building once you approve | "what's next?", "grab a card" |
| `/feature-build` | Builds a feature following your project's existing patterns, with tests | "build the password reset page" |
| `/test-gen` | Writes tests for what you just changed (best suited to JavaScript/TypeScript projects) | "write tests for this" |
| `/test-run` | Runs your tests and writes a one-page summary of what passed and failed | "run the tests", "are the tests passing?" |
| `/uat-run` | Opens your app in a real browser and checks each acceptance criterion like a person would, with screenshots — changes nothing | "check the acceptance criteria", "run UAT against localhost:3000" |
| `/create-pr` | Brings your branch up to date and opens a pull request on GitHub | "create a PR", "open a draft PR" |
| `/pr-review` | Reviews a pull request: style checks, type checks, convention checks and a code review, then posts comments | "review this PR", "review PR 42" |
| `/pr-watch` | Checks your open pull requests and tells you only about the ones that need you | "any PRs ready?", "watch my PRs" |
| `/card-done` | After a pull request is merged, moves the card along and posts a summary | "merged — close the card" |
| `/pr-fix-log` | Adds an entry to `docs/pr-fix-log.md` — only if your project keeps that file | "document this PR" |
| `/security-brief` | Works through findings from a daily security-scan pull request. **Only useful if your repository already runs that scan** — skip it otherwise | "process the security brief" |

If typing a command says it isn't found, add the plugin name: `/ship-kit:next-task`.

### Watching pull requests automatically

Ask Claude Code to check every half hour while it is open:

```
/loop 30m /pr-watch
```

It stays quiet unless a pull request needs you: ready to merge, has problems, or can be fixed.

## Running tests

```
/test-run                                # every kind of test the project has
/test-run e2e --headed                   # just the browser tests, with the browser visible
/uat-run --url=http://localhost:3000     # check acceptance criteria against your running app
```

Before running, `/test-run` checks what each kind of test needs — a database, the app running, a
browser installed — and tells you what's missing instead of failing halfway. Results are written to
the `.test-runs` folder in your project.

Browser runs are hidden ("headless") by default. Add `--headed` to watch.

## Telling ship-kit how your project runs

ship-kit works out your project's commands (lint, type checks, tests) by itself for JavaScript and
TypeScript projects that use **pnpm**, and for Python projects. If your project uses `npm` or other
commands, add a small file called `.factory/profile.json` to the project — or ask Claude to *"create
a ship-kit profile for this project"*. For an npm project it looks like this:

```json
{
  "stack": "ts-next",
  "commands": {
    "install": "npm ci",
    "lint": "npm run lint",
    "typecheck": "npx tsc --noEmit",
    "test": "npm test",
    "gate": "npm run lint && npm test",
    "dev": "npm run dev"
  }
}
```

`gate` is the full check that must pass before a pull request is ready.

## Permissions — why Claude asks before running things

Claude Code asks before running a command for the first time. When ship-kit asks to run `gh …`
(the GitHub tool) or `node …` (its own helper scripts), choose **Yes, and don't ask again**.

To approve them up front for one project, for example so `/pr-watch` can run unattended, create
`.claude/settings.json` in the project with:

```json
{
  "permissions": {
    "allow": [
      "Bash(gh pr list *)",
      "Bash(gh pr view *)",
      "Bash(gh repo view *)",
      "Bash(gh api graphql *)",
      "Bash(gh auth token)",
      "Skill(code-review:code-review)"
    ]
  }
}
```

Something not right? See [troubleshooting](troubleshooting.md#ship-kit).
