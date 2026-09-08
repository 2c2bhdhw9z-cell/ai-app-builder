---
inclusion: always
---

# Anti-Lock-In Policy

This project exists to be **owned outright**. The owner's definition of "lock-in"
is behavioral, not about how many dependencies exist or how big they are. Judge
every dependency, template, connector, SDK, and piece of generated code by the
tests below — never by size.

## What counts as lock-in (reject or fix these)

1. **Injected branding / self-crediting.** Watermarks, badges, "Powered by",
   "Made with", or any vendor credit sneaked into the user's code or UI.
2. **Telemetry / phone-home.** Analytics or tracking SDKs and hardcoded
   collector/beacon endpoints that send data back to a vendor.
3. **Edit-locking.** Hash manifests, "do not edit" file locks, or checks that
   block the owner from changing their own files.
4. **Enforcement mandates.** Config/lint rules that force importing a vendor.
5. **Exit taxes.** Anything that makes it hard or paid to export, leave, or run
   the work elsewhere. Export must produce a self-contained, credential-stripped
   copy that builds and runs on a standard toolchain outside the platform.
6. **Entangled load-bearing code (the hardest one).** Real, working vendor code
   threaded into a needed code path (auth, data sync, render, etc.) so that
   removing it genuinely breaks the app. This has no obvious text signal — the
   lock-in is the architecture, not a marker. It is defeated structurally (see
   the boundary rule below), not by scanning.

A lock-in signal found in **platform-generated code is a DEFECT to fix, not a
feature.**

## How we defend against it

- **Detect the cheap tricks.** The lock-in audit
  (`src/portability/lockin-audit.js`) scans for branding, telemetry, collectors,
  hash-locks, enforcement rules, undeclared hosts, and unused env hooks, with
  file + line evidence. Keep it authoritative; extend it, never weaken it.
- **Structurally prevent the expensive trick (entanglement) with a boundary.**
  Every dependency/vendor/engine MUST be consumed through **one narrow,
  replaceable adapter (a "seam")** that re-exports only verified surfaces and
  reimplements none of them — so removing or swapping the vendor is a known,
  contained edit in one file, never an app-wide breakage.
  - The engine boundary is the model: `ai-app-builder` touches `plumby` ONLY
    through `src/engine/plumby.js`. A direct import of the vendor anywhere else
    is a violation — a repo-wide grep for it MUST be empty.
  - Apply the same one-seam discipline to any future shipping dependency.

## Dependency decision rule

Before adding ANY dependency (shipping or dev-only), it must pass ALL of:

- **Honest:** no telemetry, no injected branding, no edit-locking, no exit tax.
- **Permissively licensed:** MIT / BSD / Apache-2.0 or similar; forkable.
- **Walk-away-able:** we could fork it or replace it, and it is consumed through
  a single owned seam if it is shipping/runtime.
- **Earns its place:** it removes real effort or risk (do not add churn).

Then:

- **The `plumby` engine stays zero-dependency.** Never add a dependency to it.
- **`ai-app-builder` adds runtime dependencies only when they pass the rule
  above AND go behind a single adapter seam.** Prefer none; dev-only helpers
  (e.g. test tooling like `fast-check`) are welcome when they pass the honesty
  and license tests, since they never ship.
- When in doubt, run the project's own lock-in audit against the candidate.

Size is never the deciding factor. Ownership and honesty are.
