# Set up on Windows

About 20 minutes, on Windows 10 or 11. You will paste a couple of commands into **PowerShell** —
each step says exactly what to paste and what you should see.

> **How to paste a command:** click once in the PowerShell window, press **Ctrl V** (or
> right-click), then press **Enter**. Wait for the prompt (`PS C:\...>`) to come back before the
> next one.

This guide installs everything directly on Windows. (If you already use WSL — Ubuntu inside
Windows — and want the tools there instead, follow [the WSL guide](setup-wsl.md).)

---

## 1. Get your Asana token ready (pm-kit only)

Skip this step if you only want ship-kit.

pm-kit connects to Asana using a *personal access token* — a long password-like code that lets
Claude act as you on your boards.

1. Open <https://app.asana.com/0/my-apps> and sign in to Asana.
2. Under **Personal access tokens**, click **Create new token**.
3. Name it `Claude`, accept the terms, and click **Create token**.
4. Click **Copy** and keep the page open — you will paste it in step 3.

Treat the token like a password: don't email it or paste it into chat.

## 2. Open PowerShell

Click **Start**, type `PowerShell`, and click **Windows PowerShell**. You do **not** need "Run as
administrator".

## 3. Run the installer

Paste this whole line:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/fractionwork/devhawk-tools/main/plugins/pm-kit/skills/_shared/factory-setup.ps1))) -Role local
```

It installs everything the plugins need — Git for Windows, Node.js, Python, the GitHub tool, Claude
Code itself — and then both plugins. Along the way:

| You see | What to do |
|---|---|
| **"Do you want to allow this app to make changes to your device?"** | Click **Yes**. Windows asks once per program being installed. |
| **"This machine has WSL… continue with the native Windows install anyway?"** | Press Enter (yes) to carry on with this guide. |
| **sign in to GitHub now?** | Yes if you will use ship-kit with GitHub: a browser opens, sign in, and approve. Otherwise type `n`. |
| **paste your Asana token now?** | Yes if you use pm-kit: paste the token from step 1 (it stays hidden) and press Enter. |

At the end it prints a summary. Lines marked `[ok]` worked. Anything marked `[x]` comes with what
to do — running the same command again is safe and retries only what failed.

> **"winget is not available"?** Install **App Installer** from the Microsoft Store, then run the
> command again.

## 4. Start Claude Code

**Close PowerShell and open a new window** (step 2 again). New programs are only found by a fresh
window.

Then start Claude Code:

```powershell
claude
```

The first time, it asks you to sign in to your Claude account in the browser. Follow the prompts.

## 5. Finish pm-kit setup (pm-kit only)

In Claude Code, type:

```
/pm-setup
```

Claude checks that everything is in place and connects to your Asana account. If you belong to
more than one Asana workspace, it asks which one to use.

When it says it's ready, type `/exit`, then start Claude Code again with `claude`.

## 6. Try it

Start Claude Code in your project's folder (`cd` to the folder first) and try:

- pm-kit: *"Add a card to the Website project for fixing the broken signup link"*
- ship-kit: *"What should I work on next?"* or *"Run the tests"*

Next: [using pm-kit](pm-kit.md) · [using ship-kit](ship-kit.md) ·
[something not working?](troubleshooting.md)

---

<details>
<summary>Prefer to install things yourself?</summary>

1. Install [Git for Windows](https://git-scm.com/download/win). **Required** — Claude Code uses
   its "Git Bash" to run the plugins' scripts on Windows.
2. Install [Node.js](https://nodejs.org) (the LTS version, 24 or newer) and, for pm-kit,
   [Python](https://www.python.org/downloads/) 3.10 or newer from python.org. (The "python" that
   opens the Microsoft Store does not count.)
3. Install Claude Code — in PowerShell: `irm https://claude.ai/install.ps1 | iex`
4. For ship-kit with GitHub: `winget install GitHub.cli`, then `gh auth login`.
5. In Claude Code:
   ```
   /plugin marketplace add fractionwork/devhawk-tools
   /plugin install pm-kit@devhawk-tools
   /plugin install ship-kit@devhawk-tools
   ```
6. Restart Claude Code and run `/pm-setup` for pm-kit. To use a token, add it to
   `%USERPROFILE%\.claude\settings.json` as shown in
   [pm-kit → Connecting to Asana](pm-kit.md#connecting-to-asana).

</details>
