#!/usr/bin/env node
// draft-drift.mjs — what to do about every open draft, decided by its blast
// radius rather than by its age alone.
//
//   node draft-drift.mjs                 # print the plan, change nothing
//   node draft-drift.mjs --apply         # label, comment, close
//   node draft-drift.mjs --repo owner/name --now 2026-09-22T00:00:00Z
//
// WHY THIS EXISTS. Drafts were being opened and left for months. The cost is
// not the open PR, it is what the branch is holding: a change to a file every
// project inherits, sitting unmerged while 75 commits land around it, is a
// collision waiting to happen. A branch that only adds files under its own new
// directory costs nothing no matter how long it sits.
//
// So there are two clocks, not one:
//
//   - a draft touching the SPINE gets the short clock. Those files are the ones
//     two branches fight over, and the loser's edit disappears quietly at merge.
//   - every other draft gets the long clock. It is a nudge, not a deadline.
//
// And two things this deliberately does NOT do:
//
//   - it never closes on COLLISION. Two PRs touching the same file is a human
//     decision about which lands first; the label says so and stops there.
//   - it never measures how long a PR has been OPEN. It measures how long the
//     AUTHOR has been quiet — their last commit or comment. A draft someone
//     pushed to yesterday is alive whenever it opened; one untouched for weeks
//     is not, however recently it started. The author's own push or comment
//     resets the clock, so whoever keeps working is never closed and never has
//     to argue about it.
//
// Closing preserves the branch, so reopening is one click and nothing is lost.
// `keep-open` on a PR exempts it from both clocks, once and out loud.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Files every project inherits. An unmerged edit to one of these is the drift
 * that actually costs something — moon's project graph, the CI definition, the
 * shared tool presets, the lockfile everyone resolves through.
 */
export const SPINE = [
  '.moon/',
  '.github/workflows/',
  'tooling/',
  'package.json', // the ROOT one; nested package.json files are their project's
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.claude-plugin/',
];

/** Days of silence before a draft is warned, then closed. */
export const CLOCKS = {
  spine: { warn: 2, close: 5 },
  plain: { warn: 7, close: 14 },
};

/** Said once, on the PR, instead of renegotiated on every run. */
export const KEEP_OPEN = 'keep-open';
export const LABELS = { spine: 'spine-hold', collides: 'collides', stale: 'stale-draft' };

/** The marker that makes the comment STICKY — one comment, rewritten. */
export const MARKER = '<!-- draft-drift -->';

const DAY_MS = 86_400_000;

export const isSpineFile = (path) =>
  SPINE.some((s) => (s.endsWith('/') ? path.startsWith(s) : path === s));

/** Whichever clock this draft is on, by what it holds. */
export const clockFor = (files) => (files.some(isSpineFile) ? 'spine' : 'plain');

export const daysQuiet = (lastActivity, now) =>
  Math.floor((Date.parse(now) - Date.parse(lastActivity)) / DAY_MS);

/**
 * When the AUTHOR last touched it.
 *
 * Not `updatedAt`: this tool labels and comments, and both bump it — the clock
 * would reset itself on every run and nothing would ever close.
 *
 * And not anyone else's comment either, which is subtler and was found by
 * running this for real: a review posted to a draft untouched for two weeks
 * made it read as active that morning. Someone else asking a question is not
 * the author picking the work back up — if anything it is the opposite, an
 * unanswered question on a branch nobody is driving. Commits and the author's
 * own comments only, falling back to when the PR was opened.
 */
export function lastActivityAt(pr) {
  const author = (pr.author?.login ?? '').toLowerCase();
  const stamps = [pr.createdAt];
  for (const c of pr.commits ?? []) stamps.push(c.committedDate);
  for (const c of pr.comments ?? []) {
    if ((c.author?.login ?? '').toLowerCase() !== author) continue;
    stamps.push(c.createdAt);
  }
  return stamps.filter(Boolean).sort().at(-1) ?? pr.createdAt;
}

/**
 * Which other open PRs touch a file this one touches. Ready PRs count too: the
 * draft is the one that loses, because the ready one merges first.
 */
export function collisionsFor(pr, all) {
  const mine = new Set(pr.files ?? []);
  const hits = [];
  for (const other of all) {
    if (other.number === pr.number) continue;
    const shared = (other.files ?? []).filter((f) => mine.has(f));
    if (shared.length) hits.push({ number: other.number, title: other.title, files: shared });
  }
  return hits;
}

/**
 * The verdict for one draft: `ok`, `warn` or `close`, plus why.
 *
 * PURE — every input is already fetched. The action for a verdict lives in
 * `apply`, so the decision can be read and tested without a network.
 */
export function assess(pr, all, now, clocks = CLOCKS) {
  const files = pr.files ?? [];
  const clock = clockFor(files);
  const quiet = daysQuiet(lastActivityAt(pr), now);
  const collisions = collisionsFor(pr, all);
  const spineFiles = files.filter(isSpineFile);
  const exempt = (pr.labels ?? []).includes(KEEP_OPEN);

  const limits = clocks[clock];
  let verdict = 'ok';
  if (!exempt && quiet >= limits.close) verdict = 'close';
  else if (!exempt && quiet >= limits.warn) verdict = 'warn';

  const labels = [];
  if (spineFiles.length) labels.push(LABELS.spine);
  if (collisions.length) labels.push(LABELS.collides);
  if (verdict !== 'ok') labels.push(LABELS.stale);

  return {
    number: pr.number,
    title: pr.title,
    clock,
    quiet,
    spineFiles,
    collisions,
    exempt,
    verdict,
    labels,
  };
}

/** What the PR is told, in the sticky comment. */
export function comment(v, clocks = CLOCKS) {
  const limits = clocks[v.clock];
  const lines = [MARKER, ''];
  const held = v.spineFiles.length
    ? `It changes ${v.spineFiles.map((f) => `\`${f}\``).join(', ')} — shared files every project inherits, which is why this draft is on the short clock (${limits.warn}d to this notice, ${limits.close}d to close).`
    : `Nothing shared is held up by it, so it is on the long clock (${limits.warn}d to this notice, ${limits.close}d to close).`;

  if (v.verdict === 'close') {
    lines.push(
      `**Closing this draft — ${v.quiet} days with no commits or comments.**`,
      '',
      held,
      '',
      'The branch is untouched and reopening is one click, so nothing here is lost. Reopen when you pick it back up, or split out the part that is ready and land that on its own.',
    );
  } else if (v.verdict === 'warn') {
    lines.push(
      `**This draft has been quiet for ${v.quiet} days** and will close at ${limits.close}.`,
      '',
      held,
      '',
      `A push or a comment resets the clock. If it is parked on purpose, add the \`${KEEP_OPEN}\` label and this stops asking.`,
    );
  }

  if (v.collisions.length) {
    lines.push(
      '',
      '**Also touching the same files:**',
      ...v.collisions.map((c) => `- #${c.number} — ${c.files.map((f) => `\`${f}\``).join(', ')}`),
      '',
      'Whichever merges second silently loses its version of those lines. Worth deciding the order now — this is never closed automatically.',
    );
  }
  return lines.join('\n');
}

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Every open PR with the fields a verdict needs. */
export function fetchOpen(repo, run = gh) {
  const list = JSON.parse(
    run([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,isDraft',
    ]),
  );
  return list.map((row) => {
    const d = JSON.parse(
      run([
        'pr',
        'view',
        String(row.number),
        '--repo',
        repo,
        '--json',
        'number,title,author,isDraft,createdAt,files,labels,comments,commits',
      ]),
    );
    return {
      ...d,
      files: (d.files ?? []).map((f) => f.path),
      labels: (d.labels ?? []).map((l) => l.name),
      commits: (d.commits ?? []).map((c) => ({ committedDate: c.committedDate })),
    };
  });
}

/**
 * One comment per PR, rewritten in place.
 *
 * A daily job that posts a fresh comment every run buries the author's own
 * thread in its own nagging, and a long-lived draft would collect a wall of
 * them. The previous notice is found by its MARKER and PATCHed; only the first
 * run on a PR creates anything.
 */
export function stickyComment(repo, number, body, run = gh) {
  let prior = [];
  try {
    prior = JSON.parse(run(['api', `repos/${repo}/issues/${number}/comments`, '--paginate']));
  } catch {
    // Unreadable listing: post a new one. A duplicate notice is noisy; a
    // swallowed close notice is a PR that shuts with no explanation on it.
    prior = [];
  }
  const existing = (Array.isArray(prior) ? prior : []).find((c) => (c.body ?? '').includes(MARKER));
  if (existing) {
    run([
      'api',
      '--method',
      'PATCH',
      `repos/${repo}/issues/comments/${existing.id}`,
      '-f',
      `body=${body}`,
    ]);
    return 'updated';
  }
  run(['pr', 'comment', String(number), '--repo', repo, '--body', body]);
  return 'created';
}

/**
 * Carry out a verdict. Labels are added, never removed — a human taking one off
 * is a decision, and re-adding it every run would overrule them.
 */
export function apply(repo, v, run = gh, log = (m) => process.stderr.write(`${m}\n`)) {
  if (v.labels.length) {
    try {
      run([
        'pr',
        'edit',
        String(v.number),
        '--repo',
        repo,
        ...v.labels.flatMap((l) => ['--add-label', l]),
      ]);
    } catch {
      log(`#${v.number}: could not add labels (${v.labels.join(', ')}) — is the label created?`);
    }
  }
  if (v.verdict === 'ok' && !v.collisions.length) return;
  stickyComment(repo, v.number, comment(v), run);
  if (v.verdict === 'close') {
    // No --delete-branch, ever: the branch is the work.
    run(['pr', 'close', String(v.number), '--repo', repo]);
  }
}

export function render(verdicts) {
  if (!verdicts.length) return 'No open drafts.';
  const lines = ['# Draft drift', ''];
  for (const v of verdicts) {
    const flags = [
      v.clock === 'spine' ? `SPINE(${v.spineFiles.length})` : 'plain',
      v.collisions.length ? `collides(#${v.collisions.map((c) => c.number).join(', #')})` : null,
      v.exempt ? KEEP_OPEN : null,
    ].filter(Boolean);
    lines.push(
      `- #${v.number} [${v.verdict.toUpperCase()}] ${v.quiet}d quiet · ${flags.join(' · ')} — ${v.title}`,
    );
  }
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2), { run = gh, out = process.stdout } = {}) {
  let repo = process.env.GITHUB_REPOSITORY;
  let now = new Date().toISOString();
  let doApply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') doApply = true;
    else if (argv[i] === '--repo') repo = argv[++i];
    else if (argv[i] === '--now') now = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      out.write('usage: draft-drift.mjs [--repo owner/name] [--now ISO] [--apply]\n');
      return 0;
    }
  }
  // No default repo: guessing one would sweep somebody else's drafts — and --apply
  // would close them.
  if (!repo) {
    out.write('draft-drift: no repo — pass --repo owner/name or set GITHUB_REPOSITORY\n');
    return 2;
  }
  const all = fetchOpen(repo, run);
  const verdicts = all.filter((pr) => pr.isDraft).map((pr) => assess(pr, all, now));
  out.write(`${render(verdicts)}\n`);
  if (doApply) for (const v of verdicts) apply(repo, v, run);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main());
}
