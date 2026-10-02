// Migration-safety audit. Catches the failure modes drizzle-kit / Postgres
// silently let through until prod deploy:
//
//   - SQL added without journal update (hand-edited migration)
//   - Journal entries out of order or referencing missing SQL files
//     (the canonical "two branches both generated migration N+1" symptom)
//   - Destructive ops without an expand/contract plan (DROP COLUMN,
//     DROP TABLE, ALTER COLUMN TYPE, SET NOT NULL on populated columns,
//     RENAME — see docs/database-patterns.md → "Destructive changes")
//   - CREATE INDEX CONCURRENTLY without IF NOT EXISTS (retry-on-failure
//     loses idempotency; drizzle-kit will error mid-deploy)
//
// Scope intentionally local — these are all checks the operator can do
// from a developer machine without network calls. The "did this actually
// apply against a test DB?" rehearsal lives in pr-review Activity 2.5,
// not here.

import { existsSync } from 'node:fs';

const JOURNAL_PATH = 'lib/db/migrations/meta/_journal.json';
const SQL_RE = /^lib\/db\/migrations\/([^/]+)\.sql$/;

// SQL patterns considered destructive enough to require an expand/contract
// review. Match is line-based so we can report the source line.
const DESTRUCTIVE_PATTERNS = [
  { name: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { name: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  { name: 'ALTER COLUMN ... TYPE', re: /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i },
  { name: 'SET NOT NULL', re: /\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i },
  { name: 'DROP CONSTRAINT', re: /\bDROP\s+CONSTRAINT\b/i },
  { name: 'DROP INDEX', re: /\bDROP\s+INDEX\b/i },
  { name: 'RENAME COLUMN', re: /\bRENAME\s+COLUMN\b/i },
  { name: 'ALTER TABLE ... RENAME TO', re: /\bALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b/i },
];

function parseJournal(readFile) {
  const lines = readFile(JOURNAL_PATH);
  if (!lines) return null;
  try {
    return JSON.parse(lines.join('\n'));
  } catch {
    return 'MALFORMED';
  }
}

function suppressedByCommit(commits) {
  return commits.some((c) => /^pr-audit:\s*migrations\s*[—-]/m.test(c.body ?? ''));
}

export const check = {
  id: 'migrations',
  // _existsSync override is for unit tests; production uses node:fs.
  run({ files, readFile, commits, addIssue, _existsSync = existsSync }) {
    const newSqls = files.filter((f) => SQL_RE.test(f));
    const journalTouched = files.some((f) => f === JOURNAL_PATH);

    // (1) SQL added without journal update — the original stub check.
    if (newSqls.length > 0 && !journalTouched) {
      for (const f of newSqls) {
        addIssue({
          severity: 'BLOCK',
          checkId: 'migrations',
          file: f,
          line: 1,
          message:
            'SQL migration added without updating meta/_journal.json — run `pnpm db:generate`.',
        });
      }
      return;
    }
    if (newSqls.length === 0 && !journalTouched) return;

    const journal = parseJournal(readFile);
    if (journal === 'MALFORMED' || (journalTouched && journal === null)) {
      addIssue({
        severity: 'BLOCK',
        checkId: 'migrations',
        file: JOURNAL_PATH,
        line: 1,
        message: 'Journal file is missing or not valid JSON — re-run `pnpm db:generate`.',
      });
      return;
    }
    if (!journal) return;

    // (2) Sequence integrity.
    const entries = Array.isArray(journal.entries) ? journal.entries : [];
    let prevIdx = -1;
    for (const entry of entries) {
      if (typeof entry.idx !== 'number') {
        addIssue({
          severity: 'BLOCK',
          checkId: 'migrations',
          file: JOURNAL_PATH,
          line: 1,
          message: `Journal entry "${entry.tag ?? '(no tag)'}" is missing numeric idx.`,
        });
        continue;
      }
      if (entry.idx <= prevIdx) {
        addIssue({
          severity: 'BLOCK',
          checkId: 'migrations',
          file: JOURNAL_PATH,
          line: 1,
          message: `Journal idx ${entry.idx} ("${entry.tag}") is out of order — expected > ${prevIdx}. Two branches likely created the same migration number; rebase + re-run \`pnpm db:generate\`.`,
        });
      }
      prevIdx = entry.idx;

      if (entry.tag) {
        const sqlPath = `lib/db/migrations/${entry.tag}.sql`;
        if (!_existsSync(sqlPath)) {
          addIssue({
            severity: 'BLOCK',
            checkId: 'migrations',
            file: JOURNAL_PATH,
            line: 1,
            message: `Journal entry "${entry.tag}" references a SQL file that doesn't exist on disk (${sqlPath}). Either the file was renamed manually or the journal is stale — re-run \`pnpm db:generate\`.`,
          });
        }
      }
    }

    // (3) Destructive ops + (4) index concurrency — scan each new SQL file.
    const suppressed = suppressedByCommit(commits);

    for (const f of newSqls) {
      const lines = readFile(f);
      if (!lines) continue;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const pat of DESTRUCTIVE_PATTERNS) {
          if (pat.re.test(line)) {
            addIssue({
              severity: suppressed ? 'INFO' : 'WARN',
              checkId: 'migrations',
              file: f,
              line: i + 1,
              message: `${pat.name} is destructive — confirm there's an expand/contract plan (paired non-destructive migration shipped first, code updated to stop using the column/table, then this one). See docs/database-patterns.md → "Destructive changes". If intentional, add \`pr-audit: migrations — <reason>\` to a commit message.`,
            });
          }
        }

        if (/\bCREATE\s+INDEX\s+CONCURRENTLY\b/i.test(line) && !/IF\s+NOT\s+EXISTS/i.test(line)) {
          addIssue({
            severity: 'WARN',
            checkId: 'migrations',
            file: f,
            line: i + 1,
            message:
              'CREATE INDEX CONCURRENTLY without IF NOT EXISTS — if drizzle-kit ' +
              'retries after a partial failure, the second attempt errors. ' +
              'Add IF NOT EXISTS for idempotency.',
          });
        }
      }
    }
  },
};
