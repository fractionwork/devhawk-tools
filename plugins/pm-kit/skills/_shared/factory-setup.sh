#!/usr/bin/env bash
# devhawk-tools setup — one command from a bare machine to working Claude Code
# plugins: pm-kit and ship-kit, from the public devhawk-tools marketplace.
#
# Installs the prerequisites (git, Node, Python, the GitHub CLI, Claude Code),
# adds the marketplace, installs both plugins and builds pm-kit's Python
# runtime, then offers two optional sign-ins: GitHub (for ship-kit's
# pull-request skills) and an Asana personal access token (for pm-kit).
#
# Usage:
#   bash factory-setup.sh             # set everything up
#   bash factory-setup.sh --check     # report what is installed, change nothing
#   bash factory-setup.sh --yes       # no questions; optional sign-ins skipped
#
# Safe to re-run: every phase is idempotent, and a phase that fails does not stop
# the ones after it — failures are collected and printed once at the end.

# NOT `set -e`: one failing phase must never abort the rest. The summary is the
# contract, and it can only be honest if execution reaches it.
set -uo pipefail

NVM_VERSION="v0.40.6"
NODE_MAJOR="24"
PYTHON_MIN="3.10"
PUBLIC_MARKETPLACE="fractionwork/devhawk-tools"
DEVHAWK_HOME="${DEVHAWK_HOME:-$HOME/.devhawk}"
ENV_FILE="$DEVHAWK_HOME/env"

CHECK_ONLY=0
ASSUME_YES=0
ROLE=""
FAILED=""
# Whether this run put anything new on PATH. Drives the closing notice: a
# "restart your terminal" banner that fires every time is one people stop
# reading, and then miss on the one run where it mattered.
PATH_CHANGED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --role) ROLE="${2:-}"; shift ;;
    --role=*) ROLE="${1#--role=}" ;;
    -h|--help)
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *) echo "factory-setup: unknown option '$1'" >&2; exit 2 ;;
  esac
  shift
done

# ── output ──────────────────────────────────────────────────────────────────
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⊙\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
say()  { printf '    %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
note_fail() { FAILED="$FAILED$1"$'\n'; }
have() { command -v "$1" >/dev/null 2>&1; }

# Where a LINUX `claude` lives, or nothing.
#
# `have claude` is not good enough on WSL. Interop puts the Windows PATH inside
# the distro — 19 `/mnt/c` entries on a stock box — so a Claude Code installed on
# Windows answers `command -v claude` perfectly well, and the script then reports
# it as present and installs nothing. That is exactly the install docs/
# prerequisites.md tells people they cannot reuse: calling it from WSL reaches
# the Linux project over the 9P filesystem, every file operation crosses a VM
# boundary, and path translation breaks the plugin scripts.
#
# So the WSL symptom is "Claude Code is missing" reported by a user whose script
# said it was fine. Resolve the path and reject anything under /mnt or ending
# .exe; the caller installs a native one regardless of what Windows offers.
# The rule itself, pure and separate from PATH lookup so it can be tested
# against real Windows paths — which a test cannot create under /mnt.
# `/mnt/*` is where WSL mounts the Windows drives; `*.exe` covers a Windows
# binary reached some other way (a symlink into $HOME, a wrapper on $PATH).
is_windows_path() {
  case "$1" in /mnt/*|*.exe) return 0 ;; *) return 1 ;; esac
}

native_claude() {
  local p; p="$(command -v claude 2>/dev/null)" || return 1
  is_windows_path "$p" && return 1
  printf '%s\n' "$p"
}

# A Windows claude reachable from this distro — reported, never used.
windows_claude() {
  local p; p="$(command -v claude 2>/dev/null)" || return 1
  is_windows_path "$p" || return 1
  printf '%s\n' "$p"
}

claude_version() { claude --version 2>/dev/null | head -1; }

# Ask. Second argument is the default when the human just presses Enter:
# `yes` (the default) for "shall I install this", `no` for anything that
# records a credential.
#
# Credential prompts default to NO deliberately. They are optional extras, and
# the old single-mode `[Y/n]` meant Enter — or any answer the case did not
# recognise — opted you IN to being asked for a secret you had just been told
# was optional. Reported from a real run: "I said no to shortcut, still asked
# for an api key."
#
# A read that FAILS also answers no now. It used to `return 0`, so losing the
# terminal was indistinguishable from consent — the worst possible direction for
# a prompt whose next step is "type your token".
confirm() {
  local prompt="$1" default="${2:-yes}" reply=""
  [ "$ASSUME_YES" = "1" ] && { [ "$default" = "yes" ] && return 0 || return 1; }
  if [ "$default" = "yes" ]; then printf '  %s [Y/n] ' "$prompt"
  else printf '  %s [y/N] ' "$prompt"; fi
  read -r reply </dev/tty 2>/dev/null || { printf '\n'; return 1; }
  reply="$(printf '%s' "$reply" | tr -d '[:space:]')"
  case "$reply" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    '')    [ "$default" = "yes" ] && return 0 || return 1 ;;
    # Anything else is NOT consent. Say so rather than guessing.
    *)     say "not understood — taking that as no"; return 1 ;;
  esac
}

# Read a secret without echoing it, and never accept one from a pipe — a value
# arriving on stdin is far more likely to be the next line of a script than a
# token a human meant to type.
read_secret() {
  # Guard on /dev/tty, NOT on stdin. The requirement is "a human is at a
  # terminal", and `[ -t 0 ]` only approximates that: it is false whenever stdin
  # is redirected, which includes `curl | bash` and — the case that actually bit
  # — the inside of a `while read` loop fed by a heredoc. There the prompt was
  # skipped silently and the credential was never recorded, with no error.
  [ -r /dev/tty ] || { echo ""; return 1; }
  printf '  %s: ' "$1" >&2
  local v=""
  read -r -s v </dev/tty 2>/dev/null || { echo ""; return 1; }
  printf '\n' >&2
  echo "$v"
}

# ── platform ────────────────────────────────────────────────────────────────
PLATFORM="unknown"
IS_WSL=0
detect_platform() {
  case "$(uname -s)" in
    Darwin) PLATFORM="macos" ;;
    Linux)
      PLATFORM="linux"
      # WSL2 advertises itself in /proc/version; `uname -r` also carries it, but
      # only on some kernels, so check both.
      if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then IS_WSL=1; PLATFORM="wsl"; fi
      ;;
  esac
}

BINFMT_DIR="/proc/sys/fs/binfmt_misc"

# Windows interop: whether this distro can execute Windows binaries.
#
# Everything that opens a browser from WSL — wslview, PowerShell's Start-Process,
# and therefore the Asana OAuth callback and any browser login — works by running
# a Windows binary from inside the distro. With interop off there is no error to
# find: `powershell.exe` is simply "command not found", Python's webbrowser finds
# no handler, and a sign-in appears to hang. Checked once, here, where the fix can
# be explained rather than guessed at.
interop_enabled() {
  local f
  for f in "$BINFMT_DIR/WSLInterop" "$BINFMT_DIR/WSLInterop-late"; do
    [ -e "$f" ] || continue
    head -1 "$f" 2>/dev/null | grep -qi '^enabled' && return 0
  done
  return 1
}
windows_on_path() { have powershell.exe || have pwsh.exe || have cmd.exe; }

# An unresolvable hostname makes EVERY sudo print two scary lines:
#
#   sudo: unable to resolve host factory-demo: Name or service not known
#
# It is only a warning — sudo still works — but it appears in the middle of the
# install, twice per call, and reads as the installer failing. It happens the
# moment somebody renames a WSL distro without updating /etc/hosts, which is a
# perfectly reasonable thing to do before a demo.
#
# Fixed here rather than explained, because the fix is one line and the
# explanation is three paragraphs.
check_hostname() {
  local h
  h="$(hostname 2>/dev/null)" || return 0
  [ -n "$h" ] || return 0
  getent hosts "$h" >/dev/null 2>&1 && return 0

  say "hostname \"$h\" does not resolve — sudo will warn on every call"
  if grep -qE "^127\.0\.1\.1[[:space:]]" /etc/hosts 2>/dev/null; then
    sudo sed -i "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t$h/" /etc/hosts 2>/dev/null
  else
    printf '127.0.1.1\t%s\n' "$h" | sudo tee -a /etc/hosts >/dev/null 2>&1
  fi

  if getent hosts "$h" >/dev/null 2>&1; then
    ok "hostname resolves ($h)"
    # WSL rewrites /etc/hosts on boot, so the fix above is good for this
    # session only. The durable fix is the wsl.conf HOSTNAME — and only that.
    #
    # This used to also recommend `generateHosts = false`, which was wrong.
    # WSL's generated /etc/hosts already contains
    # `127.0.1.1  <name>.localdomain  <name>` for whatever hostname wsl.conf
    # declares (verified on a live distro), so declaring the name is enough.
    # Turning generation off just makes the user the permanent owner of
    # /etc/hosts, including the Windows-side entries WSL injects, to solve a
    # problem they would no longer have.
    if [ "$PLATFORM" = "wsl" ] && ! grep -q "hostname" /etc/wsl.conf 2>/dev/null; then
      say "to make it stick across restarts, run:"
      say "    bash \$(dirname \"\$0\")/set-hostname.sh $h"
      say "or add to /etc/wsl.conf (APPEND — the [interop] block lives there too):"
      say "    [network]"
      say "    hostname = $h"
    fi
  else
    warn "could not make \"$h\" resolve — sudo will keep warning, harmlessly"
    note_fail "hostname resolution (add '127.0.1.1 $h' to /etc/hosts)"
  fi
}

# Set a key inside a named section of an INI file, creating the section if it is
# absent and leaving every OTHER section untouched.
#
# Section-aware on purpose. /etc/wsl.conf routinely carries [boot], [network]
# and [user] alongside [interop], and the obvious `printf >> wsl.conf` produces
# a SECOND [interop] section — which WSL resolves in a way nobody can predict
# from reading the file. Appending is how you break a config while believing you
# extended it.
ini_set() {
  local file="$1" section="$2" key="$3" value="$4" tmp
  tmp="$(mktemp)" || return 1
  sudo touch "$file" 2>/dev/null
  # Trailing blank lines are BUFFERED so an inserted key lands with the rest of
  # its section rather than after the gap that separates it from the next one.
  # Cosmetic, but a config that looks mangled invites someone to "fix" it.
  awk -v sect="$section" -v key="$key" -v val="$value" '
    function flush_blanks(  i) { for (i = 1; i <= nb; i++) print ""; nb = 0 }
    BEGIN { in_s = 0; done = 0; nb = 0 }
    /^[[:space:]]*$/ { if (in_s) { nb++; next } print; next }
    /^[[:space:]]*\[/ {
      if (in_s && !done) { print key " = " val; done = 1 }
      flush_blanks()
      in_s = ($0 ~ "^[[:space:]]*\\[" sect "\\][[:space:]]*$")
      if (in_s) seen = 1
      print; next
    }
    {
      flush_blanks()
      if (in_s && $0 ~ "^[[:space:]]*" key "[[:space:]]*=") {
        if (!done) { print key " = " val; done = 1 }
        next
      }
      print
    }
    END {
      if (in_s && !done) { print key " = " val; done = 1 }
      flush_blanks()
      if (!seen) { print ""; print "[" sect "]"; print key " = " val }
    }
  ' "$file" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  sudo cp "$tmp" "$file" && rm -f "$tmp"
}

check_interop() {
  [ "$PLATFORM" = "wsl" ] || return 0
  if interop_enabled && windows_on_path; then
    ok "Windows interop (browser sign-in will work)"
    return 0
  fi
  if interop_enabled; then
    warn "interop is on, but Windows is not on PATH"
    if ini_set /etc/wsl.conf interop appendWindowsPath true; then
      ok "set appendWindowsPath in /etc/wsl.conf"
      say "run 'wsl --shutdown' from Windows PowerShell to apply."
      note_fail "Windows on PATH (config written — run 'wsl --shutdown' to apply)"
    else
      note_fail "Windows on PATH (see /etc/wsl.conf: [interop] appendWindowsPath=true)"
    fi
    return 1
  fi
  bad "Windows interop is DISABLED — browser sign-in cannot open"
  if ini_set /etc/wsl.conf interop enabled true && ini_set /etc/wsl.conf interop appendWindowsPath true; then
    ok "wrote [interop] to /etc/wsl.conf"
    warn "NOT active until the distro restarts"
    say "from Windows PowerShell:  wsl --shutdown"
    say "interop is registered at boot, so closing the terminal is not enough."
    note_fail "Windows interop (config written — run 'wsl --shutdown' to apply)"
  else
    say "could not write /etc/wsl.conf; add by hand:"
    say "    [interop]"
    say "    enabled = true"
    say "    appendWindowsPath = true"
    note_fail "Windows interop (edit /etc/wsl.conf, then wsl --shutdown)"
  fi
  return 1
}

# ── linux distro + package manager ──────────────────────────────────────────
# This used to pin WSL to exactly Ubuntu 24.04 and speak only apt, on the theory
# that package names and Python versions differ between releases and the
# mismatches fail silently. The failures were real; the pin was the wrong fix.
# It turned away 24.10, 25.04, 26.04 and Debian, all of which install fine, and
# did nothing for native Linux, which was never pinned but got no packages at
# all off apt. What actually protects against a silent mismatch is checking the
# OUTCOME — is git here, is there a Python >= $PYTHON_MIN that can build a venv —
# and that works on any distro. See verify_base.
OS_RELEASE="${OS_RELEASE:-/etc/os-release}"

# "Ubuntu 26.04 LTS", "Fedora Linux 42", ... — for messages only, never branched on.
distro_label() {
  [ -r "$OS_RELEASE" ] || { echo "unknown distro"; return; }
  # shellcheck disable=SC1090
  ( . "$OS_RELEASE"; echo "${PRETTY_NAME:-${NAME:-unknown} ${VERSION_ID:-}}" )
}

# Branch on the package manager actually present, not on the distro name: a
# derivative (Mint, Pop!_OS, Rocky, Alma, Nobara, ...) reports its own ID but
# ships its parent's tooling, and that tooling is what the commands depend on.
# apt, dnf and pacman only, on purpose — they are what the team runs. Anything
# else (zypper, NixOS, ...) gets told exactly what to install, and verify_base
# still checks the result, so it is a manual step rather than a silent gap.
pkg_manager() {
  local m
  for m in apt-get dnf pacman; do
    have "$m" && { echo "$m"; return 0; }
  done
  return 1
}

# The base packages THIS machine still needs, in this manager's names.
#
# Only what is missing, rather than the full list every time. Installing what is
# present is not harmless on Fedora: its default is curl-minimal, and
# `dnf install curl` conflicts with it and fails the whole transaction — taking
# git and python down with it over a curl that already worked.
base_packages() {
  local pm="$1" out=""
  have git  || out="$out git"
  have curl || out="$out curl"
  if ! find_python >/dev/null; then
    case "$pm" in
      # RHEL/Rocky/Alma 9 keep python3 at 3.9 (dnf itself depends on it) and ship
      # newer ones side by side; find_python picks python3.12 up by name.
      dnf) if have python3; then out="$out python3.12"; else out="$out python3"; fi ;;
      apt-get) out="$out python3" ;;
      pacman) out="$out python" ;;
    esac
  fi
  # Debian/Ubuntu split venv + ensurepip out of python3; Fedora ships them in it.
  if [ "$pm" = "apt-get" ] && ! venv_python >/dev/null; then out="$out python3-venv"; fi
  echo "${out# }"
}

# Install packages non-interactively with whichever manager is present.
# sudo resets the environment by default, so the apt knobs are passed on the
# command line: an exported DEBIAN_FRONTEND never reaches apt-get through sudo.
pkg_install() {
  local pm; pm="$(pkg_manager)" || return 1
  [ $# -gt 0 ] || return 0
  # Refresh once per run before the first install, whichever install that is. A
  # box that needed no base packages would otherwise reach the wslu and pipx
  # installs with stale or (fresh WSL images) empty apt lists.
  [ "$PKG_REFRESHED" = "1" ] || pkg_refresh
  case "$pm" in
    apt-get) sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 \
               apt-get install -y -qq "$@" >/dev/null 2>&1 </dev/null ;;
    dnf)     sudo dnf install -y -q "$@" >/dev/null 2>&1 </dev/null ;;
    # -Syu, not -S: Arch supports no partial upgrades, and installing against a
    # stale or freshly -Sy'd database can pull a package linked against libraries
    # newer than the ones installed. Upgrading in the same transaction is the
    # documented way. --needed keeps it a no-op for what is already current.
    pacman)  sudo pacman -Syu --needed --noconfirm "$@" >/dev/null 2>&1 </dev/null ;;
  esac
}

PKG_REFRESHED=0
pkg_refresh() {
  PKG_REFRESHED=1
  case "$(pkg_manager)" in
    apt-get) sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 </dev/null ;;
    # dnf refreshes stale metadata on its own at install time, and pacman's
    # refresh is folded into pkg_install's -Syu (a bare -Sy is a partial upgrade).
    dnf|pacman) : ;;
  esac
}

# A Python >= PYTHON_MIN that can actually build a venv. `import venv` is not
# enough: Debian-family python3 without python3-venv imports venv fine and then
# fails `python3 -m venv` for want of ensurepip — the silent mismatch the old
# release pin was guarding against, caught directly instead.
venv_python() {
  local py; py="$(find_python)" || return 1
  "$py" -c 'import venv, ensurepip' >/dev/null 2>&1 </dev/null || return 1
  echo "$py"
}

# Check what phase_prereqs was for, whatever the distro did or didn't install.
verify_base() {
  local missing="" t
  for t in git curl; do have "$t" || missing="$missing $t"; done
  if [ -n "$missing" ]; then
    bad "still missing:$missing"; note_fail "base packages:$missing"
  else
    ok "git, curl"
  fi
  local py
  if py="$(venv_python)"; then
    ok "python $("$py" -V 2>&1 | awk '{print $2}') with venv"
  elif py="$(find_python)"; then
    bad "$py cannot create a venv — pm-kit's /pm-setup needs one"
    say "Debian/Ubuntu: sudo apt-get install python3-venv"
    note_fail "python venv support"
  else
    bad "no python >= $PYTHON_MIN on PATH ($(distro_label))"
    say "pm-kit's Asana MCP needs one; install python $PYTHON_MIN+ from your distro, or via uv/pyenv"
    note_fail "python >= $PYTHON_MIN"
  fi
}

# ── node ────────────────────────────────────────────────────────────────────
# nvm is a shell FUNCTION, not a binary. It is sourced from an rc file, so it
# does not exist in this script's shell unless we source it ourselves — and a
# `command -v nvm` check would report nothing on a machine where it is installed
# and working. Load it explicitly before every use.
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
}

# The version that MATTERS is the one a NEW shell resolves, because that is what
# Claude Code and the kits' .mjs scripts get. A node that works only in the
# installing terminal is the most common way this setup half-works.
#
# NEVER USE AN INTERACTIVE SHELL (`-i`) TO PROBE THIS. It looks like the obvious
# way to pick up an rc file, and it SUSPENDS THIS SCRIPT: an interactive shell
# sets up job control and reaches for the terminal's foreground process group,
# so the caller takes SIGTTIN/SIGTTOU and stops dead with `[1]+ Stopped`. It
# happened here, on WSL, immediately after a sudo prompt. A version check must
# not be able to halt the installer.
#
# The problem `-i` was reaching for is real, though: macOS defaults to zsh, nvm
# appends to ~/.zshrc, and neither `bash -lc` (reads ~/.bash_profile) nor
# `zsh -lc` (does not read .zshrc — that file is for interactive shells) would
# ever see it.
#
# The fix is to source what we want EXPLICITLY in a non-interactive shell, and
# to ask nvm directly rather than inferring it from a login shell's behaviour:
#
#   1. plain login shell         — covers a system node on PATH
#   2. rc file, sourced by hand  — covers nvm written into .zshrc / .bashrc
#   3. nvm.sh, sourced directly  — covers it regardless of any rc file at all
#
# Every probe gets `</dev/null` so nothing can block on terminal input.
login_node_version() {
  local sh rc v probe bin
  sh="${SHELL:-/bin/bash}"
  rc="$(primary_rc)"

  for probe in \
    'command -v node >/dev/null 2>&1 && node -v' \
    "[ -r '$rc' ] && . '$rc' >/dev/null 2>&1; command -v node >/dev/null 2>&1 && node -v" \
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; command -v node >/dev/null 2>&1 && node -v'
  do
    for bin in "$sh" /bin/bash; do
      [ -x "$bin" ] || continue
      v="$("$bin" -c "$probe" </dev/null 2>/dev/null | tr -d '\r' | grep -E '^v?[0-9]+\.' | head -1)"
      [ -n "$v" ] && { echo "$v"; return 0; }
    done
  done
  echo ""
  return 1
}

node_major() { echo "${1#v}" | cut -d. -f1; }

node_ok() {
  local v; v="$(login_node_version)"
  [ -n "$v" ] || return 1
  [ "$(node_major "$v")" -ge "$NODE_MAJOR" ] 2>/dev/null
}

# ── python ──────────────────────────────────────────────────────────────────
# Only pm-kit needs this, and only for its Asana MCP. Check the VERSION rather
# than trusting `python3`: macOS ships 3.9.x on several releases, and the failure
# would otherwise surface as an opaque error deep inside the mcp package.
find_python() {
  local c
  for c in python3.15 python3.14 python3.13 python3.12 python3.11 python3.10 python3 python; do
    have "$c" || continue
    if "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
      echo "$c"; return 0
    fi
  done
  return 1
}

# ── role → kits ─────────────────────────────────────────────────────────────
# This copy sets up the public plugins only. `--role local` is accepted (it is
# what the setup guides pass); any other role is refused at startup.
kits_for_role() {
  case "$1" in
    local) echo "pm-kit ship-kit" ;;
    *)     echo "" ;;
  esac
}

needs_private_marketplace() { return 1; }

prompt_role() { [ -n "$ROLE" ] || ROLE="local"; }

# ── status ──────────────────────────────────────────────────────────────────
report_state() {
  step "factory-setup — status only, nothing will be changed"
  say "platform: $PLATFORM"
  if [ "$PLATFORM" != "macos" ]; then
    say "distro: $(distro_label) · packages via $(pkg_manager || echo 'none supported (manual)')"
  fi

  if getent hosts "$(hostname 2>/dev/null)" >/dev/null 2>&1; then
    ok "hostname resolves ($(hostname))"
  else
    warn "hostname $(hostname) does not resolve — sudo warns on every call"
  fi
  if [ "$PLATFORM" = "wsl" ]; then
    if interop_enabled && windows_on_path; then ok "Windows interop"
    elif interop_enabled; then warn "interop on, but Windows not on PATH — browser sign-in may not open"
    else bad "Windows interop DISABLED — browser sign-in cannot open"; fi
  fi
  have git && ok "git ($(git --version 2>/dev/null | awk '{print $3}'))" || bad "git missing"
  have curl && ok "curl" || bad "curl missing"

  local v; v="$(login_node_version)"
  if [ -z "$v" ]; then bad "node not found in a login shell"
  elif node_ok; then ok "node $v (login shell)"
  else bad "node $v — below the $NODE_MAJOR floor"; fi

  local py
  if py="$(venv_python)"; then ok "python: $py ($($py -V 2>&1), venv ok)"
  elif py="$(find_python)"; then warn "python: $py ($($py -V 2>&1)) cannot create a venv — /pm-setup will fail"
  else warn "no python >= $PYTHON_MIN (pm-kit's Asana MCP needs one)"; fi

  if native_claude >/dev/null; then ok "claude ($(claude_version))"
  elif local win; win="$(windows_claude)"; then
    bad "only a WINDOWS Claude Code is on PATH ($win) — it cannot drive a Linux project"
  else bad "Claude Code missing"; fi

  if have gh; then
    if gh auth status >/dev/null 2>&1; then ok "gh authenticated"; else warn "gh installed but not authenticated"; fi
  else warn "gh missing (ship-kit's pull-request skills need it)"; fi

  if have claude; then
    local m; m="$(claude plugin marketplace list 2>/dev/null)"
    case "$m" in
      *devhawk-tools*)          ok "marketplace: $PUBLIC_MARKETPLACE" ;;
      *pm-skills*)              warn "marketplace: fractionwork/pm-skills — renamed; remove it and re-run with --role local" ;;
      *)                        warn "devhawk-tools marketplace not added yet" ;;
    esac
    local p; p="$(claude plugin list 2>/dev/null | tr '\n' ' ')"
    local k; for k in pm-kit ship-kit; do
      case " $p " in *"$k"*) ok "plugin: $k" ;; *) say "plugin: $k not installed" ;; esac
    done
  fi

  if [ -n "$(claude_env_get ASANA_PAT)" ]; then
    ok "Asana token saved in $CLAUDE_SETTINGS"
  else
    say "no Asana token saved yet (fine — /pm-setup can do it)"
  fi
  printf '\n'
}

# ── phases ──────────────────────────────────────────────────────────────────
phase_prereqs() {
  step "1/5  Prerequisites"

  # apt on Ubuntu 22.04+ can go INTERACTIVE mid-install even with -y: debconf
  # raises config prompts, and `needrestart` opens a whiptail dialog asking which
  # services to restart. Both read the terminal, and a script that is not the
  # foreground process group takes SIGTTIN and stops. Neither fires on a machine
  # where the packages are already present, which is why this never reproduces on
  # a developer box and bites only a fresh distro.
  export DEBIAN_FRONTEND=noninteractive
  export NEEDRESTART_MODE=a
  export NEEDRESTART_SUSPEND=1

  # Before any sudo, so its warnings never appear at all.
  check_hostname
  check_interop

  if [ "$PLATFORM" = "wsl" ] || [ "$PLATFORM" = "linux" ]; then
    say "distro: $(distro_label)"
    local pm need
    if pm="$(pkg_manager)"; then
      need="$(base_packages "$pm")"
      if [ -n "$need" ]; then
        # shellcheck disable=SC2086  # word-splitting the package list is intended
        pkg_install $need || warn "$pm could not install: $need"
      fi
      # wslview is the preferred browser handoff, but only a preference: wslu is
      # no longer maintained upstream and is gone from Ubuntu 26.04 and Fedora 43,
      # and open-url.sh falls back to PowerShell's Start-Process — which is all
      # wslview does anyway. So its absence is a note, not a warning.
      # Arch has it only in the AUR, which this script does not touch.
      if [ "$PLATFORM" = "wsl" ] && ! have wslview && [ "$pm" != "pacman" ]; then
        pkg_install wslu && ok "wslu (browser handoff)" \
          || say "wslu not packaged here — links open via PowerShell instead (fine)"
      fi
    else
      need="$(base_packages none)"
      warn "no apt-get, dnf or pacman — install these with your package manager, then re-run:"
      say "git, curl, python >= $PYTHON_MIN with venv${need:+   (missing now: $need)}"
    fi
    # The outcome, not the install exit code: this is what catches a distro whose
    # packages installed "successfully" and still left something unusable.
    verify_base
  elif [ "$PLATFORM" = "macos" ]; then
    have git || { warn "git missing — run: xcode-select --install"; note_fail "git (xcode-select --install)"; }
    if have brew; then
      ok "homebrew"
    else
      # Warning and continuing used to dead-end later: phase_github has no way
      # to install gh without it and fails with "no package manager".
      warn "homebrew not installed — gh and python cannot be installed without it"
      if [ "$ASSUME_YES" != "1" ] && confirm "install Homebrew now?"; then
        if curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o /tmp/brew-install.sh 2>/dev/null &&
           NONINTERACTIVE=1 bash /tmp/brew-install.sh >/dev/null 2>&1 </dev/null; then
          # Apple silicon installs to /opt/homebrew, which is not on PATH until
          # shellenv runs; Intel uses /usr/local and usually already is.
          for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
            [ -x "$p" ] && eval "$("$p" shellenv)" && break
          done
          have brew && ok "homebrew" || { bad "installed but not on PATH"; note_fail "homebrew on PATH"; }
        else
          bad "could not install Homebrew"; note_fail "homebrew (see https://brew.sh)"
        fi
      else
        note_fail "homebrew (see https://brew.sh)"
      fi
    fi
    # macOS is the platform where python3 is genuinely in doubt.
    if find_python >/dev/null; then ok "python $( "$(find_python)" -V 2>&1 )"
    elif have brew; then
      confirm "install python@3.12 via brew?" && { brew install python@3.12 >/dev/null 2>&1 </dev/null && ok "python@3.12" || note_fail "python@3.12"; }
    else warn "no python >= $PYTHON_MIN — pm-kit's Asana MCP will not run"; fi
  fi

  # ── node, via nvm ──
  if node_ok; then
    ok "node $(login_node_version) (login shell)"
  else
    local cur; cur="$(login_node_version)"
    [ -n "$cur" ] && say "found node $cur — below the $NODE_MAJOR floor, installing via nvm"
    # Make sure the rc file exists BEFORE nvm runs. nvm's installer appends to a
    # profile it detects, and when it finds none it prints "Profile not found"
    # and appends nothing — leaving node absent from every future shell. A fresh
    # macOS account with no ~/.zshrc hits this exactly.
    local rc; rc="$(primary_rc)"
    [ -f "$rc" ] || { touch "$rc" 2>/dev/null && say "created $rc for nvm to write to"; }

    load_nvm
    if ! command -v nvm >/dev/null 2>&1 && ! type nvm >/dev/null 2>&1; then
      if curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" -o /tmp/nvm-install.sh 2>/dev/null &&
         bash /tmp/nvm-install.sh >/dev/null 2>&1 </dev/null; then
        ok "nvm $NVM_VERSION"
      else
        bad "could not install nvm"; note_fail "nvm"
      fi
      load_nvm
    else
      ok "nvm already present"
    fi

    if type nvm >/dev/null 2>&1; then
      if nvm install "$NODE_MAJOR" >/dev/null 2>&1; then
        # Without a default alias, `nvm install` affects only THIS shell: every
        # future terminal, and anything Claude Code spawns, finds no node at all.
        nvm alias default "$NODE_MAJOR" >/dev/null 2>&1
        if node_ok; then ok "node $(login_node_version) (login shell)"
        else bad "node installed but a login shell cannot find it"
             say "check that your rc file sources nvm, then: nvm alias default $NODE_MAJOR"
             note_fail "node on PATH in a login shell"; fi
      else
        bad "nvm could not install node $NODE_MAJOR"; note_fail "node $NODE_MAJOR"
      fi
    fi
  fi

  # ── Claude Code ──
  #
  # INSTALL OR UPDATE, not install-if-absent. A box that already had it kept
  # whatever version it had forever, so re-running the one-liner — the documented
  # way to fix a machine — never actually refreshed the tool the whole kit runs
  # inside.
  install_or_update_claude
}

# Install Claude Code, or update the one that is already here.
install_or_update_claude() {
  local win; win="$(windows_claude)" && {
    # Reported before anything else: on WSL this is why `have claude` used to
    # succeed while the user had no usable Claude Code. Not an error — we just
    # install the native one alongside it and let PATH order sort itself out.
    warn "found a WINDOWS Claude Code on PATH ($win)"
    say "that one cannot drive a Linux project — installing the native build"
  }

  if native_claude >/dev/null; then
    local before; before="$(claude_version)"
    ok "Claude Code ($before)"
    # `claude update` is the tool's own updater and a no-op when current, so
    # this is safe to run on every pass. Failure is NOT fatal: an up-to-date
    # install that cannot reach the update server still works fine, and dying
    # here would skip the marketplace and every plugin.
    if claude update >/dev/null 2>&1; then
      local after; after="$(claude_version)"
      [ "$after" != "$before" ] && ok "updated to $after"
    else
      warn "could not check for updates — continuing with $before"
    fi
    return 0
  fi

  # Keep the installer's own output. It used to go to /dev/null, so the only
  # thing a failed install could say was "could not install Claude Code" — no
  # reason, nothing to act on, on the one step everything after it depends on.
  local log="${TMPDIR:-/tmp}/factory-claude-install.log"
  if curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh 2>>"$log" &&
     bash /tmp/claude-install.sh >>"$log" 2>&1 </dev/null; then
    # The installer drops the binary in ~/.local/bin (or ~/.claude/local) and
    # edits an rc file — neither of which helps THIS shell. Telling the user
    # to open a new terminal was not a cosmetic wart: phases 3 and 4 then find
    # no `claude`, so the marketplace and every plugin are skipped, and the
    # script completes "successfully" having installed nothing it exists to
    # install. Only a fresh box shows this, because anywhere else claude is
    # already on PATH.
    adopt_path "$HOME/.local/bin" "$HOME/.claude/local" "$HOME/bin"
    if native_claude >/dev/null; then
      ok "Claude Code ($(claude_version))"
    else
      bad "installed but not on PATH — the marketplace and plugin steps cannot run"
      say "find it with:  ls ~/.local/bin/claude ~/.claude/local/claude 2>/dev/null"
      note_fail "claude on PATH (re-run this script from a new terminal)"
    fi
  else
    bad "could not install Claude Code"
    say "installer output: $log"
    # The last few lines are almost always the reason (no curl, TLS failure, a
    # read-only HOME). Showing them beats sending someone to a file they will
    # not open.
    [ -s "$log" ] && tail -3 "$log" | while IFS= read -r l; do say "$l"; done
    note_fail "Claude Code"
  fi
}

# Put directories on PATH for THIS shell and for future ones.
#
# Every installer here writes somewhere that is not yet on PATH — nvm, pipx,
# Claude Code, and the scanner binaries all do it — and each one edits an rc
# file that the running script will never read. Without this the script installs
# a tool and then cannot see it, one step later.
adopt_path() {
  local d
  for d in "$@"; do
    [ -d "$d" ] || continue
    case ":$PATH:" in
      *":$d:"*) ;;
      # A directory that was NOT already here means the user's own shell is now
      # behind — which is the whole condition for the closing notice.
      *) PATH="$d:$PATH"; export PATH; PATH_CHANGED=1 ;;
    esac
    rc_ensure "case \":\$PATH:\" in *\":$d:\"*) ;; *) PATH=\"$d:\$PATH\" ;; esac" "# devhawk: $d on PATH"
  done
}

phase_github() {
  step "2/5  GitHub access"
  local kits public=0; kits="$(kits_for_role "$ROLE")"
  needs_private_marketplace "$kits" || public=1
  if [ "$public" = 1 ]; then
    # The PUBLIC marketplace needs no account to install from. ship-kit's
    # pull-request skills still drive GitHub through gh, so install it and OFFER
    # a sign-in — skipping it leaves the plugins working, minus those skills.
    ok "the plugins themselves need no GitHub account"
    say "ship-kit's pull-request skills (/create-pr, /pr-review, /pr-watch) use the"
    say "GitHub CLI, so it is installed now — signing in is optional"
  fi

  if ! have gh; then
    if [ "$PLATFORM" = "macos" ] && have brew; then
      brew install gh >/dev/null 2>&1 </dev/null && ok "gh" || { bad "could not install gh"; note_fail "gh"; return 1; }
    elif [ "$(pkg_manager)" = "dnf" ]; then
      # GitHub's own rpm repo, as with apt below. Written as a .repo file rather
      # than via `dnf config-manager`, whose syntax changed incompatibly in dnf5
      # (Fedora 41+) — a file in yum.repos.d reads the same to dnf4 and dnf5, and
      # is what makes this work on RHEL/Rocky/Alma, which do not package gh.
      curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo 2>/dev/null \
        | sudo tee /etc/yum.repos.d/gh-cli.repo >/dev/null 2>&1
      pkg_install gh && ok "gh" || { bad "could not install gh"; note_fail "gh"; return 1; }
    elif [ "$(pkg_manager)" = "pacman" ]; then
      # In Arch's own extra repo, and current — no third-party source needed.
      pkg_install github-cli && ok "gh" || { bad "could not install gh"; note_fail "gh"; return 1; }
    elif have apt-get; then
      # GitHub's own apt repo — Ubuntu's copy lags well behind. The source line is
      # distro-agnostic ("stable main"), so this is right on Debian and every Ubuntu.
      sudo mkdir -p -m 755 /etc/apt/keyrings 2>/dev/null
      if curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg 2>/dev/null \
           | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null 2>&1; then
        sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
          | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
        pkg_refresh
      fi
      pkg_install gh && ok "gh" || { bad "could not install gh"; note_fail "gh"; return 1; }
    else
      bad "no package manager to install gh with"; note_fail "gh"; return 1
    fi
  else
    ok "gh present"
  fi

  if gh auth status >/dev/null 2>&1; then
    ok "gh authenticated"
  elif [ "$public" = 1 ]; then
    if [ "$ASSUME_YES" != "1" ] && confirm "sign in to GitHub now? (needed only for the pull-request skills)" yes; then
      # HTTPS, with gh as git's credential helper: nothing to set up, and the
      # public marketplace never needs SSH.
      gh auth login --git-protocol https --web </dev/tty
      if gh auth status >/dev/null 2>&1; then
        ok "gh authenticated"
        gh auth setup-git >/dev/null 2>&1 || true
      else
        warn "not signed in — run later: gh auth login"
      fi
    else
      say "skipped — sign in any time later with: gh auth login"
    fi
  fi
}

phase_marketplace() {
  step "3/5  Marketplace"
  have claude || { bad "Claude Code is not installed — skipping"; note_fail "marketplace (no claude)"; return 1; }

  local kits source
  kits="$(kits_for_role "$ROLE")"
  source="$PUBLIC_MARKETPLACE"

  local existing; existing="$(claude plugin marketplace list 2>/dev/null)"
  case "$existing" in
    *"${source##*/}"*) ok "marketplace already added: $source"; return 0 ;;
  esac

  if claude plugin marketplace add "$source" >/dev/null 2>&1; then
    ok "added marketplace: $source"
  else
    bad "could not add marketplace: $source"
    note_fail "marketplace $source"
    return 1
  fi
}

phase_plugins() {
  step "4/5  Plugins"
  have claude || { bad "Claude Code is not installed — skipping"; note_fail "plugins (no claude)"; return 1; }

  local kits mp k installed
  kits="$(kits_for_role "$ROLE")"
  mp="devhawk-tools"
  installed="$(claude plugin list 2>/dev/null | tr '\n' ' ')"

  for k in $kits; do
    case " $installed " in
      *"$k"*) ok "$k already installed"; continue ;;
    esac
    if claude plugin install "$k@$mp" >/dev/null 2>&1; then
      ok "installed $k"
    else
      bad "could not install $k"; note_fail "plugin $k"
    fi
  done

  # pm-kit's Python runtime. `--deps-only` builds the venv and exits BEFORE the
  # authenticate step, which is the split that matters: the venv is a property
  # of this MACHINE, and the Asana credential is a property of a PROJECT. The
  # runtime belongs here with the other plugin runtimes; the credential belongs
  # at onboarding with every other board credential.
  case " $kits " in
    *" pm-kit "*)
      local ps; ps="$(find "$HOME/.claude/plugins" -path '*pm-kit*' -name 'pm-setup.sh' -type f 2>/dev/null | head -1)"
      if [ -n "$ps" ]; then
        if bash "$ps" --deps-only >/dev/null 2>&1 </dev/null; then
          ok "pm-kit Python runtime"
        else
          warn "pm-kit's Python runtime did not build — run /pm-setup inside Claude Code"
          note_fail "pm-kit runtime (re-run: $ps)"
        fi
      fi
      ;;
  esac

}

# The rc file the user's OWN shell will actually read on a new session.
#
# Not a cosmetic choice. On macOS the default shell is zsh and a fresh account
# frequently has no ~/.zshrc at all; on Linux it is bash and ~/.bashrc. Picking
# the wrong one — or skipping because the file is absent — writes credentials
# that are never loaded.
#
# macOS bash is the subtle case: Terminal starts LOGIN shells, which read
# ~/.bash_profile and never ~/.bashrc.
primary_rc() {
  case "$(basename "${SHELL:-/bin/bash}")" in
    zsh)  echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$PLATFORM" = "macos" ]; then echo "$HOME/.bash_profile"; else echo "$HOME/.bashrc"; fi ;;
    *)    echo "$HOME/.profile" ;;
  esac
}

# Append a line to the shell rc exactly once, keyed by a marker.
#
# CREATES the primary rc if it is missing. The previous version skipped absent
# files, which on a fresh Mac (no ~/.zshrc) meant the credential file was
# written and the line that loads it never was — a 0600 file that looks like
# working configuration and is read by nothing.
rc_ensure() {
  local line="$1" marker="$2" rc primary
  primary="$(primary_rc)"
  [ -f "$primary" ] || { touch "$primary" 2>/dev/null && say "created $primary"; }
  for rc in "$primary" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
    [ -f "$rc" ] || continue
    grep -qF "$marker" "$rc" 2>/dev/null && continue
    printf '\n%s\n%s\n' "$marker" "$line" >> "$rc"
  done
}

# Is this variable already stored?
secret_set() { grep -q "^export $1=" "$ENV_FILE" 2>/dev/null; }

# Claude Code's own settings file. Its "env" block is handed to every session AND
# every MCP server Claude Code starts, on every platform — so it is where a token
# reaches pm-kit's Asana server whatever shell the user starts Claude Code from.
# An `export` in a shell rc only reaches sessions started from that shell.
CLAUDE_SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

claude_env_get() {  # <name> → value, or nothing
  have python3 || return 0
  python3 - "$CLAUDE_SETTINGS" "$1" <<'PY' 2>/dev/null
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding="utf-8")).get("env", {}).get(sys.argv[2], ""))
except Exception:
    pass
PY
}

claude_env_set() {  # <name> <value> — merges; never rewrites a file it cannot parse
  have python3 || { bad "python3 is needed to update $CLAUDE_SETTINGS"; return 1; }
  NAME="$1" VALUE="$2" python3 - "$CLAUDE_SETTINGS" <<'PY'
import json, os, sys
path = sys.argv[1]
settings = {}
if os.path.exists(path):
    raw = open(path, encoding="utf-8").read()
    if raw.strip():
        try:
            settings = json.loads(raw)
        except ValueError:
            sys.exit("settings.json is not valid JSON, so it was left unchanged: " + path)
        if not isinstance(settings, dict):
            sys.exit("settings.json is not a JSON object, so it was left unchanged: " + path)
    # The original, once: a re-run must not replace the file the user had before
    # this script ever touched it. Created 0600 from the start — it can hold
    # every token in settings.json, so it is never world-readable, even briefly.
    backup = path + ".bak"
    if not os.path.exists(backup):
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(raw)
os.makedirs(os.path.dirname(path), exist_ok=True)
settings.setdefault("env", {})[os.environ["NAME"]] = os.environ["VALUE"]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
# O_CREAT's mode applies only to a NEW file; an existing one keeps its own.
os.chmod(path, 0o600)
PY
}

# Outside Fraction, pm-kit signs in to Asana with a personal access token: no
# OAuth app to register, nothing to configure. Offered here so the one command
# leaves a working setup; skippable, and /pm-setup covers it later.
offer_asana_token() {
  printf '\n'
  say "pm-kit connects to Asana with a personal access token. To make one:"
  say "  open https://app.asana.com/0/my-apps → \"Create new token\" → copy it"
  if [ -n "$(claude_env_get ASANA_PAT)" ]; then
    ok "an Asana token is already saved in $CLAUDE_SETTINGS — keeping it"
    return 0
  fi
  if [ "$ASSUME_YES" = "1" ] || ! confirm "paste your Asana token now?" yes; then
    say "skipped — run /pm-setup inside Claude Code whenever you are ready"
    return 0
  fi
  local t; t="$(read_secret 'Asana token (hidden as you paste)')"
  if [ -z "$t" ]; then
    say "nothing entered — skipped. /pm-setup can do this later."
    return 0
  fi
  if claude_env_set ASANA_PAT "$t"; then
    ok "saved to $CLAUDE_SETTINGS (only you can read it)"
    say "restart Claude Code, then run /pm-setup once to finish"
  else
    note_fail "Asana token (add it to $CLAUDE_SETTINGS — see the setup guide)"
  fi
}

save_secret() {
  local name="$1" value="$2" tmp
  mkdir -p "$DEVHAWK_HOME" 2>/dev/null
  touch "$ENV_FILE" 2>/dev/null
  chmod 600 "$ENV_FILE" 2>/dev/null

  # Rewrite through a temp file, ALWAYS — never conditionally on grep's exit
  # status. `grep -v` exits 1 when it filters everything out, so when the file
  # held only this one variable — the normal case, since this is the only
  # credential the script writes — the old `... && mv` silently skipped the
  # move and the append below added a SECOND line. The shell takes the last
  # one, so it worked, which is why it went unnoticed; meanwhile a rotated or
  # revoked token stayed on disk indefinitely, and the file grew on every
  # re-run.
  tmp="$ENV_FILE.tmp.$$"
  grep -v "^export $name=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  # Single quotes are the only thing that can escape the quoting below, so
  # close-escape-reopen them. An unescaped quote does not error — it produces a
  # file the shell mis-parses on every future login.
  printf "export %s='%s'\n" "$name" "$(printf '%s' "$value" | sed "s/'/'\\\\''/g")" >> "$tmp"
  # Mode set BEFORE the move, so the credential is never briefly world-readable.
  chmod 600 "$tmp" 2>/dev/null
  mv "$tmp" "$ENV_FILE"
  rc_ensure '[ -f "$HOME/.devhawk/env" ] && . "$HOME/.devhawk/env"' '# devhawk: local credentials'
}

phase_credentials() {
  step "5/5  Credentials — all optional"
  say "Everything below can be skipped. The kits are fully usable without any of it."

  printf '\n'
  say "To drive an Asana board with YOUR OWN Asana account, run \`/pm-setup\`."
  say "The runtime is already installed above; that signs it in."
  offer_asana_token
}

# ── main ────────────────────────────────────────────────────────────────────
detect_platform

if [ "$CHECK_ONLY" = "1" ]; then report_state; exit 0; fi

case "$PLATFORM" in
  wsl|macos|linux) ;;
  *) echo "factory-setup: unsupported platform '$(uname -s)'" >&2; exit 2 ;;
esac

printf '\n\033[1mfactory-setup\033[0m — prerequisites, marketplace, plugins, credentials\n'
say "platform: $PLATFORM"
say "you will be asked for your password once, for system packages"

prompt_role
if [ -z "$(kits_for_role "$ROLE")" ]; then
  echo "This installer sets up the public plugins (pm-kit, ship-kit) only. Fraction staff:" >&2
  echo "use the setup guide in the internal repository." >&2
  exit 2
fi
say "role: $ROLE  →  $(kits_for_role "$ROLE")"

phase_prereqs
phase_github
phase_marketplace
phase_plugins
phase_credentials

# ── summary ─────────────────────────────────────────────────────────────────
step "Done"
if [ -n "$FAILED" ]; then
  bad "some steps did not complete:"
  printf '%s' "$FAILED" | sed 's/^/      - /'
  printf '\n'
  say "everything else finished. Re-running this script is safe and will retry only these."
else
  ok "everything completed"
fi

# The one instruction people actually have to follow, and it used to be the
# QUIETEST line on screen — `say`, four spaces, no colour, at the end of a page
# of output. Reported exactly as you would expect: "ran the installer again,
# claude is still not found." It was installed; the shell that asked had simply
# never re-read its PATH.
#
# So: a banner, the REASON, and a command that fixes it without opening a new
# terminal. Shown only when this run actually changed PATH — a notice that fires
# every time is one people learn to skip, and then miss when it matters.
if [ "$PATH_CHANGED" = "1" ]; then
  printf '\n\033[1;33m%s\033[0m\n' '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  printf '\033[1;33m  ONE MORE STEP — this terminal cannot see the new tools yet\033[0m\n'
  printf '\033[1;33m%s\033[0m\n\n' '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  say "claude was installed, but a shell that is already running never re-reads"
  say "its PATH. Until you do one of these it will still say command not found —"
  say "the install is fine, this window is stale."
  printf '\n'
  printf '      \033[1mexec %s -l\033[0m       reload this terminal, right now\n' "${SHELL:-/bin/bash}"
  say "  ...or close this window and open a new one"
  printf '\n'
  say "Then run: claude"
else
  printf '\n'
  say "Next: start Claude Code and run /help to see the skills."
fi
say "Re-run with --check at any time to see the state of this machine."
printf '\n'
