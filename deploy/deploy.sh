#!/usr/bin/env bash
# Installed root-owned on the VPS; never execute a script from the upload as root.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run using the installed sudo entrypoint.' >&2; exit 1; }
revision=${1:-}
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full Git commit SHA.' >&2; exit 1; }
# This root-owned file contains only DEPLOY_HOME=/home/<deployment-user>.
source /etc/lucky-deploy.conf
: "${DEPLOY_HOME:?Missing DEPLOY_HOME}"
archive="$DEPLOY_HOME/deploy-incoming/luckydice-backend/$revision/release.tar.gz"
test -f "$archive"
exec 9>/run/lock/lucky-vps-deploy.lock
flock -w 900 9
work=$(mktemp -d /var/tmp/luckydice-backend.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
# Copy first: subsequent extraction is from a root-owned, stable archive.
cp "$archive" "$work/release.tar.gz"
mkdir "$work/source"
# git archive produces regular files; reject links and traversal before extraction.
python3 - "$work/release.tar.gz" "$work/source" <<'PYTHON'
import sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1]) as archive:
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
            raise SystemExit('Release contains an unsafe archive member')
    archive.extractall(sys.argv[2], filter='data')
PYTHON
src="$work/source"
# Abort before any update if the competing host service has been re-enabled.
if systemctl is-active --quiet caddy.service || systemctl is-enabled --quiet caddy.service; then
  echo 'Host caddy.service must be disabled and stopped; Docker Caddy owns ports 80/443.' >&2
  exit 1
fi
snapshot=/var/backups/lucky-deploy/luckydice-backend/$(date -u +%Y%m%dT%H%M%S)-$revision
install -d -m 0700 "$snapshot"
echo "Backup directory: $snapshot"
trap 'status=$?; echo "Deployment failed (exit $status); backup directory: $snapshot" >&2; exit "$status"' ERR
# Caddy is shared by both projects. Root-owned activation files preserve the
# reviewed live domain state and any extra site blocks across both deployments.
test -f /etc/lucky-deploy/caddy-himmelsteil.conf
test -f /etc/lucky-deploy/caddy-extra.conf
assemble_caddy() {
  cat "${1:-/etc/lucky-deploy/caddy-himmelsteil.conf}"
  if [[ -f /etc/lucky-deploy/himmelsteil-production-enabled ]]; then
    printf '\nimport /etc/caddy/Caddyfile.production\n'
  fi
  local lucky_file=${2:-/opt/luckydicedesign/backend/Caddyfile.luckydice}
  if [[ -f $lucky_file ]]; then
    printf '\n'
    cat "$lucky_file"
  fi
  printf '\n'
  cat /etc/lucky-deploy/caddy-extra.conf
}
# Do not silently upgrade the database engine or Directus during code deployment.
# Image changes require an explicit migration with a verified backup first.
check_images() {
  local target=$1 compose=$2
  docker compose --project-directory "$target" -f "$target/compose.yaml" config --format json > "$work/old-compose.json"
  docker compose --project-directory "$target" -f "$compose" config --format json > "$work/new-compose.json"
  python3 - "$work/old-compose.json" "$work/new-compose.json" <<'PYTHON'
import json, sys
old, new = [json.load(open(p))['services'] for p in sys.argv[1:]]
for service in ('database', 'directus', 'luckydice-cms'):
    if service in old and old[service].get('image') != new.get(service, {}).get('image'):
        raise SystemExit(f'{service}: image change requires a manual migration')
PYTHON
  rm "$work/old-compose.json" "$work/new-compose.json"
}
target=/opt/luckydicedesign/backend
test -f "$target/.env"
test -s "$target/secrets/contact_token"
check_images "$target" "$src/compose.yaml"
exec 8>/run/lock/luckydice-content.lock
flock -w 300 8
tar --exclude=./backups -czf "$snapshot/config.tar.gz" -C "$target" .
cp -a /etc/lucky-deploy "$snapshot/caddy-management"
cp -a /opt/himmelsteil-cms/Caddyfile "$snapshot/Caddyfile"
assemble_caddy /etc/lucky-deploy/caddy-himmelsteil.conf "$src/Caddyfile.luckydice" > "$work/Caddyfile"
(cd /opt/himmelsteil-cms
 docker compose cp "$work/Caddyfile" caddy:/tmp/Caddyfile.deploy
 docker compose exec -T caddy caddy validate --config /tmp/Caddyfile.deploy --adapter caddyfile)
cd "$target"
docker compose exec -T database pg_dump -U directus -d directus | gzip > "$snapshot/database.sql.gz"
gzip -t "$snapshot/database.sql.gz"
# Archive the actual mounted uploads, independent of Compose volume naming.
docker compose exec -T luckydice-cms tar -czf - -C /directus/uploads . > "$snapshot/uploads.tar.gz"
tar -tzf "$snapshot/uploads.tar.gz" > /dev/null
for file in compose.yaml setup.mjs server.mjs schema.json seed.json Caddyfile.luckydice sync-content.sh sync-content.mjs; do
  install -m 0644 "$src/$file" "$target/$file"
done
docker compose config --quiet
docker compose up -d --wait --wait-timeout 180 database luckydice-cms
ready=false
for attempt in $(seq 1 60); do
  if docker compose exec -T luckydice-cms node -e "fetch('http://127.0.0.1:8055/server/ping',{signal:AbortSignal.timeout(5000)}).then(async r=>process.exit(r.ok&&(await r.text()).trim()==='pong'?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 2
done
[[ $ready == true ]] || { echo 'Directus startup check failed.' >&2; exit 1; }
# Existing noninteractive, additive schema/permission setup. Credentials remain in .env.
docker compose cp setup.mjs luckydice-cms:/tmp/lucky-setup.mjs
docker compose cp schema.json luckydice-cms:/tmp/lucky-schema.json
docker compose cp seed.json luckydice-cms:/tmp/lucky-seed.json
docker compose exec -T -u root -e SCHEMA_PATH=/tmp/lucky-schema.json -e SEED_PATH=/tmp/lucky-seed.json luckydice-cms node /tmp/lucky-setup.mjs
chown 1000:1000 secrets/contact_token
chmod 0640 secrets/contact_token
docker compose up -d --no-deps --force-recreate website
ready=false
for attempt in $(seq 1 30); do
  if docker compose exec -T website node -e "fetch('http://127.0.0.1:3000/cms/items/site_settings').then(async r=>{const j=await r.json();process.exit(r.ok&&j.data?.site_name?0:1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 2
done
[[ $ready == true ]] || { echo 'Website/CMS health check failed.' >&2; exit 1; }
assemble_caddy > "$work/Caddyfile"
cd /opt/himmelsteil-cms
docker compose cp "$work/Caddyfile" caddy:/tmp/Caddyfile.deploy
docker compose exec -T caddy caddy validate --config /tmp/Caddyfile.deploy --adapter caddyfile
# Keep the existing inode for the running Caddy bind mount.
cat "$work/Caddyfile" > Caddyfile
if ! docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  cat "$snapshot/Caddyfile" > Caddyfile
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  exit 1
fi
cd "$target"
timeout 180 docker compose exec -T website node --input-type=module < sync-content.mjs > "$work/content.js"
test -s "$work/content.js"
install -m 0644 "$work/content.js" /opt/luckydicedesign/frontend/dist/assets/content.js
install -m 0644 "$src/luckydice-content.cron" /etc/cron.d/luckydice-content
install -m 0644 "$src/luckydice-content.logrotate" /etc/logrotate.d/luckydice-content
# Test the shared proxy and both CMS backends, including TLS and host routing.
for domain in admin.himmelsteil.de admin.luckydicedesign.de; do
  result=$(curl --silent --show-error --fail --retry 8 --retry-connrefused --retry-delay 2 --max-time 10 \
    --resolve "$domain:443:127.0.0.1" "https://$domain/server/ping")
  [[ $result == pong ]] || { echo "CMS probe failed: $domain" >&2; exit 1; }
done
printf '%s\n' "$revision" > "$target/.deployed-revision"
echo "Lucky Dice backend deployed: $revision; backup: $snapshot"
