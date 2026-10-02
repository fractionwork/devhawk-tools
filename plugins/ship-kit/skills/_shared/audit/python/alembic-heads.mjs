// Alembic revision-graph integrity.
//
// This is the analogue of the Drizzle journal check, and it is the single most
// likely thing to break a Python deploy when two people (or two agents) branch
// in parallel: both autogenerate a revision from the same `down_revision`, both
// merge, and the graph now has TWO heads. Nothing fails until deploy, when
// `alembic upgrade head` refuses with "Multiple head revisions are present" —
// after the image is built and the rollout has started.
//
// It is invisible in review, because each migration file looks perfectly
// correct on its own. Only the graph is wrong.
//
// Catches:
//   1. multiple heads (no revision points at them as down_revision)
//   2. a down_revision naming a revision that does not exist
//   3. two files declaring the same revision id
//   4. a version file with no parseable revision id
//
// Runs only when the diff touches migrations — which is when a collision can
// be introduced. Note it fires on the rebased branch, which is exactly where
// you want to learn about it: before the merge, not during the deploy.

import { readdirSync } from 'node:fs';

import { migrationsDir, touchesMigrations } from './_helpers.mjs';

// `revision: str = "abc123"` / `revision = 'abc123'`
const REVISION_RE = /^revision(?::[^=]+)?\s*=\s*['"]([^'"]+)['"]/m;
// `down_revision: str | None = "def456"` / `... = None`
const DOWN_RE = /^down_revision(?::[^=]+)?\s*=\s*(?:['"]([^'"]+)['"]|(None))/m;
// A merge revision carries a tuple: `down_revision = ("a", "b")`. That is the
// deliberate FIX for multiple heads — but only for the heads it actually names,
// so we parse them out. `[^)\]]` matches newlines, so a tuple the formatter
// wrapped across lines still reads.
const DOWN_TUPLE_RE = /^down_revision(?::[^=]+)?\s*=\s*[([]/m;
const DOWN_TUPLE_PARENTS_RE = /^down_revision(?::[^=]+)?\s*=\s*[([]([^)\]]*)[)\]]/m;

export function parseRevisions(fileNames, readFile, dir) {
  const nodes = [];
  for (const name of fileNames) {
    if (!name.endsWith('.py') || name.startsWith('__')) continue;
    const path = `${dir}/${name}`;
    const lines = readFile(path);
    if (!lines) continue;
    const content = lines.join('\n');

    const revision = REVISION_RE.exec(content)?.[1] ?? null;
    const isMerge = DOWN_TUPLE_RE.test(content);
    const down = isMerge ? null : (DOWN_RE.exec(content)?.[1] ?? null);
    const parents = isMerge
      ? [...(DOWN_TUPLE_PARENTS_RE.exec(content)?.[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map(
          (m) => m[1],
        )
      : [];
    nodes.push({ path, revision, down, isMerge, parents });
  }
  return nodes;
}

export function analyze(nodes) {
  const problems = [];
  const byRevision = new Map();

  for (const node of nodes) {
    if (node.revision === null) {
      problems.push({
        path: node.path,
        kind: 'unparseable',
        message:
          'No `revision = "..."` found in this Alembic version file. Alembic cannot place it in ' +
          'the graph, so it will be silently skipped by `upgrade head`.',
      });
      continue;
    }
    const existing = byRevision.get(node.revision);
    if (existing) {
      problems.push({
        path: node.path,
        kind: 'duplicate',
        message:
          `Revision id "${node.revision}" is already declared in ${existing.path}. ` +
          'Two files with the same id means one of them is unreachable — usually a copy-pasted ' +
          'migration. Generate a fresh revision instead of editing the id by hand.',
      });
      continue;
    }
    byRevision.set(node.revision, node);
  }

  const known = new Set(byRevision.keys());
  const referenced = new Set();

  for (const node of byRevision.values()) {
    // A merge names its parents in a tuple; each is as much a reference as a
    // plain `down_revision` is.
    for (const parent of node.parents ?? []) {
      referenced.add(parent);
      if (!known.has(parent)) {
        problems.push({
          path: node.path,
          kind: 'broken-chain',
          message:
            `Merge parent "${parent}" does not exist. The chain is broken, so ` +
            '`alembic upgrade head` cannot walk to this revision. Usually a migration was ' +
            'deleted or renamed without repointing the merge that joins it.',
        });
      }
    }

    if (node.down === null) continue; // base revision, or a merge
    referenced.add(node.down);
    if (!known.has(node.down)) {
      problems.push({
        path: node.path,
        kind: 'broken-chain',
        message:
          `down_revision "${node.down}" does not exist. The chain is broken, so ` +
          '`alembic upgrade head` cannot walk to this revision. Usually a migration was deleted ' +
          'or renamed without repointing its child.',
      });
    }
  }

  // A merge resolves THE HEADS IT NAMES, and nothing else. Treating the mere
  // presence of a merge as "the graph is being fixed" disabled this check
  // permanently: one `alembic merge` in history and multiple-heads was never
  // reported again, on a check whose whole point is that the graph is the only
  // thing that is wrong.
  const heads = [...byRevision.values()].filter((n) => !referenced.has(n.revision));

  if (heads.length > 1) {
    problems.push({
      path: heads[0].path,
      kind: 'multiple-heads',
      message:
        `Multiple head revisions: ${heads.map((h) => h.revision).join(', ')}. ` +
        '`alembic upgrade head` fails outright on this — and it fails at DEPLOY, after the image ' +
        'is built. Two branches almost certainly generated a revision from the same parent. ' +
        "Fix by rebasing and repointing the newer revision's down_revision at the other head, " +
        'or by generating a merge revision (`alembic merge -m "merge" <rev1> <rev2>`).',
    });
  }

  return problems;
}

export const check = {
  id: 'alembic-heads',
  // _readdir is injected by the unit tests; production uses node:fs.
  run({ files, readFile, addIssue, _readdir = readdirSync, _profile = undefined }) {
    if (!touchesMigrations(files, _profile)) return;

    const dir = migrationsDir(_profile);
    let names;
    try {
      names = _readdir(dir);
    } catch {
      // Migrations were touched but the directory is unreadable from the repo
      // root. Nothing useful to say; the other checks will notice.
      return;
    }

    for (const problem of analyze(parseRevisions(names, readFile, dir))) {
      addIssue({
        severity: 'BLOCK',
        checkId: 'alembic-heads',
        file: problem.path,
        line: 1,
        message: problem.message,
      });
    }
  },
};
