#!/usr/bin/env bash
# Start a throwaway local Supabase (the same images `supabase start` uses, without the
# parts we do not need) and apply every migration:
#
#   Postgres  127.0.0.1:54322   roles anon/authenticated/service_role, auth schema
#   GoTrue    behind the gateway  sign-in; public sign-up DISABLED, users are provisioned
#   PostgREST behind the gateway  the Supabase client's table API, so RLS is exercised for real
#   gateway   http://127.0.0.1:54321   /auth/v1 and /rest/v1, like a Supabase project URL
#
# Always starts from empty, because evidence tables cannot be cleaned up by design.
# With the full CLI stack (`supabase start`) you do not need this script.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:17.6.1.066}"
GOTRUE_IMAGE="${SUPABASE_GOTRUE_IMAGE:-supabase/gotrue:v2.188.1}"
POSTGREST_IMAGE="${POSTGREST_IMAGE:-postgrest/postgrest:v12.2.12}"
STORAGE_IMAGE="${SUPABASE_STORAGE_IMAGE:-supabase/storage-api:v1.29.1}"
# The well-known Supabase local-development secret. It protects nothing real.
JWT_SECRET="${LOCAL_JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters-long}"
NET="meetlou-net"
PORT="${DB_PORT:-54322}"
export PGPASSWORD=postgres
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

mkdir -p .local
if [[ -f .local/gateway.pid ]]; then kill "$(cat .local/gateway.pid)" 2>/dev/null || true; rm -f .local/gateway.pid; fi
docker rm -f meetlou-db meetlou-gotrue meetlou-postgrest meetlou-storage >/dev/null 2>&1 || true
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

docker run -d --name meetlou-db --network "$NET" -e POSTGRES_PASSWORD=postgres \
  -p "127.0.0.1:$PORT:5432" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do "${PSQL[@]}" -c 'select 1' >/dev/null 2>&1 && break; sleep 2; done
"${PSQL[@]}" -c 'select 1' >/dev/null

# The image creates these service roles without a usable password; set it for local use.
psql -h 127.0.0.1 -p "$PORT" -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q \
  -c "alter role supabase_auth_admin with password 'postgres'" \
  -c "alter role authenticator with password 'postgres'" \
  -c "alter role supabase_storage_admin with password 'postgres'"

# GoTrue first: it owns the auth schema, and our tables reference auth.users.
docker run -d --name meetlou-gotrue --network "$NET" -p 127.0.0.1:54324:9999 \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 \
  -e API_EXTERNAL_URL=http://127.0.0.1:54321 \
  -e GOTRUE_DB_DRIVER=postgres -e GOTRUE_DB_NAMESPACE=auth \
  -e GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:postgres@meetlou-db:5432/postgres \
  -e GOTRUE_SITE_URL=http://127.0.0.1:3000 \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_DISABLE_SIGNUP=true -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
  -e GOTRUE_MAILER_AUTOCONFIRM=true \
  "$GOTRUE_IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:54324/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:54324/health >/dev/null

# Storage next, for the same reason: it creates storage.buckets / storage.objects, which
# the recordings migration refers to. Files live on the container's own disk (throwaway).
docker run -d --name meetlou-storage --network "$NET" -p 127.0.0.1:54325:5000 \
  -e ANON_KEY="$(node scripts/local-keys.mjs anon)" \
  -e SERVICE_KEY="$(node scripts/local-keys.mjs service)" \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e DATABASE_URL=postgres://supabase_storage_admin:postgres@meetlou-db:5432/postgres \
  -e POSTGREST_URL=http://meetlou-postgrest:3000 \
  -e FILE_SIZE_LIMIT=157286400 -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/var/lib/storage \
  -e TENANT_ID=local -e REGION=local -e GLOBAL_S3_BUCKET=local -e ENABLE_IMAGE_TRANSFORMATION=false \
  -e SERVER_PORT=5000 \
  "$STORAGE_IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:54325/status >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:54325/status >/dev/null
# The Supabase platform lets `postgres` manage storage (create buckets and their policies from
# migrations) and gives the API roles their table privileges (RLS then decides what they see);
# this image only does so once the storage tables exist, so do the same here.
psql -h 127.0.0.1 -p "$PORT" -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q \
  -c "grant all on all tables in schema storage to postgres, anon, authenticated, service_role" \
  -c "grant all on all sequences in schema storage to postgres, anon, authenticated, service_role" \
  -c "grant usage on schema storage to postgres, anon, authenticated, service_role"

for f in supabase/migrations/*.sql; do
  echo "applying $(basename "$f")"
  "${PSQL[@]}" --single-transaction -f "$f"
done

docker run -d --name meetlou-postgrest --network "$NET" -p 127.0.0.1:54323:3000 \
  -e PGRST_DB_URI=postgres://authenticator:postgres@meetlou-db:5432/postgres \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  "$POSTGREST_IMAGE" >/dev/null
for _ in $(seq 1 30); do curl -sS -o /dev/null http://127.0.0.1:54323/ 2>/dev/null && break; sleep 1; done

nohup node scripts/local-gateway.mjs >.local/gateway.log 2>&1 &
echo $! > .local/gateway.pid
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:54321/auth/v1/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:54321/auth/v1/health >/dev/null
echo "local stack ready: API http://127.0.0.1:54321, database port $PORT"
