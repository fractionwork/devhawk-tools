#!/usr/bin/env node
/**
 * What can this repo actually TEST right now, and what is stopping it?
 *
 * WHY THIS EXISTS. "Run the tests" is four different commands in four different
 * repos, and the way an ad-hoc test run dies is never the tests — it is a
 * missing Postgres, a dev server nobody started, or Playwright browsers that
 * were never downloaded. Asking a model to infer the right script from a
 * package.json each time gets it right most of the time, and a demo does not
 * want most of the time. This resolves it deterministically, the same way on
 * every run, and names the blockers BEFORE anything is executed rather than
 * after a four-minute suite fails on connection refused.
 *
 * WHAT IT DOES NOT DO. It never runs a test, starts a service, or installs
 * anything. It reads package.json, the config files on disk, and (for the two
 * suites that need a live dependency) probes a TCP port. Everything it finds is
 * a suggestion the caller is free to ignore — a repo with an unusual layout is
 * reported as `detected: false` with the reason, never guessed at.
 *
 * THE FOUR SUITES, and why they are separate rather than one "test" script:
 *   unit  — pure, no services. Always safe to run; the fast feedback.
 *   api   — integration/server-side: needs a database, and usually a migration.
 *   e2e   — a real browser against a real app: needs BOTH a dev server and
 *           browser binaries, and is the one people want to WATCH.
 *   uat   — acceptance criteria exercised as a user, not a spec file. Needs a
 *           running app; see the `uat-run` skill. Listed here so one command
 *           answers "what can I demo?" completely.
 *
 * Usage:
 *   node test-detect.mjs                  # -> JSON on stdout
 *   node test-detect.mjs --suite=e2e      # -> just that suite
 *   node test-detect.mjs --summary        # -> a human-readable table
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUITES = ['unit', 'api', 'e2e', 'uat'];

/** package.json, or null when there isn't one (a non-Node repo, or the wrong cwd). */
export function readPackageJson(cwd = process.cwd()) {
  try {
    return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Which package manager's `run` to prefix a script with.
 *
 * From the LOCKFILE, not from whatever happens to be installed: running `npm
 * run test` in a pnpm workspace resolves a different dependency tree, and the
 * failure it produces looks like a broken test rather than a wrong runner.
 */
export function detectPackageManager(cwd = process.cwd()) {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';
  return 'npm';
}

/**
 * The first package.json script whose name matches one of `candidates`, in
 * PREFERENCE order — not the first that merely contains the word.
 *
 * A repo with both `test` and `test:run` means the second one: `test` is
 * conventionally the watching, never-exiting variant, and a skill that starts
 * it hangs until somebody notices. Preferring the explicit name is the
 * difference between a run that finishes and a demo that stalls.
 */
export function pickScript(scripts, candidates) {
  if (!scripts) return null;
  for (const name of candidates) {
    if (typeof scripts[name] === 'string') return name;
  }
  return null;
}

/** Watch mode never exits, so a skill that shells out to one hangs forever. */
export function isWatchScript(body) {
  if (!body) return false;
  if (/--watch\b/.test(body) && !/--watch[= ]false/.test(body)) return true;
  // Bare `vitest` / `jest` with no subcommand defaults to watch in a TTY.
  return /(^|&&\s*|;\s*)(vitest|jest)\s*$/.test(body.trim());
}

/** Is something listening? The cheapest true answer to "is the DB/app up?". */
export function probePort(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * The port the app is expected on.
 *
 * `PORT` in the environment wins, then an explicit `-p`/`--port` in the dev
 * script, then the framework default. The env override exists because the
 * common real case — a dev server someone started by hand on a different port —
 * is otherwise reported as "the app is down" while it is plainly running, and a
 * blocker that is wrong is worse than no blocker at all.
 */
export function devPort(scripts, env = process.env) {
  const fromEnv = Number(env.PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const dev = scripts?.dev ?? scripts?.start ?? '';
  const flag = /(?:-p|--port)[= ](\d{2,5})/.exec(dev);
  if (flag) return Number(flag[1]);
  return 3000;
}

/**
 * Are Playwright's browser binaries actually downloaded?
 *
 * Checked because the failure without them is a launch error deep in a suite
 * run, minutes in, that reads as a broken test rather than as a missing
 * download. `playwright install chromium` is the whole fix and it belongs in
 * the blocker list, not in a stack trace.
 */
export function browsersInstalled(env = process.env) {
  const root = env.PLAYWRIGHT_BROWSERS_PATH || join(env.HOME || '', '.cache', 'ms-playwright');
  try {
    return readdirSync(root).some((d) => d.startsWith('chromium'));
  } catch {
    return false;
  }
}

/**
 * Does the repo bring its own services up? Names the file so a blocker can say
 * `docker compose -f <it> up -d` rather than the generic advice.
 *
 * Looks in `docker/` and `deploy/` as well as the root — a repo that keeps its
 * compose file in a subdirectory is common enough that missing it turns the most
 * actionable blocker in the set back into "the database is not running".
 */
export function composeFile(cwd = process.cwd()) {
  const names = [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
    'docker-compose.dev.yml',
    'docker-compose.local.yml',
  ];
  for (const dir of ['', 'docker', 'deploy', '.docker']) {
    for (const f of names) {
      const rel = dir ? `${dir}/${f}` : f;
      if (existsSync(join(cwd, rel))) return rel;
    }
  }
  return null;
}

/** The database port from a DATABASE_URL in the environment or a local .env. */
export function dbPort(cwd = process.cwd(), env = process.env) {
  let url = env.DATABASE_URL;
  if (!url) {
    for (const f of ['.env.local', '.env']) {
      try {
        const m = /^DATABASE_URL=["']?([^"'\n]+)/m.exec(readFileSync(join(cwd, f), 'utf8'));
        if (m) {
          url = m[1];
          break;
        }
      } catch {
        // no such file
      }
    }
  }
  const m = url && /:(\d{2,5})\//.exec(url);
  return m ? Number(m[1]) : 5432;
}

/** Playwright is configured here (and so `e2e` means something). */
export function playwrightConfig(cwd = process.cwd()) {
  for (const f of [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'e2e/playwright.config.ts',
  ]) {
    if (existsSync(join(cwd, f))) return f;
  }
  return null;
}

/**
 * Resolve all four suites.
 *
 * Every suite reports the same shape — `detected`, `command`, `blockers`,
 * `notes` — so a caller renders them uniformly and a suite that is simply
 * absent reads the same as one that is present but not runnable yet. `blockers`
 * is the whole point: it is what turns "the tests failed" into "Postgres is not
 * up on 5432, run `docker compose up -d`".
 */
export async function detect(cwd = process.cwd(), env = process.env) {
  const pkg = readPackageJson(cwd);
  const scripts = pkg?.scripts ?? {};
  const pm = detectPackageManager(cwd);
  const run = (name) => `${pm} run ${name}`;
  /**
   * The form that can take EXTRA runner flags — `pnpm exec <script body> …`.
   *
   * `pnpm run <script> --reporter=json` does not work: pnpm has its own
   * `--reporter`, so it eats the flag and the JSON file is never written, while
   * the run still exits 0 and looks fine. Putting `--` in front instead gets the
   * separator forwarded to the runner as a positional test filter. Neither
   * failure is visible in the output — you just get no results file — so the
   * exec form is resolved here once rather than rediscovered per skill.
   */
  const exec = (name) => (scripts[name] ? `${pm} exec ${scripts[name]}` : null);

  const suites = {};

  // ── unit ────────────────────────────────────────────────────────────────
  const unitName = pickScript(scripts, ['test:unit', 'test:run', 'test:ci', 'unit', 'test']);
  suites.unit = {
    detected: Boolean(unitName),
    command: unitName ? run(unitName) : null,
    // Use this one when adding --reporter/--outputFile; see `exec` above.
    execCommand: unitName ? exec(unitName) : null,
    script: unitName,
    blockers: [],
    notes: [],
  };
  if (unitName && isWatchScript(scripts[unitName])) {
    suites.unit.notes.push(
      `"${unitName}" looks like watch mode and will not exit on its own — append \`--run\`.`,
    );
  }
  if (!unitName) suites.unit.blockers.push('no unit test script in package.json');

  // ── api / integration ───────────────────────────────────────────────────
  const apiName = pickScript(scripts, [
    'test:integration',
    'test:api',
    'test:server',
    'integration',
  ]);
  const port = dbPort(cwd, env);
  const compose = composeFile(cwd);
  suites.api = {
    detected: Boolean(apiName),
    command: apiName ? run(apiName) : null,
    execCommand: apiName ? exec(apiName) : null,
    script: apiName,
    blockers: [],
    notes: [],
    dbPort: port,
  };
  if (!apiName) {
    suites.api.blockers.push(
      'no integration/api test script in package.json (unit tests may already cover it)',
    );
  } else if (!(await probePort(port))) {
    suites.api.blockers.push(
      compose
        ? `nothing is listening on ${port} — start the database: \`docker compose -f ${compose} up -d\``
        : `nothing is listening on ${port} — the database these tests need is not running`,
    );
  }

  // ── e2e ─────────────────────────────────────────────────────────────────
  const e2eName = pickScript(scripts, ['test:e2e', 'e2e', 'playwright']);
  const pwConfig = playwrightConfig(cwd);
  const appPort = devPort(scripts, env);
  const appUp = await probePort(appPort);
  suites.e2e = {
    detected: Boolean(e2eName || pwConfig),
    command: e2eName ? run(e2eName) : pwConfig ? `${pm} exec playwright test` : null,
    execCommand: e2eName ? exec(e2eName) : pwConfig ? `${pm} exec playwright test` : null,
    script: e2eName,
    config: pwConfig,
    appPort,
    appUp,
    blockers: [],
    notes: [],
    // Playwright's own config usually starts the app (`webServer`), so an app
    // that is down is only a blocker when it does not.
    headedFlag: '--headed',
  };
  if (!e2eName && !pwConfig) suites.e2e.blockers.push('no Playwright config and no e2e script');
  if (suites.e2e.detected && !browsersInstalled(env)) {
    suites.e2e.blockers.push(
      `no Playwright browsers downloaded — run \`${pm} exec playwright install chromium\``,
    );
  }
  if (suites.e2e.detected && !appUp) {
    const managed = pwConfig && /webServer/.test(safeRead(join(cwd, pwConfig)));
    if (managed) {
      suites.e2e.notes.push(
        `nothing on ${appPort}, but ${pwConfig} declares a webServer — Playwright will start it.`,
      );
    } else {
      suites.e2e.blockers.push(
        `nothing is listening on ${appPort} — start the app first: \`${pm} run dev\``,
      );
    }
  }

  // ── uat ─────────────────────────────────────────────────────────────────
  // Not a spec suite: acceptance criteria driven through a browser by the
  // `uat-run` skill. It needs a running app and nothing else, which is exactly
  // why it is the one that demos anywhere.
  suites.uat = {
    detected: true,
    command: null,
    skill: 'uat-run',
    appPort,
    appUp,
    blockers: appUp
      ? []
      : [
          `nothing is listening on ${appPort} — start the app (\`${pm} run dev\`), ` +
            'or point the run at the right one with `--url=` / `PORT=`',
        ],
    notes: ['Driven by the `uat-run` skill against acceptance criteria, not by a spec file.'],
  };

  return { cwd, packageManager: pm, suites };
}

function safeRead(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Is `docker compose` even available? Named so a blocker can say so honestly. */
export function dockerAvailable() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function renderSummary(result) {
  const lines = [`Repo: ${result.cwd}`, `Package manager: ${result.packageManager}`, ''];
  for (const name of SUITES) {
    const s = result.suites[name];
    const state = !s.detected ? 'not configured' : s.blockers.length ? 'BLOCKED' : 'ready';
    lines.push(`${name.padEnd(5)} ${state.padEnd(14)} ${s.command ?? s.skill ?? ''}`);
    for (const b of s.blockers) lines.push(`      ! ${b}`);
    for (const n of s.notes) lines.push(`      · ${n}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const only = /--suite=([a-z]+)/.exec(process.argv.join(' '))?.[1];
  const result = await detect();
  if (only) {
    process.stdout.write(`${JSON.stringify(result.suites[only] ?? null, null, 2)}\n`);
  } else if (process.argv.includes('--summary')) {
    process.stdout.write(`${renderSummary(result)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
