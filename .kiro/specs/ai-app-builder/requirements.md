# Requirements Document

## Introduction

This document specifies the requirements for **ai-app-builder**, a greenfield platform in the same class as Bolt, Replit, Lovable, Bubble, v0, Google AI Studio, and Rork. A user describes an application in natural language and receives a working, running project that can be iteratively refined through continued conversation, previewed live, and deployed.

The platform is built **on top of the existing `plumby` coding agent** (`/projects/sandbox/plumby`, see `PLAN.md` and `README.md`). Plumby supplies the proven code-generation engine — an agent loop, a tool registry (`read_file`, `write_file`, `edit_file`, `bash`, `grep`, `glob`, `verify`, `load_skill`, `spawn_subagent`), three model providers (anthropic, gemini, openrouter), streaming, context compaction, steering/skills for project context, sub-agents, a permission/safety classifier, and a web UI with Server-Sent-Events (SSE) streaming and visual diff rendering. Plumby is zero-dependency Node stdlib. The ai-app-builder **reuses** these capabilities rather than reinventing them; plumby becomes the generation engine underneath the builder.

The platform supports four target categories, all confirmed in scope:

1. Web apps (React/Next-style) with live in-browser preview
2. Full-stack web apps (frontend + backend + database)
3. Mobile apps (React Native / Expo)
4. Multi-target projects (web + mobile + backend together, with shared code)

A core product principle is that generated Projects are portable and free of platform lock-in: a user can export a Project and continue building it anywhere with no residual dependence on the platform. To uphold this, the platform vendors (pre-installs) the open-source `vendor-lockin-guard` and `devendor-project` Agent Skills into plumby's skills directory from the standalone upstream `agent-skills-lockin` repository, so the Builder_Agent has them available at session start and prevents lock-in as it generates code rather than leaving it to be discovered later.

Beyond those two lock-in skills, the platform ships a curated Skill_Library that users can extend with their own created or imported Skills, and it provides transparent, user-controlled, bounded memory — both per-Project and global — stored as human-readable files on disk, consistent with the anti-lock-in principle that memory must be owned, editable, and exportable by the user rather than trapped in a hidden profile.

## Glossary

- **AI_App_Builder**: The overall platform being specified; orchestrates the plumby agent, sandbox runtime, preview, persistence, and deployment.
- **Plumby_Engine**: The existing plumby agent core, reused as the code-generation and file-mutation engine (agent loop, tool registry, providers, permission classifier).
- **Builder_Agent**: An invocation of the Plumby_Engine scoped to a single Project, responsible for scaffolding and editing that Project's files.
- **Project**: A user's application under construction, consisting of source files, configuration, one or more Targets, and a version history.
- **Target**: A build output category within a Project. Valid values are `web`, `backend`, `mobile`, and `shared`.
- **Target_Category**: The Project-level classification selected at creation: `web`, `full-stack-web`, `mobile`, or `multi-target`.
- **Template**: A starter Project scaffold for a given Target_Category. A Template is only ONE of several Project_Origins and is not mandatory; a Project may instead be initialized blank, by GitHub import, or by fork.
- **Project_Origin**: How a Project is initialized. One of `blank`, `template`, `github-import`, or `fork`.
- **Blank_Project**: A Project created empty (no Template), with only the minimal files needed for the Sandbox and Dev_Server to start.
- **Repository_Import**: Initialization of a Project by cloning an existing Git repository (e.g., from GitHub) into the Project's Sandbox.
- **Fork**: Initialization of a Project by copying an existing accessible Project's file state as the new Project's starting state.
- **Sandbox**: A new, platform-built per-Project Isolation_Boundary — a container or virtual machine with filesystem, process, and network isolation plus resource limits — that the AI_App_Builder provisions and maintains, in which a Project's build, dev server, package installation, and generated code run. This isolation is BUILT by the AI_App_Builder and is not inherited from plumby: plumby contributes its pure Permission_Classifier (which gates whether a command runs) and its opt-in whole-agent Dockerfile as a starting point, but plumby provides no per-Project multi-tenant isolation of its own. The Permission_Classifier decides whether a command runs and does not by itself contain what a command does once running; the Isolation_Boundary is what contains a running command.
- **Isolation_Boundary**: The enforced per-Project container or virtual-machine boundary — filesystem, process, and network isolation plus resource limits — that the AI_App_Builder provisions and maintains so one Project's execution cannot observe or affect another Project or the host. The Permission_Classifier gates whether a command runs; the Isolation_Boundary contains what a running command can reach.
- **Preview**: A live, interactive running instance of a Project served to the user — in-browser for `web`, and via an Expo-compatible runtime for `mobile`.
- **Dev_Server**: The process inside the Sandbox that serves the Preview and rebuilds on file change.
- **Activity_Stream**: The live, ordered feed surfaced to the user during a generation turn, composed of the Builder_Agent's streamed reasoning/text (plumby `text_delta` events) and its tool actions (read_file, write_file, edit_file, bash, verify, etc.), with file changes rendered inline as Diffs.
- **Package_Manager**: The dependency installer invoked inside the Sandbox (e.g., npm) to resolve a Project's declared dependencies.
- **Database_Service**: A provisioned data store attached to a full-stack or multi-target Project.
- **Connector**: A managed integration between a Project and an external third-party service (e.g., database, auth, payments, hosting, storage), providing credential capture, configuration, and Secret injection into the Sandbox.
- **Connector_Catalog**: The set of Connectors the AI_App_Builder offers, each identified by a service and category.
- **Connector_Category**: The class of a Connector. Supported categories: `database`, `auth`, `payments`, `hosting-deploy`, `storage`, `ai-model`.
- **Secret**: A named, sensitive configuration value (e.g., API key, connection string) associated with a Project and injected into the Sandbox environment.
- **Diff**: A line-level change set produced when the Builder_Agent edits a file, rendered visually (added/removed lines) via plumby's diff renderer.
- **User_Account**: An authenticated identity that owns Projects, Skills, Global_Memory, Connectors, and settings, and against which authorization decisions are made.
- **Authorization**: The determination of whether a given User_Account may perform an action on a resource (e.g., read/modify a Project, import a repository, fork a Project, create or open a Share_Link).
- **Permission_Classifier**: Plumby's pure command classifier that sorts a command into `allow`, `confirm`, or `refuse`. The Permission_Classifier gates whether a command runs; it is not an isolation mechanism and does not contain what a command does once it is allowed to run.
- **Verify_Result**: The structured `verdict: PASS | FAIL` plus exit code returned by plumby's `verify` tool.
- **Self_Healing**: The loop in which the AI_App_Builder detects a build or runtime error and drives the Builder_Agent to correct it automatically.
- **Session**: A single continuous period of user interaction with a Project.
- **Snapshot**: A committed, restorable version of a Project's full file state.
- **Deployment_Artifact**: A build output package suitable for deploying a Target to a hosting destination.
- **Share_Link**: A URL granting read access to a Project or its live Preview.
- **Portability**: The property that a generated Project can be exported and continued outside the AI_App_Builder with no residual dependence on the platform — no platform telemetry, no injected platform branding, no enforcement rules that fail a build when platform code is removed, and a complete data/credential export path.
- **Lockin_Audit**: An automated check applied to a generated Project that reports any platform or vendor lock-in signals — telemetry/beacons, injected UI/badges, hardcoded platform hosts, enforcement lint/convention rules, hash-protected files, and undeclared outbound hosts.
- **Devendor_Skill**: The `devendor-project` Agent Skill (removes existing lock-in), available to the Builder_Agent via plumby's skills mechanism.
- **Guard_Skill**: The `vendor-lockin-guard` Agent Skill (detects and prevents lock-in), available to the Builder_Agent via plumby's skills mechanism.
- **Skills_Source_Repository**: The standalone, MIT-licensed `agent-skills-lockin` repository that already exists independently and is the upstream source of truth for the Guard_Skill and Devendor_Skill. "Kept in sync" means a defined, explicit vendoring/update step — copying the SKILL.md folders from this repository into plumby's skills directory as part of the platform's build/release process — NOT an automatic runtime dependency or live fetch. The Skills_Source_Repository remains independently usable by other Agent Skills-compatible tools.
- **Skill**: A unit of on-demand instruction in the open Agent Skills format (a SKILL.md with at least `name` and `description` frontmatter plus an instruction body), loaded by the Builder_Agent via plumby's progressive-disclosure skills mechanism.
- **Stocked_Skill**: A Skill pre-installed (vendored) with the platform as part of a curated starter library available to every Project by default.
- **User_Skill**: A Skill a user creates or imports into their own skill library, available to that user's Projects.
- **Skill_Library**: The collection of Skills available to the Builder_Agent for a Project — the Stocked_Skills plus the user's User_Skills.
- **Project_Memory**: Persistent, human-readable memory scoped to a single Project, stored as files on disk, that carries decisions, preferences, and context across Sessions for that Project.
- **Global_Memory**: Persistent, human-readable memory scoped to a user across all their Projects, capturing durable preferences, conventions, and recurring corrections.
- **Memory_Entry**: A single, individually viewable and editable item within Project_Memory or Global_Memory.
- **Memory_Mode**: A user-controlled setting governing automatic memory management, selectable in the user's profile settings. One of `auto` (summarize and evict oldest when the Memory_Cap is reached), `manual` (freeze at the Memory_Cap, notify the user, and require the user to prune manually — automatic summarization and eviction are turned off), or `off` (no automatic learning; memory holds only entries the user explicitly adds). Memory_Mode `auto` is the default and applies to every user until the user manually selects `manual` or `off`, so automatic memory learning is on by default. Under every Memory_Mode the user may manually prune Memory_Entries at any time.
- **Memory_Cap**: The configured maximum size of a memory store, beyond which Memory_Mode governs behavior.
- **Project_Export**: A downloadable, self-contained copy of a Project's full file state suitable for continuing development outside the AI_App_Builder (e.g., a standard Git repository or archive).
- **Standard_Toolchain**: Publicly available, documented development tools (compilers, package managers, build tools) that contain no AI_App_Builder-proprietary or AI_App_Builder-account-gated component.
- **Service_Level_Objective (SLO)**: A target that must hold for a stated percentage of operations under normal load (e.g., "95% of operations within N seconds"), rather than a hard guarantee for every single operation.
- **Rate_Limit**: A configured ceiling on the number of resource-creating operations a User_Account may perform within a time window (e.g., Project creations, builds, deployments, or generation turns per minute).
- **Resource_Quota**: A configured ceiling on the resources a User_Account or Project may consume concurrently or in total (e.g., maximum concurrent Sandboxes, maximum total Projects, and the per-Sandbox CPU/memory/execution-time limits).
- **Encryption_At_Rest**: The property that a stored value is persisted in encrypted form on disk so that the raw value is not recoverable from the stored bytes without the decryption key.

## Requirements

### Requirement 1: Natural-Language App Creation

**User Story:** As a builder user, I want to describe an application in plain language and receive a working, running project, so that I can start from an idea without writing scaffolding by hand.

#### Acceptance Criteria

1. WHEN a user submits a natural-language description (1–5,000 characters after trimming whitespace), selects a Target_Category that is one of `web`, `full-stack-web`, `mobile`, or `multi-target`, and selects a Project_Origin that is one of `blank`, `template`, `github-import`, or `fork`, THE AI_App_Builder SHALL begin Project creation — recording the Project and allocating its Sandbox so the Project becomes available for streaming — within 10 seconds for at least 95% of such requests under normal load as a Service_Level_Objective, acknowledging that cold Sandbox or container provisioning may occasionally exceed this bound; this criterion covers the start of creation and not a finished Project, while origin population completes within the origin-specific bounds defined in the Project Scaffolding and Templates requirement (Template population) and the Project Origins requirement (`github-import` clone).
2. WHEN a Project is created from a description, THE Builder_Agent SHALL generate the Project source files by invoking the Plumby_Engine.
3. WHEN Project generation completes and a Verify_Result reports verdict PASS, THE AI_App_Builder SHALL start the Dev_Server and make a Preview available within 60 seconds of Dev_Server start.
4. IF a user submits a description that is empty or shorter than 1 character after trimming whitespace, THEN THE AI_App_Builder SHALL reject the request, SHALL NOT create a Project, and SHALL return a message requesting a description.
5. IF a user selects a Target_Category that is not one of `web`, `full-stack-web`, `mobile`, or `multi-target`, THEN THE AI_App_Builder SHALL reject the request, SHALL NOT create a Project, and SHALL return an error indicating the Target_Category is unsupported.
6. IF a user selects a Project_Origin that is not one of `blank`, `template`, `github-import`, or `fork`, THEN THE AI_App_Builder SHALL reject the request, SHALL NOT create a Project, and SHALL return an error indicating the Project_Origin is unsupported.
7. IF Project generation produces a Verify_Result reporting verdict FAIL, THEN THE AI_App_Builder SHALL report the failure with the captured error output, SHALL NOT start the Dev_Server, and SHALL retain the Project files in an editable state.
8. THE AI_App_Builder SHALL treat the numeric timing bounds stated throughout these requirements as targets under normal load, and WHERE a bound is stated as a Service_Level_Objective THE AI_App_Builder SHALL evaluate that bound against the stated percentage of operations rather than as a hard guarantee for every individual operation.

### Requirement 2: Iterative Refinement via Chat

**User Story:** As a builder user, I want to keep chatting to change my app, so that I can refine it incrementally instead of regenerating from scratch.

#### Acceptance Criteria

1. WHEN a user submits a refinement message for an existing Project, THE Builder_Agent SHALL apply the requested changes only to the files within that existing Project and SHALL NOT create a new Project or regenerate existing files from scratch.
2. WHEN the Builder_Agent modifies an existing file, THE Builder_Agent SHALL apply the change using plumby's `edit_file` exact-string replacement, matching a single contiguous target string in the file.
3. WHEN a file is modified, THE AI_App_Builder SHALL render the change as a visual Diff showing each added line and each removed line within 2 seconds of the modification completing.
4. WHEN a refinement is applied, THE AI_App_Builder SHALL preserve every byte of Project content outside the edited regions unchanged, including files not targeted by the refinement.
5. IF a requested edit's target string matches zero locations or more than one location in the target file, THEN THE Builder_Agent SHALL report a failure indicating that the edit target was not uniquely located and SHALL leave the target file unchanged.
6. IF the target file for a requested edit does not exist in the Project, THEN THE Builder_Agent SHALL report a failure indicating the file was not found and SHALL leave all Project files unchanged.
7. WHEN a refinement message references no actionable change to any Project file, THE Builder_Agent SHALL report that no changes were applied and SHALL leave all Project files unchanged.

### Requirement 3: Live Preview

**User Story:** As a builder user, I want a running preview of my app that I can interact with, so that I can see the effect of each change immediately.

#### Acceptance Criteria

1. WHILE a `web` Target Dev_Server is running, THE AI_App_Builder SHALL serve an interactive in-browser Preview of the Project that reflects the current committed Project state and accepts user input events (clicks, keyboard, form entry).
2. WHERE a Project has a `mobile` Target, THE AI_App_Builder SHALL provide an Expo-compatible Preview accessible via a device or emulator, and SHALL display connection instructions (including a scannable QR code and a connection URL) to the user.
3. WHEN a Project file change is committed as a Snapshot, THE AI_App_Builder SHALL update the Preview to reflect the committed Project state within 5 seconds of the Snapshot being committed.
4. IF a committed Snapshot fails to compile or build, THEN THE AI_App_Builder SHALL retain the last successfully-built Preview, SHALL display the captured build error output, and SHALL indicate that the Preview is showing a prior Project state.
5. WHILE the Dev_Server is starting, THE AI_App_Builder SHALL display a preview-loading status to the user, and IF the Dev_Server does not become ready within 60 seconds, THEN THE AI_App_Builder SHALL display a startup-timeout error and SHALL offer to restart the Dev_Server.
6. IF the Dev_Server exits unexpectedly, THEN THE AI_App_Builder SHALL display the captured error output, SHALL preserve the current Project state, and SHALL offer to restart the Dev_Server.
7. WHEN the user requests a Dev_Server restart, THE AI_App_Builder SHALL attempt to restart the Dev_Server up to 3 times, and IF all 3 restart attempts fail, THEN THE AI_App_Builder SHALL display a persistent-failure error and SHALL stop further automatic restart attempts.

### Requirement 4: Live Activity and Thinking Stream

**User Story:** As a builder user, I want to see the AI's reasoning and the actions it is taking as it works, so that I understand what is happening and can trust the changes being made.

#### Acceptance Criteria

1. WHILE a Builder_Agent generation turn is in progress, THE AI_App_Builder SHALL stream the Builder_Agent's generated reasoning/text to the user's Activity_Stream as it is produced (via plumby `text_delta` events), without waiting for the turn to complete.
2. WHEN the Builder_Agent invokes a tool (read_file, write_file, edit_file, bash, grep, glob, verify, load_skill, or spawn_subagent), THE AI_App_Builder SHALL surface that tool action in the Activity_Stream in the order it occurred.
3. WHEN a tool action modifies a file, THE AI_App_Builder SHALL render the corresponding change inline in the Activity_Stream as a Diff.
4. THE AI_App_Builder SHALL present the Activity_Stream and the Preview concurrently, such that the user can view the reasoning/actions feed and the running Preview at the same time.
5. WHEN a generation turn completes, THE AI_App_Builder SHALL indicate turn completion in the Activity_Stream.
6. WHERE captured tool output shown in the Activity_Stream exceeds plumby's per-stream cap, THE AI_App_Builder SHALL truncate it with a truncation notice indicating output was omitted.

### Requirement 5: Project Scaffolding and Templates

**User Story:** As a builder user, I want starter templates per target category, so that new projects begin from a sensible, runnable baseline.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL provide at least one Template for each Target_Category: `web`, `full-stack-web`, `mobile`, and `multi-target`.
2. WHEN a Project is created from a Template, THE AI_App_Builder SHALL populate the Project with all of the Template's files and its dependency manifest within 30 seconds for at least 95% of Templates under normal load as a Service_Level_Objective, where population time scales with Template size so that larger Templates may take proportionally longer.
3. IF a Project is created from a Template and one or more Template files or the dependency manifest fail to be written, THEN THE AI_App_Builder SHALL abort creation, remove any partially written Project files, and return an error indicating which artifact failed to populate.
4. WHEN a Template is instantiated, THE AI_App_Builder SHALL produce a Project whose baseline build completes with a zero (success) exit status and no build errors before any user refinement.
5. IF a Template's baseline build does not complete with a success exit status within 300 seconds of build start, THEN THE AI_App_Builder SHALL mark the instantiation as failed and return an error indicating the build failure.
6. WHERE a user selects the `multi-target` Target_Category, THE AI_App_Builder SHALL scaffold exactly four Targets — `web`, `backend`, `mobile`, and `shared` — within a single Project.
7. IF a user selects a Target_Category that is not one of `web`, `full-stack-web`, `mobile`, or `multi-target`, THEN THE AI_App_Builder SHALL reject the request, create no Project, and return an error indicating the Target_Category is unsupported.

### Requirement 6: Project Origins (Blank, Template, GitHub Import, Fork)

**User Story:** As a builder user, I want to start a project blank, from a template, by importing a GitHub repository, or by forking an existing project, so that I am not forced into a template and can begin from wherever my work already lives.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL support four Project_Origins: `blank`, `template`, `github-import`, and `fork`.
2. WHEN a user creates a Project with Project_Origin `blank`, THE AI_App_Builder SHALL create a Project containing only the minimal files required for the Sandbox and Dev_Server to start, with no Template applied.
3. WHEN a user creates a Project with Project_Origin `template`, THE AI_App_Builder SHALL initialize the Project from the Template matching the selected Target_Category.
4. WHEN a user creates a Project with Project_Origin `github-import` referencing a small repository (up to 100 MB) the user is authorized to access, THE AI_App_Builder SHALL clone the repository into the Project's Sandbox within 120 seconds as a Service_Level_Objective under normal load and use its contents as the Project's starting file state.
5. WHERE a `github-import` references a repository larger than 100 MB, THE AI_App_Builder SHALL report ongoing clone progress to the user and SHALL apply a configurable maximum clone time (default 600 seconds), and IF the clone exceeds the configured maximum clone time, THEN THE AI_App_Builder SHALL abort the import with its cause, SHALL NOT create a partially imported Project, and SHALL leave no orphaned Sandbox running.
6. IF a `github-import` repository reference is invalid, inaccessible, or the clone exceeds the applicable maximum clone time, THEN THE AI_App_Builder SHALL report the import failure with its cause, SHALL NOT create a partially imported Project, and SHALL leave no orphaned Sandbox running.
7. WHEN a user creates a Project with Project_Origin `fork` referencing an existing Project the user is authorized to access, THE AI_App_Builder SHALL create a new Project whose starting file state is a copy of the referenced Project's most recent Snapshot, independent of the original.
8. IF a `fork` references a Project that does not exist or that the user is not authorized to access, THEN THE AI_App_Builder SHALL reject the request and SHALL NOT create a Project.
9. WHEN a Project is created from any Project_Origin, THE AI_App_Builder SHALL proceed to the same iterative refinement, Preview, persistence, and verify/self-healing behavior as any other Project.

### Requirement 7: Authentication and Authorization

**User Story:** As a builder user, I want my account, projects, and data protected behind authentication and authorization, so that only I (and people I explicitly permit) can access or change my work.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL require a User_Account to be authenticated before creating, opening, or modifying a Project.
2. WHEN an unauthenticated request attempts to access or modify a Project, THE AI_App_Builder SHALL deny the request and SHALL NOT disclose the Project's contents.
3. THE AI_App_Builder SHALL associate every Project, User_Skill, Global_Memory store, Connector, and Secret with an owning User_Account.
4. WHEN a User_Account attempts an action on a resource the User_Account does not own or has not been granted access to, THE AI_App_Builder SHALL deny the action via Authorization and return an access-denied indication.
5. WHERE a requirement refers to a user being "authorized to access" a repository, Project, or Share_Link, THE AI_App_Builder SHALL determine that authorization against the requesting User_Account.
6. WHEN a user authenticates, THE AI_App_Builder SHALL scope Builder_Agent sessions, Projects, and memory to that User_Account.

### Requirement 8: Sandboxed Execution and Runtime

**User Story:** As a builder user, I want each generated app to run in an isolated sandbox, so that untrusted generated code and installs cannot affect other projects or the host.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL provision an Isolation_Boundary for each Project that isolates that Project's filesystem, processes, and network from every other Project and from the host.
2. THE AI_App_Builder SHALL apply resource limits, at minimum CPU, memory, and execution-time limits, to each Project's Sandbox.
3. WHEN a Project runs its build, Dev_Server, or package installation, THE AI_App_Builder SHALL execute those operations inside the Project's Sandbox, within the provisioned Isolation_Boundary.
4. THE AI_App_Builder SHALL restrict each Project's file-system access and running processes to that Project's Isolation_Boundary only.
5. THE AI_App_Builder SHALL enforce the Isolation_Boundary independently of the Permission_Classifier, such that isolation holds even for commands the Permission_Classifier classifies as `allow`.
6. IF a command executed on behalf of a Project attempts to access another Project's Sandbox or the host outside the Isolation_Boundary, THEN THE AI_App_Builder SHALL block the access, preserve the target state unchanged, and return a denied error indication.
7. WHEN a command is executed inside a Sandbox, THE AI_App_Builder SHALL route the command through plumby's Permission_Classifier before execution, on top of the enforced Isolation_Boundary.
8. IF the Permission_Classifier is unavailable or does not return a classification within 10 seconds, THEN THE AI_App_Builder SHALL NOT execute the command and SHALL return an error indication that the command could not be classified.
9. IF the Permission_Classifier classifies a command as `refuse`, THEN THE AI_App_Builder SHALL block the command, SHALL NOT execute it, and SHALL return an error indication.
10. IF the Permission_Classifier classifies a command as `confirm`, THEN THE AI_App_Builder SHALL request user confirmation before executing the command, SHALL execute the command only if confirmation is granted within 60 seconds, and SHALL deny the command if confirmation is not granted within 60 seconds.

### Requirement 9: Full-Stack Support

**User Story:** As a builder user, I want backend services, a database, and API endpoints, so that I can build applications with persistent server-side behavior.

#### Acceptance Criteria

1. WHERE a Project has a `full-stack-web` or `multi-target` Target_Category, THE AI_App_Builder SHALL scaffold a `backend` Target containing at least one reachable API endpoint that returns a non-error HTTP response (status code below 400) when invoked in the Sandbox.
2. WHEN a full-stack Project is created, THE AI_App_Builder SHALL provision a Database_Service for the Project within 60 seconds and SHALL report the Database_Service as ready before scaffolding is marked complete.
3. IF Database_Service provisioning does not complete within 60 seconds or returns a failure, THEN THE AI_App_Builder SHALL report a provisioning error indicating the failure cause and SHALL mark the Project scaffolding as incomplete without leaving a partially provisioned Database_Service in an active state.
4. WHEN the Builder_Agent generates or changes a database schema, THE AI_App_Builder SHALL apply the corresponding migration to the Database_Service through the confirm-gated command path within 120 seconds and SHALL report the applied schema version on success.
5. IF a database migration fails or exceeds 120 seconds, THEN THE AI_App_Builder SHALL report a migration error indicating the failure cause and SHALL leave the prior schema state in effect with no partial changes applied.
6. WHEN a user defines a Secret for a Project, THE AI_App_Builder SHALL inject the Secret value into the Sandbox environment at runtime.
7. WHEN a user defines a Secret for a Project, THE AI_App_Builder SHALL exclude the Secret value from all generated source files, such that no generated source file contains the literal Secret value.

### Requirement 10: Managed Connectors to External Services

**User Story:** As a builder user, I want first-class managed connectors to services like databases, auth, payments, hosting, and storage, so that my app can integrate with them without me hand-wiring credentials.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL provide a Connector_Catalog covering these Connector_Categories: `database` (e.g., Supabase, Neon), `auth` (e.g., Clerk, Auth0), `payments` (e.g., Stripe), `hosting-deploy` (e.g., Vercel, Netlify, Expo EAS), `storage`, and `ai-model`.
2. WHEN a user selects a Connector from the Connector_Catalog for a Project, THE AI_App_Builder SHALL initiate the Connector's credential capture flow (OAuth authorization or API-key entry, as applicable to that Connector).
3. WHEN a Connector's credential capture completes successfully, THE AI_App_Builder SHALL store the resulting credential as a Secret and SHALL inject it into the Project's Sandbox environment at runtime.
4. THE AI_App_Builder SHALL exclude every Connector credential value from all generated source files, such that no generated source file contains the literal credential value.
5. WHEN a Connector is added to a Project, THE AI_App_Builder SHALL make the Builder_Agent aware of the Connector so it can generate integration code that references the injected Secret rather than a literal credential.
6. IF a Connector's credential capture fails, is cancelled, or is denied, THEN THE AI_App_Builder SHALL report the failure, SHALL NOT store a partial credential, and SHALL leave the Project's existing Connectors and Secrets unchanged.
7. WHEN a user removes a Connector from a Project, THE AI_App_Builder SHALL revoke the associated Secret's injection into the Sandbox and SHALL report the removal.
8. WHERE a Connector is a `hosting-deploy` Connector, THE AI_App_Builder SHALL use it as a deployment destination for the Project's Deployment_Artifact, routing any deploy command through plumby's Permission_Classifier.

### Requirement 11: Generated Project Portability (No Lock-In)

**User Story:** As a builder user, I want the projects the platform generates to be genuinely mine and free of platform lock-in, so that I can export my project and keep building it anywhere without the platform's tooling fighting me.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL generate Projects that contain no AI_App_Builder telemetry, beacon, or phone-home code, defined as no source code, dependency, build-tool plugin, or configuration that transmits data to any AI_App_Builder-controlled host at build time or run time.
2. THE AI_App_Builder SHALL generate Projects that contain no injected AI_App_Builder branding, badge, or watermark rendered in, or embedded in, the Project's shipped output.
3. THE AI_App_Builder SHALL NOT add any lint rule, convention rule, or hash-protected file to a generated Project whose effect is to fail the Project's build, test run, or startup when AI_App_Builder-specific code is removed.
4. WHEN a Connector injects credentials, THE AI_App_Builder SHALL reference those credentials only through injected Secrets (environment configuration), such that no hardcoded platform host or literal credential value is written into the Project's source files; this criterion is the PRIMARY mechanism for keeping credentials and platform hosts out of Project source files.
5. IF, during Project generation, the AI_App_Builder would write a literal credential value or a hardcoded AI_App_Builder platform host into a Project source file, THEN THE AI_App_Builder SHALL replace it with an environment-variable reference and SHALL record the substitution in a report available to the user; this criterion is a SECONDARY safety net behind criterion 4 that should rarely trigger when criterion 4 is operating correctly.
6. WHEN a user requests a Project_Export, THE AI_App_Builder SHALL produce a self-contained copy of the Project's full file state that builds and runs outside the AI_App_Builder using a Standard_Toolchain, without requiring an AI_App_Builder account or any network access to an AI_App_Builder-controlled host, completing within 300 seconds for a Project within the configured file-count limit as a Service_Level_Objective under normal load.
7. IF a Project_Export fails to complete or cannot produce a self-contained copy, THEN THE AI_App_Builder SHALL abort the export, retain the Project's stored state unchanged, and return an error indication identifying the reason for the failure.
8. WHEN a Project_Export is produced, THE AI_App_Builder SHALL exclude every Secret and Connector credential value from the exported files and SHALL instead include a template that lists every required environment variable name with no accompanying value.
9. THE AI_App_Builder SHALL apply a configurable maximum file-count (default 10,000 files) to a single Project_Export or Lockin_Audit operation, and IF a Project exceeds the configured maximum file-count for the requested operation, THEN THE AI_App_Builder SHALL report the excess to the user rather than silently truncating the operation.
10. WHEN a user runs a Lockin_Audit on a Project within the configured file-count limit, THE AI_App_Builder SHALL complete the audit within 120 seconds as a Service_Level_Objective under normal load and SHALL report each detected lock-in signal (telemetry/beacons, injected UI, hardcoded platform hosts, enforcement rules, hash-protected files, undeclared outbound hosts) with file path and line number evidence, or SHALL report that no lock-in signals were found.
11. WHERE a prior Lockin_Audit result exists for a Project, THE AI_App_Builder MAY scan only the files changed since the last audit and combine the result with the prior findings, provided the combined report still reflects the current Project state.
12. IF a Lockin_Audit encounters a file it cannot scan, THEN THE AI_App_Builder SHALL report that file as an unverified surface in the audit results rather than omitting it silently.
13. WHERE a Lockin_Audit reports a lock-in signal in AI_App_Builder-generated code, THE AI_App_Builder SHALL treat it as a defect to be corrected rather than a required feature.

### Requirement 12: Lock-In Awareness Skills Available to the Builder Agent

**User Story:** As a builder user, I want the AI to understand and actively avoid vendor lock-in when it generates and edits my project, so that lock-in is prevented as the code is written rather than discovered later.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL vendor the Guard_Skill and the Devendor_Skill as pre-installed copies in plumby's skills directory, such that they are discoverable by the Builder_Agent at session start with no runtime fetch, copy, or tool call required to obtain them.
2. THE AI_App_Builder SHALL represent each vendored skill as a SKILL.md file whose YAML frontmatter provides at minimum a `name` and a `description`.
3. WHEN the Builder_Agent session starts, THE AI_App_Builder SHALL expose to the Builder_Agent only the `name` and `description` of the Guard_Skill and the Devendor_Skill (progressive disclosure), where each `description` shown in the startup listing is clipped to at most 500 characters and the combined skill-listing block is capped at 16 KiB with a visible truncation notice if it overflows.
4. WHEN the Builder_Agent requests a listed skill by its exact `name`, THE AI_App_Builder SHALL return the full SKILL.md instruction body (frontmatter stripped) truncated to at most 64 KiB, appending a visible truncation notice when any content is dropped.
5. WHEN a user asks to remove lock-in, escape a platform, or de-couple from a vendor, THE Builder_Agent SHALL load the Devendor_Skill by name and apply its phased methodology.
6. WHEN the Builder_Agent evaluates adding a dependency, SDK, template, or Connector, THE Builder_Agent SHALL load the Guard_Skill by name and apply its lock-in scorecard and red-flag checks.
7. IF the Builder_Agent requests a skill whose `name` does not match any registered skill, THEN THE AI_App_Builder SHALL reject the request with an error that lists the available skill names and SHALL make no change to the project.
8. IF a requested skill is registered but its SKILL.md file cannot be read (for example, the file is missing) or its instruction body is empty after frontmatter is removed, THEN THE AI_App_Builder SHALL return an error indicating that the skill body is unavailable or empty and SHALL make no change to the project.
9. IF the resolved SKILL.md path for a requested skill falls outside the skills directory tree, THEN THE AI_App_Builder SHALL refuse to load it with an error indicating the path is outside the skills directory and SHALL make no change to the project.
10. IF a skill's SKILL.md frontmatter omits `name`, THEN THE AI_App_Builder SHALL use the skill's directory name as its invocation name; IF two registered skills resolve to the same invocation name, THEN THE AI_App_Builder SHALL keep the first one discovered and ignore the later duplicate.
11. WHERE the Builder_Agent performs a destructive lock-in-removal operation identified by the Devendor_Skill, THE AI_App_Builder SHALL route the operation through plumby's Permission_Classifier before executing it, such that: IF the operation is unrecoverable (for example, rewriting git history with filter-branch or filter-repo), THEN THE AI_App_Builder SHALL refuse it and SHALL NOT execute it even with user consent; and IF the operation is recoverable only with consent (deleting a vendor project, rotating or revoking a credential, running a migration, force-pushing, or changing DNS), THEN THE AI_App_Builder SHALL require an explicit user confirmation before executing it.
12. IF the user declines confirmation for a recoverable destructive operation, THEN THE AI_App_Builder SHALL not execute that operation and SHALL leave the project in its pre-operation state.
13. THE AI_App_Builder SHALL preserve the Devendor_Skill and Guard_Skill in their open Agent Skills format (a SKILL.md file with `name` and `description` YAML frontmatter) so they remain usable by other Agent Skills-compatible tools.
14. THE AI_App_Builder SHALL treat the Skills_Source_Repository as the upstream source of truth for the Guard_Skill and the Devendor_Skill, keeping the vendored copies in plumby in sync with it while the Skills_Source_Repository remains an independent repository usable by other Agent Skills-compatible tools.
15. THE AI_App_Builder SHALL perform the vendoring/sync of the Guard_Skill and the Devendor_Skill from the Skills_Source_Repository as an explicit build/release-time step that copies the SKILL.md folders into plumby's skills directory, and SHALL NOT fetch the Skills_Source_Repository at Builder_Agent runtime.

### Requirement 13: Skill Library (Stocked, User-Created, and Imported Skills)

**User Story:** As a builder user, I want a library of ready-made skills plus the ability to create and import my own, so that the AI can apply reusable expertise and I can extend it with my own workflows.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL provide a curated set of Stocked_Skills, pre-installed and available to every Project's Builder_Agent by default, each in the open Agent Skills format (a SKILL.md with at least `name` and `description` frontmatter).
2. THE AI_App_Builder SHALL load the Skill_Library by progressive disclosure, exposing only each Skill's `name` and `description` at Builder_Agent session start and loading a Skill's full instruction body only when the Builder_Agent requests it by name.
3. WHEN a user creates a User_Skill by providing a `name`, a `description`, and an instruction body, THE AI_App_Builder SHALL add the User_Skill to that user's Skill_Library and make it available to the user's Projects.
4. WHEN a user imports a Skill in the open Agent Skills format, THE AI_App_Builder SHALL validate that the Skill contains at least a `name` and a `description` and SHALL add the Skill to the user's Skill_Library.
5. IF an imported Skill is missing a `name` or a `description`, or is not in the open Agent Skills format, THEN THE AI_App_Builder SHALL reject the import with an error identifying the missing or invalid field and SHALL NOT add the Skill to the Skill_Library.
6. WHEN a User_Skill's `name` would collide with an existing Skill available to the user, THE AI_App_Builder SHALL namespace the User_Skill under the owning User_Account (for example, an invocation name of the form `user/skill-name`) so that the user can still add it, and IF a collision remains even within the user's own namespace, THEN THE AI_App_Builder SHALL reject the addition with a naming-collision error and SHALL leave the existing Skill unchanged.
7. THE AI_App_Builder SHALL reserve a base namespace for Stocked_Skills and vendored lock-in Skills (the Guard_Skill and the Devendor_Skill), such that a User_Skill SHALL NOT overwrite a Stocked_Skill or a vendored lock-in Skill.
8. WHEN a user edits or deletes a User_Skill, THE AI_App_Builder SHALL apply the change to the user's Skill_Library and SHALL leave every Stocked_Skill unchanged.
9. THE AI_App_Builder SHALL keep every Skill in the open Agent Skills format so that Skills remain usable by, and importable from, other Agent Skills-compatible tools.

### Requirement 14: Persistent Memory Across Chats

**User Story:** As a builder user, I want the AI to remember useful context across chats — both per project and across all my projects — while keeping that memory transparent, editable, and under my control, so that I get continuity without a hidden or unbounded profile.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL maintain Project_Memory for each Project as human-readable files on disk, persisted with the Project and restored when the Project is reopened in a new Session.
2. THE AI_App_Builder SHALL maintain Global_Memory for each user as human-readable files on disk, available to the Builder_Agent across all of that user's Projects.
3. WHERE a user has not selected a Memory_Mode, THE AI_App_Builder SHALL apply Memory_Mode `auto` as the default for that user, such that automatic memory learning is enabled for every user until the user manually selects a different Memory_Mode.
4. WHERE the applicable Memory_Mode is `auto`, THE AI_App_Builder SHALL allow the Builder_Agent to add or update Memory_Entries automatically as the Builder_Agent identifies durable preferences, decisions, or recurring corrections.
5. THE AI_App_Builder SHALL allow the user to view, edit, and delete any individual Memory_Entry in Project_Memory or Global_Memory at any time, regardless of Memory_Mode.
6. THE AI_App_Builder SHALL allow the user to export Project_Memory and Global_Memory as human-readable files.
7. THE AI_App_Builder SHALL enforce a Memory_Cap on each memory store.
8. WHERE Memory_Mode is `auto` and a memory store reaches the Memory_Cap, THE AI_App_Builder SHALL summarize older Memory_Entries and evict the oldest Memory_Entries to remain within the Memory_Cap while preserving the summarized gist.
9. WHERE Memory_Mode is `manual` and a memory store reaches the Memory_Cap, THE AI_App_Builder SHALL stop adding new Memory_Entries, notify the user that memory is full, and require the user to prune before further automatic additions.
10. WHERE Memory_Mode is `off`, THE AI_App_Builder SHALL add no Memory_Entries automatically and SHALL store only Memory_Entries the user explicitly adds.
11. WHEN a user changes the Memory_Mode in the user's profile settings, THE AI_App_Builder SHALL apply the selected Memory_Mode to subsequent memory management.
12. THE AI_App_Builder SHALL allow the user to manually prune Memory_Entries from Project_Memory and Global_Memory at any time, regardless of the selected Memory_Mode.
13. THE AI_App_Builder SHALL store all memory in human-readable, user-owned files with no hidden or non-exportable memory state.

### Requirement 15: Mobile Support

**User Story:** As a builder user, I want Expo/React Native project generation, preview, and build, so that I can produce mobile apps from the same platform.

#### Acceptance Criteria

1. WHERE a Project has a `mobile` or `multi-target` Target_Category, THE AI_App_Builder SHALL scaffold an Expo/React Native `mobile` Target within 30 seconds, completing with a zero (success) exit status.
2. WHEN a `mobile` Target Dev_Server is running, THE AI_App_Builder SHALL expose an Expo-compatible Preview endpoint reachable within 60 seconds of Dev_Server start.
3. IF the Expo-compatible Preview endpoint does not become reachable within 60 seconds, THEN THE AI_App_Builder SHALL report the preview unavailability with its cause and SHALL retain any prior reachable Preview.
4. WHEN a user requests a mobile build, THE AI_App_Builder SHALL produce a Deployment_Artifact for the `mobile` Target within a configurable mobile-build-execution timeout defaulting to 1800 seconds, measured from when the build actually starts executing and excluding any time the build is queued on a shared build service, with the build completing at a zero (success) exit status and the artifact present.
5. WHILE a mobile build is queued on a shared build service, THE AI_App_Builder SHALL report the queued status to the user and SHALL NOT count queue time against the mobile-build-execution timeout.
6. IF a required mobile toolchain component is unavailable in the Sandbox, THEN THE AI_App_Builder SHALL report the specific missing component, SHALL NOT report the build as successful, and SHALL leave existing files and any prior artifacts unchanged.
7. IF a mobile build's execution exceeds the configured mobile-build-execution timeout (default 1800 seconds, measured from build-execution start and excluding queue time) or completes with a non-zero exit status, THEN THE AI_App_Builder SHALL report the build failure with its cause and SHALL NOT produce a Deployment_Artifact.

### Requirement 16: Multi-Target Projects

**User Story:** As a builder user, I want web, mobile, and backend coordinated in one project with shared code, so that I can maintain a single source of truth across platforms.

#### Acceptance Criteria

1. WHERE a Project has the `multi-target` Target_Category, THE AI_App_Builder SHALL maintain exactly four Targets within one Project: `web`, `mobile`, `backend`, and `shared`.
2. WHEN the Builder_Agent completes a modification to code in the `shared` Target, THE AI_App_Builder SHALL make the modified `shared` code available to the `web`, `mobile`, and `backend` Targets within 5 seconds of the modification completing.
3. IF a modification to the `shared` Target fails validation or cannot be propagated to one or more of the `web`, `mobile`, or `backend` Targets, THEN THE AI_App_Builder SHALL retain the last successfully propagated version of the `shared` code in all Targets and present an error indication identifying which Target(s) failed to receive the update.
4. WHEN a user runs a Preview for a multi-target Project, THE AI_App_Builder SHALL present a selection control listing each of the `web`, `mobile`, and `backend` Targets and SHALL preview only the single Target selected by the user.
5. IF a user runs a Preview for a multi-target Project without selecting a Target, THEN THE AI_App_Builder SHALL preview the `web` Target as the default and SHALL indicate that the default Target was used.
6. WHEN a multi-target Project is built, THE AI_App_Builder SHALL produce exactly one Deployment_Artifact for each Target explicitly requested by the user, and SHALL NOT produce a Deployment_Artifact for any Target not requested.
7. IF the build of any requested Target fails, THEN THE AI_App_Builder SHALL complete the builds of the remaining requested Targets, SHALL NOT produce a Deployment_Artifact for the failed Target, and SHALL present an error indication identifying each failed Target and preserving any previously produced Deployment_Artifacts.
8. IF a user requests a build or Preview for a Target that is not one of `web`, `mobile`, `backend`, or `shared`, THEN THE AI_App_Builder SHALL reject the request and present an error indication identifying the invalid Target, without modifying any existing Deployment_Artifact.

### Requirement 17: Dependency and Package Management

**User Story:** As a builder user, I want dependencies managed inside the sandbox, so that my project has the libraries it needs without manual setup.

#### Acceptance Criteria

1. WHEN the Builder_Agent adds a dependency to a Project's dependency manifest, THE AI_App_Builder SHALL invoke the Package_Manager inside the Sandbox to install the dependency within 300 seconds.
2. WHEN package installation completes successfully, THE AI_App_Builder SHALL make the installed dependency resolvable to the Project's build and Dev_Server without any additional install step.
3. IF package installation fails or exceeds 300 seconds, THEN THE AI_App_Builder SHALL report the installer error output, SHALL restore the Project's dependency manifest to its prior state, and SHALL NOT expose partially installed dependency files to the build.
4. WHEN a Package_Manager command is executed, THE AI_App_Builder SHALL route the command through plumby's Permission_Classifier before execution.
5. IF a Package_Manager command is denied by the Permission_Classifier, THEN THE AI_App_Builder SHALL cancel the installation, SHALL NOT modify the dependency manifest or the Sandbox, and SHALL report the denial.

### Requirement 18: Build and Deploy

**User Story:** As a builder user, I want to produce deployable artifacts and deploy to a hosting target, so that I can publish my app.

#### Acceptance Criteria

1. WHEN a user requests a build for a non-`mobile` Target (`web`, `backend`, or `shared`), THE AI_App_Builder SHALL produce a Deployment_Artifact for that Target with a zero (success) exit status within 300 seconds of build start.
2. WHEN a user requests a build for a `mobile` Target, THE AI_App_Builder SHALL produce the Deployment_Artifact within the configurable mobile-build-execution timeout defined in the Mobile Support requirement (default 1800 seconds, measured from build-execution start and excluding queue time on a shared build service).
3. IF a non-`mobile` Target build does not complete within 300 seconds, or a `mobile` Target build's execution does not complete within the configured mobile-build-execution timeout, THEN THE AI_App_Builder SHALL report a build-timeout error and SHALL NOT produce a Deployment_Artifact.
4. WHEN a user requests deployment of a Deployment_Artifact to a hosting destination, THE AI_App_Builder SHALL deploy the Deployment_Artifact and return the resulting hosting URL within 120 seconds.
5. IF a build completes with a non-zero exit status, THEN THE AI_App_Builder SHALL report the build error output and SHALL NOT produce a Deployment_Artifact.
6. IF a deployment operation fails or exceeds 120 seconds, THEN THE AI_App_Builder SHALL report the deployment failure with its cause and SHALL leave any prior deployed state unchanged.
7. IF a deployment operation is classified as `confirm` by the Permission_Classifier, THEN THE AI_App_Builder SHALL request user confirmation before deploying, and SHALL cancel the deployment if confirmation is not granted within 60 seconds.
8. IF a user requests deployment of a Deployment_Artifact that does not exist, THEN THE AI_App_Builder SHALL reject the request and report that no artifact is available to deploy.

### Requirement 19: Project Persistence, Versioning, and Resumability

**User Story:** As a builder user, I want my projects saved, versioned, and resumable across sessions, so that I never lose work and can return to any prior state.

#### Acceptance Criteria

1. WHEN a Project's files change during a Session, THE AI_App_Builder SHALL persist the Project's file state to disk within 2 seconds of the change becoming idle, such that the persisted state is durably readable in a subsequent Session.
2. IF persisting the Project's file state to disk fails, THEN THE AI_App_Builder SHALL retain the last successfully persisted file state unchanged and return an error indication describing the persistence failure.
3. WHEN a set of changes is committed, THE AI_App_Builder SHALL record a Snapshot atomically capturing the Project's full file state, such that the Snapshot is either fully recorded or not recorded at all.
4. IF recording a Snapshot fails, THEN THE AI_App_Builder SHALL discard the partial Snapshot, retain the most recent complete Snapshot, and return an error indication describing the snapshot failure.
5. WHEN a user reopens a persisted Project that has at least one Snapshot in a new Session, THE AI_App_Builder SHALL restore the Project to its most recent complete Snapshot state.
6. WHEN a user reopens a persisted Project that has no recorded Snapshot in a new Session, THE AI_App_Builder SHALL restore the Project to its most recent successfully persisted file state.
7. WHEN a user selects a prior Snapshot, THE AI_App_Builder SHALL restore the Project's file state to that Snapshot.
8. IF a Snapshot selected for restore is missing or its stored file state is unreadable, THEN THE AI_App_Builder SHALL leave the Project's current file state unchanged and return an error indication describing the restore failure.
9. THE AI_App_Builder SHALL persist Project state as files on disk in the Project's repository, consistent with plumby's handoff-files-on-disk approach.

### Requirement 20: Error Detection and Self-Healing

**User Story:** As a builder user, I want the platform to detect and fix build and runtime errors automatically, so that my app stays runnable without manual debugging.

#### Acceptance Criteria

1. WHEN a build or refinement completes, THE AI_App_Builder SHALL run plumby's `verify` tool (default 120-second, maximum 600-second timeout) to obtain a Verify_Result whose first line reports verdict PASS or FAIL.
2. IF the `verify` tool cannot produce a Verify_Result (no command discovered, timeout, or safety-guard refusal), THEN THE AI_App_Builder SHALL report the verify failure with its cause and SHALL leave Project files unchanged.
3. IF a Verify_Result reports verdict FAIL, THEN THE AI_App_Builder SHALL initiate Self_Healing by supplying the failure output (failure lines and output tail) to the Builder_Agent for correction.
4. WHILE Self_Healing is active, THE AI_App_Builder SHALL re-run the `verify` tool after each correction attempt to obtain a new Verify_Result.
5. THE AI_App_Builder SHALL allow the user to configure Self_Healing behavior, including enabling or disabling automatic Self_Healing and setting the maximum number of correction attempts (default 3, configurable 1–10), with automatic Self_Healing enabled by default.
6. WHERE Self_Healing is disabled, THE AI_App_Builder SHALL report the failing Verify_Result to the user and SHALL NOT attempt automatic correction.
7. WHILE Self_Healing is active, THE AI_App_Builder SHALL stop after the configured maximum number of correction attempts (default 3, configurable 1–10).
8. IF Self_Healing detects that a correction attempt reproduces a previously-seen failure signature — the same error recurring across attempts — THEN THE AI_App_Builder SHALL stop Self_Healing early, report the oscillation to the user, and SHALL NOT continue retrying variations of the failing approach.
9. IF Self_Healing reaches the maximum number of correction attempts without a verdict PASS, THEN THE AI_App_Builder SHALL report the unresolved error output and the number of attempts made, and SHALL stop attempting further automatic corrections.
10. WHEN Self_Healing stops without a verdict PASS, whether because the attempt cap was reached or an oscillation was detected, THE AI_App_Builder SHALL surface the unresolved error to the user with the captured failure output and the attempt history so the user can intervene.
11. WHEN Self_Healing produces a verdict PASS, THE AI_App_Builder SHALL report the resolution, the number of attempts made, and the corrective Diffs to the user.

### Requirement 21: Model and Provider Selection

**User Story:** As a builder user, I want to select the model and provider, so that I can control cost, capability, and availability.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL allow a user to select a provider from plumby's supported providers: anthropic, gemini, and openrouter.
2. WHEN a user selects a provider and model, THE Builder_Agent SHALL use the selected provider and model for every generation turn started after the selection, until the selection is changed.
3. IF a user selects a provider that is not one of anthropic, gemini, or openrouter, THEN THE AI_App_Builder SHALL reject the selection, leave the current Session provider unchanged, and return an error indication naming the unsupported provider.
4. IF a user selects a model that the selected provider does not support, THEN THE AI_App_Builder SHALL reject the selection and leave the current Session provider and model unchanged.
5. WHERE no provider is explicitly selected, THE AI_App_Builder SHALL resolve the provider by selecting the first provider in plumby's environment-based resolution order that has an available credential.
6. IF no provider credential is available, THEN THE AI_App_Builder SHALL report the missing credential naming the provider, SHALL NOT start a generation turn, and SHALL leave the Session state unchanged.

### Requirement 22: Safety and Isolation for Generated Code

**User Story:** As a platform operator, I want generated code and installs run under the permission model and container isolation, so that untrusted operations are contained.

#### Acceptance Criteria

1. WHEN any command runs on behalf of a Project, THE AI_App_Builder SHALL classify the command with plumby's Permission_Classifier before execution.
2. THE AI_App_Builder SHALL execute Project build, install, and run commands inside the Project's isolated Sandbox, with no cross-Sandbox access to another Project's file-system, process, or network state.
3. IF a command is classified as `refuse`, THEN THE AI_App_Builder SHALL block the command under all conditions, SHALL NOT execute it, leave state unchanged, and return an error indication.
4. IF a command is classified as `confirm`, THEN THE AI_App_Builder SHALL request user confirmation, SHALL execute the command only if consent is granted within 60 seconds, and SHALL deny it (leaving state unchanged) otherwise.
5. IF plumby's Permission_Classifier is unavailable or does not classify a command within 10 seconds, THEN THE AI_App_Builder SHALL fail closed by treating the command as `refuse` and SHALL NOT execute it.
6. WHERE a Builder_Agent operation is delegated to a plumby sub-agent, THE AI_App_Builder SHALL run the sub-agent's commands under plumby's read-only sub-agent policy, blocking any confirm-class or refuse-class command without execution.
7. WHEN the AI_App_Builder truncates captured command or build output exceeding 64 KB per stream, THE AI_App_Builder SHALL retain the first 64 KB and append a truncation notice, on its own line, indicating the number of bytes omitted.

### Requirement 23: Platform Operations: Rate Limiting, Quotas, and Abuse Prevention

**User Story:** As a platform operator, I want per-account rate limits, resource quotas, and abuse mitigation, so that no single user can exhaust shared platform capacity or degrade service for others.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL enforce per-User_Account Rate_Limits on resource-creating operations, including Project creation, builds, deployments, and generation turns.
2. THE AI_App_Builder SHALL enforce per-User_Account and per-Project Resource_Quotas, at minimum a maximum number of concurrent Sandboxes, a maximum total number of Projects, and the CPU, memory, and execution-time limits already applied per Sandbox.
3. IF a User_Account exceeds a configured Rate_Limit or Resource_Quota, THEN THE AI_App_Builder SHALL reject the offending request with a quota or rate-limit error indicating which limit was exceeded and SHALL NOT allocate additional resources for that request.
4. WHEN the AI_App_Builder detects an abusive usage pattern, such as sustained failed builds or runaway resource consumption, THE AI_App_Builder SHALL mitigate it by throttling or suspending the offending Sandbox and SHALL report the action taken.

### Requirement 24: Data Retention, Deletion, and Secret Protection

**User Story:** As a builder user, I want clear control over how long my data is kept and the ability to delete it, and I want my secrets protected, so that I retain ownership of my data and my credentials stay safe.

#### Acceptance Criteria

1. WHEN a user requests deletion of a Project, THE AI_App_Builder SHALL delete the Project's files, Snapshots, Sandbox, and associated Secrets, and SHALL confirm the deletion to the user.
2. WHEN a user requests deletion of their User_Account, THE AI_App_Builder SHALL delete or irreversibly anonymize all data owned by that User_Account, including Projects, Skills, Project_Memory and Global_Memory, Connectors, and Secrets.
3. THE AI_App_Builder SHALL store every Secret and every Connector credential with Encryption_At_Rest.
4. THE AI_App_Builder SHALL NOT log any Secret value or Connector credential value in plaintext in any platform log or audit record.
5. THE AI_App_Builder SHALL retain a Project's persisted state and Snapshots until the user deletes the Project or the User_Account, and SHALL document the retention behavior to the user.

### Requirement 25: Observability and Audit Logging

**User Story:** As a platform operator, I want audit logs of security-relevant actions and operational telemetry, so that I can investigate security events and diagnose failures.

#### Acceptance Criteria

1. THE AI_App_Builder SHALL record an audit log of security-relevant actions — authentication, authorization decisions, Secret access, destructive confirm-class operations, and deletions — scoped to the acting User_Account, and SHALL exclude Secret values from the audit log.
2. THE AI_App_Builder SHALL emit platform operational metrics and error events sufficient to detect and diagnose failures in Sandbox provisioning, generation turns, builds, and deployments.
3. WHEN a platform-level error occurs during an operation on behalf of a User_Account, THE AI_App_Builder SHALL surface a user-facing error indication and SHALL record the error in the operational log with correlation to the operation.

### Requirement 26: Collaboration and Sharing (Nice-to-Have)

**User Story:** As a builder user, I want to share a project or its live preview, so that others can view my work.

**Note on "Nice-to-Have":** This is a lower-priority requirement that MAY be deferred to a later release. It is not part of the mandatory baseline. However, IF this requirement is implemented, the acceptance criteria below are binding (SHALL) exactly as written and are not weakened by the "Nice-to-Have" label.

#### Acceptance Criteria

1. WHEN a user requests sharing for a Project that exists and the user is authorized to share, THE AI_App_Builder SHALL generate a unique, read-only Share_Link granting read access to the Project or its Preview within 5 seconds, with the Share_Link expiring 7 days after generation.
2. IF a user requests sharing for a Project that does not exist or that the user is not authorized to share, THEN THE AI_App_Builder SHALL reject the request and SHALL NOT generate a Share_Link.
3. WHEN a recipient opens a valid, unexpired, unrevoked Share_Link, THE AI_App_Builder SHALL grant read-only access to the shared Project or Preview within 5 seconds.
4. IF a recipient opens a Share_Link that is expired, revoked, or malformed, THEN THE AI_App_Builder SHALL deny access and SHALL NOT disclose the shared Project or Preview content.
5. IF a recipient accessing a Project via a Share_Link attempts to modify the Project, THEN THE AI_App_Builder SHALL reject the modification and leave the Project state unchanged.
6. WHEN a user revokes a Share_Link, THE AI_App_Builder SHALL deny all subsequent access via that Share_Link within 5 seconds of revocation.
7. IF a user requests revocation of a Share_Link that does not exist or was already revoked, THEN THE AI_App_Builder SHALL report that no active Share_Link matched and SHALL make no change to other Share_Links.

## Correctness Properties (for Property-Based Testing)

The following invariants are candidates for property-based testing. Each is stated so that it holds for all valid inputs.

1. **Sandbox isolation invariant.** FOR ALL commands executed on behalf of a Project — regardless of how the Permission_Classifier classifies them — all filesystem access, process effects, and network access SHALL remain confined within that Project's platform-enforced Isolation_Boundary, so that no command can observe or affect another Project or the host. (Supports Requirements 8, 22.)
2. **Diff application preserves unedited content.** FOR ALL file edits, applying the Diff SHALL change only the targeted region and SHALL leave every other line of the file byte-for-byte identical. (Round-trip / invariant; supports Requirement 2.)
3. **Preview reflects committed state.** FOR ALL committed Snapshots, the served Preview content SHALL correspond to the most recently committed Snapshot rather than to uncommitted intermediate state. (Metamorphic; supports Requirement 3.)
4. **Resumability restores prior state.** FOR ALL Projects, persisting a Project state and then restoring it in a new Session SHALL reproduce the same file state that was persisted (`restore(persist(state)) == state`). (Round-trip; supports Requirement 19.)
5. **Permission classifier never allows refuse-class commands.** FOR ALL commands classified as `refuse`, the AI_App_Builder SHALL NOT execute the command under any configuration or flag. (Invariant; supports Requirements 8, 22.)
6. **Snapshot idempotence.** FOR ALL Projects, restoring the same Snapshot twice SHALL yield the same Project file state as restoring it once (`restore(restore(s)) == restore(s)`). (Idempotence; supports Requirement 19.)
7. **Template baseline builds.** FOR ALL Templates, instantiating a Project from the Template and running `verify` SHALL produce `verdict: PASS` before any user refinement. (Model-based / invariant; supports Requirement 5.)
8. **Secret non-leakage.** FOR ALL Secrets defined on a Project, no generated source file committed to a Snapshot SHALL contain the Secret's value. (Invariant; supports Requirement 9.)
9. **Connector credential non-leakage.** FOR ALL Connectors added to a Project, no generated source file committed to a Snapshot SHALL contain the literal credential value. (Invariant; supports Requirement 10.)
10. **Fork independence.** FOR ALL forked Projects, mutating the fork SHALL NOT change the origin Project's file state. (Invariant; supports Requirement 6.)
11. **Blank origin still runs.** FOR ALL Projects created with Project_Origin `blank`, the Sandbox and Dev_Server SHALL start successfully with the minimal generated files. (Invariant; supports Requirement 6.)
12. **No enforcement lock-in in generated projects.** FOR ALL generated Projects, removing AI_App_Builder-specific code SHALL NOT cause the Project's baseline build to fail. (Invariant; supports Requirement 11.)
13. **Export builds standalone.** FOR ALL Project_Exports, the exported Project SHALL build and run using a standard toolchain with no AI_App_Builder account and no network access to the AI_App_Builder. (Invariant; supports Requirement 11.)
14. **Export credential non-leakage.** FOR ALL Project_Exports, no exported file SHALL contain a literal Secret or Connector credential value. (Invariant; supports Requirement 11.)
15. **Audit soundness on clean projects.** FOR ALL generated Projects with no lock-in signals present, a Lockin_Audit SHALL report no lock-in signals (no false positives on clean generated output). (Invariant; supports Requirement 11.)
16. **Memory stays within cap.** FOR ALL memory stores under Memory_Mode `auto`, after any sequence of automatic additions the store size SHALL remain at or below the Memory_Cap. (Invariant; supports Requirement 14.)
17. **Memory is fully exportable.** FOR ALL memory stores, exporting the memory SHALL reproduce every current Memory_Entry as human-readable content with no hidden state omitted. (Invariant; supports Requirement 14.)
18. **Off mode adds nothing automatically.** FOR ALL memory stores under Memory_Mode `off`, no Memory_Entry SHALL be added except by explicit user action. (Invariant; supports Requirement 14.)
19. **Skills remain portable.** FOR ALL Skills in a user's Skill_Library, each Skill SHALL remain a valid open-format Agent Skill (a SKILL.md with `name` and `description`) that can be exported and loaded by another Agent Skills-compatible tool. (Invariant; supports Requirement 13.)
