#!/usr/bin/env bash
# Opens the LXD container `dev` to the NucBox only: dev-proxy also on the container's LAN address
# (local compose override, git-excluded), sshd key-only, and an nft table in the container that drops
# 22/80/443 on eth0 from anyone but the NucBox. Tailnet clients arrive SNATed to the NucBox's address
# (subnet router, NoSNAT false), so they pass; the rest of the LAN does not. Filtered in prerouting
# before Docker's DNAT, which an input rule would never see. Safe to run again. No sudo: lxc exec.
set -euo pipefail
PROJECTS_DIR=${PROJECTS_DIR:-$HOME/projects}
DEV_REPO=${DEV_REPO:-$PROJECTS_DIR/dogchef/dev}
addr() { sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p' | head -n1; }
DEV_IP=$(lxc exec dev -- ip -4 -o addr show eth0 | addr)
BOX_IP=$(ip -4 -o addr show br0 | addr)
[[ -n $DEV_IP && -n $BOX_IP ]] || { echo "no address for dev eth0 or br0" >&2; exit 1; }
echo "dev: $DEV_IP, NucBox: $BOX_IP"

lxc exec dev --env BOX_IP="$BOX_IP" -- bash -euo pipefail -s <<'IN'
cat >/etc/nftables-dev-lan.nft <<EOF
table inet dev_lan
delete table inet dev_lan
table inet dev_lan {
  chain prerouting {
    type filter hook prerouting priority -150; policy accept;
    iifname "eth0" tcp dport { 22, 80, 443 } ip saddr $BOX_IP counter accept
    iifname "eth0" tcp dport { 22, 80, 443 } counter drop
  }
  # sshd itself listens everywhere: the Docker bridges and WARP must not reach it
  chain input {
    type filter hook input priority 0; policy accept;
    iifname != { "eth0", "lo" } tcp dport 22 counter drop
  }
}
EOF
# dev-proxy binds the LAN address by number: with this it still starts if DHCP moves the container
echo net.ipv4.ip_nonlocal_bind=1 >/etc/sysctl.d/60-dev-lan.conf
sysctl -q -p /etc/sysctl.d/60-dev-lan.conf

# own unit: the stock nftables.service flushes the whole ruleset (Docker's, WARP's) on stop
cat >/etc/systemd/system/dev-lan-filter.service <<'EOF'
[Unit]
Description=Only the NucBox reaches 22/80/443 on eth0
DefaultDependencies=no
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables-dev-lan.nft
ExecStop=/usr/sbin/nft delete table inet dev_lan

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable dev-lan-filter.service
systemctl restart dev-lan-filter.service

# sshd keeps the first value it reads: 10- comes before the image's 60-cloudimg-settings.conf
cat >/etc/ssh/sshd_config.d/10-dev-lan.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AuthenticationMethods publickey
AllowUsers fabio
AllowTcpForwarding local
PermitOpen 127.0.0.1:3306
AllowStreamLocalForwarding no
X11Forwarding no
EOF
install -d -m 755 /run/sshd   # sshd -t wants it; the service creates it itself
sshd -t
systemctl unmask ssh.socket ssh.service
systemctl disable --now ssh.socket
systemctl enable ssh.service
systemctl restart ssh.service
IN

# the box's own key, usable from the box only, so it can check the way in; the Mac's key is added from the Mac
lxc exec dev -- sudo -u fabio -H bash -c 'umask 077; f=~/.ssh/authorized_keys; k=$(cat); line="from=\"$1\" $k"
  grep -qxF "$line" "$f" 2>/dev/null && exit 0
  body=$(cut -d" " -f2 <<<"$k"); { grep -vF "$body" "$f" 2>/dev/null || true; echo "$line"; } >"$f.new" && mv "$f.new" "$f"' \
  _ "$BOX_IP" <"$HOME/.ssh/id_ed25519.pub"

cat >"$DEV_REPO/docker-compose.override.yml" <<EOF
# local only (nucbox/dev-lan-access.sh in evcc-pi): dev-proxy also on the LXD container's LAN address
services:
  proxy:
    ports:
      - "$DEV_IP:80:80"
      - "$DEV_IP:443:443"
EOF
exclude=$(git -C "$DEV_REPO" rev-parse --path-format=absolute --git-common-dir)/info/exclude
grep -qxF /docker-compose.override.yml "$exclude" || echo /docker-compose.override.yml >>"$exclude"
(cd "$DEV_REPO" && dogchefbox docker compose -p fresh-chef up -d --no-deps proxy)

(cd "$DEV_REPO" && dogchefbox docker port dev-proxy)
lxc exec dev -- nft list table inet dev_lan
lxc exec dev -- systemctl is-enabled dev-lan-filter.service ssh.service
