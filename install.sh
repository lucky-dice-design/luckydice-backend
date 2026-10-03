#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this installer with sudo bash.' >&2
  exit 1
fi
release=$(cd "$(dirname "$0")/.." && pwd)
target=/opt/luckydicedesign
himmel=/opt/himmelsteil-cms
test -f "$himmel/compose.yaml"
test -f "$himmel/Caddyfile"
docker network inspect himmelsteil-cms_web >/dev/null
install -d -m 0755 "$target/frontend/dist" "$target/backend"
cp -a "$release/frontend/dist/." "$target/frontend/dist/"
for file in compose.yaml setup.mjs server.mjs schema.json seed.json Caddyfile.luckydice; do
  install -m 0644 "$release/backend/$file" "$target/backend/$file"
done
cd "$target/backend"
install -d -m 0700 secrets
if [ ! -f .env ]; then
  read -r -p 'Directus admin email: ' admin_email
  if [[ ! "$admin_email" =~ ^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
    echo 'Invalid email address.' >&2; exit 1
  fi
  admin_password=$(openssl rand -hex 24)
  umask 077
  printf 'ADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\nPOSTGRES_PASSWORD=%s\nDIRECTUS_SECRET=%s\n' \
    "$admin_email" "$admin_password" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
  echo "Directus admin email: $admin_email"
  echo "Directus initial password: $admin_password"
fi
chmod 0600 .env
if [ "${1:-}" = '--license' ]; then
  read -r -s -p 'Directus license key (hidden): ' license_key
  printf '\n'
  if [[ ! "$license_key" =~ ^[a-zA-Z0-9._:+/=-]+$ ]]; then
    echo 'Empty or unsupported license key format.' >&2; exit 1
  fi
  umask 077
  license_env=$(mktemp .env.XXXXXX)
  sed '/^LICENSE_KEY=/d' .env > "$license_env"
  printf 'LICENSE_KEY=%s\n' "$license_key" >> "$license_env"
  chmod 0600 "$license_env"
  mv "$license_env" .env
  unset license_key
fi
if [ ! -f secrets/contact_token ]; then install -m 0640 /dev/null secrets/contact_token; fi
docker compose config --quiet
docker compose up -d --remove-orphans database luckydice-cms
ready=false
for attempt in $(seq 1 60); do
  if docker compose exec -T luckydice-cms node -e "fetch('http://127.0.0.1:8055/server/ping',{signal:AbortSignal.timeout(5000)}).then(async r=>process.exit(r.ok&&(await r.text()).trim()==='pong'?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 3
done
if [ "$ready" != true ]; then
  echo 'Directus failed to become ready. Recent startup logs:' >&2
  docker compose logs --tail=60 luckydice-cms
  exit 1
fi
# A running file bind mount can retain the previous inode after install replaces it.
docker compose cp setup.mjs luckydice-cms:/tmp/lucky-setup.mjs
docker compose cp schema.json luckydice-cms:/tmp/lucky-schema.json
docker compose cp seed.json luckydice-cms:/tmp/lucky-seed.json
docker compose exec -T -u root -e SCHEMA_PATH=/tmp/lucky-schema.json -e SEED_PATH=/tmp/lucky-seed.json luckydice-cms node /tmp/lucky-setup.mjs
chown 1000:1000 secrets/contact_token
chmod 0640 secrets/contact_token
docker compose up -d website
for attempt in $(seq 1 20); do
  if docker compose exec -T website node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker compose exec -T website node -e "fetch('http://127.0.0.1:3000/cms/items/site_settings').then(async r=>{const j=await r.json();if(!r.ok||!j.data?.site_name)process.exit(1)}).catch(()=>process.exit(1))"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
candidate=$(mktemp)
trap 'rm -f "$candidate"' EXIT
cp "$himmel/Caddyfile" "$candidate"
if ! grep -q 'admin.luckydicedesign.de' "$candidate"; then
  cat Caddyfile.luckydice >> "$candidate"
fi
cd "$himmel"
docker compose cp "$candidate" caddy:/tmp/Caddyfile.luckydice
docker compose exec -T caddy caddy validate --config /tmp/Caddyfile.luckydice --adapter caddyfile
cp -p Caddyfile "Caddyfile.before-luckydice-$stamp"
# Preserve the inode of the file mounted by the running Caddy container.
cat "$candidate" > Caddyfile
if ! docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  cat "Caddyfile.before-luckydice-$stamp" > Caddyfile
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  exit 1
fi
echo 'Lucky Dice installed. CMS: https://admin.luckydicedesign.de'
echo 'Point the .de/.com root and www DNS A records at 212.227.161.13.'
