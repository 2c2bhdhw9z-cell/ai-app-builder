# Audit findings and their status

`AUDIT-FINDINGS-2026-09-06.md` is an independent read-only audit of all three repos
(`plumby`, `ai-app-builder`, `agent-skills-lockin`). It found **3 Critical, 21 High,
30 Medium, 11 Low**, plus a section on tests that passed without proving much.

It previously existed only on a stray branch (`audit/independent-findings-2026-09-06`)
that was not merged anywhere, so nobody knew it existed. It is committed here so it
cannot be lost again. The branch has been deleted.

## Verified status

Checked against the running code, not inferred from commit messages.

### Critical — all 3 closed

| # | Finding | Evidence it is fixed |
|---|---|---|
| C1 | `plumby-web` bound `0.0.0.0` with **zero authentication** — unauthenticated RCE | `bin/plumby-web.js` now has `DEFAULT_HOST = '127.0.0.1'`; the router has auth checks |
| C2 | No Origin/Host check and content-type-blind body parse — drive-by CSRF from any website | Origin/Host/content-type handling present in `src/web/server.js` |
| C3 | A partial refinement **deleted the entire project tree** and reported success | `src/project/refinement.js` uses `persistPartial()`, which merges and never prunes. The code cites "audit C3" |

C3 was the worst: the audit proved it empirically — edit one line of one file in a
five-file project, four files gone, result `ok: true, persisted: true`. On a real
project that is the user's whole codebase.

### High — 21, substantially closed

Fixes are traceable in the code: 16 files in `ai-app-builder` and 2 in `plumby`
reference audit numbers, and there is a `fix(H18)` commit. Verified by inspection:
path containment on `grep`/`glob` (H1), child-env scrubbing (H6), the two
`authorize()` fail-opens (H7/H8), envelope AAD (H9, cited in code), session lifetime
bounds (H18).

The three `agent-skills-lockin` findings (H19–H21) are fixed **and** regression-tested:
`vendor-lockin-guard/tests/run-tests.sh` passes 36 tests and pins each one. All three
reproductions from the audit were re-run and now behave correctly — `--help` prints
usage and exits 0; a nonexistent path, a file-as-root and an invalid regex each exit 2
instead of reporting a green "0 high"; and a finding whose own text mentions `/dist/`
is no longer suppressed.

### Medium — partially open, not fully triaged

Two were verified as genuinely open and **fixed on 2026-09-13**:

- **M21** — `classifyCommand()` failed **open** on a non-string: `classifyCommand(42)`,
  `({})`, `(null)` and `(undefined)` all returned `allow`, bypassing every REFUSE and
  CONFIRM rule. Now refuses on a type error; a genuinely empty string still allows.
- **Redaction self-corruption** (adjacent to M14/H6) — `redactSecrets()` looped once
  per secret over its own rewritten output, so an emitted marker could itself be
  redacted when a secret's value was an ordinary identifier. Now a single-pass
  alternation. This was surfacing as a pre-existing failing test.

**The remaining Mediums and Lows have NOT been individually verified.** A grep-level
pass suggested several may still be open, including M1 (bash timeout orphans
grandchildren), M3 (`read_file` loads a whole file before capping), M13 (path
containment TOCTOU), M18 (`sessions` never evicted) and M19 (`close()` does not end
live SSE responses, so shutdown hangs). Those are heuristics, not confirmations —
treat the list as a to-do, not a status.

## Suggested next step

Work the audit's own §"Suggested fix order" from item 9 onward, and triage the
Medium list properly rather than by grep. The audit is specific about file and line
for every finding, so each is checkable in minutes.
