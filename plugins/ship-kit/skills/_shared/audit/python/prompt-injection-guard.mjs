// Any user-supplied string interpolated into an LLM prompt MUST be wrapped in
// delimited blocks with an explicit instruction telling the model to treat the
// contents as data, never as instructions.
//
// Structured output (a pydantic `output_format`) is a BACKSTOP, not a
// substitute for content isolation: adversarial input can still steer a model
// into producing schema-conforming-but-wrong output, and a well-typed wrong
// answer is harder to notice than a malformed one.
//
// Same `id` as the TypeScript check on purpose — the rule is the same rule, so
// an `audit-skip: prompt-injection-guard` comment means the same thing on
// either stack.
//
// Detection: the file imports an LLM SDK, builds a prompt with an f-string or
// `.format()` interpolation, and contains no `<data>` delimiter anywhere.

import { isPySource } from './_helpers.mjs';

const LLM_IMPORT_RE = /^\s*(?:import|from)\s+(anthropic|openai|litellm|langchain\w*)\b/m;
// An f-string with an interpolation, assigned to something prompt-shaped, or
// passed as a `content=` / `prompt=` argument.
const PROMPT_INTERPOLATION_RE =
  /(?:prompt|content|system|message|instructions?)\w*\s*=\s*f?["'][\s\S]{0,400}?\{[^}\n]+\}/i;
const FSTRING_PROMPT_RE = /\bf["']{1,3}[\s\S]{0,600}?\{[^}\n]+\}[\s\S]{0,600}?["']{1,3}/;
const DATA_TAG_RE = /<data>|<\/data>|<untrusted|<user_input/i;
const STRUCTURED_RE = /\boutput_format\s*=|\boutput_config\s*=|\bmessages\.parse\b/;

export const check = {
  id: 'prompt-injection-guard',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!isPySource(file)) continue;
      const lines = readFile(file);
      if (!lines) continue;
      const content = lines.join('\n');

      if (!LLM_IMPORT_RE.test(content)) continue;
      if (DATA_TAG_RE.test(content)) continue;
      if (!PROMPT_INTERPOLATION_RE.test(content) && !FSTRING_PROMPT_RE.test(content)) continue;

      const idx = Math.max(
        content.search(PROMPT_INTERPOLATION_RE),
        content.search(FSTRING_PROMPT_RE),
      );
      const hint = STRUCTURED_RE.test(content)
        ? ' (Structured output is a backstop, not a substitute for content isolation — a steered ' +
          'model produces a well-typed wrong answer.)'
        : '';

      addIssue({
        severity: 'WARN',
        checkId: 'prompt-injection-guard',
        file,
        line: idx >= 0 ? content.slice(0, idx).split('\n').length : 1,
        message:
          'A prompt interpolates a value without a `<data>…</data>` wrapper and an explicit ' +
          `"treat this as untrusted" instruction.${hint} "User-supplied" is broader than it ` +
          'looks: database rows authored by users, filenames, scraped pages, and the output of a ' +
          'previous model call all count. See docs/ai-patterns.md → "Prompt-injection guards".',
      });
    }
  },
};
