// `ALTER COLUMN ... SET DEFAULT` only affects new inserts. Existing rows
// keep their previous values. When you flip a default to match a new
// business invariant, either backfill old rows in the same migration
// (with an `UPDATE`) or add an SQL comment that documents why the split
// is intentional. Silent split-state between old and new rows is a
// frequent audit/compliance bug.

const SQL_MIGRATION_RE = /^lib\/db\/migrations\/[^/]+\.sql$/;
const SET_DEFAULT_RE = /ALTER\s+COLUMN\s+\w+\s+SET\s+DEFAULT\b/i;
const HAS_UPDATE_RE = /\bUPDATE\s+\w+\s+SET\s+\w+\s*=/i;
const HAS_JUSTIFYING_COMMENT_RE =
  /--[^\n]*\b(default|existing rows|intentional|backfill|compliance)\b/i;

export const check = {
  id: 'default-flip-backfill',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!SQL_MIGRATION_RE.test(file)) continue;
      const lines = readFile(file);
      if (!lines) continue;
      const content = lines.join('\n');

      const defaultIdx = content.search(SET_DEFAULT_RE);
      if (defaultIdx < 0) continue;

      if (HAS_UPDATE_RE.test(content)) continue;
      if (HAS_JUSTIFYING_COMMENT_RE.test(content)) continue;

      const line = content.slice(0, defaultIdx).split('\n').length;
      addIssue({
        severity: 'WARN',
        checkId: 'default-flip-backfill',
        file,
        line,
        message:
          '`ALTER COLUMN ... SET DEFAULT` only affects new inserts. Either add ' +
          'an `UPDATE` to backfill existing rows in the same migration, or add ' +
          'an SQL comment documenting why old rows intentionally diverge — see ' +
          'docs/database-patterns.md → "Default-value changes".',
      });
    }
  },
};
