# Exit drills — turning a score into evidence

The scorecard in `SKILL.md` produces an *opinion*. These four exercises produce **evidence**, and
evidence is what survives an argument six months later when someone wants to add another SDK.

Run them periodically, not once. Coupling accretes.

---

## Drill 1 — The kill drill

**Block the vendor at the network level in staging, then walk the critical paths.**

```bash
# Simplest approach: poison DNS locally, no infrastructure required
# /etc/hosts
127.0.0.1  api.vendor.com
127.0.0.1  cdn.vendor.com
127.0.0.1  auth.vendor.com
```

Then walk, in order, and time each failure:

| Path | What to record |
|---|---|
| Cold start / first load | Does it boot, or hang waiting? |
| Sign up | Blocked entirely, or degraded? |
| Log in — **new session** | This is where identity coupling shows |
| Log in — **existing session** | Often survives when new logins do not |
| The core action of the product | Can a user do the main thing? |
| Payment or checkout | |
| Data export | Ironically often the first casualty |
| Admin access | Can *you* get in to fix things? |

Record for each: **fails / degrades / unaffected**, and how long recovery would take if the outage
lasted a week.

**What good looks like:** the product's core action is unaffected, and failures are explicit rather
than hangs. A request that times out after 30 seconds is far worse than one that fails immediately,
because the user experiences it as "broken" rather than "one feature is down."

**Watch for hidden blocking dependencies.** A telemetry SDK on the startup path can prevent boot
entirely when its host is unreachable — a failure mode nobody predicts, because nobody thinks of
analytics as load-bearing.

---

## Drill 2 — The tested export

Documented export is a claim. Tested export is a capability.

1. Trigger the real export, on real-shaped data at realistic volume.
2. **Time it.** An export that takes 40 hours is different from one that takes 40 seconds.
3. Load the result into something that is not the vendor — Postgres, SQLite, files on disk.
4. Answer honestly:
   - Is anything **missing**? Relations, attachments, metadata, timestamps, soft-deleted rows?
   - Is it **usable**, or does it need transformation nobody has written?
   - Are there **referential holes** — ids pointing at things the export did not include?
   - Could you **serve traffic** from it, or is it only an archive?
5. Compute the **cost**: egress, export fees, engineer time.

Record the result with a date. Re-run when the schema changes materially.

**A partial export is worse than no export**, because it creates false confidence. Knowing you cannot
leave is more useful than believing you can.

---

## Drill 3 — The offline build

**Can a new contributor build and test with no vendor account and no network?**

```bash
# Approximate it in CI: no credentials, no network
env -u VENDOR_API_KEY -u VENDOR_TOKEN npm test
```

Make it a CI job. If it passes, work continues during a vendor incident and onboarding does not require
provisioning. If it fails, you have found runtime coupling you did not know about — which is the point.

Distinguish two failures:

- **Build fails** — the vendor is in your toolchain. Serious.
- **Tests fail** — tests depend on live vendor calls. Fix by adding a fake at your own interface
  boundary, which you should have anyway.

---

## Drill 4 — The outbound host allowlist

Pre-ship auditing catches what is there. An allowlist makes adding a new outbound host **impossible to
merge silently**, which is strictly better.

```bash
#!/usr/bin/env bash
# tools/check-outbound-hosts.sh — fail on any outbound host not reviewed.
set -uo pipefail

ALLOWLIST="tools/allowed-hosts.txt"   # one host per line, '#' comments
[ -f "$ALLOWLIST" ] || { echo "missing $ALLOWLIST"; exit 1; }

found=$(grep -rhoE 'https?://[a-zA-Z0-9.-]+' \
          --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' . 2>/dev/null \
        | grep -v node_modules \
        | sed -E 's#https?://##' | sort -u)

unknown=""
while read -r host; do
  [ -z "$host" ] && continue
  grep -qxF "$host" <(grep -vE '^\s*#|^\s*$' "$ALLOWLIST") || unknown="${unknown}${host}\n"
done <<< "$found"

if [ -n "$unknown" ]; then
  echo "Outbound host(s) not in the allowlist:"
  printf '%b' "$unknown"
  echo "Add to $ALLOWLIST with a comment saying WHY, or remove the call."
  exit 1
fi
echo "all outbound hosts reviewed"
```

Two things make this work in practice:

- **Require a reason in the allowlist.** `# stripe.com — payments, DPA signed 2026-03` ages far better
  than a bare hostname.
- **Expect false positives** from documentation URLs and comments. Tune the include globs rather than
  loosening the check; a check people disable is worth nothing.

Keep the allowlist next to the privacy policy in review. If a host is in one and not the other, one of
them is wrong — and that is a compliance problem, not a tidiness problem.
