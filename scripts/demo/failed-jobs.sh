#!/bin/sh
# Demo read-only CI monitor: prints fictional failed CI jobs of the last N days as JSON.
# Credential-free and offline; it only reads its own embedded data (projects and host are fictional).
# Usage: failed-jobs.sh --days N [--project NAME|todos]
set -eu

days=7
project=todos
while [ "$#" -gt 0 ]; do
  case "$1" in
    --days) days="$2"; shift 2 ;;
    --project) project="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$days" in
  '' | *[!0-9]*) echo "--days must be a positive integer" >&2; exit 2 ;;
esac

first=1
printf '['
# project|job|branch|days ago|reason
while IFS='|' read -r proj job branch ago reason; do
  [ "$ago" -le "$days" ] || continue
  [ "$project" = todos ] || [ "$project" = "$proj" ] || continue
  [ "$first" -eq 1 ] || printf ','
  first=0
  printf '\n  {"project": "%s", "job": "%s", "branch": "%s", "daysAgo": %s, "reason": "%s", "url": "https://ci.example.com/%s/-/pipelines"}' \
    "$proj" "$job" "$branch" "$ago" "$reason" "$proj"
done <<'DATA'
acme-ui-kit|test:unit|develop|1|2 tests fallidos en date-picker.spec.ts (zona horaria)
acme-card-elements|build:elements|feature/acme-card|2|Error de compilación: input variant no existe en AcmeCardComponent
acme-shell|lint|main|4|Regla no-unused-vars en app.config.ts
acme-header-elements|deploy:cdn-qa|release/2.1.0|12|Timeout subiendo el bundle al CDN de QA
DATA
printf '\n]\n'
