#!/usr/bin/env bash
set -euo pipefail
exec 9>/run/lock/luckydice-content.lock
flock -n 9 || exit 0
cd /opt/luckydicedesign/backend
target=/opt/luckydicedesign/frontend/dist/assets/content.js
temporary=$(mktemp "${target}.XXXXXX")
trap 'rm -f "$temporary"' EXIT
# Only publish a complete successful export; preserve the last good file on errors.
timeout 180 docker compose exec -T website node --input-type=module < sync-content.mjs > "$temporary"
test -s "$temporary"
if cmp -s "$temporary" "$target"; then exit 0; fi
chmod 0644 "$temporary"
mv -f "$temporary" "$target"
printf '%s CMS fallback content updated\n' "$(date -Is)"
