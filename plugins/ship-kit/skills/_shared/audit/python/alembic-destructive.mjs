// Destructive operations in an Alembic migration.
//
// Every one of these is fine on an empty table and data loss on a populated
// one, and the difference is invisible in the diff. They want expand/contract
// across separate deploys — see docs/database-patterns.md → "Destructive
// changes".
//
// A second, subtler failure this catches: during a rolling deploy BOTH the old
// and new code are live, so a migration that drops a column the old revision
// still selects takes down the half of the fleet that has not rolled yet.
//
// WARN, not BLOCK: a destructive migration is sometimes exactly right (a table
// that has never held production data). Suppress a deliberate one with
// `pr-audit: alembic-destructive — <reason>` in a commit message.

import { migrationsDir, statementAt, stripNonCodeLines } from './_helpers.mjs';

const DESTRUCTIVE = [
  { name: 'op.drop_table', re: /\bop\.drop_table\s*\(/ },
  { name: 'op.drop_column', re: /\bop\.drop_column\s*\(/ },
  { name: 'op.drop_constraint', re: /\bop\.drop_constraint\s*\(/ },
  { name: 'op.drop_index', re: /\bop\.drop_index\s*\(/ },
  {
    name: 'op.alter_column(... new_column_name=)',
    re: /\bop\.alter_column\s*\([^)]*new_column_name\s*=/,
  },
  { name: 'op.rename_table', re: /\bop\.rename_table\s*\(/ },
  { name: 'raw DROP', re: /\bop\.execute\s*\(\s*['"]?\s*(?:--\s*)?\bDROP\b/i },
  {
    name: 'raw ALTER ... DROP',
    re: /\bop\.execute\s*\([^)]*\bDROP\s+(?:COLUMN|TABLE|CONSTRAINT)\b/i,
  },
];

// `nullable=False` on an added column with no server_default fails outright on
// a populated table — after taking a lock.
const ADD_COLUMN_RE = /\bop\.add_column\s*\(/;
const NOT_NULL_RE = /nullable\s*=\s*False/;
const SERVER_DEFAULT_RE = /server_default\s*=/;

// A type change is only lossy in one direction, but the diff cannot tell you
// which, so surface it and let the reviewer decide.
const TYPE_CHANGE_RE = /\bop\.alter_column\s*\([^)]*\btype_\s*=/;

function suppressedByCommit(commits) {
  return commits.some((c) => /^pr-audit:\s*alembic-destructive\s*[—-]/m.test(c.body ?? ''));
}

export const check = {
  id: 'alembic-destructive',
  run({ files, readFile, commits, addIssue, _profile = undefined }) {
    const dir = `${migrationsDir(_profile)}/`;
    const suppressed = suppressedByCommit(commits ?? []);
    const severity = suppressed ? 'INFO' : 'WARN';

    for (const file of files) {
      if (!file.startsWith(dir) || !file.endsWith('.py')) continue;
      const lines = readFile(file);
      if (!lines) continue;

      // add_column spans lines often enough that a line-local check misses it.
      const code = stripNonCodeLines(lines);

      for (let i = 0; i < code.length; i++) {
        const line = code[i];

        for (const pat of DESTRUCTIVE) {
          if (pat.re.test(line)) {
            addIssue({
              severity,
              checkId: 'alembic-destructive',
              file,
              line: i + 1,
              message:
                `${pat.name} is destructive. Confirm there is an expand/contract plan — the ` +
                'additive migration shipped first, code updated to stop using it, then this one, ' +
                'in a separate deploy. During a rolling deploy the previous revision is still ' +
                'live and still queries this. See docs/database-patterns.md → "Destructive ' +
                'changes". If deliberate, add `pr-audit: alembic-destructive — <reason>` to a ' +
                'commit message.',
            });
          }
        }

        if (TYPE_CHANGE_RE.test(line)) {
          addIssue({
            severity,
            checkId: 'alembic-destructive',
            file,
            line: i + 1,
            message:
              'Column type change. If it NARROWS (Numeric(20,4) → Numeric(20,2), text → ' +
              'varchar(50)) this is silent data loss on existing rows. Confirm the direction, ' +
              'and that no in-flight code writes the wider value.',
          });
        }

        // Read the whole add_column call, which the formatter routinely wraps
        // across lines — bounded by paren depth, NOT by a line count, so a
        // neighbouring call's server_default cannot excuse this one.
        if (ADD_COLUMN_RE.test(line)) {
          const stmt = statementAt(code, i);
          if (NOT_NULL_RE.test(stmt) && !SERVER_DEFAULT_RE.test(stmt)) {
            addIssue({
              severity: 'BLOCK',
              checkId: 'alembic-destructive',
              file,
              line: i + 1,
              message:
                'Adding a NOT NULL column with no server_default fails on any table that already ' +
                'has rows — after taking a lock, so it blocks writes and THEN errors. Add a ' +
                'server_default, or add the column nullable and backfill first.',
            });
          }
        }
      }
    }
  },
};
