// Shared helpers for the convention-style checks.

import { activeProfile } from '../stack-profile.mjs';

// The ts-next answer, and the fallback whenever a profile cannot be resolved.
// A convention check must never crash the whole audit run because profile
// resolution failed, so every path through this file degrades to these.
const DEFAULT_EXCLUDES = [
  'tests/',
  'lib/db/migrations/meta/',
  'node_modules/',
  '.next/',
  'playwright-report/',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a leading-anchor regex from a list of path prefixes.
 *
 * An empty list must match NOTHING. The obvious construction, `^()`, matches
 * the empty string at position 0 of every path — so `isAppFile` returned false
 * for every file and every convention check silently inspected nothing. A check
 * that quietly stops looking is the failure mode this whole kit is built to
 * avoid, so it must not be one regex away.
 */
export function excludeRegex(prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return /(?!)/;
  return new RegExp(`^(${prefixes.map(escapeRe).join('|')})`);
}

// Kept as a named export because it was one before this file learned about
// profiles, and because it is still exactly the ts-next answer.
export const TEST_OR_GENERATED_RE = excludeRegex(DEFAULT_EXCLUDES);

function excludesFor(profile) {
  try {
    const p = profile ?? activeProfile();
    const list = p?.paths?.excludeFromConventionChecks;
    // An explicit `[]` means "exclude nothing" and is honoured. Previously a
    // length check silently replaced it with the TypeScript defaults, so a
    // project that deliberately opted out of exclusions got someone else's.
    return Array.isArray(list) ? list : DEFAULT_EXCLUDES;
  } catch {
    return DEFAULT_EXCLUDES;
  }
}

// Most convention checks apply to app code, not test code. Tests legitimately
// stub Server Actions, set status fields directly, and inline mock prompts.
//
// `profile` is optional: the checks call this with one argument and get the
// active profile for the repo being audited. Passing one explicitly is what the
// unit tests do, so they never depend on the cwd they happen to run in.
export function isAppFile(path, profile) {
  return !excludeRegex(excludesFor(profile)).test(path);
}

// Detect a file-level `"use server"` directive: the first non-blank,
// non-comment statement of the file. Function-level "use server" inside a
// function body doesn't trigger the Next.js export restriction, so we
// deliberately do not match it.
const USE_SERVER_RE = /^['"]use server['"]\s*;?\s*$/;

export function fileLevelUseServer(lines) {
  if (!lines) return false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('//')) continue;
    if (t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) continue;
    return USE_SERVER_RE.test(t);
  }
  return false;
}

// Conservative "is this a TypeScript source file we care about" filter. Stays
// TypeScript-specific on purpose: the checks that call it are Next.js checks,
// and a Python repo resolves `auditChecks` to a different directory entirely
// rather than running these against .py files.
export function isTsSource(path, profile) {
  return /\.(ts|tsx|mts|cts)$/.test(path) && isAppFile(path, profile);
}

// Stack-neutral equivalent, for checks that are not TypeScript-specific: takes
// the extensions from the active profile.
export function isSourceFile(path, profile) {
  const p = (() => {
    try {
      return profile ?? activeProfile();
    } catch {
      return null;
    }
  })();
  const exts = p?.paths?.sourceExtensions ?? ['.ts', '.tsx', '.mts', '.cts'];
  return exts.some((ext) => path.endsWith(ext)) && isAppFile(path, p ?? undefined);
}
