// State-machine columns (status, phase, step) must have their source state
// validated before any `update().set({ status: ... })`. Without the guard,
// two browser tabs can both transition the same record, finalized records
// can be silently reset, and side-effect-bearing transitions (audit logs,
// email jobs, webhooks) can fire twice.
//
// Detection: a write to a status-like column without a comparison /
// set-membership / switch / if guard against that column earlier in the
// same file. The regex is per-file; for false positives, pair the guard
// with the write inside the same function (which the regex can't see).

import { isTsSource } from './_helpers.mjs';

const SET_STATUS_RE = /\.set\s*\(\s*\{[^}]*\b(status|phase|step|state)\s*:/g;
const GUARD_PATTERNS = [
  /\b(status|phase|step|state)\s*===/, // explicit comparison
  /\.has\s*\(\s*\w*\.(status|phase|step|state)\s*\)/, // Set.has(record.status)
  /switch\s*\(\s*\w*\.(status|phase|step|state)\s*\)/, // switch on status
  /\bif\s*\([^)]*\.(status|phase|step|state)\b/, // if (record.status …)
];

export const check = {
  id: 'status-transition',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!isTsSource(file)) continue;
      const lines = readFile(file);
      if (!lines) continue;
      const content = lines.join('\n');

      const matches = [...content.matchAll(SET_STATUS_RE)];
      if (matches.length === 0) continue;

      const hasGuard = GUARD_PATTERNS.some((re) => re.test(content));
      if (hasGuard) continue;

      for (const m of matches) {
        const line = content.slice(0, m.index).split('\n').length;
        addIssue({
          severity: 'WARN',
          checkId: 'status-transition',
          file,
          line,
          message: `update().set({ ${m[1]}: ... }) without a guarded source-state precondition. Validate the current state before mutating — see docs/conventions.md → "State-machine fields".`,
        });
      }
    }
  },
};
