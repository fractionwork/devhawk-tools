// A Server Action that accepts a parent ID AND a child ID from the client
// must FK-verify that the child belongs to the parent before any mutation.
// Standard tenant-access checks only validate the parent — without the join
// re-fetch, an attacker (org variant) or privilege-confused write (solo
// variant) can splice a child from another tenant into the row.
//
// Detection (regex, conservative):
//   1. File has `"use server"` (or path matches a Server Action convention).
//   2. The destructured shape contains at least two distinct `*Id` fields.
//   3. The file lacks an `and(eq(...id, ...), eq(...id, ...))` block — the
//      canonical shape of a FK-joined re-fetch.
//
// Severity is WARN even though the brief targets BLOCK: regex can't reliably
// tell a valid join from a coincidental `and(...)`. Upgrade to BLOCK once the
// check moves to AST.

import { fileLevelUseServer, isTsSource } from './_helpers.mjs';

const ID_FIELD_RE = /\b(\w+Id)\s*:/g;
const FK_JOIN_RE = /\band\s*\(\s*eq\s*\([^)]*\)\s*,\s*eq\s*\(/;
const ACTION_PATH_RE = /^app\/.*actions(?:\.ts|\/[^/]*\.ts)$/;

export const check = {
  id: 'cross-resource',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!isTsSource(file)) continue;
      const lines = readFile(file);
      if (!lines) continue;
      const content = lines.join('\n');
      const isAction = fileLevelUseServer(lines) || ACTION_PATH_RE.test(file);
      if (!isAction) continue;

      const ids = new Set();
      for (const m of content.matchAll(ID_FIELD_RE)) ids.add(m[1]);
      if (ids.size < 2) continue;

      if (FK_JOIN_RE.test(content)) continue;

      addIssue({
        severity: 'WARN',
        checkId: 'cross-resource',
        file,
        line: 1,
        message: `Server Action references multiple *Id fields (${[...ids].join(', ')}) but the file has no \`and(eq(...), eq(...))\` FK-joined re-fetch. Verify the child belongs to the parent before mutating — see docs/conventions.md → "Cross-resource binding".`,
      });
    }
  },
};
