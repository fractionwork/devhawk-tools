// Catches wall-clock reads inside Vitest test files that don't install
// fake timers. `Date.now()` and `new Date()` (no args) bind the test to
// the machine clock and produce flaky failures around midnight, DST
// transitions, or fast CI runners.
//
// The check scans only test files (the inverse of the convention checks,
// which skip tests). Files that opt in to fake timers via
// `vi.useFakeTimers()`, `vi.setSystemTime(...)`, or an explicit
// `@sinonjs/fake-timers` import are exempt.

const TEST_FILE_RE = /^tests\/.*\.test\.tsx?$/;
const DATE_NOW_RE = /\bDate\.now\s*\(\s*\)/g;
const NEW_DATE_NO_ARGS_RE = /\bnew\s+Date\s*\(\s*\)/g;

const FAKE_TIMER_MARKERS = ['vi.useFakeTimers', 'vi.setSystemTime', '@sinonjs/fake-timers'];

export function fileUsesFakeTimers(content) {
  return FAKE_TIMER_MARKERS.some((m) => content.includes(m));
}

export function findTimeFlakyHits(content) {
  const hits = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (DATE_NOW_RE.test(line)) hits.push({ line: i + 1, snippet: 'Date.now()' });
    DATE_NOW_RE.lastIndex = 0;
    if (NEW_DATE_NO_ARGS_RE.test(line)) hits.push({ line: i + 1, snippet: 'new Date()' });
    NEW_DATE_NO_ARGS_RE.lastIndex = 0;
  }
  return hits;
}

export const check = {
  id: 'time-flaky',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!TEST_FILE_RE.test(file)) continue;
      const lines = readFile(file);
      if (!lines) continue;
      const content = lines.join('\n');
      if (fileUsesFakeTimers(content)) continue;
      for (const hit of findTimeFlakyHits(content)) {
        addIssue({
          severity: 'WARN',
          checkId: 'time-flaky',
          file,
          line: hit.line,
          message: `${hit.snippet} reads the wall clock — install fake timers (\`vi.useFakeTimers()\` + \`vi.setSystemTime(...)\`) to keep the test deterministic.`,
        });
      }
    }
  },
};
