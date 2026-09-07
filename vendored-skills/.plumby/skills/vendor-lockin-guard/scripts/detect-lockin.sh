#!/usr/bin/env bash
#
# detect-lockin.sh — audit a repository for vendor lock-in signals.
#
# Read-only. Changes nothing. Prints findings grouped by severity and exits non-zero if any
# HIGH-severity signal is present, so it can be used as a CI gate or run ad hoc.
#
#   usage:  ./detect-lockin.sh [path] [vendor-name-regex]
#   e.g.    ./detect-lockin.sh . 'acme|acmehq'
#
# With no vendor regex it still finds the generic signals: telemetry endpoints, enforcement rules,
# hash-protection manifests, "do not remove" comments, and unused env declarations.
#
# Exit codes (a CI gate must be able to tell "clean" from "broke"):
#   0  clean — no HIGH findings
#   1  at least one HIGH finding
#   2  usage / environment error — the audit could NOT run (bad path, file-as-root, invalid
#      vendor regex, unknown flag). This is fail-closed: a gate must never go green on an
#      audit that never happened.
#
# Why these particular checks: each one is a mechanism that made a real project feel impossible to
# leave. The enforcement checks matter most — a lint rule that requires a vendor import converts
# "please keep this" into "your build fails without this", which is what stops people trying.

set -uo pipefail

usage() {
  cat <<'EOF'
detect-lockin.sh — audit a repository for vendor lock-in signals (read-only).

usage:  ./detect-lockin.sh [path] [vendor-name-regex]
  e.g.  ./detect-lockin.sh . 'acme|acmehq'

Arguments:
  path                Directory to audit. Defaults to the current directory (.).
  vendor-name-regex   Optional POSIX ERE naming the vendor(s). Enables the precise
                      HIGH enforcement checks (lint rules, mandated imports, identity
                      fields, lockfile/build/CI mentions). Without it the generic
                      signals are still found.

Options:
  -h, --help          Show this help and exit 0.

Exit codes:
  0  no HIGH findings
  1  at least one HIGH finding
  2  usage / environment error (bad path, file-as-root, invalid regex, unknown flag)

The script only reads files. It never writes, and it makes no network calls.
EOF
}

# ---- argument parsing --------------------------------------------------------------------------
# Parse -h/--help FIRST, before $1 could ever reach grep as an option. Any other flag-shaped
# first argument is rejected rather than silently treated as a path (which would make grep
# interpret it as an option — see the fabricated-findings bug this replaces).
case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  -*)
    printf 'error: unknown option: %s\n\n' "$1" >&2
    usage >&2
    exit 2
    ;;
esac

ROOT="${1:-.}"
VENDOR="${2:-}"

# Fail closed: the root must be a real directory. A typo'd path or an unmade checkout must NOT
# produce a green build that audited nothing.
if [ ! -d "$ROOT" ]; then
  if [ -e "$ROOT" ]; then
    printf 'error: root is not a directory: %s\n' "$ROOT" >&2
  else
    printf 'error: path does not exist: %s\n' "$ROOT" >&2
  fi
  exit 2
fi

# Fail closed: a $VENDOR that is not a valid ERE would make every vendor-aware grep error out and,
# under the old "|| true", collapse to "0 findings". Validate that it compiles first.
if [ -n "$VENDOR" ]; then
  # grep returns 0 (match) or 1 (no match) for a VALID regex, and >=2 for an INVALID one. Feeding
  # a non-empty probe line means a benign regex may match (rc 0) or not (rc 1); only rc>=2 is a
  # compile error. Empty input would always be rc 1 and could not distinguish the two.
  printf 'x\n' | grep -qE -- "$VENDOR" >/dev/null 2>&1
  vrc=$?
  if [ "$vrc" -ge 2 ]; then
    printf 'error: invalid vendor regex (not a valid POSIX ERE): %s\n' "$VENDOR" >&2
    exit 2
  fi
fi

# Paths that are never interesting. Matched against the PATH ONLY (never against matched source
# text), so a finding can no longer be suppressed by a substring in its own line.
EXCLUDES='node_modules/|/\.git/|\.lock$|/dist/|/build/|/\.next/|/\.expo/|/coverage/'

# Directory names to hand to grep's own --exclude-dir (never sees file content).
EXCLUDE_DIRS=(node_modules .git dist build .next .expo coverage)

high=0
med=0

hr() { printf '%s\n' "------------------------------------------------------------"; }

# strip_and_filter — read grep "path:line:content" output on stdin and drop lines whose PATH part
# matches $EXCLUDES. Only the "path:" prefix (up to the first colon) is tested, so matched source
# text can never suppress a finding.
strip_and_filter() {
  while IFS= read -r line; do
    local p="${line%%:*}"
    if printf '%s\n' "$p" | grep -qE "$EXCLUDES"; then
      continue
    fi
    printf '%s\n' "$line"
  done
}

scan() {
  # scan <label> <severity> <regex> [file-globs...]
  local label="$1" sev="$2" re="$3"; shift 3
  local args=()
  local d
  for d in "${EXCLUDE_DIRS[@]}"; do args+=(--exclude-dir="$d"); done
  if [ "$#" -gt 0 ]; then local g; for g in "$@"; do args+=(--include="$g"); done; fi

  local raw rc
  raw=$(grep -rniE "${args[@]}" -- "$re" "$ROOT" 2>/dev/null)
  rc=$?
  # rc 0 = matches, rc 1 = no matches, rc >= 2 = error.
  if [ "$rc" -ge 2 ]; then
    printf 'error: scan failed (grep exit %s) for check: %s\n' "$rc" "$label" >&2
    exit 2
  fi

  local hits
  hits=$(printf '%s\n' "$raw" | grep -v '^$' | strip_and_filter)
  [ -z "$hits" ] && return 0

  local n
  n=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
  printf '\n[%s] %s — %s hit(s)\n' "$sev" "$label" "$n"
  printf '%s\n' "$hits" | head -12 | sed 's/^/    /'
  [ "$n" -gt 12 ] && printf '    … %s more\n' "$((n - 12))"

  if [ "$sev" = "HIGH" ]; then high=$((high + 1)); else med=$((med + 1)); fi
}

printf 'Lock-in audit: %s\n' "$ROOT"
[ -n "$VENDOR" ] && printf 'Vendor pattern: %s\n' "$VENDOR"
hr

# ---- HIGH: the enforcement layer -----------------------------------------------------------------
# Rules that require a vendor import, or require vendor files to exist, are the reason removal feels
# impossible: the build punishes it.
if [ -n "$VENDOR" ]; then
  scan "Convention/lint rules referencing the vendor (may enforce its presence)" HIGH \
    "$VENDOR" '*.json' '.*rc' '.eslintrc*' '*.config.js' '*.config.ts'
fi

# Rules that mandate an import are the sharpest lock-in signal there is — but only a human can judge
# them, and here is why this check is shaped the way it is.
#
# Two earlier versions were wrong. The first matched every `importFrom:` and flagged six perfectly
# ordinary structural rules. The second tried to match only scoped packages on the same line as the
# key — but grep is line-based and these configs are pretty-printed, so the package sits on the *next*
# line and nothing matched at all. A detector that cries wolf gets ignored; one that silently matches
# nothing is worse.
#
# The deeper problem is that no pattern can tell `@tanstack/react-query` (a real dependency a rule may
# legitimately require) from `@someplatform/runtime` (a vendor holding your build hostage). That
# distinction needs a name. So:
#
#   - with a vendor name, this is a HIGH finding and precise
#   - without one, every mandated third-party package is listed for a human to read
#
# The vendor mention is scoped to the value of an importFrom/mustImport/requiredImports key so a
# config that merely mentions the vendor in an unrelated comment is not reported as mandating it.
if [ -n "$VENDOR" ]; then
  # Collect candidate files null-safely (paths with spaces survive). --exclude-dir keeps the
  # match confined to files, then strip_and_filter drops any excluded path.
  files=$(grep -rlE "${EXCLUDE_DIRS[@]/#/--exclude-dir=}" --include='*.json' \
            -- '"(importFrom|mustImport|requiredImports)"' "$ROOT" 2>/dev/null)
  rc=$?
  if [ "$rc" -ge 2 ]; then
    printf 'error: importFrom scan failed (grep exit %s)\n' "$rc" >&2
    exit 2
  fi
  files=$(printf '%s\n' "$files" | grep -v '^$' | strip_and_filter)
  if [ -n "$files" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      # Only inspect the import-mandate keys' own lines/values, not the whole file, so an
      # unrelated comment mentioning the vendor does not manufacture a HIGH finding.
      hit=$(grep -niE -- "\"(importFrom|mustImport|requiredImports)\"[^]]*($VENDOR)" "$f" 2>/dev/null)
      grc=$?
      if [ "$grc" -ge 2 ]; then
        printf 'error: importFrom value scan failed (grep exit %s) for %s\n' "$grc" "$f" >&2
        exit 2
      fi
      if [ -n "$hit" ]; then
        printf '\n[HIGH] %s mandates a vendor import — removing the vendor will fail the build\n' "$f"
        printf '%s\n' "$hit" | head -8 | sed 's/^/    /'
        high=$((high + 1))
      fi
    done <<EOF
$files
EOF
  fi
else
  # The file list must be captured separately and checked for emptiness BEFORE it is used.
  #
  # An earlier version inlined it as `grep ... $(grep -rl ...)`. When the inner grep matched nothing,
  # the substitution expanded to nothing, grep fell back to scanning the whole tree, and the result was
  # every scoped package in `package-lock.json` — 15+ lines of @azure and @babel noise on a project with
  # no convention config at all. Same lesson as the other three: a detector that cries wolf gets
  # switched off, and an empty argument list is one of the easiest ways to cry wolf by accident.
  #
  # Filenames are read null-safely via find -print0 | xargs -0 so a path containing a space is a
  # single argument, not two broken ones.
  configs=$(grep -rlE "${EXCLUDE_DIRS[@]/#/--exclude-dir=}" --include='*.json' \
              -- '"(importFrom|mustImport|requiredImports)"' "$ROOT" 2>/dev/null)
  rc=$?
  if [ "$rc" -ge 2 ]; then
    printf 'error: importFrom scan failed (grep exit %s)\n' "$rc" >&2
    exit 2
  fi
  configs=$(printf '%s\n' "$configs" | grep -v '^$' | strip_and_filter)
  mandated=""
  if [ -n "$configs" ]; then
    # Read the filenames into an array one-per-line (mapfile is portable across bash 4+, and unlike
    # `xargs -d` — a GNU extension — needs no external tool), then pass them quoted so a path
    # containing whitespace stays a single argument.
    mapfile -t cfg_files <<<"$configs"
    if [ "${#cfg_files[@]}" -gt 0 ]; then
      mandated=$(grep -hoE '"@[a-z0-9-]+/[a-z0-9._-]+"' -- "${cfg_files[@]}" 2>/dev/null | sort -u)
    fi
  fi
  if [ -n "$mandated" ]; then
    printf '\n[MED] Third-party packages named in convention/lint config — review each\n'
    printf '      A rule that REQUIRES one of these means removing it breaks your build.\n'
    printf '%s\n' "$mandated" | head -15 | sed 's/^/    /'
    med=$((med + 1))
  fi
fi

scan "Hash-protection manifest (files you are blocked from editing)" HIGH \
  '"[^"]+\.(ts|tsx|js|mjs)"\s*:\s*"[a-f0-9]{64}"' '*.json'

# ---- HIGH: phones home ---------------------------------------------------------------------------
# Package-qualified on purpose. An earlier version matched a bare `amplitude`, which fired on a
# physics variable in a wave-motion test — a false positive that teaches people to ignore the tool.
# Prefer a missed hit over a noisy one; the import form is what actually indicates an SDK.
scan "Telemetry / analytics SDKs" HIGH \
  'onedollarstats|posthog-js|posthog-node|@posthog/|mixpanel-browser|@amplitude/|amplitude-js|@segment/|analytics-node|@sentry/|react-ga|gtag\(|googletagmanager' \
  '*.ts' '*.tsx' '*.js' '*.json'

scan "Hardcoded collector or event endpoints" HIGH \
  'https?://[a-z0-9.-]+/(events?|collect|track|beacon|ingest)\b' '*.ts' '*.tsx' '*.js'

# ---- MEDIUM: coupling that is real but cheaper to unwind -----------------------------------------
scan "Comments asserting something must not be removed" MED \
  'do not remove|dont remove|don.t remove|required for|must stay|do not edit' '*.ts' '*.tsx' '*.js'

scan "Vendor preview/sandbox hosts (these die silently)" MED \
  'https?://[a-z0-9.-]*(preview|sandbox|staging)[a-z0-9.-]*\.[a-z]{2,}' '*.ts' '*.tsx' '*.json'

# Rendered components only, not the words. An earlier version matched a bare `Badge` and produced 45
# hits in a game that calls its achievements "badges" — all prose, all in comments. Requiring JSX
# angle-bracket usage of a capitalised component name finds `<VendorBadge />` and ignores paragraphs
# about badges. Third strike for the same lesson: match the construct, never the vocabulary.
#
# The prefix before the suffix is OPTIONAL, so the exactly-named forms — `<Badge/>`, `<PoweredBy/>`,
# `<Watermark/>` — are caught too. They are the most common real-world spelling of an injected vendor
# component, and the earlier `[A-Z][A-Za-z0-9]*` (which required at least one leading character)
# missed all of them. Still a JSX construct, never the prose word.
scan "Injected badge / watermark / feedback components" MED \
  '<([A-Z][A-Za-z0-9]*)?(Badge|Watermark|PoweredBy|MadeWith|Feedback|Branding)\b' '*.tsx' '*.jsx' '*.vue' '*.svelte'

if [ -n "$VENDOR" ]; then
  scan "Vendor name in identity fields (bundle id, package, scheme)" MED \
    "(bundleIdentifier|\"package\"|\"scheme\"|applicationId).*($VENDOR)" '*.json'
fi

# ---- MEDIUM: surfaces a source grep never reaches ------------------------------------------------
# Each of these was missed by a careful manual pass on a real project, because none of them is source
# code: state in a dot-directory, a plugin in build config, a deploy step in CI, a generated config
# file nothing imports, or an SDK arriving as somebody else's dependency.

if [ -n "$VENDOR" ]; then
  scan "Vendor in the lockfile — may be transitive, i.e. not yours to remove" MED \
    "$VENDOR" 'package-lock.json' 'yarn.lock' 'pnpm-lock.yaml' 'bun.lock' 'Cargo.lock' 'poetry.lock' 'go.sum'

  scan "Vendor in build tool configuration (plugins and presets hide here)" MED \
    "$VENDOR" 'vite.config.*' 'webpack.config.*' 'next.config.*' 'rollup.config.*' \
    'babel.config.*' 'metro.config.*' 'nuxt.config.*' 'astro.config.*' 'svelte.config.*'

  scan "Vendor in CI/CD configuration" MED \
    "$VENDOR" '*.yml' '*.yaml' 'Jenkinsfile'
fi

# Hidden vendor state directories. Nothing imports these, so no source grep finds them.
hidden=$(find "$ROOT" -maxdepth 3 \
  \( -name '.firebase*' -o -name '.amplify*' -o -name '.vercel*' -o -name '.netlify*' \
     -o -name '.wrangler*' -o -name '.sst*' -o -name '.serverless*' -o -name '.supabase*' \) \
  -not -path '*/node_modules/*' 2>/dev/null | head -8)
if [ -n "$hidden" ]; then
  printf '\n[MED] Vendor-generated state directories\n'
  printf '%s\n' "$hidden" | sed 's/^/    /'
  med=$((med + 1))
fi

# Generated config. The test that matters: could you recreate this from the repo alone?
generated=$(find "$ROOT" -maxdepth 3 \
  \( -name 'firebase.json' -o -name 'amplifyconfiguration.json' -o -name 'vercel.json' \
     -o -name 'wrangler.toml' -o -name 'netlify.toml' -o -name 'now.json' \
     -o -name '*.config.json' \) \
  -not -path '*/node_modules/*' 2>/dev/null | head -8)
if [ -n "$generated" ]; then
  printf '\n[MED] Generated config — apply the recreatability test to each\n'
  printf '      If deleting it means you cannot rebuild it from this repo, it holds vendor-only state.\n'
  printf '%s\n' "$generated" | sed 's/^/    /'
  med=$((med + 1))
fi

# ---- MEDIUM: declared-but-unread env ------------------------------------------------------------
# The env var is considered "read" if it appears in ANY of a broad set of source/config file types,
# not just JS/TS — a Python, Go, Rust, Ruby, PHP, shell, Docker or CI project reads env too, and
# restricting the search to *.ts/*.tsx/*.js reported every variable as unused on those stacks.
# Extraction is anchored on `NAME=` so a bare uppercase word in a prose line is not treated as a var.
ENV_READ_INCLUDES=(--include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
  --include='*.cjs' --include='*.jsx' --include='*.vue' --include='*.svelte' \
  --include='*.py' --include='*.go' --include='*.rs' --include='*.rb' --include='*.php' \
  --include='*.java' --include='*.kt' --include='*.cs' --include='*.sh' --include='*.bash' \
  --include='*.yml' --include='*.yaml' --include='*.toml' --include='Dockerfile' --include='*.env')
for tmpl in "$ROOT/.env.template" "$ROOT/.env.example" "$ROOT/.env.sample"; do
  [ -f "$tmpl" ] || continue
  unused=""
  while read -r v; do
    [ -z "$v" ] && continue
    matches=$(grep -rl "${EXCLUDE_DIRS[@]/#/--exclude-dir=}" "${ENV_READ_INCLUDES[@]}" \
                -- "$v" "$ROOT" 2>/dev/null | grep -v '^$' | strip_and_filter)
    n=$(printf '%s' "$matches" | grep -c . || true)
    [ "${n:-0}" -eq 0 ] && unused="${unused}    ${v}\n"
  done < <(grep -oE '^[A-Z][A-Z0-9_]*=' "$tmpl" 2>/dev/null | sed 's/=$//')

  if [ -n "$unused" ]; then
    printf '\n[MED] Env vars declared in %s but read nowhere\n' "$(basename "$tmpl")"
    printf '%b' "$unused"
    med=$((med + 1))
  fi
done

# ---- the decisive question ----------------------------------------------------------------------
hr
printf '\nSummary: %s high, %s medium\n\n' "$high" "$med"

cat <<'EOF'
This script only reads files. It cannot see the three things that usually decide the real exit cost:

  1. MONEY.     Egress fees, minimum commitments, auto-renewal. A flawless export API is worthless
                if moving your data costs more than your runway.
  2. IDENTITY.  If the vendor is down right now, can anyone log in? Including your admins?
  3. DATA.      Has the export ever actually been RUN, and loaded somewhere that is not the vendor?
                A documented export is a promise; a tested one is a capability.

And the question no tool can answer:

  If this vendor shut down tomorrow with no notice, what would it take to keep shipping?

Write the answer down. If nobody can answer it, that is the finding.

Drills that turn these from opinions into evidence: references/exit-drills.md
EOF

[ "$high" -gt 0 ] && exit 1
exit 0
