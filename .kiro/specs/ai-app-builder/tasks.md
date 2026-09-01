# Implementation Plan: ai-app-builder

## Overview

This plan builds `ai-app-builder` as a **new orchestration + surface layer** in a dedicated repository that
**consumes `plumby` as a dependency** (the code-generation engine at `/projects/sandbox/plumby`) and vendors
the lock-in skills from `agent-skills-lockin` (`/projects/sandbox/agent-skills-lockin`). It does **not**
modify plumby's or agent-skills-lockin's repositories — it wires in their seams.

**Implementation language:** JavaScript / Node.js, matching plumby (zero-dependency Node stdlib). The design
consistently references plumby's `.js` seams (`src/core/loop.js`, `src/providers/scripted.js`,
`src/core/permissions.js`, `src/web/server.js`, `eval/runner.js`), so tasks consume those directly.

**Sequencing philosophy:** early tasks stand up the skeleton and the two hardest, most security-critical
seams first — the test harness (scripted provider + hermetic temp-dir eval pattern), then auth, the
per-project Isolation_Boundary, the command guard (fail-closed + refuse-never-runs), and secret
non-leakage — because everything else runs on top of them. Later tasks flesh out each subsystem. Every task
references the requirement clauses and/or correctness properties it implements. The final section defines
execution waves for parallel scheduling.

**PBT libraries:** property-based tests use a real Node PBT library (`fast-check`); toolchain-backed
properties (7, 11, 12, 13) use plumby's `eval/runner.js` hermetic-temp-dir pattern with the scripted
provider so they stay cheap and hermetic. Every property test runs **≥100 iterations** and is tagged
`Feature: ai-app-builder, Property N: {title}`.

**Task convention:** sub-tasks postfixed with `*` are test tasks and are optional/skippable for a faster MVP;
they are still scheduled in the dependency graph. Requirement 23 (Sharing) is a nice-to-have and is grouped
last and marked deferrable.

## Tasks

- [ ] 1. Scaffold the ai-app-builder repository and wire in plumby as the engine
  - [ ] 1.1 Create the project structure and plumby engine boundary
    - Create the new repo's Node project structure (`package.json`, `src/`, `test/`, `eval/`), add
      `fast-check` as the sole PBT dev dependency, and keep runtime deps minimal (Node stdlib + plumby)
    - Declare a dependency on `plumby` (local path/link to `/projects/sandbox/plumby`) and add a thin
      `src/engine/plumby.js` re-export module that surfaces the seams the builder consumes: `createAgent`,
      `onEvent`, `classifyCommand`, `verify`, `load_skill`/skills loader, `toViewEvent`, diff renderer, and
      the scripted provider — so the rest of the codebase imports plumby through one boundary
    - Define the closed enums as shared constants (`Target_Category`, `Target`, `Project_Origin`,
      `Connector_Category`, `Memory_Mode`, classifier outcomes) in `src/model/enums.js`
    - _Requirements: 1.5, 1.6, 5.1, 10.1, 14.3, 16.1_

- [ ] 2. Build the hermetic test harness on plumby's seams
  - [ ] 2.1 Create the scripted-provider test builder
    - Add `test/support/scripted-agent.js` that constructs a real `createAgent` wired to plumby's
      `src/providers/scripted.js`, so the real loop/tools/permission model/truncation run with no key or
      network (canned model turns)
    - _Requirements: 1.2, 4.1, 4.2_

  - [ ] 2.2 Create the hermetic eval-runner harness
    - Add `eval/runner.js` in this repo mirroring plumby's `eval/runner.js`: build the agent against an
      isolated `fs.mkdtemp` temp dir, **always removed in a `finally`**, with a non-interactive safe bash
      policy (confirm-class denied by default) and a hard iteration cap — the shape the toolchain-backed
      property tests (7, 11, 12, 13) need
    - Add `test/support/fc.js` exporting the shared `fast-check` config (≥100 runs) and the
      `Feature: ai-app-builder, Property N: {title}` tag helper
    - _Requirements: 5.4, 6.2, 11.1, 11.6_

- [ ] 3. Define control-plane data models and file-on-disk layout
  - [ ] 3.1 Implement data-model records and storage split
    - Implement the data-model records from the design (`User_Account`, `Authorization`, `Project`, `Target`,
      `Snapshot`, `Connector`, `ConnectorBinding`, `Secret`, `Skill`, `MemoryEntry`, `MemoryStoreMeta`,
      `DeploymentArtifact`, `ShareLink`, `VerifyResult`) in `src/model/`
    - Establish the storage split: human-readable files-on-disk for exportable state (project tree, memory,
      skills) and out-of-tree control-plane metadata (project registry, share links, connector bindings,
      secret values) so secrets never enter an exported tree
    - _Requirements: 7.3, 9.6, 9.7, 10.4, 19.9_

- [ ] 4. Implement Authentication & Authorization (security foundation)
  - [ ] 4.1 Implement AuthService/IdentityManager
    - Implement `authenticate(request) → User_Account | Denied` requiring an authenticated account before
      create/open/modify; unauthenticated attempts denied without disclosing Project contents
    - Implement `authorize(userAccount, action, resource) → Allowed | AccessDenied` as the per-resource
      ownership/grant check for Projects, User_Skills, Global_Memory, Connectors, Secrets, Share_Links
    - Implement `resolveAccess(userAccount, ref)` as the single "authorized to access" resolution (import
      repos, fork sources, share links) against the requesting account, and `scopeSession(userAccount)` to
      scope sessions/projects/memory to the account
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [ ]* 4.2 Write unit tests for auth/authz
    - Unauthenticated create/open/modify denied without disclosure; action on a non-owned resource denied;
      "authorized to access" resolves against the requester; session scoping isolates users
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.6_

- [ ] 5. Build the per-project Isolation_Boundary + runtime manager (LARGEST BUILD ITEM)
  - This is the single largest scope item: plumby ships **no** per-project isolation (its README says "a
    permission model, not a sandbox"), so the boundary is genuinely new. It must hold independently of the
    permission classifier.
  - [ ] 5.1 Implement SandboxManager provisioning and reaping
    - Implement `acquire(projectId) → Sandbox`: provision a per-Project Isolation_Boundary (container/VM) with
      filesystem, process, and network isolation; apply resource limits (CPU, memory, execution-time); mount
      only that Project's tree. Use plumby's opt-in `Dockerfile` (non-root, keys from env at run time) as a
      starting input, not the boundary itself
    - Implement `release(projectId)` reaping in a `finally`, including orphan cleanup on failed import
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 6.5_

  - [ ] 5.2 Enforce cross-boundary containment independently of the classifier
    - Implement `exec(projectId, command)` so every command runs inside the boundary and is confined
      regardless of classifier verdict; a command attempting to reach another Project's Sandbox or the host
      outside the boundary is blocked, target state preserved, denied error returned
    - Enforce that isolation holds even for `allow`-class commands (boundary is not the classifier)
    - _Requirements: 8.4, 8.5, 8.6, 22.2_

  - [ ]* 5.3 Write property test for Isolation_Boundary invariant
    - **Property 1: Isolation_Boundary invariant** — for all commands (regardless of classification), all
      filesystem/process/network access stays confined to the Project's boundary, with no cross-Sandbox or
      host access; holds for `allow`-class commands too
    - Use `fast-check` over generated command strings + paths; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 1: Isolation_Boundary invariant`
    - **Validates: Requirements 8.1, 8.4, 8.5, 8.6, 22.2**

  - [ ]* 5.4 Write unit test for classifier-independent isolation
    - An `allow`-class command is still confined to the Isolation_Boundary (isolation independent of gating)
    - _Requirements: 8.5_

- [ ] 6. Build the CommandGuard (fail-closed gate composing plumby's pure classifier)
  - [ ] 6.1 Implement the surface guard around classifyCommand + boundary
    - Implement CommandGuard as the single choke point: call plumby's pure `classifyCommand(cmd)` (unchanged)
      → allow/confirm/refuse, then run inside the SandboxManager boundary. `allow` runs contained; `refuse`
      blocked, state unchanged, error returned; `confirm` emits a `confirm_request` and awaits consent ≤60s,
      else deny (state unchanged)
    - Fail closed: no classification within 10s or classifier unavailable → treat as `refuse`, do not execute,
      return a "could not classify" error
    - Apply plumby's read-only sub-agent policy for delegated commands: confirm/refuse-class blocked without
      execution
    - _Requirements: 8.7, 8.8, 8.9, 8.10, 22.1, 22.3, 22.4, 22.5, 22.6_

  - [ ]* 6.2 Write property test for refuse-class commands never running
    - **Property 5: Permission classifier never allows refuse-class commands** — for all commands
      `classifyCommand` marks `refuse`, the guard never executes them under any config/flag/consent
    - `fast-check` over generated command strings against the pure classifier; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 5: Permission classifier never allows refuse-class commands`
    - **Validates: Requirements 8.9, 22.3**

  - [ ]* 6.3 Write unit tests for guard gating paths
    - Fail-closed on 10s/unavailable → refuse; representative `refuse` (rm -rf /, filter-branch), `confirm`
      (force-push, migrate, DNS) needs consent ≤60s else deny; `allow` proceeds; sub-agent read-only policy;
      64 KB per-stream truncation retains first 64 KB + a notice line naming bytes omitted
    - _Requirements: 8.8, 8.10, 22.4, 22.5, 22.6, 22.7_

- [ ] 7. Implement Secret storage and injection (secret non-leakage foundation)
  - [ ] 7.1 Implement SecretStore and Sandbox env injection
    - Implement `SecretStore.put/get/remove(projectId, name, value)` storing values **out-of-tree**; inject
      Secrets into the Sandbox environment at runtime; expose only names to bindings
    - Implement the generation guardrail: if generation would write a literal credential or hardcoded
      platform host into a source file, replace it with an env-var reference and record the substitution in a
      user-visible report
    - _Requirements: 9.6, 9.7, 10.4, 11.4, 11.5_

  - [ ]* 7.2 Write property test for Secret non-leakage
    - **Property 8: Secret non-leakage** — for all Secrets on a Project, no generated source file committed to
      a Snapshot contains the Secret's literal value
    - `fast-check` generates secret strings, grep the committed tree; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 8: Secret non-leakage`
    - **Validates: Requirements 9.7, 11.4**

- [ ] 8. Implement Persistence, Snapshots, and resumability (files-on-disk, Git-backed)
  - [ ] 8.1 Implement PersistenceStore idle persistence
    - Implement `persist(projectTree)` writing the tree durably within 2s of the change becoming idle
      (debounce), readable in a later Session; on failure retain last good state and return a persistence
      error
    - _Requirements: 19.1, 19.2, 19.9_

  - [ ] 8.2 Implement SnapshotStore atomic commit and restore
    - Implement `commitSnapshot(projectTree) → snapshotId` as an atomic content-addressed Git commit (fully
      recorded or not at all); failed snapshot discards partial and retains most recent complete
    - Implement `restore(snapshotId) → projectTree` deterministically and idempotently; resume rules: reopen
      → restore most recent complete Snapshot, else most recent persisted file state; missing/unreadable
      Snapshot → leave current state unchanged, return restore error
    - _Requirements: 19.3, 19.4, 19.5, 19.6, 19.7, 19.8_

  - [ ]* 8.3 Write property test for resumability
    - **Property 4: Resumability restores prior state** — for all Projects, `restore(persist(state)) == state`
    - `fast-check` generates project trees; persist/restore round-trip; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 4: Resumability restores prior state`
    - **Validates: Requirements 19.1, 19.5, 19.6**

  - [ ]* 8.4 Write property test for Snapshot idempotence
    - **Property 6: Snapshot idempotence** — for all Projects and Snapshots, `restore(restore(s)) == restore(s)`
    - `fast-check` over generated trees/snapshots; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 6: Snapshot idempotence`
    - **Validates: Requirements 19.7**

  - [ ]* 8.5 Write unit tests for snapshot triggers and restore edge cases
    - Turn-PASS commits a snapshot; turn-FAIL does not; explicit commit; missing/unreadable snapshot restore
      leaves state unchanged
    - _Requirements: 19.3, 19.4, 19.8_

- [ ] 9. Checkpoint - security and persistence foundations
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Build the Builder Server (HTTP + SSE surface, mirrors plumby src/web/server.js)
  - [ ] 10.1 Implement BuilderServer request/stream flow
    - Bind HTTP + SSE; `GET /events` streams Activity_Stream frames per Session; `POST /message {projectId,
      text}` returns 202 then streams a turn; `POST /confirm {requestId, approved}` resolves confirm-class
      prompts (fail-closed, 60s). Gate every request through AuthService before it reaches the loop
    - Construct a `Builder_Agent` (plumby `createAgent`) per Project Session with the working dir set to the
      Project tree inside its Sandbox; run one in-flight turn per Project Session; emit `turn_start`/
      `turn_state` reconnection frames
    - _Requirements: 1.2, 2.1, 7.1, 7.2, 21.2_

  - [ ]* 10.2 Write unit tests for server flow and reconnection
    - Unauthenticated request rejected with access-denied; 202-then-SSE message flow; confirm resolution;
      one-turn-per-session; `turn_start`/`turn_state` mid-turn reconnection
    - _Requirements: 7.1, 7.2, 8.10_

- [ ] 11. Implement the Activity Stream (consume plumby onEvent, reuse events.js + diff.js)
  - [ ] 11.1 Implement ActivityStream event mapping
    - Consume plumby `onEvent`: stream `text_delta` reasoning as produced (before turn completion); surface
      tool-call events (read/write/edit_file, bash, grep, glob, verify, load_skill, spawn_subagent) in
      occurrence order; render file-modifying events inline as Diffs via plumby's `src/web/diff.js` (edit_file
      focused old→new, write_file full-content "new file"); emit a turn-completion indicator; truncate
      over-cap output with a notice; present Activity_Stream and Preview concurrently (client contract)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 2.3_

  - [ ]* 11.2 Write property test for diff application preserving unedited content
    - **Property 2: Diff application preserves unedited content** — for all edits via plumby `edit_file`
      exact-string replacement, applying the Diff changes only the single targeted contiguous region and
      leaves every other byte identical
    - `fast-check` generates a file + unique substring + replacement; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 2: Diff application preserves unedited content`
    - **Validates: Requirements 2.2, 2.4**

  - [ ]* 11.3 Write integration tests for Activity_Stream ordering
    - `text_delta` streamed before turn end; tool events in order (incl. load_skill); file change → inline
      diff; turn-complete indicator; over-cap truncation notice — reusing `src/web/events.js` assertions
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6_

- [ ] 12. Implement Project lifecycle and creation orchestration
  - [ ] 12.1 Implement ProjectManager input validation and creation timing
    - Validate description trimmed to 1–5,000 chars and `Target_Category`/`Project_Origin` against closed
      enums **before** any Project is created; reject empty/short description, unsupported category, or
      unsupported origin with a specific message and no partial Project
    - Implement the 10s "begins creation" bound: record the Project and allocate its Sandbox (via
      SandboxManager) so it becomes available for streaming; delegate generation to a Builder_Agent
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 5.7_

  - [ ] 12.2 Wire generation → verify → Dev_Server start / editable-on-fail
    - On generation completion run verify; on PASS start Dev_Server (Preview available ≤60s of start); on FAIL
      report captured error, do not start Dev_Server, retain files editable
    - _Requirements: 1.3, 1.7_

  - [ ]* 12.3 Write unit tests for creation validation boundaries
    - 0 chars, 5,000 chars, 5,001 chars; each invalid enum value; verify-FAIL keeps files editable and does
      not start Dev_Server
    - _Requirements: 1.4, 1.5, 1.6, 1.7_

- [ ] 13. Implement Project Origins (blank, template, github-import, fork)
  - [ ] 13.1 Implement blank and template origins
    - `blank`: write only the minimal files for the Sandbox + Dev_Server to start, no Template applied.
      `template`: copy the Template matching the `Target_Category`, populating all Template files + dependency
      manifest within 30s; on write failure abort, remove partial files, name the failed artifact
    - Converge all origins onto the identical downstream refinement/preview/persist/verify pipeline
    - _Requirements: 6.1, 6.2, 6.3, 6.8, 5.2, 5.3_

  - [ ] 13.2 Implement github-import and fork origins
    - `github-import`: clone the repository into the Project's Sandbox within 120s as a `bash` command
      (passes the classifier); on invalid/inaccessible ref or timeout abort with cause, create no partial
      Project, leave no orphaned Sandbox (reap in `finally`)
    - `fork`: after authorization check, copy the referenced Project's **most recent Snapshot** as the new
      starting state, fully independent of the origin; reject fork of nonexistent/unauthorized Project,
      creating nothing
    - _Requirements: 6.4, 6.5, 6.6, 6.7_

  - [ ]* 13.3 Write property test for blank origin still runs
    - **Property 11: Blank origin still runs** — for all `blank` Projects, the Sandbox and Dev_Server start
      successfully with only the minimal generated files
    - Toolchain-backed via `eval/runner.js` (hermetic temp dir, scripted provider); bounded generators; ≥100
      iterations; tag `Feature: ai-app-builder, Property 11: Blank origin still runs`
    - **Validates: Requirements 6.2**

  - [ ]* 13.4 Write property test for fork independence
    - **Property 10: Fork independence** — for all forked Projects, mutating the fork does not change the
      origin Project's file state
    - `fast-check` fork/mutate/compare over generated trees; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 10: Fork independence`
    - **Validates: Requirements 6.6**

  - [ ]* 13.5 Write integration tests for import timing and orphan cleanup
    - github-import clone ≤120s success path; failure/orphan-cleanup path leaves no running Sandbox; creation
      begins ≤10s; Template population ≤30s
    - _Requirements: 6.4, 6.5, 1.1, 5.2_

- [ ] 14. Implement Project Scaffolding and Templates (per Target_Category)
  - [ ] 14.1 Implement Template set and baseline build
    - Provide at least one Template per `Target_Category` (`web`, `full-stack-web`, `mobile`, `multi-target`);
      a `multi-target` Template scaffolds exactly four Targets (`web`, `backend`, `mobile`, `shared`); each
      Template's baseline build completes with exit 0 and no errors before any refinement; a baseline build
      exceeding 300s marks instantiation failed with a build-failure error
    - _Requirements: 5.1, 5.4, 5.5, 5.6, 16.1_

  - [ ]* 14.2 Write property test for template baseline builds
    - **Property 7: Template baseline builds** — for all Templates, instantiating a Project and running
      plumby's `verify` produces `verdict: PASS` before any user refinement
    - Toolchain-backed via `eval/runner.js` (hermetic temp dir, scripted provider); iterate over each
      Template; ≥100 iterations; tag `Feature: ai-app-builder, Property 7: Template baseline builds`
    - **Validates: Requirements 5.4, 5.5**

- [ ] 15. Implement iterative refinement routing (edit_file semantics)
  - [ ] 15.1 Implement refinement application via plumby edit_file
    - Route refinement messages to apply changes only to files within the existing Project (no new Project,
      no regen from scratch), using plumby's `edit_file` exact-string replacement against a single contiguous
      target; preserve every byte outside edited regions; render the change as a visual Diff within 2s
    - Error paths: zero/multi-match target → "not uniquely located", file unchanged; missing file → "file not
      found", all files unchanged; no actionable change → "no changes applied", files unchanged
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 15.2 Write unit tests for edit_file failure modes
    - Zero-match, multi-match, missing file, no-op refinement each leave files unchanged with the correct
      report
    - _Requirements: 2.5, 2.6, 2.7_

- [ ] 16. Implement the Self-Healing controller (reuse plumby verify)
  - [ ] 16.1 Implement the verify-driven heal loop
    - Run plumby `verify` (default 120s, max 600s) to get a Verify_Result whose first line is the verdict; if
      verify cannot produce a result report the cause and leave files unchanged; on FAIL feed failure
      lines + output tail to the Builder_Agent, re-run verify after each attempt, cap at a configured max
      (default 3, configurable 1–10); at cap without PASS report unresolved output + attempt count and stop;
      on PASS report resolution + attempt count + corrective Diffs and trigger a Snapshot commit
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7_

  - [ ]* 16.2 Write unit tests for self-heal cap and reporting
    - verify-cannot-produce path leaves files unchanged; FAIL→heal→re-verify; cap stops without infinite loop;
      PASS reports diffs and triggers snapshot
    - _Requirements: 20.2, 20.5, 20.6, 20.7_

- [ ] 17. Implement the Preview pipeline (web + mobile/Expo)
  - [ ] 17.1 Implement PreviewController publish-on-commit and web preview
    - Serve an interactive in-browser `web` Preview reflecting the most-recent successfully-built **committed**
      Snapshot; label uncommitted hot-reload as in-progress/building; on Snapshot commit point the served
      Preview at the committed tree and update within 5s; if a committed Snapshot fails to build, retain the
      last successfully-built Preview, show the captured build error, and indicate a prior state is shown
    - _Requirements: 3.1, 3.3, 3.4_

  - [ ] 17.2 Implement Dev_Server lifecycle and mobile/Expo preview
    - Preview-loading status while starting; 60s startup-timeout error with a restart offer; unexpected-exit
      handling preserves state and offers restart; restart capped at 3 attempts then a persistent-failure
      error with no further automatic restarts. For `mobile`, expose an Expo-compatible Preview endpoint
      reachable within 60s of Dev_Server start with a scannable QR code and connection URL; unreachable →
      report cause and retain prior reachable Preview
    - _Requirements: 3.2, 3.5, 3.6, 3.7, 15.2, 15.3_

  - [ ]* 17.3 Write property test for Preview reflecting committed state
    - **Property 3: Preview reflects committed state** — for all sequences of committed Snapshots and
      uncommitted edits, served Preview content corresponds to the most-recently successfully-built committed
      Snapshot, never uncommitted intermediate state
    - `fast-check` models the publish transition over commit/edit sequences; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 3: Preview reflects committed state`
    - **Validates: Requirements 3.1, 3.3, 3.4**

- [ ] 18. Implement dependency and package management
  - [ ] 18.1 Implement Package_Manager install inside the Sandbox
    - The Builder_Agent adds to the manifest, then the Package_Manager (npm) installs inside the Sandbox
      within 300s, resolvable to build/Dev_Server with no extra step; on failure/timeout report installer
      output, restore the manifest to its prior state, expose no partial deps; route every package command
      through the classifier; a denied command cancels install, changes nothing, reports the denial
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [ ]* 18.2 Write unit tests for install failure and denial
    - Failure/timeout restores manifest and exposes no partial deps; classifier-denied command cancels with
      no change and a denial report
    - _Requirements: 17.3, 17.5_

- [ ] 19. Implement full-stack + database support
  - [ ] 19.1 Implement backend scaffolding and database provisioning
    - For `full-stack-web`/`multi-target`, scaffold a `backend` Target with at least one reachable endpoint
      returning HTTP < 400 in the Sandbox; provision a Database_Service within 60s and report it ready before
      scaffolding completes; on timeout/failure report the cause and leave no partially provisioned DB active
    - _Requirements: 9.1, 9.2, 9.3_

  - [ ] 19.2 Implement confirm-gated schema migrations
    - Run schema migrations through the confirm-gated command path (classifier tags migrations as
      `db-migration` → confirm) within 120s and report the applied version; on failure/timeout report the
      cause and leave the prior schema in effect with no partial changes
    - _Requirements: 9.4, 9.5_

  - [ ]* 19.3 Write integration tests for DB provisioning and migration timing
    - DB ready ≤60s before scaffolding completes; migration ≤120s via the confirm path; failure paths leave no
      partial DB / prior schema intact
    - _Requirements: 9.2, 9.3, 9.4, 9.5_

- [ ] 20. Implement the Connector subsystem (catalog, capture, injection)
  - [ ] 20.1 Implement Connector catalog and credential capture
    - Provide a Connector_Catalog across all six categories (`database`, `auth`, `payments`,
      `hosting-deploy`, `storage`, `ai-model`); initiate the per-Connector OAuth or API-key capture flow; on
      success store the credential as a Secret and inject it into the Sandbox env at runtime; on
      failure/cancel/deny report and store nothing partial, leaving existing Connectors/Secrets unchanged
    - Surface an added Connector to the Builder_Agent (via steering / a connectors manifest) so it generates
      integration code referencing the injected Secret, not a literal; removal revokes the Secret's injection
      and reports it; `hosting-deploy` Connectors act as deploy destinations routed through the classifier
    - Keep the `ai-model` Connector (a service the generated app calls) distinct from the builder provider
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8_

  - [ ]* 20.2 Write property test for Connector credential non-leakage
    - **Property 9: Connector credential non-leakage** — for all Connectors added to a Project, no generated
      source file committed to a Snapshot contains the literal credential value
    - `fast-check` generates credential strings, grep the committed tree; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 9: Connector credential non-leakage`
    - **Validates: Requirements 10.4, 11.4**

  - [ ]* 20.3 Write unit tests for capture failure handling
    - Capture fail/cancel/deny stores nothing partial and leaves existing Connectors/Secrets unchanged;
      removal revokes injection and reports
    - _Requirements: 10.6, 10.7_

- [ ] 21. Implement Skill Library + vendored lock-in skills
  - [ ] 21.1 Implement the build/release-time vendoring copy step
    - Add a build/release-time step that **copies** the `vendor-lockin-guard/` and `devendor-project/`
      SKILL.md folders from the `agent-skills-lockin` repo into plumby's skills directory, so they are
      discoverable at session start with **no runtime fetch/clone**; keep the vendored copies in sync with the
      upstream repo, which stays independently usable. Preserve the open Agent Skills format (SKILL.md with
      `name` + `description`)
    - _Requirements: 12.1, 12.2, 12.13, 12.14, 12.15_

  - [ ] 21.2 Wire skill loading and lock-in behavioral hooks via plumby
    - Reuse plumby `src/core/skills.js` + `src/tools/load_skill.js` progressive disclosure: expose only
      `name` + `description` at session start (description clipped ≤500 chars, listing block capped 16 KiB
      with truncation notice), load a body by exact `name` (stripped, ≤64 KiB with notice); unknown name →
      error listing available names, no change; unreadable/empty body → error, no change; path outside skills
      tree → refuse; missing `name` → dir name, first-discovered wins on duplicate
    - Behavioral hooks: on de-couple/escape request load the Devendor_Skill and apply its phased methodology;
      when evaluating a dependency/SDK/template/Connector load the Guard_Skill; route destructive lock-in
      removal through the classifier (unrecoverable e.g. filter-branch refused even with consent; recoverable
      e.g. delete/rotate/migrate/force-push/DNS require confirmation; declined confirmation leaves
      pre-operation state)
    - _Requirements: 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12_

  - [ ] 21.3 Implement Skill Library CRUD
    - Ship a curated set of Stocked_Skills; create a User_Skill by `name` + `description` + body; import an
      Agent-Skills-format skill validated for `name` + `description`; missing field → reject naming it; name
      collision → reject, existing unchanged; edit/delete of a User_Skill leaves Stocked_Skills untouched;
      everything stays in the open format
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

  - [ ]* 21.4 Write property test for skills remaining portable
    - **Property 19: Skills remain portable** — for all Skills in a user's library, each remains a valid
      open-format Agent Skill (SKILL.md with `name` + `description`) exportable and loadable by another Agent
      Skills tool
    - `fast-check` generates valid skills, frontmatter round-trip; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 19: Skills remain portable`
    - **Validates: Requirements 12.13, 13.8**

  - [ ]* 21.5 Write unit tests for vendoring and skill CRUD edges
    - Guard/Devendor SKILL.md folders present in plumby's skills dir at session start with no runtime fetch;
      description clip / 16 KiB listing cap / 64 KiB body cap; missing-name → dir name; duplicate → first
      wins; import missing field rejected; name collision rejected leaving existing unchanged
    - _Requirements: 12.1, 12.3, 12.4, 12.10, 12.15, 13.5, 13.6_

- [ ] 22. Checkpoint - generation, previews, connectors, and skills
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 23. Implement the Memory subsystem (Project + Global, files-on-disk)
  - [ ] 23.1 Implement memory stores, modes, and manual controls
    - Maintain Project_Memory (per-Project, persisted with the Project, restored on reopen) and Global_Memory
      (per-user across Projects) as human-readable files on disk; default Memory_Mode `auto` until changed;
      `auto` lets the Builder_Agent add/update entries for durable preferences/decisions/corrections; user may
      view/edit/delete/export any entry under every mode at any time; changing the mode applies to subsequent
      management; no hidden/non-exportable state
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.11, 14.12, 14.13_

  - [ ] 23.2 Implement Memory_Cap and summarize-and-evict
    - Enforce a per-store cap (default 64 KiB and 200 entries, either binds; configurable). In `auto` at cap:
      keep the newest KEEP_RECENT (default 20) verbatim, structured-summarize the oldest overflow (DECISIONS,
      PREFERENCES, CONVENTIONS, CORRECTIONS) into one synthetic entry, evict summarized content first if still
      over, never destroy history on a bad/empty summary, notify the user. In `manual` at cap: freeze, notify,
      require manual pruning. In `off`: add nothing automatically, only explicit user entries
    - _Requirements: 14.7, 14.8, 14.9, 14.10_

  - [ ]* 23.3 Write property test for memory staying within cap
    - **Property 16: Memory stays within cap** — for all `auto` stores, after any sequence of automatic
      additions the store stays at or below both the byte cap and entry cap, preserving the summarized gist
    - `fast-check` generates add sequences vs. cap; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 16: Memory stays within cap`
    - **Validates: Requirements 14.7, 14.8**

  - [ ]* 23.4 Write property test for memory being fully exportable
    - **Property 17: Memory is fully exportable** — for all stores, exporting reproduces every current
      Memory_Entry as human-readable content with no hidden state omitted
    - `fast-check` generates a store, checks export completeness; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 17: Memory is fully exportable`
    - **Validates: Requirements 14.6, 14.13**

  - [ ]* 23.5 Write property test for off mode adding nothing automatically
    - **Property 18: Off mode adds nothing automatically** — for all `off` stores, no Memory_Entry is added
      except by explicit user action
    - `fast-check` generates off-mode add sequences; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 18: Off mode adds nothing automatically`
    - **Validates: Requirements 14.10**

  - [ ]* 23.6 Write unit tests for memory mode transitions
    - `auto`→`manual` freeze-and-notify at cap; `off` explicit-only; mode change applies to subsequent
      management
    - _Requirements: 14.9, 14.11_

- [ ] 24. Implement Provider / model selection (reuse plumby resolution)
  - [ ] 24.1 Implement ProviderResolver
    - Allow selecting a provider from `anthropic | gemini | openrouter`; the selection applies to every turn
      started after it until changed; unsupported provider → reject, Session unchanged, name it; unsupported
      model → reject, Session unchanged; with no explicit selection resolve the first provider in plumby's env
      order with an available credential; with no credential report the missing provider, start no turn, leave
      Session unchanged. Keep this distinct from the `ai-model` Connector
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6_

  - [ ]* 24.2 Write unit tests for provider/model selection edges
    - Unsupported provider/model rejected leaving Session unchanged; env-order default resolution; no-credential
      reports missing provider and starts no turn
    - _Requirements: 21.3, 21.4, 21.5, 21.6_

- [ ] 25. Implement Build, Deploy, Mobile build, and Multi-target
  - [ ] 25.1 Implement build + deploy for non-mobile Targets
    - Build a non-`mobile` Target's Deployment_Artifact (exit 0) within 300s; non-zero exit or >300s → error,
      no artifact; deploy a Deployment_Artifact to a hosting destination returning the URL within 120s;
      deploy failure/timeout → report cause, prior deployed state unchanged; a `confirm`-classified deploy
      needs consent within 60s; deploying a nonexistent artifact is rejected
    - _Requirements: 18.1, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8_

  - [ ] 25.2 Implement mobile build timing (execution timeout, queue-aware)
    - Scaffold Expo/RN `mobile` Target within 30s (exit 0); produce the `mobile` Deployment_Artifact within a
      configurable mobile-build-execution timeout (default 1800s) **measured from build-execution start,
      excluding queue time**; while queued on a shared build service report the queued status separately and
      do not count queue time; missing toolchain component → name it, not reported successful, files/prior
      artifacts unchanged; execution timeout or non-zero exit → failure cause, no artifact
    - _Requirements: 15.1, 15.4, 15.5, 15.6, 15.7, 18.2, 18.3_

  - [ ] 25.3 Implement multi-target coordination
    - Maintain exactly four Targets (`web`/`mobile`/`backend`/`shared`); propagate `shared` changes to the
      other three within 5s; failed propagation retains the last good `shared` in all Targets and names the
      failed Target(s); Preview selector with `web` default and an explicit "default used" indication; build
      exactly one artifact per requested Target and none for unrequested; a failed Target build still
      completes the others, produces no artifact for the failed one, names it, preserves prior artifacts; an
      invalid Target is rejected with the invalid Target named, no artifact modified
    - _Requirements: 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8_

  - [ ]* 25.4 Write integration tests for build/deploy/mobile/multi-target timing
    - web/backend/shared build ≤300s; deploy URL ≤120s; confirm-gated deploy; mobile scaffold ≤30s, Expo
      endpoint ≤60s, build bounded by 1800s execution timeout with queued status reported separately and not
      counted; exactly four Targets; `shared` propagation ≤5s; per-Target artifact selection
    - _Requirements: 15.1, 15.2, 15.4, 15.5, 16.1, 16.2, 16.6, 18.1, 18.4_

- [ ] 26. Implement Export + Lockin-Audit subsystem (portability)
  - [ ] 26.1 Implement Project_Export
    - Produce a self-contained copy of the Project's full file state that builds/runs outside the platform
      with a Standard_Toolchain, requiring no platform account and no network to a platform host, within 300s
      for ≤10,000 files; strip every Secret and Connector credential and include an env-var template listing
      every required variable name with no value; a failed export aborts, retains stored state unchanged, and
      returns a cause
    - _Requirements: 11.6, 11.7, 11.8_

  - [ ] 26.2 Implement Lockin_Audit
    - Reuse the `detect-lockin.sh` concept + Guard/Devendor methodology: scan a Project (≤10,000 files,
      ≤120s) and report each detected signal (telemetry/beacons, injected UI/badges, hardcoded platform
      hosts, enforcement lint/convention rules, hash-protected files, undeclared outbound hosts) with file
      path + line number, or report none found; a file it cannot scan is reported as an unverified surface,
      never silently omitted; a signal in platform-generated code is treated as a defect to fix; may run as a
      read-only sub-agent. Ensure generated projects carry no telemetry/branding/enforcement rules
    - _Requirements: 11.1, 11.2, 11.3, 11.9, 11.10, 11.11_

  - [ ]* 26.3 Write property test for no enforcement lock-in
    - **Property 12: No enforcement lock-in in generated projects** — for all generated Projects, removing
      AI_App_Builder-specific code does not cause the baseline build to fail
    - Toolchain-backed via `eval/runner.js` (hermetic temp dir, scripted provider): remove platform markers,
      confirm baseline build still passes; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 12: No enforcement lock-in in generated projects`
    - **Validates: Requirements 11.1, 11.2, 11.3**

  - [ ]* 26.4 Write property test for export building standalone
    - **Property 13: Export builds standalone** — for all Project_Exports, the exported Project builds/runs
      with a Standard_Toolchain, no platform account, and no network to a platform host
    - Toolchain-backed via `eval/runner.js`: export → build in a no-network, no-credential sandbox; ≥100
      iterations; tag `Feature: ai-app-builder, Property 13: Export builds standalone`
    - **Validates: Requirements 11.6**

  - [ ]* 26.5 Write property test for export credential non-leakage
    - **Property 14: Export credential non-leakage** — for all Project_Exports, no exported file contains a
      literal Secret or Connector credential value, and the export includes an env-var template listing every
      required variable name with no value
    - `fast-check` generates secrets, grep the exported tree + assert env template; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 14: Export credential non-leakage`
    - **Validates: Requirements 11.8**

  - [ ]* 26.6 Write property test for audit soundness on clean projects
    - **Property 15: Audit soundness on clean projects** — for all generated Projects with no lock-in signals,
      a Lockin_Audit reports no signals (no false positives on clean output)
    - `fast-check` generates clean projects, audit reports nothing; ≥100 iterations; tag
      `Feature: ai-app-builder, Property 15: Audit soundness on clean projects`
    - **Validates: Requirements 11.9**

- [ ] 27. Checkpoint - memory, providers, build/deploy, and portability
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 28. Implement Collaboration and Sharing (Nice-to-Have, deferrable)
  - This epic implements Requirement 23, a lower-priority nice-to-have that MAY be deferred to a later
    release. If implemented, its criteria are binding exactly as written.
  - [ ] 28.1 Implement Share_Link generation, access, revocation
    - Authorized share (authorization resolved against the requesting User_Account) → unique read-only
      Share_Link within 5s, expiring 7 days later; unauthorized/nonexistent → reject, no link; valid
      unexpired unrevoked link → read-only access within 5s; expired/revoked/malformed → deny, disclose
      nothing; a recipient's modification attempt is rejected, Project unchanged; revoke → deny all
      subsequent access within 5s; revoking a nonexistent/already-revoked link → report no match, other
      links unchanged
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 7.5_

  - [ ]* 28.2 Write unit tests for the Share_Link state machine
    - valid/expired/revoked/malformed access; recipient modification rejected; revoke-then-access;
      revoke nonexistent reports no match
    - _Requirements: 23.3, 23.4, 23.5, 23.6, 23.7_

- [ ] 29. Final checkpoint - full-system wiring
  - Ensure all tests pass, confirm every subsystem is wired through the Builder Server behind Auth and the
    Isolation_Boundary + CommandGuard, and ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; they remain in the
  dependency graph for scheduling.
- Each task references specific requirement clauses and/or correctness properties for traceability.
- The 19 correctness properties are each implemented by a single property-based test (≥100 iterations) with
  a real PBT library (`fast-check`), tagged `Feature: ai-app-builder, Property N: {title}`. Properties 7, 11,
  12, and 13 are toolchain-backed and use plumby's `eval/runner.js` hermetic-temp-dir pattern with the
  scripted provider.
- The security-critical foundations (Isolation_Boundary, Auth, CommandGuard fail-closed / refuse-never-runs,
  secret non-leakage) are built and tested early (tasks 4–8) because every later subsystem depends on them.
- This is a NEW dedicated repository consuming plumby and agent-skills-lockin as dependencies; no task edits
  those upstream repos' cores — plumby's classifier, loop, and skills mechanism stay unmodified and are
  consumed through their seams.
- Requirement 23 (Sharing) is a deferrable nice-to-have (task 28).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1"] },
    { "id": 1, "tasks": ["2.1", "2.2", "4.1"] },
    { "id": 2, "tasks": ["4.2", "5.1"] },
    { "id": 3, "tasks": ["5.2", "5.4"] },
    { "id": 4, "tasks": ["5.3", "6.1"] },
    { "id": 5, "tasks": ["6.2", "6.3", "7.1"] },
    { "id": 6, "tasks": ["7.2", "8.1"] },
    { "id": 7, "tasks": ["8.2", "8.5"] },
    { "id": 8, "tasks": ["8.3", "8.4", "10.1"] },
    { "id": 9, "tasks": ["10.2", "11.1"] },
    { "id": 10, "tasks": ["11.2", "11.3", "12.1"] },
    { "id": 11, "tasks": ["12.2", "12.3", "13.1"] },
    { "id": 12, "tasks": ["13.2", "14.1"] },
    { "id": 13, "tasks": ["13.3", "13.4", "13.5", "14.2", "15.1"] },
    { "id": 14, "tasks": ["15.2", "16.1"] },
    { "id": 15, "tasks": ["16.2", "17.1"] },
    { "id": 16, "tasks": ["17.2", "18.1"] },
    { "id": 17, "tasks": ["17.3", "18.2", "19.1"] },
    { "id": 18, "tasks": ["19.2", "20.1"] },
    { "id": 19, "tasks": ["19.3", "20.2", "20.3", "21.1"] },
    { "id": 20, "tasks": ["21.2"] },
    { "id": 21, "tasks": ["21.3"] },
    { "id": 22, "tasks": ["21.4", "21.5", "23.1"] },
    { "id": 23, "tasks": ["23.2", "24.1"] },
    { "id": 24, "tasks": ["23.3", "23.4", "23.5", "23.6", "24.2", "25.1"] },
    { "id": 25, "tasks": ["25.2", "25.3", "26.1"] },
    { "id": 26, "tasks": ["25.4", "26.2"] },
    { "id": 27, "tasks": ["26.3", "26.4", "26.5", "26.6", "28.1"] },
    { "id": 28, "tasks": ["28.2"] }
  ]
}
```
