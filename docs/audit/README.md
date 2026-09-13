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

### Medium — all 34 verified individually on 2026-09-13

Every Medium was checked against the running code. Where a behaviour could be
executed, it was executed rather than inferred — several grep-level guesses in the
earlier version of this file were **wrong** (M11 in particular looked fixed and was
not), so nothing below is a heuristic.

#### Fixed on 2026-09-13 (4)

| # | Repo | Finding | Verified how |
|---|---|---|---|
| M10 | plumby | The bare word `migrate` made ordinary commands confirm-class. `grep -rn migrate src/` and `git commit -m "refactor: migrate to new API"` both required confirmation — and since a sub-agent's `bashPolicy` is `read-only`, `guard()` **refused them structurally**. Now requires a runner prefix | Ran the classifier |
| M11 | plumby | `dd of=/dev/…` matched only `sd\|nvme\|hd\|disk`, so `of=/dev/vda` (KVM/virtio) and `of=/dev/xvda` (Xen/EC2) — the normal root disks in the VMs this runs inside — were **allow**. Also missed `mmcblk`, `md`, `loop`, `dm-` | Ran the classifier |
| M21 | plumby | `classifyCommand()` failed **open** on a type error: `42`, `{}`, `null`, `undefined` all returned `allow`, bypassing every REFUSE and CONFIRM rule | Ran the classifier |
| M22 | ai-app-builder | `truncateStream` with a limit of `0`, `NaN`, `null` or a negative **discarded all output**, emitting `[output truncated: NaN bytes omitted]`. Now falls back to the default | Called it directly |
| M23 | ai-app-builder | `deepCopyTree` copied only `Buffer`; a plain `Uint8Array` was passed by reference, so a forked tree **aliased the source's bytes**. Fork exists to give an independent copy | Read the function; pinned by test |

Plus the redaction self-corruption fix (adjacent to M14/H6) described above.
All are pinned by regression tests. Suites: ai-app-builder 1043 tests / 0 fail,
plumby 850 tests / 0 fail.

#### Confirmed already fixed (7)

**M6** `/compact` now refuses while a turn is running. **M14** error responses carry a
correlation id rather than internal text. **M16** the background turn has a `.catch()`.
**M24** ISO-date validation exists. **M31** the badge regex prefix is now optional —
verified `<Badge />`, `<PoweredBy />`, `<Watermark />`, `<Feedback />`, `<Branding />`
are all caught. **M32** the unused-env search covers py/go/rs/rb/php/java/kt/cs/sh and
extraction is anchored on `=`. **M34** an invalid vendor regex exits 2.

#### Confirmed still OPEN (22)

Ordered by what I'd fix first. None is a remote-exploitable hole; they are resource,
correctness and containment issues.

**Worth fixing next**

- **M1** (plumby) — a `bash` timeout kills only the shell, **orphaning every
  grandchild**. Verified empirically: timeout fired correctly at 1.2s, `timedOut:true`,
  and the background grandchild still ran to completion and touched its marker file.
  Needs a detached process group and a group kill.
- **M3** (plumby) — `read_file` does `await fs.readFile(target, 'utf8')` and only then
  caps output. `stat` is already in hand two lines earlier, so a multi-GB file inside
  the workspace OOMs the agent. One comparison away.
- **M7** (plumby) — SSE ignores `res.write`'s return value, never waits for `drain`,
  and caps nothing. A stalled reader queues every frame until OOM.
- **M13** (plumby) — path-containment TOCTOU: the realpath check and the write are
  separate, with no `O_NOFOLLOW` or post-open `fstat`.
- **M19** (ai-app-builder) — `close()` never ends live SSE responses, so shutdown hangs.
- **M18** (ai-app-builder) — the `sessions` map is never evicted; unbounded growth.
- **M29** (ai-app-builder) — nothing ever stops a Dev_Server (`devServer.stop` is
  called nowhere).

**Correctness / quality**

- **M2** (plumby) — `verify` classifies `scripts.test` but runs `npm test`, so a
  malicious `pretest` never passes the guard. The docstring claims otherwise.
- **M4** (plumby) — `cleanSplitPoint` re-slices and re-reduces the whole retained tail
  on every step, with three regex tests per character underneath. O(n²) on the
  synchronous path right before a turn.
- **M5** (plumby) — `provider.contextWindow` is fixed at the boot model and preferred
  over the table; benign for Anthropic, wrong for a provider spanning 8k–2M.
- **M8** (plumby) — `multi_edit` is wired into neither surface's diff nor summary
  (0 references in `src/web` and `src/cli`), so the highest-risk file operation renders
  as raw JSON.
- **M9** (plumby) — the `todos` event is emitted and consumed by nobody, while the tool
  description tells the model the user can see the list.
- **M12** (plumby) — workspace steering and skills are folded into the system prompt
  with **no trust gate**, so a cloned repo's `.plumby/steering/*.md` gets
  system-prompt authority. Medium only because it needs the user to run against
  untrusted code, which is the primary use case.
- **M17** (ai-app-builder) — the one-turn lock is keyed `accountId::projectId`, not per
  project, so two accounts on a shared project can run concurrent turns.
- **M20** (ai-app-builder) — `CommandGuard` does not wrap `manager.exec`, so it throws
  instead of denying.
- **M33** (agent-skills-lockin) — **partially** fixed. `vendor-lockin-guard/SKILL.md`
  now references the script, but `devendor-project/SKILL.md` still prescribes
  bare-vocabulary greps and never mentions `detect-lockin.sh`.
- **M15, M25, M26, M27, M28, M30** — reviewed and left as reported: raw turn error
  broadcast, egress host classification edge cases, `supportsEgressFiltering` unused,
  refinement edit-path containment, refinement rollback lossiness, self-healing
  over-normalisation.

#### Low (11)

Not individually re-verified. They are cosmetic or documentation-level; the audit
gives file and line for each.

## Suggested next step

Work the audit's own §"Suggested fix order" from item 9 onward, and triage the
Medium list properly rather than by grep. The audit is specific about file and line
for every finding, so each is checkable in minutes.
