#!/usr/bin/env node
// Resolve the toolchain profile for the repository being worked on.
//
// ship-kit's skills used to say `pnpm typecheck` in prose. That is correct for a
// Next.js repo and wrong everywhere else, and prose cannot branch. A profile
// names the same VERBS (lint, typecheck, test, gate, db:migrate) and maps each
// to the command that stack actually uses, so one skill body serves every stack.
//
// Usage (from the root of the repository being worked on):
//   node <ship-kit>/skills/_shared/stack-profile.mjs            # human report
//   node <ship-kit>/skills/_shared/stack-profile.mjs --json     # full profile
//   node <ship-kit>/skills/_shared/stack-profile.mjs --id       # just the id
//   node <ship-kit>/skills/_shared/stack-profile.mjs --cmd lint # one command
//   node <ship-kit>/skills/_shared/stack-profile.mjs --env      # eval-able exports
//
//   --root <dir>       resolve against a directory other than cwd
//   --profile <id>     force a profile, skipping detection
//
// Resolution order, first hit wins:
//   1. --profile <id>            explicit override
//   2. .factory/profile.json     the project's own declaration
//   3. local inference           manifest files in the root (see inferId)
//   4. "ts-next"                 the historical default
//
// Step 4 is what makes this change safe to land: every repo that worked before
// this file existed still resolves to the exact commands it used before.
//
// NOTE ON INFERENCE — a sibling plugin ships a far better detector
// (`detect-stack.mjs`, ~450 lines, with evidence and confidence). We
// deliberately do NOT call it: it lives in a DIFFERENT plugin, and ship-kit is
// installable on its own. A hard dependency would make the whole card-to-merge
// loop fail on any machine that installed ship-kit without that plugin. So the
// inference here is intentionally tiny — enough to tell a Python repo from a
// JS one — and `.factory/profile.json` is the escape hatch for anything
// ambiguous.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STACKS_DIR = join(__dirname, 'stacks');
export const PROJECT_DECLARATION = join('.factory', 'profile.json');
export const DEFAULT_PROFILE_ID = 'ts-next';

/**
 * The verbs a profile must define to be usable.
 *
 * This exists because of a specific, silent failure: a resolved profile with no
 * `commands` yields an empty `$FACTORY_LINT`, and `eval ""` exits 0. pr-review
 * then records "Lint: passed" having run nothing at all — the gate reports
 * success precisely when it is most broken. A profile that cannot drive the
 * loop must fail loudly instead.
 */
export const REQUIRED_COMMANDS = ['install', 'lint', 'typecheck', 'test', 'gate'];

/** Which required verbs a profile is missing, or resolves to blank. */
export function missingCommands(profile) {
  return REQUIRED_COMMANDS.filter((key) => {
    const value = profile?.commands?.[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });
}

/** Every profile id shipped with the kit. */
export function availableIds(stacksDir = STACKS_DIR) {
  if (!existsSync(stacksDir)) return [];
  return readdirSync(stacksDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export function loadProfile(id, stacksDir = STACKS_DIR) {
  const path = join(stacksDir, `${id}.json`);
  if (!existsSync(path)) {
    const known = availableIds(stacksDir).join(', ') || '(none)';
    throw new Error(`Unknown stack profile "${id}". Available: ${known}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Minimal, deliberately shallow stack inference. See the note at the top of the
 * file for why this is not the sibling plugin's detector.
 *
 * Python is checked BEFORE JavaScript: a Python service commonly carries a
 * package.json for tooling (a docs site, a lint hook, biome), and treating that
 * as the primary stack would run `pnpm typecheck` on a FastAPI repo. A JS repo
 * essentially never carries a pyproject.toml declaring fastapi/django/flask.
 */
export function inferId(root = process.cwd(), { exists = existsSync, read = readJson } = {}) {
  const at = (p) => resolve(root, p);

  const pyproject = at('pyproject.toml');
  if (exists(pyproject)) return 'py-fastapi';
  if (exists(at('requirements.txt')) || exists(at('Pipfile')) || exists(at('manage.py'))) {
    return 'py-fastapi';
  }

  if (exists(at('package.json'))) return 'ts-next';

  // Nothing recognized. The caller falls back to the default rather than
  // guessing, so an unrecognized repo behaves exactly as it did before.
  void read;
  return null;
}

/**
 * Fold a profile's per-platform commands into `commands`.
 *
 * `py-fastapi` drives its gates through `make`, which is the right answer
 * everywhere it exists: the Makefile is the project's own definition of the
 * gate, and CI runs the same targets. Windows has no `make` and no package
 * manager that ships one by default, so every gate on a Python repo failed
 * there — and `pr-review` records a failed gate as a finding about the PR.
 *
 * The overrides are the Makefile's own recipes spelled out, so the gate stays
 * the same commands rather than a weaker Windows-only subset. A project's own
 * `.factory/profile.json` still wins over both: it is merged afterwards.
 */
export function forPlatform(profile, platform = process.platform) {
  const overrides = profile?.platformCommands?.[platform];
  if (!overrides) return profile;
  return { ...profile, commands: { ...(profile.commands ?? {}), ...overrides } };
}

/**
 * Resolve the active profile for `root`.
 *
 * A `.factory/profile.json` may either name a shipped profile:
 *     { "stack": "py-fastapi" }
 * or name one and override parts of it:
 *     { "stack": "py-fastapi", "commands": { "test": "make test-fast" } }
 * or declare a whole profile inline by carrying its own `commands` with no
 * `stack` key, for a project on something we don't ship.
 *
 * Overrides are merged one level deep per section, so a project overriding a
 * single command keeps the rest of the profile rather than having to restate it.
 */
export function resolveProfile({
  root = process.cwd(),
  id = null,
  stacksDir = STACKS_DIR,
  platform = process.platform,
} = {}) {
  const shipped = (profileId) => forPlatform(loadProfile(profileId, stacksDir), platform);

  if (id) return { ...shipped(id), source: 'override' };

  const declared = readJson(resolve(root, PROJECT_DECLARATION));
  // A declaration that names neither a `stack` to build on nor any `commands`
  // of its own declares nothing. Falling through to inference is strictly
  // better than honouring it: honouring it produced a command-less profile,
  // which is the silent-pass failure described at REQUIRED_COMMANDS.
  const declaresSomething =
    declared && (declared.stack || Object.keys(declared.commands ?? {}).length > 0);
  if (declaresSomething) {
    const base = declared.stack
      ? shipped(declared.stack)
      : { id: 'custom', language: 'unknown', commands: {}, paths: {} };
    return {
      ...base,
      ...declared,
      commands: { ...(base.commands ?? {}), ...(declared.commands ?? {}) },
      paths: { ...(base.paths ?? {}), ...(declared.paths ?? {}) },
      source: PROJECT_DECLARATION,
    };
  }

  const inferred = inferId(root);
  if (inferred) return { ...shipped(inferred), source: 'inferred' };

  return { ...shipped(DEFAULT_PROFILE_ID), source: 'default' };
}

// Memoized per-root, so the audit checks can call this per-file without
// re-reading the same JSON hundreds of times in a single run.
const cache = new Map();
export function activeProfile(root = process.cwd()) {
  if (!cache.has(root)) cache.set(root, resolveProfile({ root }));
  return cache.get(root);
}
export function clearProfileCache() {
  cache.clear();
}

/** `lint` -> `FACTORY_LINT`, `db:migrate:test` -> `FACTORY_DB_MIGRATE_TEST`. */
export function envVarName(key) {
  return `FACTORY_${key.replace(/[:.-]/g, '_').toUpperCase()}`;
}

/** Variables `--env` emits that describe the stack rather than name a command. */
export const NON_COMMAND_VARS = new Set([
  'FACTORY_STACK',
  'FACTORY_LANGUAGE',
  'FACTORY_MIGRATION_TOOL',
]);

/** Single-quoted for POSIX sh, with embedded quotes escaped. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command to substitute for a verb the profile does not define.
 *
 * Every skill invokes the resolver as `eval "$(… --env)"`, and command
 * substitution DISCARDS the child's exit status — so `process.exit(4)` here is
 * unreachable from the only call shape that exists. The guard has to travel
 * INSIDE the emitted script and fail in the caller's own shell.
 *
 * The one thing it must never be is the empty string: `eval ""` exits 0, and
 * pr-review then records "Lint: passed" having run nothing at all.
 */
function poison(label) {
  return (
    `printf '%s\\n' 'stack-profile: this repo defines no "${label}" command. ` +
    `Declare it in ${PROJECT_DECLARATION}.' >&2; exit 97`
  );
}

/**
 * Every `$FACTORY_*` command variable the shipped skills reference.
 *
 * Read off the skills themselves rather than restated here, so a skill that
 * starts using `$FACTORY_COVERAGE` gets a poisoned variable automatically
 * instead of an unset one. Best-effort: an unreadable skills directory just
 * means the optional verbs fall back to being unset, which is what they were
 * before this existed.
 */
export function skillCommandVars(skillsDir = join(__dirname, '..')) {
  const found = new Set();
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '_shared') continue;
    let text;
    try {
      text = readFileSync(join(skillsDir, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\$(FACTORY_[A-Z0-9_]+)/g)) {
      if (!NON_COMMAND_VARS.has(m[1])) found.add(m[1]);
    }
  }
  return found;
}

/**
 * The eval-able export script for a profile.
 *
 * `extraVars` names variables the skills reference that this profile may not
 * define; they are poisoned rather than left unset for the same reason as the
 * required verbs — an unset variable evaluates to the empty string.
 */
export function envScript(profile, { extraVars = [] } = {}) {
  const lines = [
    `export FACTORY_STACK=${shQuote(profile.id)}`,
    `export FACTORY_LANGUAGE=${shQuote(profile.language ?? 'unknown')}`,
  ];
  if (profile.migrationTool) {
    lines.push(`export FACTORY_MIGRATION_TOOL=${shQuote(profile.migrationTool)}`);
  }

  const emitted = new Set();
  const emit = (name, command) => {
    if (emitted.has(name)) return;
    emitted.add(name);
    lines.push(`export ${name}=${shQuote(command)}`);
  };

  // Every verb a skill may reference is exported. A missing or blank one gets a
  // command that FAILS, never the empty string.
  for (const key of new Set([...REQUIRED_COMMANDS, ...Object.keys(profile.commands ?? {})])) {
    const value = profile.commands?.[key];
    emit(envVarName(key), typeof value === 'string' && value.trim() ? value : poison(key));
  }
  for (const name of extraVars) {
    if (!NON_COMMAND_VARS.has(name)) emit(name, poison(name));
  }
  return lines.join('\n');
}

function humanReport(profile) {
  const pad = (s) => String(s).padEnd(18);
  console.log(`Stack profile: ${profile.id}  (${profile.displayName ?? profile.language})`);
  console.log(`  resolved from   ${profile.source}`);
  console.log();
  for (const [key, value] of Object.entries(profile.commands ?? {})) {
    console.log(`  ${pad(key)} ${value}`);
  }
  if (profile.source === 'default') {
    console.log();
    console.log('  → Nothing recognized in this directory; using the default profile.');
    console.log(`    Declare the stack explicitly in ${PROJECT_DECLARATION} if that is wrong.`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };

  let profile;
  try {
    profile = resolveProfile({ root: flag('--root') ?? process.cwd(), id: flag('--profile') });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const missing = missingCommands(profile);
  const complain = () =>
    console.error(
      `Stack profile "${profile.id}" (from ${profile.source}) defines no ` +
        `${missing.join(', ')}.\n\n` +
        '  Emitting those as the empty string would make `eval ""` exit 0 —\n' +
        '  so every gate would report success without running. Each is exported\n' +
        '  as a command that fails loudly instead.\n\n' +
        `  Fix ${PROJECT_DECLARATION}: name a "stack" to inherit from, or define\n` +
        '  every command yourself.',
    );

  // --env goes FIRST, and emits even when the profile is incomplete. Every
  // caller writes `eval "$(… --env)"`, which discards our exit status: bailing
  // here would emit nothing, `eval ""` would exit 0, and the gates would report
  // success having run nothing — the exact failure this guard exists to stop.
  // The poisoned exports fail inside the caller's shell instead.
  if (args.includes('--env')) {
    process.stdout.write(`${envScript(profile, { extraVars: skillCommandVars() })}\n`);
    if (missing.length > 0) {
      complain();
      process.exit(4);
    }
    return;
  }

  // Every other path is read by a human or by a caller that can see the status.
  if (missing.length > 0) {
    complain();
    process.exit(4);
  }

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    return;
  }
  if (args.includes('--id')) {
    process.stdout.write(`${profile.id}\n`);
    return;
  }
  const cmdKey = flag('--cmd');
  if (cmdKey) {
    const cmd = profile.commands?.[cmdKey];
    if (!cmd) {
      console.error(`Profile "${profile.id}" defines no command "${cmdKey}".`);
      process.exit(3);
    }
    process.stdout.write(`${cmd}\n`);
    return;
  }
  humanReport(profile);
}

// CLI/library duality — realpathSync so the guard still fires under a symlink
// install, which is how install.sh wires the kit up.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) main();
