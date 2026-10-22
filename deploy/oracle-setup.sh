#!/bin/bash
# Choo Choo worker: one-shot setup for an Oracle Cloud "Always Free" Ubuntu server.
#
# Paste this whole file into "Show advanced options → Management → Paste cloud-init script"
# when creating the instance. It installs everything, starts the worker, and gives it a
# public HTTPS address. Fill in your Network Rail login below first (or leave it blank and
# add it later in /etc/choochoo.env — see README).
#
# Progress log on the server: /var/log/choochoo-setup.log
# The worker's public address is written to /opt/choochoo/address.txt

NR_USERNAME=""        # your Network Rail Open Data email
NR_PASSWORD=""        # your Network Rail Open Data password
ALLOWED_ORIGIN="*"    # optional: your Vercel URL, e.g. https://choochoo.vercel.app

############################################################################################
set -euxo pipefail
exec > >(tee -a /var/log/choochoo-setup.log) 2>&1
export DEBIAN_FRONTEND=noninteractive

# Swap: the free AMD server has 1 GB of RAM; loading the daily timetable needs headroom.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

apt-get update
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy (HTTPS with automatic certificates)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# The app
id choochoo >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/choochoo --shell /usr/sbin/nologin choochoo
if [ -d /opt/choochoo/app/.git ]; then
  git -C /opt/choochoo/app pull --ff-only
else
  git clone --depth 1 https://github.com/eagiakatsikas/ChooChoo.git /opt/choochoo/app
fi
(cd /opt/choochoo/app/worker && npm ci --omit=dev)
mkdir -p /opt/choochoo/data
chown -R choochoo:choochoo /opt/choochoo

# Settings (kept if they already exist, so re-running this script never wipes your login)
if [ ! -f /etc/choochoo.env ]; then
  cat > /etc/choochoo.env <<EOF
NR_USERNAME=${NR_USERNAME}
NR_PASSWORD=${NR_PASSWORD}
NR_CLIENT_ID=choo-choo-oracle
ALLOWED_ORIGIN=${ALLOWED_ORIGIN}
PORT=8080
DATA_DIR=/opt/choochoo/data
EOF
fi
chmod 600 /etc/choochoo.env

cat > /etc/systemd/system/choochoo.service <<'EOF'
[Unit]
Description=Choo Choo worker (live London train positions)
After=network-online.target
Wants=network-online.target

[Service]
User=choochoo
WorkingDirectory=/opt/choochoo/app/worker
EnvironmentFile=/etc/choochoo.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=30
MemoryMax=900M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now choochoo

# Oracle's Ubuntu images block web traffic in the server's own firewall: open 80 and 443.
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
netfilter-persistent save

# Public HTTPS address: sslip.io turns the server's IP into a hostname Caddy can get a certificate for.
IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
HOST="${IP//./-}.sslip.io"
cat > /etc/caddy/Caddyfile <<EOF
${HOST} {
  reverse_proxy 127.0.0.1:8080 {
    flush_interval -1
  }
}
EOF
systemctl restart caddy
echo "https://${HOST}" > /opt/choochoo/address.txt
echo "Choo Choo worker set up at https://${HOST}"
