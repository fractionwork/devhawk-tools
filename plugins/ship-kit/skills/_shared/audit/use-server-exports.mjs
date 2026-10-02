// A file declaring file-level `"use server"` may only export async functions.
// `export type`, `export interface`, `export const X = ...`, `export class`,
// and `export enum` all crash production builds at page-data collection time
// with an opaque error message. tsc and lint don't catch it.
//
// This check is regex-based and intentionally only inspects column-0 exports
// (top-level). Exports nested inside namespaces or functions are out of scope.

import { fileLevelUseServer, isTsSource } from './_helpers.mjs';

const BANNED_TYPE_RE = /^export\s+(type|interface|class|enum)\b/;
// Top-level `export const|let|var foo = ...` where the right-hand side does
// NOT start with the word `async`. The lookahead must absorb whitespace
// itself — making the preceding `\s*` greedy isn't enough; the engine
// backtracks to zero and then the lookahead succeeds against the leading
// space, falsely flagging `export const x = async () => ...`.
const BANNED_CONST_RE = /^export\s+(const|let|var)\s+\w+\s*=(?!\s*async\b)/;

export const check = {
  id: 'use-server-exports',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!isTsSource(file)) continue;
      const lines = readFile(file);
      if (!lines || !fileLevelUseServer(lines)) continue;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (BANNED_TYPE_RE.test(line) || BANNED_CONST_RE.test(line)) {
          addIssue({
            severity: 'BLOCK',
            checkId: 'use-server-exports',
            file,
            line: i + 1,
            message:
              'File has `"use server"` directive but exports a non-async value. ' +
              'Next.js rejects this at production build with an opaque error. ' +
              'Move shared types/constants to a plain module and import them in.',
          });
        }
      }
    }
  },
};
