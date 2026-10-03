#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo 'Run with sudo bash.' >&2; exit 1; fi
release=$(cd "$(dirname "$0")" && pwd)
target=/opt/luckydicedesign/backend
test -f "$target/compose.yaml"
command -v flock >/dev/null
command -v timeout >/dev/null
command -v cron >/dev/null
command -v logrotate >/dev/null
for file in sync-content.sh sync-content.mjs; do
  install -m 0644 -o root -g root "$release/$file" "$target/$file"
done
touch /var/log/luckydice-content.log
chmod 0640 /var/log/luckydice-content.log
chown root:root /var/log/luckydice-content.log
# Enable the recurring job only after a successful first export.
bash "$target/sync-content.sh"
install -m 0644 -o root -g root "$release/luckydice-content.logrotate" /etc/logrotate.d/luckydice-content
install -m 0644 -o root -g root "$release/luckydice-content.cron" /etc/cron.d/luckydice-content
systemctl enable --now cron
echo 'Lucky Dice content sync enabled: every five minutes.'
