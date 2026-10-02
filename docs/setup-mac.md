# Set up on a Mac

About 15 minutes. You will copy and paste a few commands into the **Terminal** app — each step
says exactly what to paste and what you should see.

> **How to paste a command:** click once in the Terminal window, press **⌘V**, then press
> **Return**. Paste one command at a time and wait for it to finish (the prompt, ending in `%` or
> `$`, comes back) before pasting the next.

---

## 1. Get your Asana token ready (pm-kit only)

Skip this step if you only want ship-kit.

pm-kit connects to Asana using a *personal access token* — a long password-like code that lets
Claude act as you on your boards.

1. Open <https://app.asana.com/0/my-apps> and sign in to Asana.
2. Under **Personal access tokens**, click **Create new token**.
3. Name it `Claude`, accept the terms, and click **Create token**.
4. Click **Copy** and keep the page open — you will paste it in step 4.

Treat the token like a password: don't email it or paste it into chat.

## 2. Open Terminal

Press **⌘ Space**, type `Terminal`, and press **Return**.

## 3. Install Apple's developer tools

Paste:

```bash
xcode-select --install
```

- If a window pops up, click **Install** and wait for it to finish (a few minutes).
- If you see `command line tools are already installed`, that's fine — carry on.

## 4. Run the installer

Paste this whole line:

```bash
curl -fsSL https://raw.githubusercontent.com/fractionwork/devhawk-tools/main/plugins/pm-kit/skills/_shared/factory-setup.sh -o /tmp/devhawk-setup.sh && bash /tmp/devhawk-setup.sh --role local
```

It installs everything the plugins need — Node.js, Python, the GitHub tool, Claude Code itself —
and then both plugins. Along the way it may ask you:

| It asks | What to do |
|---|---|
| **Password** | Type your Mac login password and press Return. Nothing appears as you type — that's normal. |
| **install Homebrew now?** | Press Return (yes). Homebrew is the standard way to install tools on a Mac. |
| **install python@3.12 via brew?** | Press Return (yes) — your Mac's built-in Python is too old. |
| **sign in to GitHub now?** | Yes if you will use ship-kit with GitHub: a browser opens, sign in, and approve. Otherwise type `n`. |
| **paste your Asana token now?** | Yes if you use pm-kit: paste the token from step 1 (it stays hidden) and press Return. |

At the end it prints a summary. Lines with a green ✓ worked. If anything shows a red ✗, the
summary says what to do — running the same command again is safe and retries only what failed.

## 5. Start Claude Code

**Close the Terminal window and open a new one** (⌘ Q, then step 2 again). New programs are only
found by a fresh window.

Then start Claude Code:

```bash
claude
```

The first time, it asks you to sign in to your Claude account in the browser. Follow the prompts.

## 6. Finish pm-kit setup (pm-kit only)

In Claude Code, type:

```
/pm-setup
```

Claude checks that everything is in place and connects to your Asana account. If you belong to
more than one Asana workspace, it asks which one to use.

When it says it's ready, type `/exit`, then start Claude Code again with `claude`.

## 7. Try it

Start Claude Code in your project's folder (`cd` to the folder first) and try:

- pm-kit: *"Add a card to the Website project for fixing the broken signup link"*
- ship-kit: *"What should I work on next?"* or *"Run the tests"*

Next: [using pm-kit](pm-kit.md) · [using ship-kit](ship-kit.md) ·
[something not working?](troubleshooting.md)

---

<details>
<summary>Prefer to install things yourself?</summary>

The installer does nothing you can't do by hand:

1. Install Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
2. Install [Node.js](https://nodejs.org) (the LTS version, 24 or newer) and, for pm-kit,
   [Python](https://www.python.org/downloads/) 3.10 or newer.
3. For ship-kit with GitHub: install the GitHub CLI (`brew install gh`) and run
   `gh auth login`.
4. In Claude Code:
   ```
   /plugin marketplace add fractionwork/devhawk-tools
   /plugin install pm-kit@devhawk-tools
   /plugin install ship-kit@devhawk-tools
   ```
5. Restart Claude Code and run `/pm-setup` for pm-kit. To use a token, add it to
   `~/.claude/settings.json` as shown in [pm-kit → Connecting to Asana](pm-kit.md#connecting-to-asana).

</details>
