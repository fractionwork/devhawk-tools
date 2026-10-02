# pm-kit — managing your Asana board

pm-kit teaches Claude your team's board rules, so cards come out right the first time: in the right
column, with the standard fields filled in, without duplicates, and with a note of where each
request came from.

You don't need to remember commands — describe what you want and Claude picks the right one. The
commands are listed so you know what's possible.

| Command | What it does | Say something like |
|---|---|---|
| `/add-card` | Creates one card correctly: checks for duplicates first, puts it in **INBOX** (an idea still to be discussed) or **BACKLOG** (agreed work), fills in the standard fields, and records where the request came from | "add a ticket for the broken export button", "log a bug: the invoice total is wrong", "park this idea: dark mode" |
| `/add-comment` | Posts a properly formatted comment on a card, including @mentions | "comment on the login card that the fix is deployed", "tell @Sam on the export ticket that it's ready to test" |
| `/asana-bootstrap` | Creates a **new** Asana project already set up the standard way (columns, fields, admins) | "create an Asana project for the Acme rebuild" |
| `/asana-hygiene` | Checks an **existing** board against the standard and fixes what it can: missing fields, missing estimates, stale INBOX items, cards with no owner | "clean up the Website board", "audit the board" |
| `/milestone-mapper` | Builds a one-page progress report (what shipped, what's next, what's blocked) as a web page you can share. Reads the board — changes nothing | "make a milestone tracker for Acme", "build a status page" |
| `/pm-setup` | One-time setup, and the first thing to run if Asana stops working | "connect Asana", "Asana isn't working" |

If typing `/add-card` says the command isn't found, try `/pm-kit:add-card`.

---

## Connecting to Asana

pm-kit signs in to Asana as **you**, using a personal access token. Everything Claude does on the
board shows up under your name.

**If the installer saved your token** (you answered yes to "paste your Asana token now?"), skip to
step 3.

1. **Create a token** — open <https://app.asana.com/0/my-apps>, click **Create new token** under
   *Personal access tokens*, name it `Claude`, and copy it.

2. **Save it where Claude Code can find it.** The easy way: run the installer from your
   [setup guide](../README.md#set-up--pick-your-computer) again and answer yes to the token
   question. It only redoes what's missing.

   Or save it by hand in Claude Code's settings file:

   | Computer | Open the file with |
   |---|---|
   | Mac | `mkdir -p ~/.claude && touch ~/.claude/settings.json && open -e ~/.claude/settings.json` |
   | Windows (PowerShell) | `notepad $env:USERPROFILE\.claude\settings.json` |
   | WSL / Linux | `mkdir -p ~/.claude && nano ~/.claude/settings.json` |

   If the file is **empty**, paste this, with your token in place of the placeholder:

   ```json
   {
     "env": {
       "ASANA_PAT": "paste-your-token-here"
     }
   }
   ```

   If it **already has settings in it**, add the `"env"` part inside the outer `{ }`, with a comma
   after the line before it. Save and close.

3. **Restart Claude Code** (type `/exit`, then `claude`) and run `/pm-setup`. It checks everything
   and, if you belong to more than one Asana workspace, asks which one to use.

4. **Restart Claude Code once more.** pm-kit's Asana connection starts when Claude Code starts.

To check it worked, ask: *"list my Asana projects"*.

<details>
<summary>Rather sign in through the browser than use a token?</summary>

`/pm-setup` can sign you in through Asana's own sign-in page instead. To do that you first register
a small "app" in Asana's developer console (<https://app.asana.com/0/my-apps> → **Create new
app**), with the redirect URL `http://localhost:8372/callback`. `/pm-setup` opens a form in your
browser for its Client ID and secret, then the Asana sign-in. A token is simpler for most people.

</details>

## Setting up your board

pm-kit works best on boards laid out the standard way:

- **Columns (sections):** INBOX → BACKLOG → TODO → WIP → READY FOR REVIEW → READY FOR TESTING →
  READY FOR RELEASE → DONE
- **Fields:** Priority, Task Type, Story Points, Release, Sprint, Task Progress, Theme, Feature
- **At least two project admins**, so a card never ends up with nobody responsible

You don't need to build this by hand:

- **New project?** Ask Claude to *"create an Asana project for …"* (`/asana-bootstrap`).
- **Existing project?** Ask Claude to *"audit the … board"* (`/asana-hygiene`). It reports what's
  missing and offers to fix it.

## Good to know

- **Every card records its source.** When Claude adds or changes a card, it notes where the request
  came from (a meeting, an email, you) and posts a comment quoting it — so anyone can see later why
  the card exists.
- **Big batches stay quiet.** When Claude changes six or more cards at once, it turns Asana
  notifications off for that batch so your team isn't flooded, and tells you it did.
- **Other boards.** Adding cards also works on Linear, commenting on Linear and Jira, and the
  milestone tracker reads Linear too — if you have connected those tools to Claude Code yourself.
  Board setup and clean-up are Asana only.
- **Your sign-in lives in** the `.devhawk/pm` folder in your home folder (and your token, if you
  used one, in Claude Code's `settings.json`). Updating the plugin never touches them.

Something not right? See [troubleshooting](troubleshooting.md#pm-kit).
