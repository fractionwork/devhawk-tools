// Re-run the project's own layer-purity gate at PR time.
//
// The gate already runs in pre-commit and pre-push. Both are bypassable
// (`--no-verify`, a hook that was never installed on a fresh clone, a commit
// pushed from CI), and this is the one rule whose violation is invisible in
// review: `import sqlalchemy` at the top of a domain module looks completely
// ordinary. So it is checked again where it cannot be skipped.
//
// This SHELLS OUT to the project's own script rather than reimplementing it.
// Reimplementing would mean two definitions of "pure" that drift apart, and the
// one in the repo is the one the developer's hooks enforce. The script is
// stdlib-only by design, so any Python 3 runs it — no virtualenv needed, which
// matters because pr-audit runs in a fresh worktree. Which interpreter that is
// depends on the platform: `python3` does not exist on a python.org install for
// Windows, where the names are `py -3` and `python`.
//
// Self-skips on any repo without the script.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const SCRIPT = 'scripts/check_layer_purity.py';

/**
 * Interpreters to try, in order, for `platform`.
 *
 * `py -3` first on Windows: it is the python.org launcher and picks the newest
 * install. `python3.exe` there is usually the Microsoft Store stub, which
 * exists on PATH and runs nothing — so it is tried last rather than first.
 */
export function pythonCandidates(platform = process.platform) {
  return platform === 'win32'
    ? [
        ['py', ['-3']],
        ['python', []],
        ['python3', []],
      ]
    : [
        ['python3', []],
        ['python', []],
      ];
}

// `  /abs/or/rel/path.py:13: imports `x` — reason`
const FINDING_RE = /^\s*(.+?\.py):(\d+):\s*(.+)$/;

export function parseFindings(stderr, cwd) {
  const findings = [];
  for (const line of stderr.split('\n')) {
    const m = FINDING_RE.exec(line);
    if (!m) continue;
    // The script prints paths resolved against its root, which is absolute.
    // Issues must be repo-relative to link correctly in a PR comment — and
    // forward-slashed, because that absolute path is `D:\\repo\\pkg\\x.py` on
    // Windows and a PR comment anchors on the repo's own spelling.
    const raw = m[1].startsWith(cwd) ? m[1].slice(cwd.length).replace(/^[\\/]/, '') : m[1];
    const file = raw.replace(/\\/g, '/');
    findings.push({ file, line: Number(m[2]), message: m[3].trim() });
  }
  return findings;
}

export const check = {
  id: 'layer-purity',
  run({
    addIssue,
    _exists = existsSync,
    _run = (cmd, args, opts) => execFileSync(cmd, args, opts),
    _cwd = process.cwd(),
    _platform = process.platform,
    _env = process.env,
  }) {
    if (!_exists(SCRIPT)) return;

    let status = 0;
    let stderr = '';
    let stdout = '';
    let err = null;
    for (const [cmd, args] of pythonCandidates(_platform)) {
      err = null;
      try {
        stdout = String(
          _run(cmd, [...args, SCRIPT], {
            cwd: _cwd,
            encoding: 'utf8',
            timeout: 30_000,
            // Python on Windows otherwise reads source files as cp1252, and
            // the gate's own source and the files it parses are UTF-8: a
            // comment with an em dash in it would crash the gate, which this
            // check would then report as a BLOCK against the repo.
            env: { ..._env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
            // execFileSync passes the child's stderr through to OUR stderr unless
            // it is piped explicitly. Without this the gate's own report is
            // echoed into the audit output alongside the issues we raise from
            // it — the same findings, twice, in two formats.
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        );
        break;
      } catch (e) {
        err = e;
        // `status === null` means the process never started — that candidate is
        // not installed, so try the next one. A real exit code is the gate
        // speaking, and must be reported rather than retried elsewhere.
        if (e?.status != null) break;
      }
    }
    if (err) {
      // No candidate could be spawned at all, which is a fact about the
      // machine rather than a finding about the code.
      if (err?.status == null) {
        addIssue({
          severity: 'INFO',
          checkId: 'layer-purity',
          file: SCRIPT,
          line: 1,
          message:
            `Could not run the layer-purity gate (${err?.message ?? 'no Python 3 available'}). ` +
            'The domain-layer boundary was NOT checked on this PR.',
        });
        return;
      }
      status = err.status;
      stderr = String(err.stderr ?? '');
      stdout = String(err.stdout ?? '');
    }

    if (status === 0) return;

    if (status === 2) {
      addIssue({
        severity: 'BLOCK',
        checkId: 'layer-purity',
        file: SCRIPT,
        line: 1,
        message:
          `The layer-purity gate is misconfigured, so it is not protecting anything: ` +
          `${(stderr || stdout).trim().split('\n')[0]}`,
      });
      return;
    }

    const findings = parseFindings(stderr, _cwd);
    if (findings.length === 0) {
      addIssue({
        severity: 'BLOCK',
        checkId: 'layer-purity',
        file: SCRIPT,
        line: 1,
        message: `The layer-purity gate failed: ${(stderr || stdout).trim().split('\n')[0]}`,
      });
      return;
    }

    for (const finding of findings) {
      addIssue({
        severity: 'BLOCK',
        checkId: 'layer-purity',
        file: finding.file,
        line: finding.line,
        message:
          `${finding.message} — the domain layer takes its inputs as arguments and returns ` +
          'values. Fetch at the edge and pass it in. See docs/conventions.md → "Layout and the ' +
          'dependency rule".',
      });
    }
  },
};
