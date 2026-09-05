# ai-app-builder

An AI app builder platform — describe an app in natural language and get a working,
running, iteratively-refinable project. In the same class as Bolt, Replit, Lovable,
v0, Bubble, Google AI Studio, and Rork, with **portability / no vendor lock-in** as a
first-class product principle.

Supports four target categories: **web**, **full-stack web**, **mobile** (Expo/React
Native), and **multi-target** (web + mobile + backend with shared code), each with a
live preview.

## Architecture

Three independent, standalone repositories — each usable on its own:

- **[`plumby`](https://github.com/2c2bhdhw9z-cell/plumby)** — the coding-agent engine
  (agent loop, tools, providers, streaming, compaction, skills, sub-agents, permission
  classifier, diff rendering). This platform *uses* plumby as its generation engine.
- **[`agent-skills-lockin`](https://github.com/2c2bhdhw9z-cell/agent-skills-lockin)** —
  the open-format vendor-lock-in skills (vendor-lockin-guard, devendor-project),
  vendored in at build time so the builder prevents lock-in as it generates code.
- **ai-app-builder** (this repo) — the platform: orchestration + surface layer, per-project
  sandbox isolation, live preview, connectors, project origins, export + lock-in audit,
  memory, and the skill library.

Keeping these separate is deliberate: it is the anti-lock-in principle applied to the
project's own structure. plumby stays its own thing; this platform depends on it rather
than absorbing it.

## Data retention

Retain-until-deletion (Req 24.5): a Project's persisted file state and its Snapshots are
retained for as long as the Project exists. There is **no** silent expiry, TTL, or
background reaper. Durable state is removed only when the user explicitly deletes the
Project, or deletes their account (which cascades to every owned Project). The
`RetentionService` (`src/ops/retention.js`) is the single choke point for those explicit
deletions: `deleteProject` releases the Sandbox and deletes the project's files,
Snapshots, and secrets; `deleteAccount` deletes-or-anonymizes every `ownerId`-keyed
category (Projects, Skills, Project/Global memory, Connectors, Secrets). Secret values
are stored encrypted at rest via envelope encryption (`src/secrets/envelope-codec.js`
over the KMS seam in `src/secrets/kms.js`).

## Spec

The full specification lives under `.kiro/specs/ai-app-builder/`:

- `requirements.md` — 23 requirements in EARS format, plus 19 correctness properties for
  property-based testing.
- `design.md` — technical design: how it sits on top of plumby, the subsystems, data
  models, testing strategy, and security/isolation model.

Implementation tasks are the next step.
