# Set up on Windows with WSL (or on Linux)

About 25 minutes. WSL runs Ubuntu Linux inside Windows. Use this guide if you already work in WSL,
or were told to. Otherwise, [the plain Windows guide](setup-windows.md) is simpler.

**On a Linux computer** (Ubuntu, Debian, Fedora, Arch): skip steps 2 and 3, open your terminal,
and start at step 4.

> **How to paste a command into the Ubuntu window:** right-click in the window (or press
> **Ctrl Shift V**), then press **Enter**. Wait for the prompt (ending in `$`) to come back before
> the next one.

---

## 1. Get your Asana token ready (pm-kit only)

Skip this step if you only want ship-kit.

pm-kit connects to Asana using a *personal access token* — a long password-like code that lets
Claude act as you on your boards.

1. Open <https://app.asana.com/0/my-apps> in your Windows browser and sign in to Asana.
2. Under **Personal access tokens**, click **Create new token**.
3. Name it `Claude`, accept the terms, and click **Create token**.
4. Click **Copy** and keep the page open — you will paste it in step 4.

Treat the token like a password: don't email it or paste it into chat.

## 2. Install WSL (skip if you already have Ubuntu)

1. Click **Start**, type `PowerShell`, right-click **Windows PowerShell**, and choose **Run as
   administrator**.
2. Paste:
   ```powershell
   wsl --install
   ```
3. **Restart your computer** when it finishes.
4. After the restart an **Ubuntu** window opens and asks you to create a username and password.
   Pick something you will remember — this password is asked for later.

## 3. Open Ubuntu

Click **Start**, type `Ubuntu`, and open it. Everything from here on happens in this window.

## 4. Run the installer

Paste this whole line:

```bash
curl -fsSL https://raw.githubusercontent.com/fractionwork/devhawk-tools/main/plugins/pm-kit/skills/_shared/factory-setup.sh -o /tmp/devhawk-setup.sh && bash /tmp/devhawk-setup.sh --role local
```

It installs everything the plugins need — Node.js, Python, the GitHub tool, Claude Code itself —
and then both plugins. Along the way it may ask you:

| It asks | What to do |
|---|---|
| **[sudo] password** | Type your **Ubuntu** password (from step 2) and press Enter. Nothing appears as you type — that's normal. |
| **sign in to GitHub now?** | Yes if you will use ship-kit with GitHub. A browser should open on Windows; if it doesn't, copy the web address it prints into your browser and type the code it shows. Otherwise type `n`. |
| **paste your Asana token now?** | Yes if you use pm-kit: paste the token from step 1 (it stays hidden) and press Enter. |

At the end it prints a summary. Lines with a green ✓ worked. If anything shows a red ✗, the
summary says what to do — running the same command again is safe and retries only what failed.

> **It mentions "Windows interop" or `wsl --shutdown`?** Do what it says: in Windows PowerShell
> run `wsl --shutdown`, reopen Ubuntu, and run the installer again. That setting is what lets
> Ubuntu open your Windows browser for sign-ins.

## 5. Start Claude Code

**Close the Ubuntu window and open a new one** (step 3 again). New programs are only found by a
fresh window.

Then start Claude Code:

```bash
claude
```

The first time, it asks you to sign in to your Claude account. If no browser opens, copy the web
address it prints into your Windows browser.

## 6. Finish pm-kit setup (pm-kit only)

In Claude Code, type:

```
/pm-setup
```

Claude checks that everything is in place and connects to your Asana account. If you belong to
more than one Asana workspace, it asks which one to use.

When it says it's ready, type `/exit`, then start Claude Code again with `claude`.

## 7. Try it

**Keep your projects inside Ubuntu** — in your Ubuntu home folder (`~`), not under `/mnt/c/...`.
Windows folders work, but are much slower from inside WSL.

Start Claude Code in your project's folder (`cd` to the folder first) and try:

- pm-kit: *"Add a card to the Website project for fixing the broken signup link"*
- ship-kit: *"What should I work on next?"* or *"Run the tests"*

Next: [using pm-kit](pm-kit.md) · [using ship-kit](ship-kit.md) ·
[something not working?](troubleshooting.md)

---

<details>
<summary>Prefer to install things yourself?</summary>

1. Install the basics: `sudo apt update && sudo apt install -y git curl python3 python3-venv`
2. Install [Node.js](https://nodejs.org) 24 or newer — the Ubuntu package is too old. The
   simplest way is [nvm](https://github.com/nvm-sh/nvm): install it, then `nvm install 24`.
3. Install Claude Code **inside Ubuntu** (not the Windows one):
   `curl -fsSL https://claude.ai/install.sh | bash`
4. For ship-kit with GitHub: install the [GitHub CLI](https://github.com/cli/cli#installation)
   and run `gh auth login`.
5. In Claude Code:
   ```
   /plugin marketplace add fractionwork/devhawk-tools
   /plugin install pm-kit@devhawk-tools
   /plugin install ship-kit@devhawk-tools
   ```
6. Restart Claude Code and run `/pm-setup` for pm-kit. To use a token, add it to
   `~/.claude/settings.json` as shown in [pm-kit → Connecting to Asana](pm-kit.md#connecting-to-asana).

</details>
