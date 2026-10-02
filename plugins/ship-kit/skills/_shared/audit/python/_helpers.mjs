// Shared helpers for the Python convention checks.

import { activeProfile } from '../../stack-profile.mjs';

export const DEFAULT_MIGRATIONS_DIR = 'apps/api/migrations/versions';

/**
 * Where Alembic revisions live, per the active profile.
 *
 * The `language === 'python'` guard is load-bearing. These checks only load
 * under a Python profile, but `activeProfile()` resolves against the ambient
 * cwd — so in a unit test, or anywhere the resolver falls back to `ts-next`,
 * an unguarded read returns `lib/db/migrations` and every migration check
 * silently inspects nothing. A check that quietly stops looking is worse than
 * one that fails.
 */
export function migrationsDir(profile) {
  try {
    const resolved = profile ?? activeProfile();
    if (resolved?.language !== 'python') return DEFAULT_MIGRATIONS_DIR;
    const configured = resolved.paths?.migrations;
    return typeof configured === 'string' && configured.length > 0
      ? configured
      : DEFAULT_MIGRATIONS_DIR;
  } catch {
    return DEFAULT_MIGRATIONS_DIR;
  }
}

const EXCLUDED_RE = /(^|\/)(\.venv|__pycache__|node_modules|\.tox|build|dist)\//;

/** Application Python: not a test, not generated, not vendored. */
export function isPySource(path, profile) {
  if (!path.endsWith('.py')) return false;
  if (EXCLUDED_RE.test(path)) return false;
  if (path.startsWith('tests/')) return false;
  if (path.startsWith(`${migrationsDir(profile)}/`)) return false;
  return true;
}

export function isPyTest(path) {
  return path.startsWith('tests/') && path.endsWith('.py') && !EXCLUDED_RE.test(path);
}

/**
 * Index of the fence that CLOSES a triple-quoted string opened before `from`,
 * or -1 if it stays open past the end of the line.
 *
 * `indexOf` is wrong here, and wrongly in the worst direction. In valid Python
 * `"""Quote style is \\""" here."""` is a single string; `indexOf` closes it at
 * the escaped quote, reads the tail as code, then REOPENS on the trailing
 * fence — and the fence stays open to EOF, so every whole-file check silently
 * sees nothing for the rest of the file.
 */
function closingFence(line, from, fence) {
  let j = from;
  while (j < line.length) {
    if (line[j] === '\\') {
      j += 2;
      continue;
    }
    if (line.startsWith(fence, j)) return j;
    j += 1;
  }
  return -1;
}

/**
 * Strip `#` comments and string literals from ONE line, reporting any
 * triple-quote left open at the end of it.
 *
 * Splitting this out is what makes `stripNonCodeLines` able to track a
 * docstring across lines, which the line-local version could not.
 */
function scanLine(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const fence = line.slice(i, i + 3);
    if (fence === '\"\"\"' || fence === "'''") {
      const close = closingFence(line, i + 3, fence);
      // Unclosed on this line: the rest of the file is inside a docstring
      // until the matching fence.
      if (close === -1) return { code: out, openFence: fence };
      i = close + 3;
      continue;
    }
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '#') break;
    out += ch;
    i += 1;
  }
  return { code: out, openFence: null };
}

/**
 * Strip comments and string literals from one line, WITHOUT docstring context.
 *
 * Prefer `stripNonCodeLines` for anything scanning a whole file: this cannot
 * see that the line sits inside a triple-quoted string.
 */
export function stripNonCode(line) {
  return scanLine(line).code;
}

/** The stripped lines, plus whether a fence was still open when we ran out. */
function scanAll(lines) {
  const code = [];
  let fence = null;
  for (const raw of lines) {
    if (fence) {
      const close = closingFence(raw, 0, fence);
      if (close === -1) {
        code.push('');
        continue;
      }
      const rest = scanLine(raw.slice(close + 3));
      code.push(rest.code);
      fence = rest.openFence;
      continue;
    }
    const scanned = scanLine(raw);
    code.push(scanned.code);
    fence = scanned.openFence;
  }
  return { code, openAtEof: fence !== null };
}

/**
 * Strip comments and every string literal from a file, preserving line count.
 *
 * Triple-quoted strings are tracked ACROSS lines. Without that, a migration
 * whose docstring explains "the contract step will call op.drop_column(...) in
 * a later deploy" was itself reported as a destructive migration — so the file
 * that documented its expand/contract plan got flagged for documenting it.
 */
export function stripNonCodeLines(lines) {
  const { code, openAtEof } = scanAll(lines);
  // A fence still open at EOF means we mis-parsed — no real Python file ends
  // inside a docstring. Swallowing the rest of the file is exactly the silent
  // miss this kit exists to prevent, so fall back to the line-local strip: a
  // possible false positive beats a guaranteed miss.
  return openAtEof ? lines.map(stripNonCode) : code;
}

/**
 * The full statement starting at line `i` of already-stripped `code`, joined
 * into one string and bounded by parenthesis depth.
 *
 * A fixed line window is wrong in both directions, and both were reproduced:
 * two `op.add_column(...)` calls the formatter put next to each other bleed
 * into one another (a `server_default` on the second silently excuses the
 * first), while one call wrapped across ten lines is truncated mid-statement
 * (its `server_default` never seen, so it is reported anyway). Depth is what
 * actually delimits the call.
 *
 * `maxLines` only stops a malformed file from running away.
 */
export function statementAt(code, i, maxLines = 40) {
  let depth = 0;
  let stmt = '';
  for (let j = i; j < Math.min(i + maxLines, code.length); j++) {
    stmt += `${code[j]} `;
    depth += (code[j].match(/\(/g) ?? []).length;
    depth -= (code[j].match(/\)/g) ?? []).length;
    if (depth <= 0) break;
  }
  return stmt;
}

/** Line numbers (1-based) whose CODE matches `re`. */
export function matchingLines(lines, re) {
  const stripped = stripNonCodeLines(lines);
  const hits = [];
  for (let i = 0; i < stripped.length; i++) {
    if (re.test(stripped[i])) hits.push(i + 1);
  }
  return hits;
}

/** True when the diff touched anything under the migrations directory. */
export function touchesMigrations(files, profile) {
  const dir = `${migrationsDir(profile)}/`;
  return files.some((f) => f.startsWith(dir) && f.endsWith('.py'));
}
