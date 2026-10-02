# DevHawk Tools for Claude Code

Two free add-ons ("plugins") for [Claude Code](https://claude.com/claude-code), Anthropic's AI
assistant that works in your terminal. Once installed, you ask Claude in plain English and it
follows the right process for you.

| Plugin | What it helps with | Say things like |
|---|---|---|
| **pm-kit** | Keeping an **Asana** project board tidy: adding cards the right way, commenting, setting up a new board, cleaning up an old one, building a progress page | "add a card for the login bug", "clean up the board", "make a milestone tracker" |
| **ship-kit** | Building software with Claude: pick up the next task, write the code and tests, open a pull request on GitHub, review it, run the tests | "what's next?", "write tests for this", "create a PR", "run the tests" |

You can install one or both. Everything runs on your own computer — there is no server to sign up
for and nothing is sent to us.

---

## What you need

- **A computer running macOS, Windows 10/11, or Linux.**
- **A Claude account that includes Claude Code** (for example Claude Pro or Max, or a Claude for
  Work plan).
- **For pm-kit:** an Asana account.
- **For ship-kit:** your project in a git repository, and a GitHub account if you want Claude to
  open and review pull requests.

You do **not** need to be a developer to install these. The setup guides below walk through every
step, and one command does most of the work for you.

## Set up — pick your computer

| Your computer | Guide | Time |
|---|---|---|
| **Mac** | [Set up on a Mac](docs/setup-mac.md) | about 15 minutes |
| **Windows** (the usual way) | [Set up on Windows](docs/setup-windows.md) | about 20 minutes |
| **Windows with WSL** (Ubuntu inside Windows — if you are not sure, use the guide above) | [Set up on Windows with WSL](docs/setup-wsl.md) | about 25 minutes |
| **Linux** | Follow the [WSL guide](docs/setup-wsl.md) from step 2 — it is the same on any Ubuntu or Debian machine | about 15 minutes |

Already have Claude Code? You can install the plugins directly. Start Claude Code and type:

```
/plugin marketplace add fractionwork/devhawk-tools
/plugin install pm-kit@devhawk-tools
/plugin install ship-kit@devhawk-tools
```

Then quit Claude Code (`/exit`) and start it again. The setup guides cover the few extra things
each plugin needs.

## Using the plugins

- [pm-kit — managing your Asana board](docs/pm-kit.md)
- [ship-kit — building and shipping code](docs/ship-kit.md)
- [Something not working?](docs/troubleshooting.md)

## Keeping up to date

New versions are published here regularly. To get them, start Claude Code and type:

```
/plugin marketplace update devhawk-tools
```

Then quit (`/exit`) and start Claude Code again.

**Coming from `pm-skills`?** This repository used to be called `fractionwork/pm-skills`. Switch
over once:

```
/plugin marketplace remove pm-skills
/plugin marketplace add fractionwork/devhawk-tools
/plugin install pm-kit@devhawk-tools
```

## Removing the plugins

```
/plugin uninstall pm-kit@devhawk-tools
/plugin uninstall ship-kit@devhawk-tools
/plugin marketplace remove devhawk-tools
```

pm-kit keeps its Asana sign-in and its Python files in a folder called `.devhawk/pm` in your home
folder. Delete that folder too if you want everything gone. If you saved an Asana token in Claude
Code's settings, remove the `ASANA_PAT` line from `~/.claude/settings.json` as well.

---

**This repository is generated.** It is rebuilt automatically from a private source repository,
and changes made directly here are overwritten.
