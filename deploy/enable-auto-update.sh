#!/bin/bash
# One-off: make the server keep itself up to date with GitHub.
# Run on the server:  sudo bash /opt/choochoo/app/deploy/enable-auto-update.sh
# (Afterwards, see what it's done with:  journalctl -u choochoo-update -n 20)
set -euo pipefail
cat > /etc/systemd/system/choochoo-update.service <<'UNIT'
[Unit]
Description=Update Choo Choo from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/choochoo/app/deploy/auto-update.sh
UNIT
cat > /etc/systemd/system/choochoo-update.timer <<'UNIT'
[Unit]
Description=Check GitHub for Choo Choo updates every 10 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now choochoo-update.timer
# Check straight away too
systemctl start choochoo-update.service || true
journalctl -u choochoo-update -n 5 --no-pager || true
echo "Done: Choo Choo will now update itself within about 10 minutes of each change."
