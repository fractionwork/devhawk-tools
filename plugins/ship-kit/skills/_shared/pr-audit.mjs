#!/usr/bin/env node
// Usage: node <ship-kit>/skills/_shared/pr-audit.mjs [--base=develop] [--strict]
//        (run from the root of the repository being audited)
//
// Runs PR-level audits against the diff between HEAD and the resolved base
// (default: origin/develop, fallback origin/main).
//
// Checks live in this kit's audit/*.mjs and in the audited project's own
// scripts/audit/*.mjs, and export `check = { id, run(ctx) }`. A project check
// with the same id overrides the bundled one.
// The runner gathers their findings, applies suppression rules, prints a
// grouped report, and exits 1 if any BLOCK survives (or any WARN under
// --strict). Exits 0 otherwise.
//
// Suppressions
//   Per-line: `// audit-skip: <check-id> — <reason>` (em-dash) or
//             `// audit-skip: <check-id> -- <reason>` (double-hyphen)
//             on the offending line or the line immediately above.
//             Silences the issue. Missing reason emits a WARN about the
//             suppression itself.
//   PR-level: `pr-audit: <check-id> — <reason>` in any commit message
//             between base and HEAD. Demotes BLOCK to WARN. Never silences.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { activeProfile } from './stack-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === '--strict') out.strict = true;
    else if (a.startsWith('--base=')) out.base = a.slice('--base='.length);
  }
  return out;
}

/**
 * git, with its arguments passed as arguments.
 *
 * NOT `execSync('git ...')`: that goes through a shell, and on Windows the
 * shell is cmd.exe, which expands `%H%x00%B%x1e` as environment-variable
 * references — the commit-parsing format above would arrive mangled or empty.
 * No quoting rule to remember either, for refs and paths with spaces.
 */
function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts });
}

function resolveBase(explicit) {
  if (explicit) return explicit;
  for (const ref of ['origin/develop', 'origin/main']) {
    try {
      git(['rev-parse', '--verify', ref], { stdio: 'ignore' });
      return ref;
    } catch {}
  }
  throw new Error('No origin/develop or origin/main to diff against. Pass --base=<ref>.');
}

function changedFiles(base) {
  const out = git(['diff', `${base}...HEAD`, '--name-only', '--diff-filter=ACMRD']);
  return out.split('\n').filter(Boolean);
}

function commitsSinceBase(base) {
  const out = git(['log', `${base}..HEAD`, '--format=%H%x00%B%x1e']);
  return out
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, ...rest] = rec.split('\x00');
      return { sha, body: rest.join('\x00') };
    });
}

async function loadChecksFrom(auditDir) {
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir).filter((f) => f.endsWith('.mjs'));
  const checks = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(auditDir, f)).href);
    // Defensive: the directory also holds helpers (and, historically, standalone
    // CLIs) that are not checks. Only take modules meeting the contract.
    if (mod?.check && typeof mod.check.run === 'function' && typeof mod.check.id === 'string') {
      checks.push(mod.check);
    }
  }
  return checks;
}

/**
 * Load the checks bundled with this kit, plus any the project defines itself.
 *
 * As a plugin this file lives outside the repo being audited, so a bare
 * `__dirname/audit` would silently drop a project's own `scripts/audit/*.mjs` —
 * the checks most specific to that codebase. Both directories are read; a
 * project check with the same id wins, so a repo can override a bundled check
 * rather than being stuck with it.
 */
export function bundledChecksDir(profile) {
  // Which bundled checks apply is a property of the stack: the Next.js checks
  // would be noise on a FastAPI repo, so each profile names its own directory.
  // Falls back to the TypeScript set, which is what this resolved to before
  // profiles existed.
  //
  // `auditChecks` can come from the audited repo's own .factory/profile.json,
  // and `loadChecksFrom` import()s every .mjs it finds in the result — so a
  // `../../../..`-shaped value would execute arbitrary code off the reviewer's
  // disk. The directory must stay inside this kit.
  const fallback = join(__dirname, 'audit');
  try {
    const sub = (profile ?? activeProfile()).auditChecks;
    if (typeof sub !== 'string' || sub.length === 0) return fallback;
    const dir = join(__dirname, sub);
    if (!resolve(dir).startsWith(`${resolve(__dirname)}${sep}`)) return fallback;
    return dir;
  } catch {
    return fallback;
  }
}

export async function loadChecks(
  bundledDir = null,
  projectDir = join(process.cwd(), 'scripts', 'audit'),
) {
  const bundled = bundledDir ?? bundledChecksDir();
  const byId = new Map();
  for (const c of await loadChecksFrom(bundled)) byId.set(c.id, c);
  if (projectDir !== bundled) {
    for (const c of await loadChecksFrom(projectDir)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

// Matches: `audit-skip: <check-id>` optionally followed by ` — <reason>` or ` -- <reason>`
const SKIP_RE = /audit-skip:\s*([A-Za-z0-9_-]+)(?:\s+(?:—|--)\s*(.+?))?\s*$/;

// PR-level demotion line in commit message: `pr-audit: <id> — <reason>` or `-- <reason>`
const PR_RE = /^pr-audit:\s*([A-Za-z0-9_-]+)\s+(?:—|--)\s+(.+)$/m;

export function perLineSuppression(issue, fileLines) {
  if (!fileLines) return null;
  const idx = issue.line - 1;
  const probe = [fileLines[idx] ?? '', fileLines[idx - 1] ?? ''];
  for (const l of probe) {
    const m = l.match(SKIP_RE);
    if (m && m[1] === issue.checkId) {
      return { reason: m[2]?.trim() ?? null };
    }
  }
  return null;
}

export function prLevelDemotions(commits) {
  const map = new Map();
  for (const c of commits) {
    for (const line of c.body.split('\n')) {
      const m = line.match(PR_RE);
      if (m) map.set(m[1], m[2].trim());
    }
  }
  return map;
}

export function applySuppressions({ issues, readFile, commits }) {
  const demotions = prLevelDemotions(commits);
  const kept = [];
  const suppressed = [];
  const reasonWarns = [];
  for (const issue of issues) {
    const lines = readFile(issue.file);
    const skip = perLineSuppression(issue, lines);
    if (skip) {
      if (!skip.reason) {
        reasonWarns.push({
          severity: 'WARN',
          checkId: 'audit-skip-reason',
          file: issue.file,
          line: issue.line,
          message: `audit-skip for "${issue.checkId}" missing "— <reason>"`,
        });
      }
      suppressed.push({ ...issue, suppressedBy: 'line' });
      continue;
    }
    if (issue.severity === 'BLOCK' && demotions.has(issue.checkId)) {
      kept.push({
        ...issue,
        severity: 'WARN',
        demoted: true,
        demotionReason: demotions.get(issue.checkId),
      });
      continue;
    }
    kept.push(issue);
  }
  return { kept: [...kept, ...reasonWarns], suppressed };
}

export function formatReport(kept, suppressed) {
  const buckets = { BLOCK: [], WARN: [], INFO: [] };
  for (const i of kept) (buckets[i.severity] ?? buckets.WARN).push(i);
  const lines = [];
  for (const sev of ['BLOCK', 'WARN', 'INFO']) {
    if (!buckets[sev].length) continue;
    lines.push(`\n${sev}:`);
    for (const i of buckets[sev]) {
      const tag = i.demoted ? ` (demoted: ${i.demotionReason})` : '';
      lines.push(`  ${i.checkId} · ${i.file}:${i.line} · ${i.message}${tag}`);
    }
  }
  if (suppressed.length) lines.push(`\n${suppressed.length} issue(s) suppressed per-line.`);
  if (!kept.length && !suppressed.length) lines.push('pr-audit: no issues found');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = resolveBase(args.base);
  const files = changedFiles(base);
  const commits = commitsSinceBase(base);

  const fileCache = new Map();
  const readFile = (path) => {
    if (!fileCache.has(path)) {
      try {
        fileCache.set(path, readFileSync(path, 'utf8').split('\n'));
      } catch {
        fileCache.set(path, null);
      }
    }
    return fileCache.get(path);
  };

  const issues = [];
  const ctx = {
    base,
    files,
    commits,
    readFile,
    addIssue: (i) => issues.push(i),
  };

  for (const check of await loadChecks()) {
    try {
      await check.run(ctx);
    } catch (err) {
      issues.push({
        severity: 'WARN',
        checkId: 'audit-runner',
        file: `scripts/audit/${check.id}.mjs`,
        line: 0,
        message: `Check threw: ${err.message}`,
      });
    }
  }

  const { kept, suppressed } = applySuppressions({ issues, readFile, commits });
  console.log(formatReport(kept, suppressed));

  const hasBlock = kept.some((i) => i.severity === 'BLOCK');
  const hasWarn = kept.some((i) => i.severity === 'WARN');
  process.exit(hasBlock || (args.strict && hasWarn) ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
