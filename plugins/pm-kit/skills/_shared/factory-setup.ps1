# factory-setup.ps1 - one command from a bare Windows machine to working plugins.
#
# The native-Windows sibling of factory-setup.sh. Same five phases, same
# contract: every phase is idempotent, a phase that fails does not stop the ones
# after it, and failures are collected and printed once at the end.
#
# THIS IS FOR WINDOWS WITHOUT WSL. If the machine has WSL, run factory-setup.sh
# inside the distro instead - it is the better-supported path and this script
# says so on startup.
#
# WHAT IT DELIBERATELY DOES NOT DO, inherited from the .sh: copying skills,
# registering MCP servers and editing CLAUDE.md are the plugin system's job.
# This script's remit is strictly what has to happen BEFORE or OUTSIDE Claude
# Code. If a plugin can do it, this must not.
#
# ---------------------------------------------------------------------------
# THREE CONSTRAINTS ON HOW THIS FILE IS WRITTEN. Each one broke the first
# version, which shipped and did not run on Windows at all.
#
#   1. NO TOP-LEVEL param() BLOCK. The documented install is `irm ... | iex`,
#      and under Invoke-Expression a param() block is not parameters: every
#      line runs as a statement, so `[ValidateSet(...)][string]$Role` validated
#      an empty value and aborted before a single function was defined.
#      Arguments are parsed from $args and environment variables instead - see
#      ConvertFrom-SetupArgs.
#
#   2. ASCII ONLY. Windows PowerShell 5.1 - the one every Windows machine ships
#      - reads a .ps1 without a byte-order mark as Windows-1252. A UTF-8 em dash
#      decodes to bytes PowerShell treats as QUOTE characters, and the first
#      version failed with six parse errors. A test asserts every byte is ASCII.
#
#   3. NEVER `exit` UNLESS RUN FROM A FILE. Under `irm | iex` the script runs in
#      the user's own session, and `exit` would close their window. The result
#      goes to $LASTEXITCODE there; `exit` is used only when $PSCommandPath says
#      this is a .ps1 file being executed.
# ---------------------------------------------------------------------------
#
# Usage - sets up pm-kit and ship-kit from the public devhawk-tools marketplace:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/fractionwork/devhawk-tools/main/plugins/pm-kit/skills/_shared/factory-setup.ps1)))
#
#   .\factory-setup.ps1 -Check   # report state, change nothing
#   .\factory-setup.ps1 -Yes     # no questions; optional sign-ins skipped
#
# Environment (for `irm | iex`, which cannot pass arguments):
#   FACTORY_SETUP_YES=1, FACTORY_SETUP_CHECK=1

$script:NODE_MAJOR = 24
$script:PUBLIC_MARKETPLACE = 'fractionwork/devhawk-tools'
$script:MARKETPLACE = $script:PUBLIC_MARKETPLACE
$script:MARKETPLACE_NAME = 'devhawk-tools'
# This copy sets up the public plugins only. `-Role local` is accepted (the
# setup guides pass it); any other role is refused.
$script:ROLES = @('local')

# ---- arguments --------------------------------------------------------------

<#
Parse arguments from $args and the environment. PURE: no host state is read
here, so it can be tested with any combination.

PowerShell hands a scriptblock with no param() block its arguments as plain
strings - `-Role engineer` arrives as '-Role', 'engineer', and `-Role:pm` as
'-Role:', 'pm'. All three spellings are accepted, and anything unrecognised is
reported rather than silently ignored.
#>
function ConvertFrom-SetupArgs {
  param([object[]]$ArgList = @(), [hashtable]$Environment = @{})

  $truthy = @('1', 'true', 'yes', 'y')
  $o = @{
    Role   = [string]$Environment['FACTORY_SETUP_ROLE']
    Yes    = ([string]$Environment['FACTORY_SETUP_YES']).ToLower() -in $truthy
    Check  = ([string]$Environment['FACTORY_SETUP_CHECK']).ToLower() -in $truthy
    Errors = @()
  }

  $i = 0
  while ($i -lt $ArgList.Count) {
    $a = [string]$ArgList[$i]
    if ($a -match '^-{1,2}role:?$') {
      $i++
      if ($i -lt $ArgList.Count) { $o.Role = [string]$ArgList[$i] }
      else { $o.Errors += '-Role needs a value' }
    } elseif ($a -match '^-{1,2}role[:=](.+)$') {
      $o.Role = $Matches[1]
    } elseif ($a -match '^-{1,2}(yes|y)$') {
      $o.Yes = $true
    } elseif ($a -match '^-{1,2}check$') {
      $o.Check = $true
    } else {
      $o.Errors += "unknown argument: $a"
    }
    $i++
  }

  $o.Role = $o.Role.Trim().ToLower()
  if ($o.Role -and $o.Role -notin $script:ROLES) {
    $o.Errors += "unknown role '$($o.Role)' - choose one of: $($script:ROLES -join ', ')"
  }
  return $o
}

# ---- output -----------------------------------------------------------------

function Write-Ok   { param([string]$m) Write-Host '  [ok] ' -ForegroundColor Green  -NoNewline; Write-Host $m }
function Write-Warn { param([string]$m) Write-Host '  [!]  ' -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Write-Bad  { param([string]$m) Write-Host '  [x]  ' -ForegroundColor Red    -NoNewline; Write-Host $m }
function Write-Say  { param([string]$m = '') Write-Host "       $m" }
function Write-Step { param([string]$m) Write-Host ''; Write-Host $m -ForegroundColor White }
function Add-Failure { param([string]$m) $script:FAILED.Add($m) | Out-Null }

# ---- small helpers ----------------------------------------------------------

function Test-Have {
  param([Parameter(Mandatory)][string]$Name)
  [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

<#
Re-read PATH from the registry into this session.

winget writes the machine and user PATH, and a session that is already running
never sees it. Refreshing here means the rest of this run can find what it just
installed; the closing notice still tells the user about windows already open.
#>
function Update-SessionPath {
  $parts = @(
    [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    [System.Environment]::GetEnvironmentVariable('Path', 'User')
  ) | Where-Object { $_ }
  if ($parts) { $env:Path = ($parts -join ';') }
}

<#
Every kit a role installs.

Kept identical to kits_for_role() in factory-setup.sh, and a test compares the
two: a Windows engineer and a WSL engineer must get the same factory.
#>
function Get-KitsForRole {
  param([Parameter(Mandatory)][string]$Name)
  switch ($Name) {
    'local'    { @('pm-kit', 'ship-kit') }
    default    { @() }
  }
}

<#
Mirrors needs_private_marketplace() in factory-setup.sh: staff roles use the
private marketplace, and only `local` - somebody outside Fraction - the public one.
#>
function Test-PublicRole {
  param([string]$Name)
  $Name -eq 'local'
}

<#
How each kit fares on native Windows, and why. Data rather than prose, so the
-Check report and the closing notes cannot disagree about the same kit.
#>
function Get-KitWindowsStatus {
  param([Parameter(Mandatory)][string]$Kit)
  switch ($Kit) {
    'ship-kit'    { @{ State = 'ok';       Note = '' } }
    'pm-kit'      { @{ State = 'ok';       Note = '' } }
    default       { @{ State = 'ok';       Note = '' } }
  }
}

function Get-NodeMajor {
  param([string]$Version)
  if ($Version -match '^v?(\d+)\.') { return [int]$Matches[1] }
  return 0
}

function Test-NodeOk {
  param([string]$Version)
  (Get-NodeMajor $Version) -ge $script:NODE_MAJOR
}

<#
True for the Microsoft Store "App Execution Alias" stubs.

A fresh Windows has `python.exe` and `python3.exe` under WindowsApps that do not
run Python - they open the Store, or print "Python was not found" and exit 9009.
Get-Command finds them, so a naive check reports Python installed on a machine
that has none.
#>
function Test-IsStoreAlias {
  param([string]$Path)
  [bool]($Path -match '[\\/]Microsoft[\\/]WindowsApps[\\/]')
}

function Get-RealPython {
  foreach ($name in @('py', 'python', 'python3')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and -not (Test-IsStoreAlias $cmd.Source)) { return $cmd.Source }
  }
  return $null
}

<#
Git Bash, which is the Bash tool on Windows.

Probed rather than assumed: Git for Windows installs to Program Files, a 32-bit
Program Files, or a user profile, and Claude Code only looks in the usual
places. The path found is written to settings.json so the guess happens once.
#>
function Find-GitBash {
  $candidates = @(
    "$env:ProgramFiles\Git\bin\bash.exe"
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe"
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }

  # <root>\cmd\git.exe -> <root>\bin\bash.exe
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    $root = Split-Path (Split-Path $git.Source -Parent) -Parent
    $bash = Join-Path $root 'bin\bash.exe'
    if (Test-Path -LiteralPath $bash) { return $bash }
  }
  return $null
}

function Get-ClaudeSettingsPath { Join-Path $env:USERPROFILE '.claude\settings.json' }

<#
Merge one key into settings.json's `env` block, preserving everything else.

READ-MODIFY-WRITE, never overwrite: the file is the user's, and may carry an
update channel, permissions or other env vars. A backup is taken first. A file
that does not parse is refused rather than repaired. Written without a BOM,
because 5.1's Set-Content -Encoding UTF8 adds one and a BOM ahead of `{` is what
a strict JSON parser rejects.
#>
function Set-ClaudeSettingsEnv {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Value,
    [string]$Path = (Get-ClaudeSettingsPath)
  )

  $dir = Split-Path $Path -Parent
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $settings = [pscustomobject]@{}
  if (Test-Path -LiteralPath $Path) {
    $raw = Get-Content -LiteralPath $Path -Raw
    if ($raw -and $raw.Trim()) {
      try {
        $settings = $raw | ConvertFrom-Json
      } catch {
        throw "settings.json exists but is not valid JSON: $Path"
      }
    }
    Copy-Item -LiteralPath $Path -Destination "$Path.bak" -Force -ErrorAction SilentlyContinue
  }

  if (-not $settings.PSObject.Properties['env']) {
    $settings | Add-Member -NotePropertyName 'env' -NotePropertyValue ([pscustomobject]@{})
  }
  if ($settings.env.PSObject.Properties[$Name]) {
    $settings.env.$Name = $Value
  } else {
    $settings.env | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }

  $json = $settings | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding $false))
  return $Path
}

function Get-ClaudeSettingsEnv {
  param([Parameter(Mandatory)][string]$Name, [string]$Path = (Get-ClaudeSettingsPath))
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { $s = (Get-Content -LiteralPath $Path -Raw) | ConvertFrom-Json } catch { return $null }
  if ($s.PSObject.Properties['env'] -and $s.env.PSObject.Properties[$Name]) { return $s.env.$Name }
  return $null
}

function Confirm-Step {
  param([Parameter(Mandatory)][string]$Question, [string]$Default = 'yes')
  if ($script:Opts.Yes) { return ($Default -eq 'yes') }
  $hint = if ($Default -eq 'yes') { 'Y/n' } else { 'y/N' }
  $a = (Read-Host "       $Question [$hint]").Trim()
  if (-not $a) { return ($Default -eq 'yes') }
  return $a -match '^[Yy]'
}

function Read-Secret {
  param([Parameter(Mandatory)][string]$Label)
  $secure = Read-Host "       $Label (input hidden)" -AsSecureString
  if (-not $secure -or $secure.Length -eq 0) { return '' }
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

<#
Install one winget package, idempotently. `winget install` on a package already
present exits non-zero, which reads as a failure and is not one, so check first.
#>
function Install-WingetPackage {
  param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][string]$Label,
    [string]$ProbeCommand
  )

  if ($ProbeCommand -and (Test-Have $ProbeCommand)) { Write-Ok "$Label already installed"; return $true }

  $listed = & winget list --id $Id --exact --accept-source-agreements 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -and $listed -match [regex]::Escape($Id)) {
    Write-Ok "$Label already installed"
    Update-SessionPath
    return $true
  }

  Write-Say "installing $Label..."
  & winget install --id $Id --exact --silent `
      --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "installed $Label"
    $script:PATH_CHANGED = $true
    Update-SessionPath
    return $true
  }

  Write-Bad "could not install $Label (winget exit $LASTEXITCODE)"
  Add-Failure "$Label (retry: winget install --id $Id --exact)"
  return $false
}

function Get-ClaudeVersion {
  if (-not (Test-Have 'claude')) { return $null }
  try { return (& claude --version 2>$null | Select-Object -First 1) } catch { return $null }
}

# ---- role -------------------------------------------------------------------

function Request-Role {
  if ($script:Opts.Role) { return $script:Opts.Role }
  return 'local'
}

# ---- phase 1: prerequisites -------------------------------------------------

function Invoke-PhasePrereqs {
  param([string[]]$Kits)
  Write-Step '1/5  Prerequisites'

  if (-not (Test-Have 'winget')) {
    Write-Bad 'winget is not available'
    Write-Say 'winget ships as "App Installer". On Windows 10 it may be absent or too old.'
    Write-Say 'Install it from the Microsoft Store, then re-run this script.'
    Add-Failure 'winget (install "App Installer" from the Microsoft Store)'
    return
  }
  Write-Ok 'winget'

  # Git FIRST, and not for git's sake: Git Bash is the Bash tool on Windows, and
  # without it every hook and .sh the kits ship is handed to PowerShell.
  Install-WingetPackage -Id 'Git.Git' -Label 'Git for Windows' -ProbeCommand 'git' | Out-Null

  $bash = Find-GitBash
  if ($bash) {
    Write-Ok "Git Bash at $bash"
    if (-not (Get-ClaudeSettingsEnv -Name 'CLAUDE_CODE_GIT_BASH_PATH')) {
      try {
        Set-ClaudeSettingsEnv -Name 'CLAUDE_CODE_GIT_BASH_PATH' -Value $bash | Out-Null
        Write-Ok 'recorded CLAUDE_CODE_GIT_BASH_PATH in settings.json'
      } catch {
        Write-Warn "could not write settings.json: $($_.Exception.Message)"
        Add-Failure 'CLAUDE_CODE_GIT_BASH_PATH (add it to ~/.claude/settings.json by hand)'
      }
    } else {
      Write-Ok 'CLAUDE_CODE_GIT_BASH_PATH already set'
    }
  } else {
    Write-Bad 'Git Bash not found after installing Git'
    Write-Say 'The kits ship shell skills and a SessionStart hook; without Git Bash'
    Write-Say 'those are handed to PowerShell and fail silently.'
    Add-Failure 'Git Bash (set CLAUDE_CODE_GIT_BASH_PATH in ~/.claude/settings.json)'
  }

  Install-WingetPackage -Id 'GitHub.cli' -Label 'gh' -ProbeCommand 'gh' | Out-Null

  if (Test-Have 'node') {
    $v = (& node -v 2>$null)
    if (Test-NodeOk $v) {
      Write-Ok "Node $v"
    } else {
      Write-Warn "Node $v is below $($script:NODE_MAJOR) - the kits' scripts need $($script:NODE_MAJOR)+"
      Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Label "Node $($script:NODE_MAJOR)+" | Out-Null
      $v2 = (& node -v 2>$null)
      if (-not (Test-NodeOk $v2)) {
        Write-Bad "still on Node $v2 - a second Node may be earlier on PATH"
        Add-Failure "Node $($script:NODE_MAJOR)+ (check: where.exe node)"
      }
    }
  } else {
    Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Label 'Node' | Out-Null
  }

  # The native installer rather than winget, because winget's package does not
  # auto-update.
  if (Test-Have 'claude') {
    Write-Ok "Claude Code $(Get-ClaudeVersion)"
  } else {
    Write-Say 'installing Claude Code...'
    try {
      Invoke-RestMethod 'https://claude.ai/install.ps1' -ErrorAction Stop | Invoke-Expression
      Update-SessionPath
      $script:PATH_CHANGED = $true
      if (Test-Have 'claude') { Write-Ok "Claude Code $(Get-ClaudeVersion)" }
      else { Write-Warn 'Claude Code installed but not yet on this session PATH' }
    } catch {
      Write-Bad "Claude Code install failed: $($_.Exception.Message)"
      Add-Failure 'Claude Code (retry: irm https://claude.ai/install.ps1 | iex)'
    }
  }

  if ($Kits -contains 'pm-kit') {
    $py = Get-RealPython
    if ($py) {
      Write-Ok "Python at $py"
    } else {
      # Store stubs are ignored on purpose - they look like Python and are not.
      Install-WingetPackage -Id 'Python.Python.3.13' -Label 'Python 3.13' | Out-Null
    }
  }
}

# ---- phase 2: github --------------------------------------------------------

function Invoke-PhaseGitHub {
  Write-Step '2/5  GitHub'

  if ($script:MARKETPLACE -eq $script:PUBLIC_MARKETPLACE) {
    # The PUBLIC marketplace needs no account to install from. ship-kit's
    # pull-request skills still drive GitHub through gh, so OFFER a sign-in -
    # skipping it leaves the plugins working, minus those skills.
    Write-Ok 'the plugins themselves need no GitHub account'
    Write-Say "ship-kit's pull-request skills (/create-pr, /pr-review, /pr-watch) use the"
    Write-Say 'GitHub CLI - signing in is optional'
    if (-not (Test-Have 'gh')) { Write-Warn 'gh is not installed - sign in later with: gh auth login'; return }
    & gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok 'authenticated to GitHub'; return }
    if ($script:Opts.Yes -or -not (Confirm-Step 'sign in to GitHub now? (needed only for the pull-request skills)' 'yes')) {
      Write-Say 'skipped - sign in any time later with: gh auth login'
      return
    }
    & gh auth login --git-protocol https --web
    & gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Ok 'authenticated to GitHub'
      & gh auth setup-git 2>&1 | Out-Null
    } else {
      Write-Warn 'not signed in - run later: gh auth login'
    }
    $global:LASTEXITCODE = 0
    return
  }

}

# ---- phase 3: marketplace ---------------------------------------------------

function Invoke-PhaseMarketplace {
  Write-Step '3/5  Marketplace'

  if (-not (Test-Have 'claude')) {
    Write-Bad 'Claude Code is not installed - skipping'
    Add-Failure 'marketplace (no claude)'
    return
  }

  $existing = & claude plugin marketplace list 2>&1 | Out-String
  if ($existing -match [regex]::Escape($script:MARKETPLACE_NAME)) {
    Write-Ok "marketplace already added: $($script:MARKETPLACE)"
    return
  }

  & claude plugin marketplace add $script:MARKETPLACE 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "added marketplace: $($script:MARKETPLACE)"
  } else {
    Write-Bad "could not add marketplace: $($script:MARKETPLACE)"
    Add-Failure "marketplace $($script:MARKETPLACE)"
  }
}

# ---- phase 4: plugins -------------------------------------------------------

function Invoke-PhasePlugins {
  param([string[]]$Kits)
  Write-Step '4/5  Plugins'

  if (-not (Test-Have 'claude')) {
    Write-Bad 'Claude Code is not installed - skipping'
    Add-Failure 'plugins (no claude)'
    return
  }

  $installed = & claude plugin list 2>&1 | Out-String
  foreach ($k in $Kits) {
    if ($installed -match [regex]::Escape($k)) { Write-Ok "$k already installed"; continue }
    & claude plugin install "$k@$($script:MARKETPLACE_NAME)" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok "installed $k" }
    else { Write-Bad "could not install $k"; Add-Failure "plugin $k" }
  }

  foreach ($k in $Kits) {
    $s = Get-KitWindowsStatus $k
    if ($s.State -ne 'ok') { Write-Warn "$k on native Windows: $($s.Note)" }
  }

  if ($Kits -contains 'pm-kit') {
    Write-Host ''
    Write-Say 'pm-kit: run /pm-setup inside Claude Code to connect your own Asana account.'
  }

}

# ---- phase 5: credentials ---------------------------------------------------

function Invoke-PhaseCredentials {
  param([string[]]$Kits)
  Write-Step '5/5  Credentials - all optional'
  Write-Say 'Everything below can be skipped. The kits are usable without any of it.'
  Write-Host ''
  if ($script:MARKETPLACE -eq $script:PUBLIC_MARKETPLACE) {
    # Outside Fraction there is no engine to connect to, and the public kits do
    # not know one exists - so neither does this. pm-kit signs in to Asana with a
    # personal access token, kept in settings.json `env`: Claude Code hands that
    # to every session and to the Asana server it starts.
    Write-Say 'pm-kit connects to Asana with a personal access token. To make one:'
    Write-Say '  open https://app.asana.com/0/my-apps -> "Create new token" -> copy it'
    if (Get-ClaudeSettingsEnv -Name 'ASANA_PAT') {
      Write-Ok 'an Asana token is already saved in settings.json - keeping it'
      return
    }
    if ($script:Opts.Yes -or -not (Confirm-Step 'paste your Asana token now?' 'yes')) {
      Write-Say 'skipped - run /pm-setup inside Claude Code whenever you are ready'
      return
    }
    $t = Read-Secret 'Asana token'
    if (-not $t) { Write-Say 'nothing entered - skipped. /pm-setup can do this later.'; return }
    try {
      $p = Set-ClaudeSettingsEnv -Name 'ASANA_PAT' -Value $t
      Write-Ok "saved to $p"
      Write-Say 'restart Claude Code, then run /pm-setup once to finish'
    } catch {
      Write-Bad "could not write settings.json: $($_.Exception.Message)"
      Add-Failure 'Asana token (add it to ~/.claude/settings.json under env - see the setup guide)'
    }
    return
  }
}

# ---- -Check -----------------------------------------------------------------

function Show-State {
  Write-Host ''
  Write-Host 'factory-setup - state of this machine' -ForegroundColor White
  Write-Say "platform: Windows $([System.Environment]::OSVersion.Version)"
  Write-Host ''

  foreach ($t in @(
    @{ Cmd = 'winget'; Label = 'winget' }
    @{ Cmd = 'git';    Label = 'git' }
    @{ Cmd = 'gh';     Label = 'gh' }
    @{ Cmd = 'node';   Label = 'node' }
    @{ Cmd = 'claude'; Label = 'Claude Code' }
  )) {
    if (Test-Have $t.Cmd) {
      $v = switch ($t.Cmd) {
        'node'   { & node -v 2>$null }
        'claude' { Get-ClaudeVersion }
        default  { '' }
      }
      if ($t.Cmd -eq 'node' -and -not (Test-NodeOk $v)) { Write-Warn "$($t.Label) $v - below $($script:NODE_MAJOR)" }
      else { Write-Ok ("$($t.Label) $v").TrimEnd() }
    } else {
      Write-Bad "$($t.Label) not installed"
      $script:FAILED.Add("$($t.Label) not installed") | Out-Null
    }
  }

  $py = Get-RealPython
  if ($py) { Write-Ok "Python $py" } else { Write-Warn 'Python not installed (pm-kit needs it; Store stubs ignored)' }

  $bash = Find-GitBash
  if ($bash) { Write-Ok "Git Bash $bash" } else { Write-Bad 'Git Bash not found - shell skills and hooks will fail' }

  if (Test-Have 'gh') {
    & gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok 'GitHub authenticated' } else { Write-Bad 'GitHub not authenticated' }
  }

  if (Get-ClaudeSettingsEnv -Name 'ASANA_PAT') { Write-Ok 'Asana token saved in settings.json' }
  else { Write-Say 'no Asana token saved yet (fine - /pm-setup can do it)' }

  if (Test-Have 'claude') {
    Write-Host ''
    Write-Host '  Plugins' -ForegroundColor White
    $list = & claude plugin list 2>&1 | Out-String
    foreach ($k in @('pm-kit', 'ship-kit')) {
      if ($list -match [regex]::Escape($k)) {
        $s = Get-KitWindowsStatus $k
        if ($s.State -eq 'ok') { Write-Ok $k } else { Write-Warn "$k - $($s.Note)" }
      }
    }
  }
  Write-Host ''
}

# ---- main -------------------------------------------------------------------
# Everything below runs on load. The test harness sets FACTORY_SETUP_NO_MAIN and
# asserts this guard exists - a rename would otherwise run the installer during
# tests.

<#
Sets $script:SetupExitCode rather than returning it: a PowerShell function
returns EVERYTHING written to its output stream, so a stray value from any call
would silently become the exit code.
#>
function Invoke-FactorySetup {
  # Scoped to this function and the phases it calls, so an `irm | iex` run does
  # not leave the user's own session with changed preferences.
  $ErrorActionPreference = 'Continue'
  $ProgressPreference = 'SilentlyContinue'

  $script:FAILED = New-Object System.Collections.Generic.List[string]
  $script:PATH_CHANGED = $false
  $script:SetupExitCode = 0

  if ($script:Opts.Errors.Count -gt 0) {
    foreach ($e in $script:Opts.Errors) { Write-Bad $e }
    $script:SetupExitCode = 2
    return
  }

  if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
    Write-Host 'factory-setup.ps1 is for native Windows. On macOS or Linux run factory-setup.sh.' -ForegroundColor Red
    $script:SetupExitCode = 2
    return
  }

  if ($script:Opts.Check) {
    Show-State
    if ($script:FAILED.Count -gt 0) { $script:SetupExitCode = 1 }
    return
  }

  Write-Host ''
  Write-Host 'factory-setup' -ForegroundColor White -NoNewline
  Write-Host ' - prerequisites, marketplace, plugins, credentials'
  Write-Say 'platform: Windows (native - no WSL)'

  if (Test-Have 'wsl') {
    $distros = & wsl --list --quiet 2>$null
    if ($LASTEXITCODE -eq 0 -and $distros) {
      Write-Host ''
      Write-Warn 'This machine has WSL. factory-setup.sh inside a distro is the longer-tested path.'
      if (-not $script:Opts.Yes -and -not (Confirm-Step 'continue with the native Windows install anyway?' 'yes')) {
        Write-Say 'stopped. Open your distro and run factory-setup.sh instead.'
        return
      }
    }
  }

  $chosen = Request-Role
  $kits = Get-KitsForRole $chosen
  if (Test-PublicRole $chosen) {
    $script:MARKETPLACE = $script:PUBLIC_MARKETPLACE
    $script:MARKETPLACE_NAME = 'devhawk-tools'
  }
  Write-Say "role: $chosen  ->  $($kits -join ' ')"

  Invoke-PhasePrereqs -Kits $kits
  Invoke-PhaseGitHub
  Invoke-PhaseMarketplace
  Invoke-PhasePlugins -Kits $kits
  Invoke-PhaseCredentials -Kits $kits

  Write-Step 'Done'
  if ($script:FAILED.Count -gt 0) {
    Write-Bad 'some steps did not complete:'
    foreach ($f in $script:FAILED) { Write-Host "         - $f" }
    Write-Host ''
    Write-Say 'everything else finished. Re-running this script is safe and retries only these.'
    $script:SetupExitCode = 1
  } else {
    Write-Ok 'everything completed'
  }

  if ($script:PATH_CHANGED) {
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Yellow
    Write-Host '  Open a NEW terminal before running claude' -ForegroundColor Yellow
    Write-Host '  ============================================================' -ForegroundColor Yellow
    Write-Host ''
    Write-Say 'PATH was refreshed inside this session, so `claude` works here. Anything'
    Write-Say 'already open - another terminal, an editor - still has the old PATH.'
  }

  Write-Host ''
  Write-Say 'Next: start Claude Code and run /help to see the skills.'
  Write-Say 'Re-run with -Check at any time to see the state of this machine.'
  Write-Host ''
}

$script:Opts = ConvertFrom-SetupArgs -ArgList $args -Environment @{
  FACTORY_SETUP_ROLE  = $env:FACTORY_SETUP_ROLE
  FACTORY_SETUP_YES   = $env:FACTORY_SETUP_YES
  FACTORY_SETUP_CHECK = $env:FACTORY_SETUP_CHECK
}

if (-not $env:FACTORY_SETUP_NO_MAIN) {
  Invoke-FactorySetup
  # `exit` only from a .ps1 file. Under `irm | iex` or a scriptblock this runs in
  # the user's session and `exit` would close their window; they get
  # $LASTEXITCODE instead.
  if ($PSCommandPath -and $PSCommandPath -match 'factory-setup\.ps1$') { exit $script:SetupExitCode }
  $global:LASTEXITCODE = $script:SetupExitCode
}
