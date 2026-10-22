#!/bin/bash
# Update the Choo Choo worker to the latest code on GitHub and restart it.
# Run on the server:  sudo bash /opt/choochoo/app/deploy/update.sh
set -euo pipefail
sudo -u choochoo git -C /opt/choochoo/app pull --ff-only
cd /opt/choochoo/app/worker
sudo -u choochoo npm ci --omit=dev --no-audit --no-fund
systemctl restart choochoo
echo "Choo Choo worker updated and restarted."
