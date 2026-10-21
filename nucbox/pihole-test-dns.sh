#!/usr/bin/env bash
# Pi-hole on the NucBox answers *.test with the LXD container `dev`'s LAN address, so the dogchef apps
# open by their own names over the LAN and the tailnet (split DNS `test` -> this Pi-hole). DEV_IP overrides
# the address read from the container.
set -euo pipefail
DEV_IP=${DEV_IP:-$(lxc exec dev -- ip -4 -o addr show eth0 | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p' | head -n1)}
[[ -n $DEV_IP ]] || { echo "no address for dev eth0 (set DEV_IP)" >&2; exit 1; }
exec "$(dirname "$0")/pihole-dns.sh" test "$DEV_IP"
