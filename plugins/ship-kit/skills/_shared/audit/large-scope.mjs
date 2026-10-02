// PR-level scope guard.
//   BLOCK  at >= 100 files OR >= 50 commits
//   WARN   at >=  50 files OR >= 20 commits
//
// The runner's PR-level demotion (`pr-audit: large-scope — <reason>` in a
// commit message) downgrades BLOCK to WARN; it can never silence the
// finding. The intent: large PRs are sometimes the right call, but they
// should always be visible to reviewers.

export const THRESHOLDS = {
  filesBlock: 100,
  filesWarn: 50,
  commitsBlock: 50,
  commitsWarn: 20,
};

export const check = {
  id: 'large-scope',
  run({ files, commits, addIssue }) {
    const fileCount = files.length;
    const commitCount = commits.length;

    const blocked = fileCount >= THRESHOLDS.filesBlock || commitCount >= THRESHOLDS.commitsBlock;
    const warned = fileCount >= THRESHOLDS.filesWarn || commitCount >= THRESHOLDS.commitsWarn;
    if (!blocked && !warned) return;

    const parts = [];
    if (fileCount >= THRESHOLDS.filesWarn) parts.push(`${fileCount} files`);
    if (commitCount >= THRESHOLDS.commitsWarn) parts.push(`${commitCount} commits`);

    addIssue({
      severity: blocked ? 'BLOCK' : 'WARN',
      checkId: 'large-scope',
      file: '(pr)',
      line: 0,
      message: `PR is large (${parts.join(', ')}). Consider splitting; if intentional, add \`pr-audit: large-scope — <reason>\` to a commit message to demote the block to a warning.`,
    });
  },
};
