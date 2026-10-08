#!/usr/bin/env bash
# Type-check the Deno edge functions (they are outside the Node TypeScript project).
# Uses a local `deno` if there is one, otherwise the same Deno image the harness serves with.
set -euo pipefail
cd "$(dirname "$0")/.."

for fn in supabase/functions/*/; do
  name="$(basename "$fn")"
  [[ "$name" == _* ]] && continue
  if command -v deno >/dev/null 2>&1; then
    deno check --no-lock --config="$fn/deno.json" "$fn/index.ts"
  else
    args=(--rm -e DENO_DIR=/tmp/deno -v meetlou-deno-cache:/tmp/deno -v "$PWD":/app:ro)
    # Sandboxes that route egress through a proxy need it for Deno's npm downloads.
    if [[ -n "${HTTPS_PROXY:-}" ]]; then
      args+=(--network host -e HTTPS_PROXY="$HTTPS_PROXY" -e NO_PROXY=127.0.0.1,localhost)
    fi
    if [[ -f /root/.ccr/ca-bundle.crt ]]; then
      args+=(-v /root/.ccr/ca-bundle.crt:/ca.crt:ro -e DENO_CERT=/ca.crt)
    fi
    docker run "${args[@]}" denoland/deno:alpine-2.5.6 \
      deno check --no-lock --config="/app/$fn/deno.json" "/app/$fn/index.ts"
  fi
done
