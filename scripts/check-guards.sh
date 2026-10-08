#!/usr/bin/env bash
# Repo guards that encode non-negotiables which a linter cannot see.
# Run locally with `pnpm guards`; CI runs it on every push and PR.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

# 9. The service role key never reaches the browser.
if grep -rIn --exclude-dir=node_modules --exclude-dir=.next \
  -e 'SERVICE_ROLE' -e 'service_role' apps/web 2>/dev/null; then
  echo "GUARD FAIL: apps/web must not reference the service role key." >&2
  fail=1
fi
if grep -rIn --exclude-dir=node_modules --exclude-dir=.next \
  -e '@meetlou/records/admin' -e '@meetlou/harness' -e '@meetlou/pipeline' -e '@meetlou/providers' apps/web 2>/dev/null; then
  echo "GUARD FAIL: apps/web must not import the operator helpers (service role, pipeline, model providers)." >&2
  fail=1
fi
if grep -rIn -E 'NEXT_PUBLIC_[A-Z_]*(SERVICE|SECRET|TOKEN)' \
  --exclude-dir=node_modules --exclude-dir=.next --exclude=.env.example . 2>/dev/null; then
  echo "GUARD FAIL: secrets must never carry the NEXT_PUBLIC_ prefix." >&2
  fail=1
fi

# Migrations: append-only, numbered 0001, 0002, ... with no gaps.
shopt -s nullglob
expected=1
for f in supabase/migrations/*.sql; do
  name="$(basename "$f")"
  want="$(printf '%04d' "$expected")"
  if [[ "$name" != "${want}_"*.sql ]]; then
    echo "GUARD FAIL: migration '$name' should start with ${want}_ (numbered, no gaps)." >&2
    fail=1
  fi
  expected=$((expected + 1))
done

# Migrations: an existing migration is never edited, renamed or deleted.
# Compared against the merge base with the default branch (CI fetches full history).
base="${GUARD_BASE_REF:-origin/main}"
if git rev-parse --verify --quiet "$base" >/dev/null; then
  changed="$(git diff --name-status "$base"...HEAD -- supabase/migrations | grep -v -E '^A[[:space:]]' | grep -v '\.gitkeep' || true)"
  if [[ -n "$changed" ]]; then
    echo "GUARD FAIL: migrations are append-only; these were modified/removed:" >&2
    echo "$changed" >&2
    fail=1
  fi
else
  echo "note: base ref '$base' not found; skipping migration-immutability diff." >&2
fi

exit "$fail"
