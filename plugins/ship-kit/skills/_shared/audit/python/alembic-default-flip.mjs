// `server_default` only affects new inserts. Existing rows keep their previous
// values. When you flip a default to match a new business invariant you must
// explicitly choose: backfill old rows in the same migration, or document why
// they intentionally diverge.
//
// Silent split-state between old and new rows is a frequent audit and
// compliance bug, and one of the hardest to debug after the fact — a record
// created Friday gets the old default, and the same user sees the new value on
// a record created Monday.
//
// The Python analogue of the `default-flip-backfill` check.

import { migrationsDir, stripNonCodeLines } from './_helpers.mjs';

const SET_DEFAULT_RE = /\bop\.alter_column\s*\([^)]*\bserver_default\s*=/;
const RAW_SET_DEFAULT_RE = /\bALTER\s+COLUMN\s+\w+\s+SET\s+DEFAULT\b/i;
const HAS_BACKFILL_RE = /\bop\.execute\s*\(/;
const JUSTIFYING_COMMENT_RE =
  /#[^\n]*\b(default|existing rows|intentional|intentionally|backfill|diverge|compliance)\b/i;

export const check = {
  id: 'alembic-default-flip',
  run({ files, readFile, addIssue, _profile = undefined }) {
    const dir = `${migrationsDir(_profile)}/`;

    for (const file of files) {
      if (!file.startsWith(dir) || !file.endsWith('.py')) continue;
      const lines = readFile(file);
      if (!lines) continue;

      const raw = lines.join('\n');
      const code = stripNonCodeLines(lines).join('\n');

      const idx =
        code.search(SET_DEFAULT_RE) >= 0
          ? code.search(SET_DEFAULT_RE)
          : code.search(RAW_SET_DEFAULT_RE);
      if (idx < 0) continue;

      // An op.execute in the same migration is almost always the backfill.
      if (HAS_BACKFILL_RE.test(code.slice(idx))) continue;
      // Comments are stripped from `code`, so check the raw text for the note.
      if (JUSTIFYING_COMMENT_RE.test(raw)) continue;

      addIssue({
        severity: 'WARN',
        checkId: 'alembic-default-flip',
        file,
        line: code.slice(0, idx).split('\n').length,
        message:
          'Changing `server_default` affects new inserts only — existing rows keep their old ' +
          'value. Either backfill them in this migration with an `op.execute("UPDATE ...")` ' +
          '(scope the WHERE so you do not overwrite deliberate user choices), or add a comment ' +
          'saying why old rows intentionally diverge. See docs/database-patterns.md → ' +
          '"Default-value changes".',
      });
    }
  },
};
