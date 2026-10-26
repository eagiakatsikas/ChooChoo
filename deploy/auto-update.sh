#!/bin/bash
# Run by the choochoo-update timer every 10 minutes: if GitHub has newer code, update.
# Only restarts the worker when something it uses changed (web-only changes deploy on Vercel).
set -euo pipefail
APP=/opt/choochoo/app
cd "$APP"
g() { sudo -u choochoo git -C "$APP" "$@"; } # as the app's own user (git won't run as root in its folder)
g fetch --quiet origin main
if [ "$(g rev-parse HEAD)" = "$(g rev-parse origin/main)" ]; then
  exit 0
fi
changed=$(g diff --name-only HEAD origin/main)
g merge --quiet --ff-only origin/main
if echo "$changed" | grep -qE '^(worker|deploy)/'; then
  cd "$APP/worker"
  sudo -u choochoo npm ci --omit=dev --no-audit --no-fund --silent
  systemctl restart choochoo
  echo "Choo Choo: updated to $(g rev-parse --short HEAD) and restarted."
else
  echo "Choo Choo: updated to $(g rev-parse --short HEAD) (web only, no restart needed)."
fi
