// FastAPI route contract, per docs/conventions.md → "Errors".
//
// Two rules no linter checks, because both are about what the API PROMISES
// rather than whether the code runs:
//
//   1. Every route declares an explicit `status_code=`. Without it FastAPI
//      infers 200 (or 201 for POST in some setups), and the OpenAPI schema
//      then documents a status the handler may never return.
//   2. Handlers raise the project's typed error helpers, not a bare
//      `HTTPException(404, "not found")`. A client cannot branch on prose, and
//      "detail": "not found" says nothing about WHAT was not found.

import { isPySource, statementAt, stripNonCodeLines } from './_helpers.mjs';

const ROUTE_DECORATOR_RE = /^\s*@\w+\.(get|post|put|patch|delete|head|options)\s*\(/;
const STATUS_CODE_RE = /\bstatus_code\s*=/;
const BARE_RAISE_RE = /\braise\s+HTTPException\s*\(/;

// Only routers make API promises, so the status_code rule is gated on this.
// The bare-`HTTPException` rule deliberately is NOT: a service or repository
// raising one loses the machine-readable `ErrorCode` just as a router does, and
// is the worse smell of the two. It fires in every application module.
function isRouter(path) {
  return /(^|\/)routers?\//.test(path);
}

export const check = {
  id: 'route-contract',
  run({ files, readFile, addIssue }) {
    for (const file of files) {
      if (!isPySource(file)) continue;
      const lines = readFile(file);
      if (!lines) continue;
      const code = stripNonCodeLines(lines);

      for (let i = 0; i < code.length; i++) {
        if (BARE_RAISE_RE.test(code[i])) {
          addIssue({
            severity: 'WARN',
            checkId: 'route-contract',
            file,
            line: i + 1,
            message:
              'Bare `HTTPException` — raise a typed helper from `errors.py` instead, so the ' +
              'response carries a machine-readable `ErrorCode`. A client cannot branch on prose. ' +
              'See docs/conventions.md → "Errors".',
          });
        }

        if (!isRouter(file) || !ROUTE_DECORATOR_RE.test(code[i])) continue;

        // The decorator's arguments routinely wrap across lines; read to the
        // closing paren (bounded, so a malformed file cannot run away).
        const decorator = statementAt(code, i, 25);

        if (!STATUS_CODE_RE.test(decorator)) {
          addIssue({
            severity: 'WARN',
            checkId: 'route-contract',
            file,
            line: i + 1,
            message:
              'Route has no explicit `status_code=`. FastAPI will infer one, and the OpenAPI ' +
              'schema then documents a status this handler may never return — the schema is ' +
              'supposed to BE the contract. Declare it, plus a `responses={}` entry for each ' +
              'non-200 the handler can produce.',
          });
        }
      }
    }
  },
};
