#!/usr/bin/env bash
# Start a throwaway local Supabase Postgres (the same image `supabase start` uses, with the
# anon/authenticated/service_role roles and the auth schema) and apply every migration in
# order. Always starts from empty, because evidence tables cannot be cleaned up by design.
#
# Port 54322 matches `supabase start`, so the tests use one URL either way. With the full
# Supabase CLI stack running (`supabase db reset`), skip this script.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:17.6.1.066}"
NAME="meetlou-db"
PORT="${DB_PORT:-54322}"
export PGPASSWORD=postgres
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -p "$PORT:5432" "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  "${PSQL[@]}" -c 'select 1' >/dev/null 2>&1 && break
  sleep 2
done
"${PSQL[@]}" -c 'select 1' >/dev/null

for f in supabase/migrations/*.sql; do
  echo "applying $(basename "$f")"
  "${PSQL[@]}" --single-transaction -f "$f"
done
echo "database ready on port $PORT"
