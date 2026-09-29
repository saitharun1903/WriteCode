#!/usr/bin/env bash
# Deploys a Git revision of Code Workspace on this server, with automatic rollback.
#
#   deploy/deploy.sh [git-ref]      (default: origin/main)
#
# 1. Builds the images for the revision, tagged with its commit.
# 2. Starts them (migrations run first, as a one-shot container).
# 3. Waits for https://$PUBLIC_HOST/api/v1/health/ready through the real proxy.
# 4. On success records the tag as last known good; on failure restarts the
#    previous tag and exits non-zero.
#
# Images of earlier deployments are kept, so a rollback never needs a rebuild.
# Database migrations are forward-only: keep them additive so the previous
# version keeps working against the newer schema.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=deploy/.env.production
COMPOSE=(docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml)
LAST_GOOD=deploy/.last-good
REF="${1:-origin/main}"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE. Run deploy/setup-server.sh first." >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

log "fetching $REF"
git fetch --prune origin
git checkout --quiet --detach "$REF"
TAG="$(git rev-parse --short=12 HEAD)"
PREVIOUS="$(cat "$LAST_GOOD" 2>/dev/null || true)"
log "deploying $TAG (previous: ${PREVIOUS:-none})"

for target in api worker migrate web; do
  log "building writecode/$target:$TAG"
  docker build --target "$target" -t "writecode/$target:$TAG" .
done

up() {
  IMAGE_TAG="$1" "${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 180
}

ready() {
  # Through Caddy and TLS, pinned to this machine so DNS is not involved.
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 --resolve "$PUBLIC_HOST:443:127.0.0.1" "https://$PUBLIC_HOST/api/v1/health/ready" >/dev/null; then
      return 0
    fi
    sleep 3
  done
  return 1
}

if up "$TAG" && ready; then
  echo "$TAG" > "$LAST_GOOD"
  log "deployed $TAG; https://$PUBLIC_HOST is ready"
  # Keep the three most recent tags of each image for rollbacks.
  for target in api worker migrate web; do
    docker image ls "writecode/$target" --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | tail -n +4 | cut -f2 \
      | xargs -r -I{} docker image rm "writecode/$target:{}" >/dev/null 2>&1 || true
  done
  # Build cache grows with every deployment; keep only the last week's.
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  exit 0
fi

log "DEPLOY FAILED for $TAG"
"${COMPOSE[@]}" ps || true
"${COMPOSE[@]}" logs --tail 80 api worker web || true
if [ -n "$PREVIOUS" ]; then
  log "rolling back to $PREVIOUS"
  # The previous images with the compose file they were deployed with.
  git checkout --quiet --detach "$PREVIOUS" || log "could not check out $PREVIOUS; using the current compose file"
  up "$PREVIOUS" && ready && log "rolled back to $PREVIOUS" || log "ROLLBACK FAILED; investigate now"
fi
exit 1
