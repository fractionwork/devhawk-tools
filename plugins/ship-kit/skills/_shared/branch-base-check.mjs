#!/usr/bin/env node
// branch-base-check — refuses (or warns about) branches whose merge-base
// with origin/<base> is not on <base>'s first-parent trunk.
//
// Catches the failure mode where you branch from another open PR's tip
// instead of develop. When the upstream PR squash-merges, your branch's
// history points at a commit that no longer exists on develop's trunk,
// and the next rebase becomes per-file conflict resolution.
//
// Usage:
//   node scripts/branch-base-check.mjs              # warn-only (exit 0)
//   node scripts/branch-base-check.mjs --strict     # fail on bad base (exit 1)
//   node scripts/branch-base-check.mjs --base=main  # override base branch
//
// Env:
//   ALLOW_STACKED=1   # bypass entirely (intentional, coordinated stacks)
//
// Skip-on-integration-branch: if HEAD is main/develop/staging, exit 0.

import { execFileSync } from 'node:child_process';

const FIRST_PARENT_DEPTH = 500;
const INTEGRATION_BRANCHES = new Set(['main', 'develop', 'staging']);

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const baseArg = args.find((a) => a.startsWith('--base='));
const explicitBase = baseArg?.split('=')[1];

if (process.env.ALLOW_STACKED === '1') {
  process.exit(0);
}

// Arguments as arguments, never a command string: `execSync` runs it through a
// shell, which on Windows is cmd.exe with its own quoting and `%VAR%` expansion.
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitSilent(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const head = gitSilent('rev-parse --abbrev-ref HEAD');
if (!head || head === 'HEAD') {
  // Detached HEAD — nothing useful to check.
  process.exit(0);
}

if (INTEGRATION_BRANCHES.has(head)) {
  process.exit(0);
}

// Determine the base. Use --base if provided, else try develop, else main.
function resolveBase() {
  if (explicitBase) return explicitBase;
  for (const candidate of ['develop', 'main']) {
    if (gitSilent(['rev-parse', '--verify', '--quiet', `origin/${candidate}`])) {
      return candidate;
    }
  }
  return null;
}

const base = resolveBase();
if (!base) {
  // No origin/develop or origin/main — likely a fresh repo or no remote yet.
  process.exit(0);
}

const baseRef = `origin/${base}`;
const headSha = gitSilent(['rev-parse', 'HEAD']);
const mergeBase = gitSilent(['merge-base', baseRef, 'HEAD']);

if (!headSha || !mergeBase) {
  process.exit(0);
}

if (mergeBase === headSha) {
  // HEAD is on (or behind) the base — nothing to do.
  process.exit(0);
}

// Walk first-parent of origin/<base> back FIRST_PARENT_DEPTH commits.
const trunk = gitSilent(['rev-list', '--first-parent', '-n', String(FIRST_PARENT_DEPTH), baseRef]);
if (!trunk) {
  process.exit(0);
}
const trunkSet = new Set(trunk.split('\n'));

if (trunkSet.has(mergeBase)) {
  // Merge-base is on the first-parent trunk — clean.
  process.exit(0);
}

// The branch's merge-base is NOT on origin/<base>'s first-parent trunk.
// Try to guess the source branch by finding any non-base ref containing
// the merge-base.
function guessSourceBranch() {
  const refs = gitSilent(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']);
  if (!refs) return null;
  for (const ref of refs.split('\n')) {
    if (ref === baseRef || ref === 'origin/HEAD' || ref === `origin/${head}`) continue;
    const contains = gitSilent(['branch', '-r', '--contains', mergeBase, '--list', ref]);
    if (contains) return ref;
  }
  return null;
}

const guessed = guessSourceBranch();
const ahead = gitSilent(['rev-list', '--count', `${baseRef}..HEAD`]) ?? '?';
const behind = gitSilent(['rev-list', '--count', `HEAD..${baseRef}`]) ?? '?';

const lines = [
  '',
  `⚠ branch-base-check: this branch is not based on ${baseRef}`,
  '',
  `  Branch:         ${head}`,
  `  Merge-base:     ${mergeBase} (NOT on ${baseRef}'s first-parent trunk)`,
  `  Guessed source: ${guessed ?? '(unknown)'}`,
  `  Ahead/behind:   ${ahead} / ${behind} commits`,
  '',
  'Why this matters:',
  '  Branches stacked on other open PRs cause cascading rebase failures',
  `  when the upstream PR squash-merges. Always branch from ${baseRef}`,
  '  unless you have an explicit reason (and have coordinated merge order).',
  '',
  'To fix:',
  `  1. git switch -c <new-branch> ${baseRef}`,
  '  2. git cherry-pick <your commits from this branch>',
  '  3. Open the PR from the new branch.',
  '',
  "To override (only if you're intentionally stacking and have a plan):",
  '  ALLOW_STACKED=1 <your command>',
  '',
];

console.error(lines.join('\n'));

process.exit(strict ? 1 : 0);
