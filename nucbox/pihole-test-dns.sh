#!/usr/bin/env bash
# Pi-hole on the NucBox answers *.test with the LXD container `dev`'s LAN address, so the dogchef apps
# open by their own names over the LAN and the tailnet (split DNS `test` -> this Pi-hole). One
# `address=/test/<ip>` line in misc.dnsmasq_lines, the other lines kept; an older test line is
# replaced. Safe to run again. DEV_IP overrides the address read from the container.
set -euo pipefail
TOML=/etc/pihole/pihole.toml
DEV_IP=${DEV_IP:-$(lxc exec dev -- ip -4 -o addr show eth0 | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p' | head -n1)}
[[ $DEV_IP =~ ^[0-9]+(\.[0-9]+){3}$ ]] || { echo "no address for dev eth0 (set DEV_IP)" >&2; exit 1; }
want="address=/test/$DEV_IP"
answers() { [[ $(dig +short +time=2 +tries=1 probe.test @127.0.0.1) == "$DEV_IP" ]]; }

sudo -v
current=$(sudo cat "$TOML" | python3 -I -c 'import json, sys, tomllib
print(json.dumps(tomllib.load(sys.stdin.buffer).get("misc", {}).get("dnsmasq_lines", [])))')
echo "misc.dnsmasq_lines now: $current"
new=$(python3 -I -c 'import json, sys
lines = [l for l in json.loads(sys.argv[1]) if not l.startswith("address=/test/")]
print(json.dumps(lines + [sys.argv[2]]))' "$current" "$want")

if [[ $new == "$current" ]]; then
  echo "already there"
else
  sudo pihole-FTL --config misc.dnsmasq_lines "$new"
  echo "misc.dnsmasq_lines set: $new"
fi
for _ in 1 2 3 4 5; do answers && break; sleep 2; done
answers || { echo "not answering yet, restarting pihole-FTL"; sudo systemctl restart pihole-FTL; sleep 3; }
answers || { echo "probe.test does not resolve to $DEV_IP: dig probe.test @127.0.0.1" >&2; exit 1; }
echo "probe.test -> $(dig +short probe.test @127.0.0.1)"
