#!/usr/bin/env node
/**
 * Turn raw test-runner JSON into the one-page summary a person actually reads.
 *
 * WHY THIS EXISTS. The output of a test run is thousands of lines, and the
 * useful part is four numbers and the names of what broke. Asking a model to
 * summarise scrollback works until the run is long enough to be truncated,
 * at which point it starts summarising the part it can still see and reports
 * "all passing" about a run with failures in it. Counts come from the runner's
 * own JSON here, so the summary cannot drift from the run it describes.
 *
 * HEADLESS IS STATED, ALWAYS. A browser suite that ran headless looks identical
 * in a summary to one that ran headed, and the difference matters to anyone
 * about to say "watch this" in front of a room. Every browser suite records how
 * it ran, and `--headless` is called out explicitly rather than left as the
 * absence of `--headed`.
 *
 * Usage:
 *   node test-summary.mjs --vitest=unit:results.json --playwright=e2e.json \
 *     [--uat=uat.json] [--headed] [--title="..."] [--out=test-results/summary.md]
 *
 * `--vitest` and `--playwright` may be repeated. The `label:` prefix is
 * optional and names the suite in the report (defaults to the runner name).
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const ICON = { passed: '✅', failed: '❌', skipped: '⏭️', unclear: '❓' };

/** `label:path` -> {label, path}; a bare path keeps `fallback` as its label. */
export function splitLabelled(value, fallback) {
  const i = value.indexOf(':');
  // A Windows drive letter is not a label.
  if (i > 1) return { label: value.slice(0, i), path: value.slice(i + 1) };
  return { label: fallback, path: value };
}

/**
 * Vitest's JSON reporter, normalised.
 *
 * Reads `testResults[].assertionResults[]` rather than the top-level counters:
 * the counters alone cannot name what failed, and a summary that says "3 failed"
 * without saying which three sends somebody back to the scrollback this exists
 * to replace.
 */
export function parseVitest(json) {
  const files = json.testResults ?? [];
  /**
   * A FILE that failed to load — a bad import, a database the setup could not
   * reach — reports every test inside it as "skipped", not as failed. Left at
   * that, a suite that never got as far as running a line reads as 0 failures,
   * and the most common real breakage (the service isn't up) looks like a
   * deliberate skip. The file-level status is where the truth is, and its
   * `message` is the actual cause, so both are surfaced as failures.
   */
  const suiteFailures = files
    .filter((f) => f.status === 'failed')
    .map((f) => ({
      name: `${f.name?.split('/').pop() ?? 'suite'} — failed to run`,
      status: 'failed',
      file: f.name,
      duration: 0,
      message: (f.message ?? '').split('\n')[0],
    }));
  const cases = files.flatMap((f) =>
    (f.assertionResults ?? []).map((a) => ({
      name: [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' › '),
      status: a.status === 'pending' || a.status === 'todo' ? 'skipped' : a.status,
      file: f.name,
      duration: a.duration ?? 0,
      message: (a.failureMessages ?? [])[0] ?? '',
    })),
  );
  const failed = cases.filter((c) => c.status === 'failed');
  return {
    total: cases.length + suiteFailures.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: failed.length + suiteFailures.length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    durationMs: json.testResults?.reduce((a, f) => a + ((f.endTime ?? 0) - (f.startTime ?? 0)), 0),
    failures: [...suiteFailures, ...failed],
  };
}

/**
 * Playwright's JSON reporter, normalised to the same shape.
 *
 * A spec that FLAKED (failed, then passed on retry) is counted as passed but
 * listed, because "green" and "green on the second try" are different facts and
 * only one of them is safe to demo.
 */
export function parsePlaywright(json) {
  const cases = [];
  const walk = (suite, trail) => {
    const path = [...trail, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results[results.length - 1] ?? {};
        const flaky = results.length > 1 && last.status === 'passed';
        cases.push({
          name: [...path, spec.title].join(' › '),
          status:
            last.status === 'passed' ? 'passed' : last.status === 'skipped' ? 'skipped' : 'failed',
          flaky,
          file: spec.file ?? suite.file ?? '',
          duration: last.duration ?? 0,
          message: (last.error?.message ?? '').split('\n')[0],
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const suite of json.suites ?? []) walk(suite, []);
  return {
    total: cases.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    flaky: cases.filter((c) => c.flaky).length,
    durationMs: json.stats?.duration,
    failures: cases.filter((c) => c.status === 'failed'),
    flakes: cases.filter((c) => c.flaky),
  };
}

/**
 * The UAT Validator's `uat.json`, normalised to the same shape.
 *
 * `unclear` is kept as its own outcome rather than folded into pass or fail —
 * it is the honest answer for a criterion nobody could prove, and collapsing it
 * either way is exactly the misreport the validator's grounding rules exist to
 * prevent.
 */
export function parseUat(json) {
  const criteria = json.criteria ?? [];
  const map = { pass: 'passed', fail: 'failed', unclear: 'unclear' };
  const cases = criteria.map((c) => ({
    name: c.criterion,
    status: map[c.verdict] ?? 'unclear',
    evidence: c.evidence ?? '',
    screenshot: c.screenshot,
  }));
  return {
    total: cases.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    unclear: cases.filter((c) => c.status === 'unclear').length,
    skipped: 0,
    cases,
    failures: cases.filter((c) => c.status === 'failed'),
    trace: json.trace,
  };
}

const secs = (ms) => (typeof ms === 'number' && ms > 0 ? `${(ms / 1000).toFixed(1)}s` : '—');

/** Cases that actually EXECUTED. A skipped case proves nothing about the code. */
export const executed = (r) => (r.passed ?? 0) + (r.failed ?? 0);

/**
 * The verdict, and it is deliberately hard to get a PASS out of.
 *
 * A suite that reported twelve cases and skipped all twelve has a `total` of
 * twelve and has tested NOTHING — counting it as green is how a run where the
 * database was never up reads as "all passing". Same for a suite whose runner
 * errored before collecting anything: zero failures, zero proof. Both resolve
 * to INCONCLUSIVE, which is a result somebody investigates rather than one they
 * relax about.
 */
export function overall(suites) {
  if (suites.length === 0) return 'NO TESTS RAN';
  if (suites.some((s) => s.result.failed > 0)) return 'FAIL';
  if (suites.every((s) => executed(s.result) === 0)) return 'NO TESTS RAN';
  if (suites.some((s) => executed(s.result) === 0)) return 'INCONCLUSIVE';
  if (suites.some((s) => (s.result.unclear ?? 0) > 0)) return 'INCONCLUSIVE';
  return 'PASS';
}

export function render(suites, opts = {}) {
  const verdict = overall(suites);
  const lines = [
    `# ${opts.title ?? 'Test run'}`,
    '',
    `**${verdict}** — ${opts.when ?? 'local run'}`,
    '',
    '| Suite | Result | Passed | Failed | Other | Time |',
    '|---|---|---:|---:|---:|---:|',
  ];

  for (const { label, result, browser } of suites) {
    const other =
      (result.skipped ? `${result.skipped} skipped` : '') +
      (result.unclear ? `${result.skipped ? ', ' : ''}${result.unclear} unclear` : '') +
      (result.flaky ? `${result.skipped || result.unclear ? ', ' : ''}${result.flaky} flaky` : '');
    const state =
      executed(result) === 0
        ? '⚠️ nothing ran'
        : result.failed
          ? `${ICON.failed} fail`
          : result.unclear
            ? `${ICON.unclear} inconclusive`
            : `${ICON.passed} pass`;
    const name = browser ? `${label} (${browser})` : label;
    lines.push(
      `| ${name} | ${state} | ${result.passed} | ${result.failed} | ${other || '—'} | ${secs(result.durationMs)} |`,
    );
  }

  // Name the suites that proved nothing. Without this the table shows "0 / 0"
  // in a row that still looks like every other row, and the reader's eye goes
  // to the verdict word — which is exactly the misread this is here to stop.
  const empty = suites.filter((s) => executed(s.result) === 0);
  if (empty.length > 0) {
    lines.push(
      '',
      `> **Nothing executed in: ${empty.map((s) => s.label).join(', ')}.** ` +
        'Every case was skipped, or the runner collected none — this is not a pass for',
      '> those suites. Common causes: a service the tests skip themselves without, or a',
      '> runner that errored before collecting. Check the run output before trusting the rest.',
    );
  }

  // The headless callout. Deliberately its own paragraph rather than a table
  // cell: somebody scanning this needs to know the browser suite ran with no
  // window BEFORE they promise to show it to anybody.
  const browserSuites = suites.filter((s) => s.browser);
  if (browserSuites.length > 0) {
    const headless = browserSuites.filter((s) => s.browser === 'headless');
    if (headless.length > 0) {
      lines.push(
        '',
        `> **Ran headless** (${headless.map((s) => s.label).join(', ')}) — no browser window was shown.`,
        '> Re-run with `--headed` to watch the navigation.',
      );
    } else {
      lines.push('', '> Ran **headed** — the browser window was visible.');
    }
  }

  for (const { label, result } of suites) {
    const failures = result.failures ?? [];
    const flakes = result.flakes ?? [];
    const unclear = (result.cases ?? []).filter((c) => c.status === 'unclear');
    if (failures.length === 0 && flakes.length === 0 && unclear.length === 0) continue;
    lines.push('', `## ${label}`);
    for (const f of failures) {
      lines.push('', `${ICON.failed} **${f.name}**`, ...detail(f));
    }
    for (const f of unclear) {
      lines.push('', `${ICON.unclear} **${f.name}**`, ...detail(f));
    }
    for (const f of flakes) {
      lines.push('', `⚠️ **${f.name}** — passed only on retry (flaky).`);
    }
  }

  // Evidence last: it is what somebody opens after reading the verdict, not
  // something they scroll past on the way to it.
  const shots = suites.flatMap((s) =>
    (s.result.cases ?? []).filter((c) => c.screenshot).map((c) => c.screenshot),
  );
  const traces = suites.map((s) => s.result.trace).filter(Boolean);
  if (shots.length || traces.length) {
    lines.push('', '## Evidence');
    for (const s of shots) lines.push(`- ${s}`);
    for (const t of traces) lines.push(`- trace: ${t}`);
  }

  return `${lines.join('\n')}\n`;
}

function detail(c) {
  const out = [];
  if (c.file) out.push(`  ${c.file}`);
  if (c.evidence) out.push(`  ${c.evidence}`);
  if (c.message)
    out.push('', '  ```', `  ${c.message.split('\n').slice(0, 6).join('\n  ')}`, '  ```');
  return out;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const all = (name) =>
    argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
  const headed = argv.includes('--headed');
  const browser = headed ? 'headed' : 'headless';

  const suites = [];
  for (const raw of all('vitest')) {
    const { label, path } = splitLabelled(raw, 'unit');
    suites.push({ label, result: parseVitest(readJson(path)) });
  }
  for (const raw of all('playwright')) {
    const { label, path } = splitLabelled(raw, 'e2e');
    suites.push({ label, result: parsePlaywright(readJson(path)), browser });
  }
  for (const raw of all('uat')) {
    const { label, path } = splitLabelled(raw, 'uat');
    suites.push({ label, result: parseUat(readJson(path)), browser });
  }

  const doc = render(suites, { title: flag('title'), when: flag('when') });
  const out = flag('out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, doc);
    process.stdout.write(`${doc}\nwritten to ${out}\n`);
  } else {
    process.stdout.write(doc);
  }
  process.exit(overall(suites) === 'FAIL' ? 1 : 0);
}
