# Exhaustive discovery checklist

Run through this when the quick sweep in `SKILL.md` finds coupling and you need to be sure you found
**all** of it. Ordered by how often each surface is missed.

Adapt the commands to the project's toolchain. Where a tool is unavailable, say so rather than
skipping silently — a surface you could not check is a finding of its own.

---

## 1. Lockfiles and transitive dependencies

A vendor SDK can arrive as somebody else's dependency, so it appears nowhere in your manifests.

```bash
grep -rniE 'vendor|registry\.vendor\.com|vendor-sdk' \
  package-lock.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb 2>/dev/null | head

# Then ask WHY it is present — direct dependency or pulled in by something else?
npm ls vendor-sdk 2>/dev/null || pnpm why vendor-sdk 2>/dev/null || \
  yarn why vendor-sdk 2>/dev/null || bun pm ls 2>/dev/null | grep -i vendor
```

**A transitive vendor dependency is a different problem from a direct one.** You cannot remove it by
editing your own manifest; you either drop the parent package or accept it. Report it as such rather
than as something you can delete.

## 2. Vendor-generated hidden files and directories

Templates and CLIs leave state outside source directories, where source greps never look.

```bash
find . -maxdepth 3 \
  \( -name '.vendor*' -o -name '.firebase*' -o -name '.amplify*' -o -name '.vercel*' \
     -o -name '.netlify*' -o -name '.sst*' -o -name '.wrangler*' -o -name '.expo*' \
     -o -name '.serverless*' -o -name '.terraform*' \) \
  -not -path './node_modules/*' 2>/dev/null
```

Also check for any top-level directory whose purpose you cannot immediately name. In the case study
project, the entire template-management system lived in a dot-directory that no source grep touched.

## 3. Generated config files — the recreatability test

Files like `amplifyconfiguration.json`, `firebase.json`, `vercel.json`, `wrangler.toml`,
`website.config.json`, `app.json`.

Ask the decisive question: **if I delete this file, can I recreate it from what is in my repository?**

If not, the vendor has embedded state — an id, a region, a project handle, a routing rule — that
exists only in their dashboard. That is lock-in you cannot see in code, and it will fail *after* you
have removed everything visible.

This class is easy to miss even when you are looking. During the case-study de-vendoring, a manual
pass removed six categories of coupling and still left a config file containing the vendor's name and
a dead vendor hostname. An automated sweep caught it afterwards.

## 4. Build tool configuration

Vendor plugins and presets hide in build config, not in application source.

```bash
grep -rniE 'vendor|analytics|telemetry|errorTracking|sourcemap.*upload' \
  vite.config.* webpack.config.* next.config.* rollup.config.* esbuild.config.* \
  babel.config.* .babelrc* metro.config.* tsup.config.* astro.config.* \
  nuxt.config.* svelte.config.* tailwind.config.* 2>/dev/null
```

In the case study, a Vite plugin injected a 9KB analytics script into every page. Nothing in
application source referenced it.

## 5. CI/CD workflows and deployment configuration

```bash
grep -rniE 'vendor|VENDOR_|deploy|publish|upload.*sourcemap' \
  .github/workflows .gitlab-ci.yml bitbucket-pipelines.yml \
  .circleci Jenkinsfile azure-pipelines.yml .buildkite 2>/dev/null | head -20
```

Look for: vendor deploy actions, secrets named after the vendor, source-map uploads to error
trackers, and vendor-hosted preview environments.

## 6. Secrets, and where they have already leaked

**Removing a key from `.env` does not revoke it.** See the "Credentials" phase in `SKILL.md` — this is
a security step, not a tidiness step.

```bash
# Env files, including ones people forget
ls -a | grep -E '^\.env' ; find . -name '.env*' -not -path './node_modules/*' 2>/dev/null

# Has a credential ever been committed?
git log --all --diff-filter=AM --name-only -- '*.env*' | head
git log -p --all -S 'VENDOR_API_KEY' --oneline 2>/dev/null | head
```

If a key was ever committed, it must be **revoked at the vendor**, because the value is permanently in
the git history of every clone, fork and CI cache.

## 7. Client-side storage

Vendor SDKs leave identifiers on user devices that survive your code removal.

- **Web:** devtools → Application → Local Storage, Session Storage, Cookies, IndexedDB. Look for keys
  namespaced to the vendor.
- **Mobile:** AsyncStorage / SharedPreferences / UserDefaults / Keychain dumps.
- **Desktop:** the app's userData directory.

If vendor keys exist, decide deliberately: leave them (harmless but untidy), or ship a one-time
cleanup on upgrade. Leaving an *identifier* behind can matter for a privacy declaration.

## 8. Database schema coupling

This is the one that turns a day of work into a month.

If the vendor supplied auth or a managed database, audit your foreign keys and user tables. A schema
that stores a vendor's proprietary user id — Firebase's 28-character UID, an Auth0 `sub`, a Clerk
`user_...` — has that vendor's format embedded in **every table that references a user.**

Severing the vendor then requires a migration that:

1. mints your own stable ids (UUID or serial),
2. maps every vendor id to a new id in a translation table,
3. rewrites every foreign key,
4. keeps both readable during the transition so nothing breaks mid-migration.

**Do not begin this as part of a de-vendoring pass.** Report it as a prerequisite project with its own
plan, because a half-finished id migration is worse than the coupling.

## 9. Unused dependency confirmation (optional, noisy)

After removal, confirm nothing is left declared-but-unimported:

```bash
npx depcheck 2>/dev/null | head -30
```

**Caveats, so this is not trusted blindly:** `depcheck` has well-known false positives for packages
used only in config files, via CLI binaries, or through frameworks that import by convention. It also
does not understand every package manager equally. Treat its output as a list of candidates to check
by hand, never as proof.

A more reliable check is the one already in `SKILL.md`: grep for the vendor's name across the whole
repository and confirm only explanatory comments remain.

## 10. Infrastructure and DNS

If the vendor hosted anything user-facing, see the "Reclaim the edge before you delete anything"
warning in `SKILL.md`. Audit:

- DNS records (CNAME, A, ALIAS) pointing at vendor infrastructure
- TLS certificates issued or managed by the vendor
- CDN, WAF and edge-routing rules living in the vendor's dashboard
- Webhook endpoints registered *with* third parties that point at vendor URLs
- OAuth redirect URIs and allowed-callback lists registered with identity providers

The last two are the most commonly forgotten, because they live in *other people's* dashboards.
