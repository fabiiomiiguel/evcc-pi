#!/usr/bin/env bash
# Closes ORCA_PORT to the tailnet. Tailscale's ts-input chain accepts everything on tailscale0 before
# ufw sees it (a ufw deny on tailscale0 has no effect), and Orca binds 0.0.0.0 with no bind option,
# so the port is dropped in the raw table instead. Caddy on 127.0.0.1 stays the only way in.
set -euo pipefail
. "$(dirname "$0")/env.sh"
sudo -v
for f in /etc/ufw/before.rules /etc/ufw/before6.rules; do
  sudo grep -q 'orca-tailnet' "$f" && continue
  sudo cp "$f" "$f.bak.$(date +%Y%m%d-%H%M%S)"
  sudo sed -i "1i *raw\n:PREROUTING ACCEPT [0:0]\n-A PREROUTING -i tailscale0 -p tcp --dport $ORCA_PORT -j DROP -m comment --comment orca-tailnet\nCOMMIT\n" "$f"
done
sudo ufw reload
echo "--- raw:"; sudo iptables -t raw -S PREROUTING; sudo ip6tables -t raw -S PREROUTING
