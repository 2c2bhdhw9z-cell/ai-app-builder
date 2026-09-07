---
name: devendor-project
description: Find and remove vendor, platform, or scaffolding lock-in from a codebase — telemetry beacons, injected badges, auth wrappers, hardcoded vendor hosts, and especially lint or convention rules that fail the build when vendor code is removed. Use when a user wants to own their code, escape a platform, remove a template's coupling, stop an app phoning home, or says they feel locked in, locked out, or trapped by a service.
license: MIT
metadata:
  version: "1.0.0"
  origin: Derived from a real de-vendoring of a scaffolded monorepo; see references/case-study.md
---

# De-vendor a project

Remove a vendor's grip on a codebase without breaking it, and leave the project genuinely portable.

## The central insight

**Lock-in is rarely just dependencies. The dependencies are the easy part.**

Real lock-in has an *enforcement layer* — machinery that makes removal fail. In the case this skill
was built from, three lint rules existed whose only purpose was to fail the build if vendor code was
deleted. A developer who tried to remove the tracking beacon would see their build break and conclude
it was load-bearing. It was not. It was guarded.

So the order of work is: **find the enforcement first, then the code.** If you remove code before
neutralising what enforces it, you will fight your own tooling and conclude the coupling is
structural when it is merely defended.

## Phase 0 — Before you touch anything

1. **Work on a branch. Never `main`.** State this to the user explicitly and confirm `main` is untouched at the end.
2. **Capture a baseline.** Run the project's full verification set and record the results:
   ```
   lint / typecheck / test / build
   ```
   Write down what *already* fails. You need this, or you will be blamed for pre-existing failures —
   and you will not be able to tell your own regressions from the project's existing state.

   **A baseline is only valid for the branch it was measured on.** Measure it yourself on the branch
   you are working from. Never inherit one from a document; the document may have been written from a
   different branch, and then you will spend hours on a failure that was never yours.
3. **Identify what is currently running.** If a deployed preview, published build, or cached client
   exists, establish whether your changes can reach it. Usually they cannot — a published artifact is
   a snapshot. Say so plainly, because a user mid-project is often frightened of losing the one
   working thing they have.

### STOP — three questions that can make removal destructive

Ask these *before* deleting anything. Each one is a case where correct-looking code removal causes
real, sometimes unrecoverable damage.

**Does the vendor hold data you need?** If user records, uploads, analytics history or configuration
live in the vendor's system, **exporting that data is a prerequisite project, not part of this one.**
Removing the integration first can strand the data behind an account you then have no reason to keep
paying for. Tell the user plainly: *"there is data in their system; getting it out comes first, and it
is separate work."*

**Does the vendor serve live traffic?** If they host the frontend, terminate TLS, or run the API
gateway, then deleting the vendor project **before** repointing DNS causes a hard outage that lasts
until propagation. See "Reclaim the edge" below.

**Do users authenticate through the vendor?** Then removal is a user-facing migration, not a
refactor. Every user's identity may need re-minting. Scope it as its own project — see
`references/discovery-checklist.md` §8.

If the answer to any of these is yes, **say so and stop.** Removing the code is the last step of that
larger job, not the first.

## Phase 1 — Discovery

Cast a wide net. Vendor names appear in places grep-for-source misses.

```bash
# 1. The vendor's own name, everywhere, including config and docs
grep -rniE 'vendorname|vendor-cli|@vendor/' \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' \
  --include='*.mjs' --include='*.cjs' --include='*.md' --include='*.yml' \
  --include='*.yaml' --include='*.toml' --include='*.template' . \
  | grep -v node_modules | grep -v '\.lock'

# 2. Dependencies (all manifests in a monorepo, not just the root)
grep -rn '"@vendor\|vendor-sdk\|vendor-runtime' */package.json package.json

# 3. Telemetry and phone-home, by behaviour rather than by name
grep -rniE 'analytics|telemetry|beacon|collector|track\(|sentry|posthog|amplitude|mixpanel|segment' \
  --include='*.ts' --include='*.tsx' . | grep -v node_modules

# 4. Hardcoded vendor hosts and endpoints
grep -rnE 'https?://[a-z0-9.-]*(vendor|preview|sandbox|gateway)[a-z0-9.-]*' \
  --include='*.ts' --include='*.tsx' --include='*.json' . | grep -v node_modules

# 5. Env cruft: declared, never read
#    For each var in the template, check whether any source file reads it.
grep -oE '^[A-Z_]+' .env.template 2>/dev/null | while read -r v; do
  n=$(grep -rl "$v" --include='*.ts' --include='*.tsx' . 2>/dev/null | grep -vc node_modules)
  [ "$n" -eq 0 ] && echo "UNUSED: $v"
done
```

**Do not stop at the first vendor name you find.** In the reference case the user asked about AI
providers; a search for those returned nothing, and the real coupling was under a *platform* name
nobody had mentioned. Ask: "what scaffolded this project?" and search for that too. Check
`README`, `package.json` `name` fields, lockfile registry URLs, `.gitignore` comments, and any
directory whose name you do not recognise.

### Classify every hit

Do not treat all coupling the same. Sort into:

| Class | Example | Removal risk |
|---|---|---|
| **Telemetry** | Provider wrapping the app root, beaconing on launch | Low. Usually a wrapper you can unwrap. |
| **Injected UI** | "Made with X" badge, feedback widget | Low. Delete the component. |
| **Dead config** | Unused env vars, empty placeholders | None. |
| **Dead hosts** | Hardcoded preview URL that 502s | Low, but check what reads it. |
| **Identity** | Vendor name in bundle IDs, URL schemes, package names | Medium. Affects store listings and installed clients. |
| **Wrappers** | Vendor SDK wrapping a platform capability (deep links, auth, storage) | **High.** Needs a native replacement written. |
| **Enforcement** | Lint/convention rules requiring vendor imports; hash-protected files | Medium, and must be handled *first*. |

## Phase 2 — Neutralise the enforcement layer

Look for these specifically. They are the reason people believe they cannot leave.

**A. Convention or lint rules requiring vendor imports.** Search the project's own lint/convention
config for the vendor name:

```bash
grep -rn -i 'vendor' *.json .*rc* eslint* 2>/dev/null | grep -v node_modules
```

Signals: a rule named like `keeps-*-runtime`, `*-must-import-*`, `template-managed-files-exist`, or
any rule whose `must.importFrom` or `must.haveFiles` names vendor paths. These are removable. Note
how many rules exist before and after so you can report the change honestly.

**B. Hash-protected "template-managed" files.** A manifest of checksums plus a lint rule that fails
when a file's hash drifts. Convention is often a `__` filename prefix.

```bash
find . -name '*protected*' -o -name '*manifest*.json' | grep -v node_modules
```

If you must edit one, **recompute its hash and update the manifest** — and tell the user you did,
framing it as a deliberate act of ownership. Do not silently defeat a safety mechanism.

```bash
node -e 'const fs=require("fs"),c=require("crypto");
const f="path/to/__file.ts";
console.log(c.createHash("sha256").update(fs.readFileSync(f)).digest("hex"));'
```

**C. Comments that assert necessity.** Grep for imperative comments:

```bash
grep -rn -i 'do not remove\|required for\|must stay\|do not edit\|template-managed' \
  --include='*.ts' --include='*.tsx' . | grep -v node_modules
```

Treat these as claims to verify, not facts. In the reference case a comment read *"required for
analytics tracking"* above a provider that was not required for anything the product did.

## Phase 3 — Removal, in dependency order

Work inside-out: usage, then dependency, then enforcement, then manifest.

1. **Remove the usage.** Unwrap providers, delete injected components, drop the import.
2. **Write native replacements for wrappers *before* deleting them.** See "Replacement patterns" below.
3. **Remove the dependency** from every manifest that declares it.
4. **Relax the enforcement rules** you catalogued in Phase 2.
5. **Update protection manifests** for any hash-guarded file you touched.
6. **Delete dead config** — unused env vars, dead hosts.
7. **Re-sync the lockfile** (`bun install` / `npm install` / etc.).
8. **Verify after each step, not at the end.** If something breaks you want to know which step did it.

### One rule that will save you

**Dead code is not automatically removable code.** Verify what it *would* do before deleting it.

In the reference project, a fully written, documented, tested fixed-point-math module was unused by
the simulation — textbook dead code. It was also the **correct implementation of a property the
project claimed to have and did not.** Deleting it would have destroyed the fix for the codebase's
most serious bug. The right action was to *wire it in*.

Ask of every dead thing: is this abandoned, or is this the solution nobody connected?

## Replacement patterns for wrappers

Vendor wrappers usually wrap something the platform already does. Common cases:

**Deep links / custom URL schemes.** Vendors wrap this to route auth through their service. Native
form (Electron shown; the shape is the same elsewhere):

- Register the scheme yourself (`app.setAsDefaultProtocolClient("yourscheme")`).
- Handle the platform's delivery mechanisms — macOS sends an event (`open-url`); Windows and Linux
  pass it in `argv`, both for a cold start and for a second instance.
- Enforce single-instance and forward the URL to the window.
- Rename the scheme off the vendor's branding while you are there.

**Open-in-browser.** Wrappers hide a security check. When you reimplement it, **keep the check**:
parse the URL and reject anything that is not `http:`/`https:`. Without it, a renderer can pass
`file://` and have the OS open a local executable. This is the whole security boundary.

**Analytics.** Do not replace it. Delete it, and if the product has a user-facing telemetry
preference, note whether the vendor provider honoured it. In the reference case the save format had
`telemetryOptIn` defaulting to **false** while the provider reported on every launch regardless —
making the user's setting cosmetic and any privacy declaration built on it false.

**Managed auth / storage / config.** These are the genuinely hard ones. Establish what the product
actually needs before rebuilding. Often the answer is "nothing" — the wrapper served the platform's
needs, not the product's.

## Phase 3b — Credentials, and the edge

Two steps that are not code changes, and are the ones most often skipped.

### Revoke, do not merely delete

**Removing a key from `.env` does not invalidate it.** The credential remains live at the vendor until
somebody revokes it there. And if it was *ever committed*, it is permanently in the history of every
clone, fork, CI cache and mirror.

```bash
# Was a credential ever committed?
git log --all --diff-filter=AM --name-only -- '*.env*' | head
git log -p --all -S 'VENDOR_API_KEY' --oneline 2>/dev/null | head
```

Report every credential you find and **who must revoke it**. You usually cannot do it yourself, since
it requires the vendor's dashboard.

> **Never rewrite git history unilaterally.** Tools like `git filter-repo` and `filter-branch` are
> destructive: they change every commit hash, break every open branch and PR, and require force-pushing
> over shared history. If secrets are in history, **explain the tradeoff and let the user decide.** For
> a private repo, revoking the credential is usually sufficient and far safer. Scrubbing history is for
> the case where the repository is or will become public — and even then it is the user's call, not
> yours.

### Reclaim the edge before you delete anything

If the vendor hosted the frontend, managed DNS, terminated TLS, or ran an API gateway, the order is
**not** negotiable:

1. Stand up the replacement and verify it serves correctly on a temporary hostname.
2. Repoint DNS — CNAME, A, ALIAS — at the new infrastructure.
3. Wait for propagation and confirm from an independent network.
4. Verify TLS is valid on the new host, since the certificate may have been vendor-managed.
5. **Only then** delete the vendor project.

Delete first and the domain hard-fails until DNS propagates, which can be hours. Also re-register
anything that lives in *other people's* dashboards: third-party webhook URLs and OAuth redirect URIs
pointing at vendor hosts.

## Phase 4 — Verification gates

Everything must be at least as green as your Phase 0 baseline.

```
lint          — must be clean, or exactly as dirty as the baseline
typecheck     — every package
tests         — full suite; compare failures to the baseline list
build         — the real production build, per target
runtime smoke — start it; confirm the app boots and a core action works
```

**Then verify the removal actually happened — statically:**

```bash
# Only comments should remain
grep -rniE 'vendorname|@vendor/' --include='*.ts' --include='*.tsx' --include='*.json' . \
  | grep -v node_modules | grep -v '\.lock'
```

Explanatory comments that say "this used to come from X, here is why it does not now" are correct to
leave. They stop someone re-adding it.

Then run the exhaustive sweep in `references/discovery-checklist.md`, because source greps miss
lockfiles, hidden directories, build config, CI workflows and generated config files.

**And then verify it empirically, because grep cannot prove a runtime call is gone.** A removed import
does not guarantee a removed request: a transitive dependency, a build plugin, or an injected script
can still phone home. Watch the actual traffic during a normal user flow:

| Platform | How |
|---|---|
| Web | DevTools → Network, filter by the vendor's domain. Reload and exercise a real flow. |
| Node / server | `NODE_DEBUG=http,net`, or a local proxy via `HTTP_PROXY`/`HTTPS_PROXY` |
| Mobile | Proxy the device (mitmproxy, Charles) with the CA trusted — fiddly but decisive |
| Any | Block the vendor's hosts at DNS or firewall level and confirm nothing breaks or retries |

The last row is the cheapest and often the best: **if blocking the vendor changes nothing, the coupling
is genuinely gone.** If something hangs, retries, or logs an error, you have found a call site the grep
missed.

State which method you used. "No vendor imports remain" and "the app makes no vendor requests" are
different claims, and only the second one is what the user actually wants.

## Phase 5 — Report honestly

State, in this order:

1. **What was found**, by class, with file:line evidence.
2. **What each thing was actually doing** — especially anything that phoned home, and how often.
3. **What changed**, including how many enforcement rules were removed.
4. **Verification results** versus the baseline, naming any pre-existing failure so it is not
   mistaken for yours.
5. **What was deliberately left**, and why.
6. **Anything with product consequences** — changed bundle IDs affect store listings; changed URL
   schemes break existing deep links; removed analytics changes what a privacy policy should say.

If you also **fixed something that was already broken**, say so separately. Do not let it hide
inside the de-vendoring work.

## What not to do

- **Do not remove a vendor's identity strings from a shipped app without flagging it.** Bundle IDs
  and package names are identity to app stores. Changing them pre-launch is free; post-launch it is a
  new app.
- **Do not touch unrelated code.** A de-vendoring diff should be reviewable. Resist tidying.
- **Do not delete a protection manifest** to make a lint rule pass. Update the specific entry.
- **Do not assume the vendor's hosting is coming back.** If a preview host is dead, the project needs
  a path that does not depend on it. Removing the reference is not the same as restoring the
  capability — say which you did.
- **Do not claim a property you have not measured.** If you remove a beacon, do not say "the app no
  longer makes network calls" unless you checked every call site.

## Working outside this skill's assumptions

Written to be usable by any agent, in any stack. The examples lean JavaScript because that is where it
was first exercised; the *method* does not.

- **Do not assume a package manager.** Detect it — a lockfile name tells you (`package-lock.json` npm,
  `yarn.lock` yarn, `pnpm-lock.yaml` pnpm, `bun.lock`/`bun.lockb` bun) — then use that one. Never run
  `npm install` in a bun project; it will produce a second lockfile and a different tree.
- **Translate, do not skip.** Every phase has an equivalent elsewhere: Python has
  `pyproject.toml`/`requirements.txt` and `pip-audit`; Go has `go.mod` and `go mod why`; Rust has
  `Cargo.toml` and `cargo tree`; JVM has Gradle/Maven dependency trees. Vendor-enforcing lint rules
  appear as custom checkstyle/ruff/golangci rules.
- **If a tool is unavailable, say so.** "I could not check the lockfile because no lockfile was found"
  is useful. Silently skipping a surface and reporting success is not.
- **If you cannot run commands at all,** the skill still works as a review checklist — read the
  manifests, build config, CI workflows and generated config files, and report what you find.
- **Never leave the repository dirtier than you found it.** No stray branches, no half-applied edits,
  no deleted protection manifests.

### Destructive operations — always ask first

Never do any of these unilaterally, even when clearly correct:

- rewriting git history (`filter-repo`, `filter-branch`, force-push)
- deleting a vendor project, account or bucket
- rotating or revoking a credential that something in production may still use
- running a database migration
- changing DNS

For each: explain what it does, what breaks, and what the safer alternative is. Then let the user
decide. Your job is to make the decision easy, not to make it for them.

## Deeper material

- **`references/case-study.md`** — a complete worked example: what was found, what enforced it, the
  exact replacements, and the two mistakes made along the way. Read it when a project's coupling looks
  structural and you want to see how one that looked structural turned out not to be.
- **`references/discovery-checklist.md`** — the exhaustive sweep: lockfiles and transitive deps, hidden
  vendor directories, generated config and the recreatability test, build tool config, CI workflows,
  committed secrets, client-side storage, database schema coupling, and DNS. Use it when the quick
  sweep finds something and you need to be certain you found everything.
