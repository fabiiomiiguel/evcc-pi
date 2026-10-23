#!/usr/bin/env bash
# Creates the LXD container `personal` (what `devbox` runs in) on its own NAT bridge: no LAN or tailnet address,
# no DHCP, no DNS from LXD. Safe to run again; no sudo, only lxc. Never touches `dev` or br0.
#
# dns.mode=none still starts LXD's dnsmasq with DNS on, which dies on Pi-hole's :53 ("Address already in use"),
# so the bridge sets raw.dnsmasq port=0. The container gets a static address and public resolvers through cloud-init.
# Probed 2026-10-23: on this host ufw is active (input and forward default DROP), so TCP/UDP from the bridge to the
# host (Pi-hole :53, DHCP) and forwarded to the internet are dropped while ICMP passes. The connectivity check below
# stops with the commands that show the ufw rules (needs sudo) until ufw routes the bridge.
set -euo pipefail

NET=${PERSONAL_NET:-lxdpersonal0}
GW=${PERSONAL_GW:-10.250.50.1/24}
IP=${PERSONAL_IP:-10.250.50.10/24}
DNS=${PERSONAL_DNS:-1.1.1.1 9.9.9.9}
INST=${PERSONAL_INSTANCE:-personal}
IMAGE=${PERSONAL_IMAGE:-ubuntu:26.04}
CPU=${PERSONAL_CPU:-8}
MEM=${PERSONAL_MEM:-8GiB}
PORTS=${PERSONAL_PORTS:-3010 5000 8000 8010 8026 8125 9001}
USER_NAME=${PERSONAL_USER:-fabio}

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

if ! in_box bash -c 'command -v docker && command -v node && command -v composer' >/dev/null 2>&1; then
  in_box bash -euc "apt-get update && apt-get install -y docker.io docker-compose-v2 git make curl build-essential php8.4-cli composer python3-venv python3-pip && usermod -aG docker $USER_NAME
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs && corepack enable"
fi
echo "$INST ready: devbox true"
