#!/usr/bin/env node
// pr-watch-fetch.mjs — one tick's input: every open PR, with its review threads.
//
//   node pr-watch-fetch.mjs [--limit 50]   # a JSON array on stdout
//
// Prints a compact JSON array — `[]` exactly when the repo has no open PR — and
// exits non-zero if it could not build a COMPLETE picture. That last part is the
// whole point of the file: a watcher that silently lists fewer PRs than exist
// looks exactly like a watcher with nothing to report.
//
// WHY THIS EXISTS. This was a bash pipeline of eleven `jq` invocations in
// pr-watch/SKILL.md. jq is not installed on native Windows — Git Bash does not
// carry it — so the tick died on its first line there. `gh --jq` is no help: it
// filters one response, and the shape here is a join of one listing with one
// GraphQL call per PR. Node is already required by every kit, so the join moved
// here and the skill now runs two commands.
//
// The assertions the pipeline carried are kept, because each marks a way this
// has actually reported "0 open" on a repo with nine open PRs:
//   - a PR whose thread lookup fails is DROPPED, never emitted with zero threads
//   - a PR with more than one page of threads is DROPPED, for the same reason
//   - and dropping anything then aborts the whole tick, rather than ticking on
//     a partial set

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The listing fields `pr-watch-state.mjs` fingerprints a PR from. */
export const LIST_FIELDS =
  'number,title,url,isDraft,headRefOid,reviewDecision,mergeable,statusCheckRollup';

export const DEFAULT_LIMIT = 50;

/** One page of threads. A PR past this is dropped rather than half-read. */
export const THREAD_PAGE = 100;

/**
 * Review threads come from GraphQL, not `--json reviewThreads`: that field does
 * not exist on `gh pr view` (checked on gh 2.65 and 2.90) and answers `Unknown
 * JSON field`.
 */
export function threadsQuery(owner, name, number) {
  return `{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${number}){reviewThreads(first:${THREAD_PAGE}){totalCount nodes{isResolved}}}}}`;
}

/**
 * Attach review threads to each PR. PURE given `fetchThreads`, which is the
 * only part that talks to GitHub.
 *
 * A dropped PR is reported on `log` and simply missing from the result; the
 * caller compares counts and aborts. Drafts are skipped at plan time anyway, so
 * they get an empty thread list without an API call.
 */
export function augment(prs, fetchThreads, log = (m) => process.stderr.write(`${m}\n`)) {
  const out = [];
  for (const pr of prs) {
    if (pr.isDraft) {
      out.push({ ...pr, reviewThreads: { totalCount: 0, nodes: [] } });
      continue;
    }
    let threads;
    try {
      threads = fetchThreads(pr.number);
    } catch (err) {
      log(`[pr-watch] review-thread lookup FAILED for #${pr.number}: ${err?.message ?? err}`);
      continue;
    }
    if (!threads || !Array.isArray(threads.nodes)) {
      log(`[pr-watch] review-thread lookup FAILED for #${pr.number}`);
      continue;
    }
    // `totalCount` is the whole count, so a short `nodes` means we are looking
    // at a partial picture — and unresolved threads past the page boundary
    // would vanish, classifying the PR READY.
    if (threads.totalCount > threads.nodes.length) {
      log(
        `[pr-watch] #${pr.number}: ${threads.totalCount} review threads exceeds one page of ${THREAD_PAGE}`,
      );
      continue;
    }
    out.push({ ...pr, reviewThreads: threads });
  }
  return out;
}

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function main(argv = process.argv.slice(2), { run = gh, log, out } = {}) {
  const write = out ?? ((s) => process.stdout.write(s));
  const say = log ?? ((m) => process.stderr.write(`${m}\n`));
  const i = argv.indexOf('--limit');
  const limit = i >= 0 ? Number(argv[i + 1]) : DEFAULT_LIMIT;

  const prs = JSON.parse(
    run(['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', LIST_FIELDS]),
  );
  if (prs.length === 0) {
    write('[]\n');
    return 0;
  }
  // The listing is one page. Hitting the cap means there may be open PRs the
  // watcher never sees — say so rather than quietly watching the first 50.
  if (prs.length >= limit) {
    say(`[pr-watch] WARNING: listing hit the --limit ${limit} cap; PRs beyond it are unwatched.`);
  }

  const nwo = run(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const [owner, name] = nwo.split('/');

  const augmented = augment(
    prs,
    (number) =>
      JSON.parse(
        run([
          'api',
          'graphql',
          '-f',
          `query=${threadsQuery(owner, name, number)}`,
          '--jq',
          '.data.repository.pullRequest.reviewThreads',
        ]),
      ),
    say,
  );

  if (augmented.length !== prs.length) {
    say(`[pr-watch] ABORT: listed ${prs.length} open PRs but only augmented ${augmented.length}.`);
    say(
      "[pr-watch] Refusing to tick on a partial set — a short list reads as 'nothing to report'.",
    );
    return 1;
  }

  write(`${JSON.stringify(augmented)}\n`);
  return 0;
}

// CLI/library duality. `import.meta.url === \`file://${process.argv[1]}\`` is
// the version that never matches on Windows, where argv[1] is `D:\a\...`.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main());
}
