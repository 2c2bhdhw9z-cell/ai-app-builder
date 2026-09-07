#!/usr/bin/env bash
#
# run-tests.sh — fixture-based test suite for detect-lockin.sh.
#
# There is no Node harness in this repo, so the suite is a shell script. It runs the detector
# against a fixtures/ tree and asserts the exact HIGH/MEDIUM counts and the exit code for every
# case, pinning each audit finding (H19-H21, M31/M32/M34, L11) so a regression fails CI.
#
# Read-only, like the script it tests: it never writes outside stdout and makes no network calls.
#
# usage:  ./run-tests.sh
# exit:   0 all pass, 1 one or more failures.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/detect-lockin.sh"
FIX="$HERE/fixtures"

pass=0
fail=0

# Capture: run the detector, store stdout+stderr and the exit code.
run() {
  OUT=$(bash "$SCRIPT" "$@" 2>&1)
  RC=$?
}

ok()  { pass=$((pass + 1)); printf '  ok   — %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL — %s\n' "$1"; [ -n "${2:-}" ] && printf '         %s\n' "$2"; }

# Parse "Summary: N high, M medium" out of OUT.
summary_high() { printf '%s\n' "$OUT" | sed -n 's/^Summary: \([0-9]*\) high.*/\1/p'; }
summary_med()  { printf '%s\n' "$OUT" | sed -n 's/^Summary: [0-9]* high, \([0-9]*\) medium/\1/p'; }

# assert_exit <label> <expected-rc>
assert_exit() {
  if [ "$RC" = "$2" ]; then ok "$1 (exit $2)"; else bad "$1" "expected exit $2, got $RC"; fi
}

# assert_counts <label> <expected-high> <expected-med>
assert_counts() {
  local h m
  h=$(summary_high); m=$(summary_med)
  if [ "$h" = "$2" ] && [ "$m" = "$3" ]; then
    ok "$1 ($2 high, $3 med)"
  else
    bad "$1" "expected $2 high / $3 med, got ${h:-?} high / ${m:-?} med"
  fi
}

# assert_contains <label> <substring>
assert_contains() {
  if printf '%s\n' "$OUT" | grep -qF -- "$2"; then ok "$1"; else bad "$1" "missing: $2"; fi
}

# assert_absent <label> <substring>
assert_absent() {
  if printf '%s\n' "$OUT" | grep -qF -- "$2"; then bad "$1" "unexpected: $2"; else ok "$1"; fi
}

printf 'detect-lockin.sh test suite\n'
printf 'bash %s / grep %s\n' \
  "$(bash --version | sed -n '1s/.*version \([0-9.]*\).*/\1/p')" \
  "$(grep --version | sed -n '1s/.*grep) \([0-9.]*\).*/\1/p')"
printf '============================================================\n\n'

# ---- clean tree: 0 high, exit 0 -----------------------------------------------------------------
printf '# clean tree\n'
run "$FIX/clean"
assert_counts "clean tree has no findings" 0 0
assert_exit   "clean tree exits 0" 0

# ---- signals tree (generic, no vendor): each real HIGH + MED signal fires ------------------------
printf '\n# signals tree (generic — no vendor)\n'
run "$FIX/signals"
# 3 HIGH: telemetry SDK, collector endpoint, hash-protection manifest.
# 3 MED : do-not-remove comment, preview host, injected badge component.
assert_counts "generic signals: 3 high / 3 med" 3 3
assert_exit   "generic signals exit 1 (HIGH present)" 1
assert_contains "telemetry SDK detected"        "[HIGH] Telemetry / analytics SDKs"
assert_contains "collector endpoint detected"   "[HIGH] Hardcoded collector or event endpoints"
assert_contains "hash manifest detected"        "[HIGH] Hash-protection manifest"
# M31 pin: the badge check must catch the exactly-named forms <Badge/>, <PoweredBy/>, <Watermark/>.
assert_contains "M31: badge check finds 5 (incl. bare-named)" "components — 5 hit(s)"

# ---- signals tree (vendor=acme): enforcement HIGH checks fire ------------------------------------
printf '\n# signals tree (vendor = acme)\n'
run "$FIX/signals-vendor" 'acme'
# 2 HIGH: vendor lint/convention reference, and a mandated vendor import.
assert_counts "vendor signals: 2 high / 0 med" 2 0
assert_exit   "vendor signals exit 1" 1
assert_contains "vendor lint reference detected" "[HIGH] Convention/lint rules referencing the vendor"
assert_contains "mandated vendor import detected" "mandates a vendor import"

# ---- false positive: bare `amplitude` physics variable (must NOT fire telemetry) -----------------
printf '\n# false positive — bare amplitude (package-qualified telemetry)\n'
run "$FIX/fp-telemetry"
assert_counts "fp-telemetry: no findings" 0 0
assert_exit   "fp-telemetry exits 0" 0

# ---- false positive: prose about "badges" (must NOT fire the component check) --------------------
printf '\n# false positive — badge vocabulary in prose (M31/M33)\n'
run "$FIX/fp-badge"
assert_counts "fp-badge: no findings" 0 0
assert_exit   "fp-badge exits 0" 0

# ---- false positive: importFrom of a non-vendor package, vendor only in a comment (M34) ----------
printf '\n# false positive — importFrom without vendor mandate (M34)\n'
run "$FIX/fp-importfrom" 'acme'
# The "mandates a vendor import" HIGH must NOT fire: the importFrom value is @tanstack/react-query,
# and the vendor is only mentioned in an unrelated comment.
assert_absent "M34: no false 'mandates a vendor import'" "mandates a vendor import"
assert_exit   "fp-importfrom exits 1 (vendor mention still surfaced for review)" 1

# ---- H21 pin: a finding whose line mentions /dist/ must STILL fire --------------------------------
printf '\n# H21 — EXCLUDES applies to path, not matched text\n'
run "$FIX/fp-h21"
assert_counts "H21: finding not suppressed by its own text" 1 0
assert_exit   "H21 exits 1" 1

# ---- EXCLUDES still works on the PATH: node_modules copy is ignored -------------------------------
printf '\n# EXCLUDES — node_modules copy of an SDK is ignored (by path)\n'
run "$FIX/fp-excluded"
assert_counts "excluded path yields no findings" 0 0
assert_exit   "fp-excluded exits 0" 0

# ---- L11 pin: a path containing a space is handled ------------------------------------------------
printf '\n# L11 — path with a space is not split\n'
run "$FIX/fp-spaces"
assert_counts "path with space: telemetry still found" 1 0
assert_exit   "fp-spaces exits 1" 1

# ---- H19 — --help / -h -------------------------------------------------------------------------
printf '\n# H19 — help flags\n'
run --help
assert_exit     "--help exits 0" 0
assert_contains "--help prints usage" "usage:  ./detect-lockin.sh [path] [vendor-name-regex]"
assert_absent   "--help fabricates no HIGH findings" "[HIGH]"
assert_absent   "--help does not run grep usage as hits" "Usage: grep"

run -h
assert_exit     "-h exits 0" 0
assert_contains "-h prints usage" "usage:  ./detect-lockin.sh [path] [vendor-name-regex]"

run --verbose
assert_exit     "unknown flag exits 2" 2
assert_contains "unknown flag names itself" "unknown option: --verbose"

# ---- H20 — fail closed on bad inputs -------------------------------------------------------------
printf '\n# H20 — fail closed\n'
run "$FIX/does-not-exist"
assert_exit "nonexistent path exits 2" 2

run "$SCRIPT"   # a file, not a directory (the detector script itself)
assert_exit "file-as-root exits 2" 2

run "$FIX/clean" 'acme('   # invalid ERE
assert_exit "invalid vendor regex exits 2" 2

# ---- read-only property re-confirmation ----------------------------------------------------------
# Strip comments and string-literal noise, then look for a write/network command at the start of a
# command position. Any redirection other than the harmless 2>/dev/null, >&2, >/dev/null is a fail.
printf '\n# read-only property\n'
CODE=$(grep -vE '^\s*#' "$SCRIPT" | sed 's/#.*//')
rw_hits=$(printf '%s\n' "$CODE" \
  | grep -nE '(^|[;&|`]|\$\()[[:space:]]*(rm|mv|cp|tee|truncate|chmod|mkdir|touch|curl|wget|eval)[[:space:]]|sed[[:space:]]+-i|>[[:space:]]*[^&]' \
  | grep -vE '2>/dev/null|>&2|>/dev/null' || true)
if [ -n "$rw_hits" ]; then
  bad "no write/network commands in detector" "$rw_hits"
else
  ok "detector contains no write/network commands (only 2>/dev/null, >&2, >/dev/null)"
fi

# ---- summary -------------------------------------------------------------------------------------
printf '\n============================================================\n'
printf 'RESULT: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] && exit 0
exit 1
