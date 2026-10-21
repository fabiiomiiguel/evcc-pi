#!/usr/bin/env bash
# Pi-hole on the NucBox answers DOMAIN and every name under it with IP: one `address=/DOMAIN/IP` line in
# misc.dnsmasq_lines, the other lines kept; an older line for DOMAIN is replaced. Safe to run again. Usage: DOMAIN IP
# (pihole-test-dns.sh and pihole-dev-dns.sh fill them in).
set -euo pipefail
domain=${1:?usage: pihole-dns.sh DOMAIN IP} ip=${2:?usage: pihole-dns.sh DOMAIN IP}
TOML=/etc/pihole/pihole.toml
[[ $ip =~ ^[0-9]+(\.[0-9]+){3}$ ]] || { echo "not an IPv4 address: $ip" >&2; exit 1; }
want="address=/$domain/$ip"
answers() { [[ $(dig +short +time=2 +tries=1 "probe.$domain" @127.0.0.1) == "$ip" ]]; }

sudo -v
current=$(sudo cat "$TOML" | python3 -I -c 'import json, sys, tomllib
print(json.dumps(tomllib.load(sys.stdin.buffer).get("misc", {}).get("dnsmasq_lines", [])))')
echo "misc.dnsmasq_lines now: $current"
new=$(python3 -I -c 'import json, sys
lines = [l for l in json.loads(sys.argv[1]) if not l.startswith(f"address=/{sys.argv[3]}/")]
print(json.dumps(lines + [sys.argv[2]]))' "$current" "$want" "$domain")

if [[ $new == "$current" ]]; then
  echo "already there"
else
  sudo pihole-FTL --config misc.dnsmasq_lines "$new"
  echo "misc.dnsmasq_lines set: $new"
fi
for _ in 1 2 3 4 5; do answers && break; sleep 2; done
answers || { echo "not answering yet, restarting pihole-FTL"; sudo systemctl restart pihole-FTL; sleep 3; }
answers || { echo "probe.$domain does not resolve to $ip: dig probe.$domain @127.0.0.1" >&2; exit 1; }
echo "probe.$domain -> $(dig +short "probe.$domain" @127.0.0.1)"
