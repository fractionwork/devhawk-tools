# Something not working?

Start with the first two checks — they fix most problems.

1. **Restart Claude Code.** Type `/exit`, then `claude`. Plugins and the Asana connection only load
   when Claude Code starts, so anything installed or changed while it was open isn't seen yet.
2. **Ask Claude Code to check itself.** In your terminal (not inside Claude Code), run:
   ```bash
   claude doctor
   ```

Still stuck? Find your problem below.

---

## Installing

**`claude: command not found` (or "not recognized") right after installing**
Close the terminal window and open a new one. A terminal that was open during the install doesn't
know about the new program yet.

**The installer shows red ✗ / `[x]` lines**
Read the line under each one — it says what to do. Then run the installer command again: it skips
everything that already worked and retries only what failed.

**Windows: "winget is not available"**
Install **App Installer** from the Microsoft Store, then run the installer again.

**Windows: errors mentioning "Git Bash" or `bash`**
Claude Code needs Git for Windows to run the plugins' scripts. Install it from
<https://git-scm.com/download/win>, then close and reopen PowerShell. If it's installed somewhere
unusual, tell Claude Code where by adding this to `%USERPROFILE%\.claude\settings.json` (adjust the
path to match yours):

```json
{
  "env": {
    "CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"
  }
}
```

**`/plugin install` says the marketplace or plugin isn't found**
Add the marketplace first, then install:

```
/plugin marketplace add fractionwork/devhawk-tools
/plugin install pm-kit@devhawk-tools
```

If you used the old `pm-skills` name before, remove it first: `/plugin marketplace remove pm-skills`.

**A command like `/add-card` isn't recognized**
Use the plugin's name in front: `/pm-kit:add-card`, `/ship-kit:next-task`. Or just say what you
want in plain words. Check the plugins are installed and enabled with `/plugin`.

**Updates don't seem to arrive**
Run `/plugin marketplace update devhawk-tools`, then restart Claude Code.

---

## pm-kit

**Claude says it can't reach Asana, or the Asana tools are missing**
Run `/pm-setup`. It checks each piece and says which one is missing. The usual causes:

- **Claude Code wasn't restarted** after saving the token or running `/pm-setup`. Restart it.
- **No token is saved.** See [Connecting to Asana](pm-kit.md#connecting-to-asana). A token typed
  into a terminal with `export` only lasts until that window closes — save it in
  `settings.json` instead.
- **You belong to more than one Asana workspace** and none is chosen yet. Run `/pm-setup` and pick
  one when asked.
- **The token was deleted or mistyped.** Make a new one at <https://app.asana.com/0/my-apps> and
  save it again.

To see the connection's status directly, run `claude mcp list` in your terminal and look for the
line starting `plugin:pm-kit:asana`: it says **Connected** or why not.

**`/pm-setup` says Python is missing or too old**
pm-kit needs Python 3.10 or newer.
- **Mac:** install it from <https://www.python.org/downloads/> (or `brew install python@3.12`).
- **Windows:** install it from <https://www.python.org/downloads/>. The "python" that opens the
  Microsoft Store doesn't count.
- **WSL / Ubuntu:** `sudo apt install -y python3 python3-venv`

**WSL / Ubuntu: "ensurepip is not available" or a venv error**
Run `sudo apt install -y python3-venv` (on newer Ubuntu releases it may be named like
`python3.13-venv` — the error message says which), then `/pm-setup` again.

**WSL: the Asana sign-in page doesn't open** (only if you chose browser sign-in instead of a token)
Copy the address it prints into your Windows browser. Or use a token instead — no browser needed.

**Cards come out without some fields filled in**
Your board is probably missing the standard fields. Ask Claude to *"audit the board"*
(`/asana-hygiene`) and let it add them.

---

## ship-kit

**"gh: not logged in", or pull-request commands fail**
Sign the GitHub tool in once, in your terminal:

```bash
gh auth login
```

Choose **GitHub.com → HTTPS → Login with a web browser**. Then try again.

**`/next-task` can't find a board**
ship-kit reads tasks from Asana (through pm-kit), Linear or Jira (if connected to Claude Code), or a
`backlog.md` file in your project. Without any of those, ask Claude to *"start a backlog.md for this
project"*.

**Reviews or test runs use `pnpm` but my project uses `npm`**
Tell ship-kit your commands — see
[Telling ship-kit how your project runs](ship-kit.md#telling-ship-kit-how-your-project-runs).

**`/test-run` says a suite is blocked**
It names what's missing before running anything: start your database or app, or install the test
browser with the command it prints (usually `npx playwright install chromium`).

**`/uat-run` can't open a browser**
Install the playwright plugin — see [ship-kit → Optional extras](ship-kit.md#optional-extras--worth-adding)
— and restart Claude Code. Make sure your app is running and the `--url` points at it.

**Claude keeps asking permission for the same commands**
Choose **Yes, and don't ask again** when it asks, or approve them up front — see
[Permissions](ship-kit.md#permissions--why-claude-asks-before-running-things).
