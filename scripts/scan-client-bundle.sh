#!/usr/bin/env bash
# Scan what ships to the browser for secrets.
#
# Anything the browser can download can be read by anyone who opens the site.
# Run this after `next build`, before every release (see the security-audit skill).
# Best run as a build step in the client's Vercel/CI, where the release
# environment's variables are already loaded. Don't pull production secrets
# onto a laptop to run it; if you must, use a throwaway env file and delete it.
#
# Usage:
#   scripts/scan-client-bundle.sh [--allow-no-env] [build_dir] [public_dir] [env_example]
# Defaults: apps/web/.next  apps/web/public  .env.example
#
# What it scans (only what the browser can download):
#   - build_dir/static (client JS and CSS)
#   - prerendered pages: build_dir/server/**/*.html, *.rsc, *.body
#     (server .js is NOT scanned: it legitimately holds secrets)
#   - public_dir
# Pages rendered at request time can't be checked here: curl the preview
# deployment and check them too (see the security-audit skill).
#
# Checks:
#   1. Source maps shipped to the browser.
#   2. Known secret shapes: private keys, database URLs with a password,
#      Stripe, AWS, Supabase secret, Anthropic/OpenAI, GitHub, Slack and
#      Twilio API keys, and JWTs whose payload says role=service_role.
#   3. The real value of every server-only variable listed in env_example
#      (anything not prefixed NEXT_PUBLIC_) that is set in the environment,
#      also in JSON-escaped form. Values equal to a NEXT_PUBLIC_ value, and
#      variables named in SCAN_SKIP_VARS (space-separated), are skipped.
#
# Prints file names and variable names only, never secret values.
# Exit 0 clean · 1 findings · 2 usage error · 3 nothing to compare
# (no server-only values set; pass --allow-no-env to accept that).
#
# Written for bash 3.2 (macOS) and GNU/BSD grep.

set -uo pipefail

allow_no_env=0
args=()
for a in "$@"; do
  case "$a" in
    --allow-no-env) allow_no_env=1 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) args+=("$a") ;;
  esac
done
BUILD_DIR="${args[0]:-apps/web/.next}"
PUBLIC_DIR="${args[1]:-apps/web/public}"
ENV_EXAMPLE="${args[2]:-.env.example}"

if [[ ! -d "$BUILD_DIR" ]]; then
  echo "scan-client-bundle: build dir '$BUILD_DIR' not found. Run the build first." >&2
  exit 2
fi

# File list (NUL-separated, so paths with spaces work).
LIST=$(mktemp "${TMPDIR:-/tmp}/scan-bundle.XXXXXX") || exit 2
trap 'rm -f "$LIST"' EXIT
if [[ -d "$BUILD_DIR/static" ]]; then
  find "$BUILD_DIR/static" -type f -print0 >> "$LIST"
  if [[ -d "$BUILD_DIR/server" ]]; then
    find "$BUILD_DIR/server" -type f \( -name '*.html' -o -name '*.rsc' -o -name '*.body' \) -print0 >> "$LIST"
  fi
else
  find "$BUILD_DIR" -type f -print0 >> "$LIST"   # not a Next build dir: scan it whole
fi
[[ -d "$PUBLIC_DIR" ]] && find "$PUBLIC_DIR" -type f -print0 >> "$LIST"
nfiles=$(tr -cd '\0' < "$LIST" | wc -c | tr -d ' ')

findings=0
report() { echo "FAIL: $*"; findings=$((findings + 1)); }
# grep_files <grep options...> <pattern> : print matching file names, one line
grep_files() { xargs -0 grep -l "$@" < "$LIST" 2>/dev/null | tr '\n' ' '; }

# 1. Source maps
maps=$(tr '\0' '\n' < "$LIST" | grep -c '\.map$')
if [[ "$maps" -gt 0 ]]; then
  report "source maps are shipped to the browser ($maps files, e.g. $(tr '\0' '\n' < "$LIST" | grep '\.map$' | head -1)). Turn off productionBrowserSourceMaps."
fi

# 2. Known secret shapes. B = "not preceded by a word character" (portable \b).
B='(^|[^A-Za-z0-9_])'
shape_names=(
  "private key"
  "database URL with a password"
  "Stripe secret or restricted key"
  "AWS access key id"
  "Supabase secret key"
  "Anthropic or OpenAI API key"
  "GitHub token"
  "Slack token"
  "Twilio API key SID"
)
shape_res=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '(postgres(ql)?|mysql|mongodb(\+srv)?|redis)://[^:/@[:space:]"]+:[^@[:space:]"]+@'
  "${B}[rs]k_(live|test)_[A-Za-z0-9]{10,}"
  "${B}AKIA[0-9A-Z]{16}"
  "${B}sb_secret_[A-Za-z0-9_-]{10,}"
  "${B}sk-(ant|proj)-[A-Za-z0-9_-]{20,}"
  "${B}(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})"
  "${B}xox[abpr]-[A-Za-z0-9-]{10,}"
  "${B}SK[0-9a-f]{32}"
)
i=0
while [[ $i -lt ${#shape_names[@]} ]]; do
  hits=$(grep_files -E -- "${shape_res[$i]}")
  [[ -n "$hits" ]] && report "${shape_names[$i]} pattern found in: $hits"
  i=$((i + 1))
done

# JWTs: decode the payload and fail on role=service_role (anon/publishable are fine).
b64decode() {
  if printf 'eyJ9' | base64 --decode >/dev/null 2>&1; then base64 --decode
  elif printf 'eyJ9' | base64 -D >/dev/null 2>&1; then base64 -D
  else return 9; fi
}
JWT_RE='eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
if ! printf 'eyJ9' | b64decode >/dev/null 2>&1; then
  report "can't decode base64 on this machine, so the service_role JWT check did not run."
else
  while IFS= read -r -d '' f; do
    grep -qE "$JWT_RE" "$f" 2>/dev/null || continue
    while IFS= read -r tok; do
      payload=$(printf '%s' "$tok" | cut -d. -f2 | tr '_-' '/+')
      pad=$(( (4 - ${#payload} % 4) % 4 ))
      [[ $pad -gt 0 ]] && payload="$payload$(printf '%*s' "$pad" '' | tr ' ' '=')"
      if printf '%s' "$payload" | b64decode 2>/dev/null | grep -qE '"role"[[:space:]]*:[[:space:]]*"service_role"'; then
        report "Supabase service_role key (JWT) found in: $f"
      fi
    done < <(grep -oE "$JWT_RE" "$f" | sort -u)
  done < "$LIST"
fi

# 3. Server-only variable values
checked=0
if [[ -f "$ENV_EXAMPLE" ]]; then
  public_vals=""
  for pv in $(grep -oE '^NEXT_PUBLIC_[A-Z0-9_]*=' "$ENV_EXAMPLE" | tr -d '='); do
    public_vals="$public_vals${!pv:-}"$'\n'
  done
  for var in $(grep -oE '^[A-Z][A-Z0-9_]*=' "$ENV_EXAMPLE" | tr -d '=' | grep -v '^NEXT_PUBLIC_'); do
    case " ${SCAN_SKIP_VARS:-} " in *" $var "*) continue ;; esac
    val="${!var:-}"
    [[ ${#val} -lt 8 ]] && continue                                   # unset or too short to match safely
    printf '%s' "$public_vals" | grep -qxF -- "$val" && continue       # same as a public value: not secret
    checked=$((checked + 1))
    hits=$(grep_files -F -- "$val")
    escaped=$(printf '%s' "$val" | sed 's#/#\\/#g')
    if [[ "$escaped" != "$val" ]]; then
      hits="$hits$(grep_files -F -- "$escaped")"
    fi
    [[ -n "$hits" ]] && report "value of server-only $var found in: $hits"
  done
else
  echo "note: $ENV_EXAMPLE not found; skipped the server-only value check."
fi

echo "scanned: $nfiles files under $BUILD_DIR (static + prerendered pages) and $PUBLIC_DIR"
echo "server-only variables with values checked: $checked"

if [[ $findings -gt 0 ]]; then
  echo "RESULT: $findings finding(s). Blocking for release."
  exit 1
fi
if [[ $checked -eq 0 && $allow_no_env -eq 0 ]]; then
  echo "RESULT: incomplete. No server-only values were set, so check 3 proved nothing."
  echo "Load the release environment and re-run, or pass --allow-no-env for a shapes-only scan."
  exit 3
fi
echo "RESULT: clean."
exit 0
