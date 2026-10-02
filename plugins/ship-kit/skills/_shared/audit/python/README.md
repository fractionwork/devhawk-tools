# Python PR-audit checks

Bundled checks for the `py-fastapi` stack profile, which points here via its `auditChecks` key. The
runner (`../../pr-audit.mjs`) needs no changes to use them — it loads every `*.mjs` here that
exports a `check = { id, run(ctx) }`, and a project's own `scripts/audit/*.mjs` still overrides a
bundled check by id.

Every check earns its place by catching something **ruff and pyright structurally cannot**. A rule a
linter already enforces does not belong here.

| id | Severity | Catches |
|---|---|---|
| `alembic-heads` | BLOCK | Multiple heads, a broken `down_revision` chain, duplicate revision ids, an unparseable version file |
| `alembic-destructive` | WARN / BLOCK | `drop_column` / `drop_table` / rename / narrowing type change with no expand-contract plan; BLOCK on a `nullable=False` column with no `server_default` |
| `alembic-default-flip` | WARN | `server_default` changed with neither a backfill nor a comment saying why old rows diverge |
| `layer-purity` | BLOCK | The domain layer reaching for I/O or the clock — re-run at PR time in case a hook was bypassed |
| `route-contract` | WARN | A route with no explicit `status_code=`; a bare `HTTPException` instead of a typed helper |
| `async-db-discipline` | BLOCK / WARN | Sync engine or sessionmaker; a `postgresql://` DSN that resolves to psycopg2; a `commit()` in the session dependency |
| `prompt-injection-guard` | WARN | A prompt interpolating a value with no `<data>` wrapper. Shares its id with the TypeScript check, so a suppression means the same thing on either stack |

## Notes for anyone adding one

**`alembic-heads` is the one that matters most.** It is the analogue of the Drizzle journal check and
the likeliest thing to break a deploy when two branches (or two agents) generate a revision from the
same parent. Each file looks correct on its own; only the graph is wrong, and nothing fails until
`alembic upgrade head` runs at deploy time.

**`layer-purity` shells out to the project's own `scripts/check_layer_purity.py`** rather than
reimplementing it. Two definitions of "pure" would drift, and the one in the repo is the one the
developer's hooks enforce. That script is stdlib-only by design, so a bare `python3` runs it with no
virtualenv — which matters because pr-audit runs in a fresh worktree.

**Strip comments and string literals before matching** (`stripNonCode` in `_helpers.mjs`). Otherwise
a docstring naming a rule is itself a finding, which teaches people to stop writing the docs. The
exception is anything that lives *inside* a literal — a DSN, a prompt — where you want the raw line.

**Prove the check fires.** Every check here has a test that plants the violation and asserts it is
reported, and a test that asserts it stays quiet on the correct shape. A checker that only ever
passes is indistinguishable from a broken one.
