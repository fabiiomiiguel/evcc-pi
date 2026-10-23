#!/usr/bin/env bash
# Creates the LXD container `personal` (what `devbox` runs in) on its own NAT bridge: no LAN or tailnet address,
# no DHCP, no DNS from LXD. Safe to run again; no sudo, only lxc. Never touches `dev` or br0.
#
# dns.mode=none still starts LXD's dnsmasq with DNS on, which dies on Pi-hole's :53 ("Address already in use"),
# so the bridge sets raw.dnsmasq port=0. The container gets a static address and the host's Pi-hole (LAN address) as its only resolver through cloud-init.
# Probed 2026-10-23: on this host ufw is active (input and forward default DROP), so TCP/UDP from the bridge to the
# host (Pi-hole :53, DHCP) and forwarded to the internet are dropped while ICMP passes. The connectivity check below
# stops with the commands that show the ufw rules (needs sudo) until two ufw rules exist (the user applies them):
#   sudo ufw route allow in on lxdpersonal0 out on br0
#   sudo ufw allow in on lxdpersonal0 to 192.168.68.50 port 53
# The ACL below is the only block for the LAN and the tailnet (the earlier ufw LAN route-deny was deleted once it was confirmed live).
# ufw cannot stop the container reaching the tailnet: tailscale's ts-forward chain, jumped before ufw in FORWARD, accepts
# everything out of tailscale0. So the bridge carries an LXD network ACL (nftables driver, no sudo) that drops egress to the
# LAN and the tailnet; a drop in LXD's own chain wins over ts-forward's accept (probed 2026-10-23: tailnet peer ping and
# 100.100.100.100:53 open without the ACL, blocked with it). ACL drops beat allows, so the LAN ranges skip PERSONAL_DNS
# itself and its non-53 tcp/udp ports and icmp4 are dropped by their own rules; change PERSONAL_LAN_DROP together with PERSONAL_DNS.
set -euo pipefail

NET=${PERSONAL_NET:-lxdpersonal0}
GW=${PERSONAL_GW:-10.250.50.1/24}
IP=${PERSONAL_IP:-10.250.50.10/24}
DNS=${PERSONAL_DNS:-192.168.68.50}
INST=${PERSONAL_INSTANCE:-personal}
IMAGE=${PERSONAL_IMAGE:-ubuntu:26.04}
CPU=${PERSONAL_CPU:-8}
MEM=${PERSONAL_MEM:-8GiB}
PORTS=${PERSONAL_PORTS:-3010 5000 8000 8010 8026 8125 9001}
USER_NAME=${PERSONAL_USER:-fabio}
ACL=${PERSONAL_ACL:-personal-egress}
LAN_DROP=${PERSONAL_LAN_DROP:-192.168.68.0-192.168.68.49,192.168.68.51-192.168.71.255,100.64.0.0/10}

has_device() { lxc config device list "$INST" | grep -qx "$1"; }
add_device() { # name, then device args
  has_device "$1" && return 0
  lxc config device add "$INST" "$@"
}
in_box() { lxc exec "$INST" -- "$@"; }

for d in "$HOME/Projects" "$HOME/orca"; do [[ -d $d ]] || { echo "missing $d (mounted into $INST)" >&2; exit 1; }; done

lxc network show "$NET" >/dev/null 2>&1 ||
  lxc network create "$NET" ipv4.address="$GW" ipv4.nat=true ipv4.dhcp=false ipv6.address=none dns.mode=none \
    raw.dnsmasq=port=0

# Rules are replaced on every run, so an ACL left empty by an interrupted run cannot leave LAN and tailnet open.
# LXD ACLs cannot say "all protocols except 53", so 192.168.68.50 gets tcp and udp non-53 plus icmp4; other IP protocols to it pass.
lxc network acl show "$ACL" >/dev/null 2>&1 || lxc network acl create "$ACL"
lxc network acl edit "$ACL" <<YAML
egress:
- action: drop
  state: enabled
  destination: $LAN_DROP
- action: drop
  state: enabled
  protocol: tcp
  destination: $DNS
  destination_port: 1-52,54-65535
- action: drop
  state: enabled
  protocol: udp
  destination: $DNS
  destination_port: 1-52,54-65535
- action: drop
  state: enabled
  protocol: icmp4
  destination: $DNS
YAML
[[ $(lxc network get "$NET" security.acls) == "$ACL" ]] || lxc network set "$NET" security.acls="$ACL"
[[ $(lxc network get "$NET" security.acls.default.egress.action) == allow ]] ||
  lxc network set "$NET" security.acls.default.egress.action=allow

if ! lxc info "$INST" >/dev/null 2>&1; then
  ns=${DNS// /, }
  lxc init "$IMAGE" "$INST" -n "$NET" -c security.nesting=true -c limits.cpu="$CPU" -c limits.memory="$MEM" \
    -c boot.autostart=true -c cloud-init.network-config="version: 2
ethernets:
  eth0:
    addresses: [$IP]
    routes: [{to: default, via: ${GW%/*}}]
    nameservers: {addresses: [$ns]}"
fi
lxc list "^${INST}$" -f csv -c s | grep -qx RUNNING || lxc start "$INST"
in_box cloud-init status --wait >/dev/null

if ! in_box timeout 10 bash -c 'echo >/dev/tcp/1.1.1.1/443 && getent hosts deb.nodesource.com' >/dev/null 2>&1; then
  echo "$INST has no TCP egress or no name resolution through $NET: ufw (input and forward DROP) blocks it. Read the rules with:" >&2
  echo "  sudo ufw status verbose   (fallback: sudo nft list ruleset; sudo iptables -S FORWARD)" >&2
  exit 1
fi

# The user must exist before the disks: the mount creates /home/fabio as root and usermod -m then fails.
in_box id "$USER_NAME" >/dev/null 2>&1 ||
  in_box bash -c "usermod -l $USER_NAME -d /home/$USER_NAME -m ubuntu && groupmod -n $USER_NAME ubuntu"
add_device projects disk source="$HOME/Projects" path="$HOME/Projects" shift=true
add_device orca disk source="$HOME/orca" path="$HOME/orca" shift=true

for p in $PORTS; do add_device "p$p" proxy listen="tcp:127.0.0.1:$p" connect="tcp:127.0.0.1:$p"; done
# 3000 is the host's stellantis-worker, so the in-container 3000 (client-files app, football-fines frontend) is 3100 outside
add_device p3100 proxy listen=tcp:127.0.0.1:3100 connect=tcp:127.0.0.1:3000

# php 8.4 comes from sury like on `dev` and the host (football-fines pins 8.4.x). Ubuntu's composer package would pull php 8.5
# modules, so composer is the official installer, checked against its published SHA-384. Any failing step stops the script.
PROVISION='export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg
curl -fsSL https://packages.sury.org/php/apt.gpg -o /usr/share/keyrings/deb.sury.org-php.gpg
echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ $(. /etc/os-release && echo $VERSION_CODENAME) main" >/etc/apt/sources.list.d/sury-php.list
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y docker.io docker-compose-v2 git make build-essential php8.4-cli php8.4-mbstring php8.4-intl php8.4-curl php8.4-zip php8.4-xml python3-venv python3-pip nodejs
setup=$(mktemp)
curl -fsSL https://getcomposer.org/installer -o "$setup"
[ "$(curl -fsSL https://composer.github.io/installer.sig)" = "$(php -r "echo hash_file(\"sha384\", \"$setup\");")" ]
php "$setup" --quiet --install-dir=/usr/local/bin --filename=composer
rm "$setup"
usermod -aG docker "$1" && corepack enable'
ready() {
  in_box sudo -u "$USER_NAME" -H bash -lc 'php -r "exit(PHP_VERSION_ID>=80400&&PHP_VERSION_ID<80500?0:1);" && composer -V && docker ps && node -v && python3 -V' >/dev/null 2>&1
}
ready || {
  in_box bash -euo pipefail -c "$PROVISION" _ "$USER_NAME"
  ready || { echo "$INST provisioned but php 8.4, composer, docker, node or python3 is not usable by $USER_NAME" >&2; exit 1; }
}
echo "$INST ready: devbox true"
