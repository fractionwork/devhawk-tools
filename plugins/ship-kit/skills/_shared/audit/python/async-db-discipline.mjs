// Async/database conventions that ruff structurally cannot check, because each
// is about which of two valid APIs you picked, not about whether the code is
// well-formed.
//
//   1. A SYNC engine or sessionmaker in an async service. psycopg2 blocks the
//      event loop on every query. The symptom is a service that is fine in
//      tests and falls over under concurrency — in production, weeks later.
//   2. A `postgresql://` URL literal with no `+asyncpg`. Settings rejects this
//      at startup, so it is caught eventually; catching it in review is
//      cheaper than catching it in a failed deploy.
//   3. `commit()` inside the session DEPENDENCY. The route commits explicitly;
//      an implicit commit-on-success lets a handler that raised AFTER a partial
//      write leave that write behind.
//
// See docs/conventions.md → "Async correctness".

import { isPySource, matchingLines, stripNonCodeLines } from './_helpers.mjs';

const SYNC_ENGINE_RE = /(?<!async_)\bcreate_engine\s*\(/;
const SYNC_SESSIONMAKER_RE = /(?<!async_)\bsessionmaker\s*\(/;
const SYNC_DSN_RE = /['"]postgresql:\/\/[^'"]*['"]/;
const COMMIT_RE = /\bawait\s+\w*session\w*\.commit\s*\(/;

function isDependencyModule(path) {
  return /(^|\/)dependencies\.py$/.test(path);
}

export const check = {
  id: 'async-db-discipline',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!isPySource(file)) continue;
      // Alembic's env.py legitimately builds a sync Connection inside
      // run_sync, and conftest builds engines directly. Neither is the app.
      if (/(^|\/)(migrations|conftest)\b/.test(file)) continue;

      const lines = readFile(file);
      if (!lines) continue;

      for (const line of matchingLines(lines, SYNC_ENGINE_RE)) {
        addIssue({
          severity: 'BLOCK',
          checkId: 'async-db-discipline',
          file,
          line,
          message:
            '`create_engine` is the SYNC engine — it blocks the event loop on every query. Use ' +
            '`create_async_engine`. The symptom of getting this wrong is a service that passes ' +
            'every test and degrades only under concurrency.',
        });
      }

      for (const line of matchingLines(lines, SYNC_SESSIONMAKER_RE)) {
        addIssue({
          severity: 'BLOCK',
          checkId: 'async-db-discipline',
          file,
          line,
          message: '`sessionmaker` is the sync factory — use `async_sessionmaker`.',
        });
      }

      // Deliberately NOT matchingLines: a DSN lives inside a string literal, and
      // matchingLines strips those. Scan the raw line instead.
      const dsnLines = lines.map((l, i) => (SYNC_DSN_RE.test(l) ? i + 1 : 0)).filter((n) => n > 0);
      for (const line of dsnLines) {
        addIssue({
          severity: 'WARN',
          checkId: 'async-db-discipline',
          file,
          line,
          message:
            'A `postgresql://` URL resolves to psycopg2, which blocks the event loop. Use ' +
            '`postgresql+asyncpg://`. Settings rejects this at startup — better to fix it here ' +
            'than to find it when a deploy fails to boot.',
        });
      }

      if (!isDependencyModule(file)) continue;
      const code = stripNonCodeLines(lines);
      for (let i = 0; i < code.length; i++) {
        if (!COMMIT_RE.test(code[i])) continue;
        addIssue({
          severity: 'WARN',
          checkId: 'async-db-discipline',
          file,
          line: i + 1,
          message:
            'The session dependency commits. It should only roll back — the ROUTE commits ' +
            'explicitly, because the route knows when the unit of work is complete. An implicit ' +
            'commit-on-success lets a handler that raised after a partial write leave that write ' +
            'behind. See docs/conventions.md → "Async correctness".',
        });
      }
    }
  },
};
