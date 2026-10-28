#!/usr/bin/env bash
# Scan what ships to the browser for secrets.
#
# Anything in the client bundle can be read by anyone who opens the site.
# Run this after `next build`, before every release (see the security-audit skill).
#
# Usage:
#   scripts/scan-client-bundle.sh [build_dir] [public_dir] [env_example]
# Defaults: apps/web/.next  apps/web/public  .env.example
#
# Checks:
#   1. Source maps shipped in the client build (they expose original source).
#   2. Known secret shapes: private keys, Stripe secret keys, AWS keys,
#      Supabase secret keys, and JWTs whose payload says role=service_role.
#   3. The real value of every server-only variable listed in .env.example
#      (anything not prefixed NEXT_PUBLIC_) that is set in the current
#      environment. Run it with the release environment's variables loaded
#      for this check to mean anything.
#
# Prints file names and variable names only, never secret values.
# Exit 0: clean. Exit 1: findings. Exit 2: usage error.

set -uo pipefail

BUILD_DIR="${1:-apps/web/.next}"
PUBLIC_DIR="${2:-apps/web/public}"
ENV_EXAMPLE="${3:-.env.example}"

if [[ ! -d "$BUILD_DIR" ]]; then
  echo "scan-client-bundle: build dir '$BUILD_DIR' not found. Run the build first." >&2
  exit 2
fi

# Only what the browser can download: Next's static output plus public/.
targets=()
if [[ -d "$BUILD_DIR/static" ]]; then
  targets+=("$BUILD_DIR/static")
else
  targets+=("$BUILD_DIR")   # not a Next build dir: scan it whole
fi
[[ -d "$PUBLIC_DIR" ]] && targets+=("$PUBLIC_DIR")

findings=0
report() { echo "FAIL: $*"; findings=$((findings + 1)); }

# 1. Source maps
maps=$(find "${targets[@]}" -type f -name '*.map' 2>/dev/null)
if [[ -n "$maps" ]]; then
  report "source maps are shipped to the browser ($(echo "$maps" | wc -l | tr -d ' ') files, e.g. $(echo "$maps" | head -1)). Turn off productionBrowserSourceMaps."
fi

# 2. Known secret shapes
# Parallel arrays, not an associative array: macOS ships bash 3.2.
shape_names=("private key" "Stripe secret or restricted key" "AWS access key id" "Supabase secret key")
shape_res=('-----BEGIN [A-Z ]*PRIVATE KEY-----' '\b[rs]k_(live|test)_[A-Za-z0-9]{10,}' '\bAKIA[0-9A-Z]{16}\b' '\bsb_secret_[A-Za-z0-9_-]{10,}')
for i in "${!shape_names[@]}"; do
  hits=$(grep -rlE -- "${shape_res[$i]}" "${targets[@]}" 2>/dev/null)
  [[ -n "$hits" ]] && report "${shape_names[$i]} pattern found in: $(echo "$hits" | tr '\n' ' ')"
done

# JWTs: decode the payload and fail on role=service_role (anon keys are fine).
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  while IFS= read -r tok; do
    payload=$(echo "$tok" | cut -d. -f2 | tr '_-' '/+')
    pad=$(( (4 - ${#payload} % 4) % 4 ))
    payload="$payload$(printf '%*s' "$pad" '' | tr ' ' '=')"
    if echo "$payload" | base64 -d 2>/dev/null | grep -qE '"role"[[:space:]]*:[[:space:]]*"service_role"'; then
      report "Supabase service_role key (JWT) found in: $f"
    fi
  done < <(grep -oE 'eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}' "$f" | sort -u)
done < <(grep -rlE 'eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}' "${targets[@]}" 2>/dev/null)

# 3. Server-only variable values
checked=0
if [[ -f "$ENV_EXAMPLE" ]]; then
  while IFS= read -r var; do
    val="${!var:-}"
    [[ ${#val} -lt 8 ]] && continue      # unset or too short to match safely
    checked=$((checked + 1))
    hits=$(grep -rlF -- "$val" "${targets[@]}" 2>/dev/null)
    [[ -n "$hits" ]] && report "value of server-only $var found in: $(echo "$hits" | tr '\n' ' ')"
  done < <(grep -oE '^[A-Z][A-Z0-9_]*=' "$ENV_EXAMPLE" | tr -d '=' | grep -v '^NEXT_PUBLIC_')
else
  echo "note: $ENV_EXAMPLE not found; skipped the server-only value check."
fi

echo "scanned: ${targets[*]}"
echo "server-only variables with values checked: $checked"
if [[ $checked -eq 0 ]]; then
  echo "note: no server-only values were set, so check 3 proved nothing. Load the release environment and re-run."
fi

if [[ $findings -gt 0 ]]; then
  echo "RESULT: $findings finding(s). Blocking for release."
  exit 1
fi
echo "RESULT: clean."
exit 0
