---
name: vendor-lockin-guard
description: Detect and prevent vendor lock-in before it is embedded. Use when evaluating a dependency, SDK, platform, template, or scaffolded starter; when reviewing code that adds a third-party service; when a user asks whether something will trap them or how hard it would be to leave; or when setting up guardrails and CI checks so coupling cannot be added silently. Also use before shipping, to audit what a project sends and to whom.
license: MIT
metadata:
  version: "1.0.0"
  companion: devendor-project
---

# Guard against vendor lock-in

Prevention. The companion skill `devendor-project` removes coupling that already exists; this one
stops it being embedded and makes it impossible to add silently.

## The principle

**Lock-in is not created by using a service. It is created by the cost of stopping.**

Every dependency has an exit cost. A library you can delete in an afternoon is not lock-in even if
you use it everywhere. A three-line SDK that owns your user identities is lock-in even though it is
three lines. Judge the exit, not the entry.

The most effective single question:

> *If this vendor shut down tomorrow with no notice, what would it take to keep shipping?*

Write the answer down before adopting. If nobody can answer it, that is the finding.

## Part 1 — Evaluating something before adopting it

Score each. Any **red** means the decision needs a written justification, not a shrug.

### 1. Data ownership
- 🟢 Data in your own store, vendor reads it
- 🟡 Vendor stores it, documented full export
- 🔴 Vendor stores it, export is partial, throttled, or absent

Ask: **can I get everything out, in a format I can use, without asking permission?** "There's an API"
is not the same as "there's an export."

**Test it, do not read about it.** Run the actual export and load the result into something that is not
the vendor. Measure three things: how long it took, whether it was complete, and whether it is usable
without bespoke transformation. **If you cannot perform that test before adopting, score export 🔴, not
🟡** — an export path that has never been exercised is a promise, not a capability. Re-run it
periodically; exports rot as schemas change.

### 2. Identity and auth
- 🟢 You own the user records; vendor is one provider among several
- 🟡 Vendor issues tokens you can verify independently
- 🔴 Vendor owns identity; leaving means every user re-registers

This is the single most expensive kind to unwind, because the cost lands on your users, not on you.

**The sharper question is what happens during an outage, not at migration.** Migration is a project you
can plan; an outage is Tuesday afternoon.

- 🟢 A second login path you control — password fallback, or another provider
- 🟡 New logins fail but existing sessions continue
- 🔴 Vendor is down, so nobody can log in, including your admins

Also check whether your **schema** has their identity format in it — a vendor's proprietary user id
embedded in every foreign key means leaving requires a full id migration. See the companion skill's
`references/discovery-checklist.md` §8.

### 3. Interface shape
- 🟢 Vendor implements a standard you could swap (S3 API, SQL, OIDC, OCI)
- 🟡 Proprietary but thin, wrappable behind your own interface
- 🔴 Proprietary and pervasive; its idioms leak into your domain code

### 4. Build and deploy coupling
- 🟢 Standard toolchain; vendor is a deploy target
- 🟡 Vendor CLI wraps a standard build
- 🔴 Vendor's build is the only build; no local equivalent

**Test this directly: can you build and run the project with no network and no vendor account?** If
not, you cannot develop when they have an outage, and neither can a new contributor.

### 5. Runtime dependency for core function
- 🟢 Vendor is optional; core features work without it
- 🟡 Degrades gracefully
- 🔴 App is non-functional if the vendor is unreachable

### 6. Exit cost, in hours
Estimate honestly. Under a week is a dependency. Over a month is a merger.

### 6b. Exit cost, in money and contract terms

**A vendor can have a flawless API and still trap you commercially.** This dimension is invisible in
code review, which is exactly why it gets missed.

- 🟢 No egress fees, no minimum commitment, export included, a documented deletion SLA
- 🟡 Some egress or export cost, or a short minimum term
- 🔴 High egress fees, auto-renewing contract, "termination assistance" sold separately, or data
  retained after termination

Do the arithmetic on **data gravity**: what does it cost to move the volume you expect to have in two
years? A perfect export API is worthless if egress on several terabytes exceeds your runway. Storage
that is cheap to fill and expensive to empty is a business model, not an accident.

Check specifically: auto-renewal notice windows, whether pricing can change unilaterally mid-term, and
what happens to your data on non-payment.

### 6c. Interface coupling at the event boundary

Where a vendor pushes data *into* you — webhooks, callbacks, event streams — the shape of their payload
can leak into your domain.

- 🟢 Events hit a translation layer and are mapped to your own internal types
- 🟡 Passed through raw, but consumed in one isolated module
- 🔴 Core domain logic parses their deeply nested JSON directly, all over the codebase

The fix is cheap *before* adoption and expensive after: one adapter that converts their event into your
type, and nothing downstream knows the vendor exists. This is the same "vendors live behind your own
interface" rule as Part 3, applied to inbound data rather than outbound calls.

### 6d. Local development without the vendor

**Can a developer run the whole stack with no vendor account and no network?**

If the project depends on a proprietary cloud primitive — a bespoke queue, a managed database with no
open equivalent — then the vendor must supply a local emulator. If they do not, every laptop is
permanently tethered to their uptime, onboarding requires provisioning, and nobody can work on a plane
or during an incident.

An open-source client library does **not** solve this. Which brings us to:

### 6e. Open source is not the question

**A vendor's SDK being on GitHub tells you almost nothing about lock-in.** Judge by where the *data* and
the *identities* live. An MIT-licensed client talking to a proprietary hosted service you cannot run
yourself is full lock-in with a friendly licence file.

Conversely, a closed-source client for a service implementing a standard you can swap — S3 API, SQL,
OIDC, OCI — may be barely locked in at all.

### 6f. Jurisdiction and data residency

Not legal advice, and do not pretend otherwise. These are the questions to put to whoever advises the
project, flagged early because they are expensive to discover late:

- 🟢 Data stays in infrastructure or a region you control
- 🟡 Vendor processes it, but you choose the region and can audit
- 🔴 Residency is vendor-controlled, no data processing agreement exists, or the legal
  controller/processor relationship is unclear

Surface it as a question, never as a conclusion. If the project handles personal data, health data,
payments, or anything involving minors, say plainly that this needs qualified review rather than an
engineering opinion.

### 7. The template question — for scaffolded starters specifically

Scaffolded projects are where lock-in hides best, because it arrives *pre-installed and endorsed*.
Before building on one, audit it. **Run the bundled detector — it is the primary tool for this skill**;
it is read-only, package-qualified (so it does not fire on a `badge` in prose or an `amplitude` in a
physics test), and it fails closed:

```bash
# Generic signals (telemetry SDKs, collector endpoints, hash-protection manifests, injected
# components, generated config, unread env). With a vendor name it also finds enforcement rules,
# mandated imports, and vendor mentions in lockfiles / build config / CI.
./vendor-lockin-guard/scripts/detect-lockin.sh . 'vendorname|@vendor'
```

Exit codes make it usable as a CI gate: `0` = no HIGH findings, `1` = at least one HIGH finding,
`2` = the audit could not run (bad path, file-as-root, invalid vendor regex, unknown flag). A `2` is
a hard failure on purpose — a gate must never go green on an audit that never happened. Run
`detect-lockin.sh --help` for the full usage.

If you cannot run the script, the same three questions in shell (note the *construct*, not the
vocabulary — match rendered components and package-qualified imports, never the bare word, or you get
the false positives the detector exists to avoid):

```bash
# Does it enforce its own presence?
grep -rn -i 'vendor' *.json .*rc* 2>/dev/null | grep -v node_modules

# Does it hash-protect files so you cannot edit them?
find . -name '*protected*' -o -name '*manifest*.json' | grep -v node_modules
```

Then ask the decisive question: **does the template's own tooling fail if I remove its vendor code?**
If yes, you are not adopting a starter, you are adopting a landlord.

## Part 2 — Red flags in code review

These are the specific signals. All were present in a real project (see the companion skill's case
study) and every one is cheap to catch at review time and expensive later.

**🚩 A comment asserting necessity.**
```
// do not remove, required for analytics tracking
```
Treat as a claim to verify. In the reference case it was false. If something is genuinely required,
the comment should say *what breaks*, testably.

**🚩 A lint or convention rule that requires a vendor import.** Any rule shaped like
`must.importFrom: ["@vendor/..."]`. This is lock-in expressed as policy: it converts "you may not
remove this" into "your build fails if you try."

**🚩 Hash-protected files you are forbidden to edit.** Reasonable for genuine template plumbing;
unreasonable when it covers vendor coupling, because it means you cannot remove the coupling without
also defeating a safety mechanism — which feels illicit, so people don't.

**🚩 Telemetry on by default, or ignoring the product's own preference.** Check whether the app has a
user-facing telemetry setting and whether the vendor's SDK honours it. A provider that reports
regardless makes that setting cosmetic and any privacy statement built on it false.

**🚩 Vendor branding in permanent identity.** Bundle IDs, package names, URL schemes, database names.
Cheap to change before launch. After launch, a bundle ID change is a *new app* with no reviews and no
install base.

**🚩 Hardcoded vendor hosts, especially preview or sandbox URLs.**
```ts
apiUrl: "https://myapp-x7q2-preview-4200.vendor.site/"
```
These die silently. When they do, the error names the vendor's *proxy*, not the vendor — making it
effectively unsearchable for the person hitting it.

**🚩 Injected UI in your product.** Badges, feedback widgets, watermarks. Ask whether the licence
permits removal and remove it before shipping.

**🚩 A wrapper around a platform capability.** If an SDK wraps deep links, storage, notifications or
auth, ask what it adds beyond the platform primitive. Sometimes real value; often it is a hook to
route your users through their service.

**🚩 Declared-but-unused config.** Empty env placeholders for services you never adopted. Harmless
functionally, but they signal that nobody has audited what this project actually talks to.

**🚩 A generated config file you could not recreate.** `firebase.json`, `amplifyconfiguration.json`,
`vercel.json`, `wrangler.toml`, and any `*.config.json` a CLI wrote for you. Apply the **recreatability
test**: *if I delete this file, can I rebuild it from what is in my repository?* If not, it holds state
that exists only in the vendor's dashboard — an id, a region, a routing rule — and that is lock-in you
cannot see in code. It is also the class most likely to survive a careful manual removal pass, because
nothing imports it.

**🚩 A vendor SDK arriving transitively.** Check the lockfile, not just the manifest. A dependency you
never chose is still a dependency, and you cannot remove it by editing your own `package.json`.

## Part 3 — Guardrails that make it hard to re-add

Do not rely on vigilance. Encode it.

### A denylist check in CI

Cheap, effective, and it makes adding coupling a *conversation* rather than a commit. Adapt the
package globs to the project:

```bash
#!/usr/bin/env bash
# tools/check-vendor-coupling.sh — fail the build on undeclared vendor coupling.
set -uo pipefail

# Packages that may not be imported without an explicit, reviewed exception.
DENY='@vendor/|vendor-sdk|vendor-runtime'

# Behaviour that must never be added silently.
BEACON='r\.example\.com|collector\.|/track\?|analytics\.send'

fail=0
hits=$(grep -rnE "$DENY" --include='*.ts' --include='*.tsx' --include='*.json' . \
        2>/dev/null | grep -v node_modules | grep -v '\.lock' | grep -v '^\./docs/' || true)
if [ -n "$hits" ]; then echo "Vendor import(s) added:"; echo "$hits"; fail=1; fi

beacons=$(grep -rnE "$BEACON" --include='*.ts' --include='*.tsx' . \
        2>/dev/null | grep -v node_modules || true)
if [ -n "$beacons" ]; then echo "Telemetry endpoint(s) added:"; echo "$beacons"; fail=1; fi

[ "$fail" -eq 0 ] && echo "no new vendor coupling"
exit "$fail"
```

Wire it into the project's `lint` script so it runs where people already look.

### An architecture rule: vendors live behind your own interface

One module owns each vendor. Domain code imports your interface, never the SDK. Then a lint rule can
enforce that the SDK is imported in exactly one file — which turns "we're locked in" into "we rewrite
one adapter."

### A no-network build test

Add a CI job that builds and runs the test suite with **no network and no vendor credentials**. If it
passes, contributors can work during a vendor outage. If it fails, you have found runtime coupling
you did not know about.

### An outbound host allowlist

Stronger than auditing, because it makes adding a host **impossible to merge silently**: enumerate every
URL literal and fail on any host not in a reviewed allowlist, each with a comment saying why it is
there. Working script in `references/exit-drills.md`, Drill 4.

Keep that allowlist under review next to the privacy policy. A host in one and not the other means one
of them is wrong — a compliance problem, not a tidiness one.

### Scheduled exit drills

A score decays; evidence does not. Put the kill drill and the export test on a calendar rather than
doing them once at adoption. All four drills, with commands, are in `references/exit-drills.md`.

### An `ADR` or decision log entry per vendor

One short file per adopted vendor recording: what it does, what data it holds, the documented export
path, **the date the export was last actually tested**, the estimated exit cost in hours *and money*,
contract renewal terms, and who decided. Reviewing this list annually is how you notice that a "small"
dependency now owns your identities.

## Part 4 — Pre-ship audit

Before a release, and especially before a store submission:

1. **What does this app send, and to whom?** Enumerate every outbound host. Compare against what your
   privacy policy declares. A mismatch is a legal problem, not a tidiness problem.
2. **Does anything phone home before consent?** Many jurisdictions require consent *before* the first
   non-essential request.
3. **Is any vendor branding shipping?** Badges, splash screens, and identity strings.
4. **Does the app still work if the vendor is unreachable?** Test with the vendor's hosts blocked.
5. **Are there dead vendor hosts left in config?** They will produce unexplainable errors for users
   long after everyone has forgotten the vendor existed.

## Working outside this skill's assumptions

Written for any agent, any stack. The examples lean JavaScript because that is where it was first
exercised; the method does not depend on it.

- **Detect the toolchain, do not assume it.** The lockfile name identifies the package manager; use that
  one. Python, Go, Rust, JVM and .NET all have equivalents for every check here — dependency trees,
  lint plugins, CI config, generated vendor files.
- **If you cannot run commands,** this still works as a review checklist: read the manifests, lockfile,
  build config, CI workflows and generated config files, and report what you find.
- **If you cannot check a surface, say so.** "No lockfile found, so transitive deps were not checked" is
  a finding. Silence that reads as a pass is the one genuinely harmful output.
- **Never adopt or remove a vendor on the user's behalf.** This skill produces findings and options. The
  decision — and anything destructive, contractual or user-facing — belongs to the user.
- **Do not give legal advice.** Residency, DPAs and controller/processor relationships get surfaced as
  questions for qualified review, never as conclusions.

## How to talk to the user about this

People discover lock-in while already frustrated, and often cannot name what has them. Be concrete
and non-fatalistic:

- **Name the specific mechanism**, with file and line. "You are locked in" is useless; "these three
  lint rules fail your build if you remove the badge" is actionable.
- **Separate rented from owned.** Users routinely believe their own good work is contaminated. Tell
  them which parts are genuinely theirs — usually most of it.
- **Give the exit cost as a number.** "About a day" changes how someone feels far more than
  reassurance does.
- **Do not moralise about the vendor.** They want to keep building.
- **Do not overstate the fix.** Removing a reference to a dead host is not the same as restoring the
  capability it provided. Say which you did.
