// A constraint a user can satisfy via the UI must be re-checked in the
// Server Action — re-fetch the candidate ID and re-validate against the
// constraint. A <select> populated with eligible options is a UX
// affordance, not a security control.
//
// Detection: Server Action file reads an ID from formData / parsed input
// but does not re-fetch the candidate (no `findFirst`, `findMany`, or
// `.select().from(...)` in the file). Severity INFO — false positives are
// common (some IDs reference rows the caller already owns and a re-fetch
// isn't needed). Acts as a reviewer prompt.

import { fileLevelUseServer, isTsSource } from './_helpers.mjs';

const ID_INPUT_RE = /formData\.get\s*\(\s*['"][^'"]*[Ii]d['"]\s*\)|parsed\.data\.\w+Id\b/;
const REFETCH_RE = /\b(?:db\.query\.\w+\.(?:findFirst|findMany)|\.select\s*\(\s*\)\s*\.from\s*\()/;

export const check = {
  id: 'server-revalidation',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!isTsSource(file)) continue;
      const lines = readFile(file);
      if (!lines || !fileLevelUseServer(lines)) continue;
      const content = lines.join('\n');

      if (!ID_INPUT_RE.test(content)) continue;
      if (REFETCH_RE.test(content)) continue;

      addIssue({
        severity: 'INFO',
        checkId: 'server-revalidation',
        file,
        line: 1,
        message:
          'Server Action reads an ID from formData/parsed input but the file ' +
          'has no re-fetch query. Confirm the constraint behind the ID is ' +
          'server-side re-validated — see docs/conventions.md → "Server-side ' +
          're-validation".',
      });
    }
  },
};
