// Any user-supplied string interpolated into an LLM prompt MUST be wrapped
// in `<data>…</data>` blocks with an explicit system-instruction guard
// telling the model to treat the contents as data, not instructions.
// generateObject with a Zod schema is a backstop, not a substitute for
// content isolation — adversarial input can still steer a model into
// producing schema-conforming-but-wrong output.
//
// Detection: file imports from `ai` or `@ai-sdk/*`, contains a template
// literal with at least one `${...}` interpolation passed to a generation
// call, and lacks `<data>` anywhere in the file.

import { isTsSource } from './_helpers.mjs';

const AI_IMPORT_RE = /from\s+['"]ai['"]|from\s+['"]@ai-sdk\//;
const PROMPT_INTERPOLATION_RE = /prompt:\s*`[^`]*\$\{[^}]+\}[^`]*`/;
const DATA_TAG_RE = /<data>/;
const SCHEMA_VAR_RE = /\b(z\.object|zodSchema)\b/;

export const check = {
  id: 'prompt-injection-guard',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!isTsSource(file)) continue;
      const lines = readFile(file);
      if (!lines) continue;
      const content = lines.join('\n');

      if (!AI_IMPORT_RE.test(content)) continue;
      if (!PROMPT_INTERPOLATION_RE.test(content)) continue;
      if (DATA_TAG_RE.test(content)) continue;

      const idx = content.search(PROMPT_INTERPOLATION_RE);
      const line = idx >= 0 ? content.slice(0, idx).split('\n').length : 1;

      const hint = SCHEMA_VAR_RE.test(content)
        ? ' (Zod schema is a backstop, not a substitute for content isolation.)'
        : '';

      addIssue({
        severity: 'WARN',
        checkId: 'prompt-injection-guard',
        file,
        line,
        message: `Prompt interpolates user-controlled input without a \`<data>…</data>\` wrapper + system-instruction guard.${hint} See docs/ai-patterns.md → "Prompt-injection guards".`,
      });
    }
  },
};
