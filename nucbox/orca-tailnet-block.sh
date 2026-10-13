#!/usr/bin/env bash
# Closes ORCA_PORT to the tailnet. Tailscale's ts-input chain accepts everything on tailscale0 before
# ufw sees it (a ufw deny on tailscale0 has no effect), and Orca binds 0.0.0.0 with no bind option,
# so the port is dropped in the raw table instead, from ufw's before.init (ufw reload re-applies
# before.rules without flushing, so a *raw block there piles up one more copy per reload).
# Caddy on 127.0.0.1 stays the only way in.
set -euo pipefail
. "$(dirname "$0")/env.sh"
UFW_DIR=${UFW_DIR:-/etc/ufw}
init=$UFW_DIR/before.init
sudo -v

for f in "$UFW_DIR/before.rules" "$UFW_DIR/before6.rules"; do
  sudo grep -q 'orca-tailnet' "$f" || continue
  sudo cp -p "$f" "$f.bak"
  sudo awk '
    /^\*raw$/ { blk = $0 ORS; held = 1; next }
    held { blk = blk $0 ORS; if ($0 == "COMMIT") { if (blk !~ /orca-tailnet/) printf "%s", blk; blk = ""; held = 0 }; next }
    { print }' "$f" | sudo tee "$f.new" >/dev/null
  sudo mv "$f.new" "$f"
done

IFS= read -r -d '' block <<'BLK' || true
# BEGIN orca-tailnet
orca_tailnet() {
  for ipt in iptables ip6tables; do
    case "$1" in
      start) $ipt -t raw -C PREROUTING -i tailscale0 -p tcp --dport @PORT@ -m comment --comment orca-tailnet -j DROP 2>/dev/null ||
             $ipt -t raw -I PREROUTING -i tailscale0 -p tcp --dport @PORT@ -m comment --comment orca-tailnet -j DROP || true ;;
      stop|flush-all) while $ipt -t raw -D PREROUTING -i tailscale0 -p tcp --dport @PORT@ -m comment --comment orca-tailnet -j DROP 2>/dev/null; do :; done ;;
    esac
  done
}
orca_tailnet "$1"
# END orca-tailnet
BLK
block=${block%$'\n'}
block=${block//@PORT@/$ORCA_PORT}

if sudo test -e "$init"; then
  first=$(sudo head -n1 "$init")
  [[ $first == '#!/bin/sh'* || $first == '#!/bin/bash'* || $first == '#!/usr/bin/env '*sh ]] ||
    { echo "$init exists and is not a shell script; add the orca-tailnet block by hand" >&2; exit 1; }
  sudo cp -p "$init" "$init.bak"
  rest=$(sudo awk '/^# BEGIN orca-tailnet$/ {skip=1} !skip && NR>1 {print} /^# END orca-tailnet$/ {skip=0}' "$init")
  printf '%s\n%s\n%s\n' "$first" "$block" "$rest" | sudo tee "$init.new" >/dev/null
  sudo mv "$init.new" "$init"
else
  printf '#!/bin/sh\n%s\n' "$block" | sudo tee "$init" >/dev/null
fi
sudo chmod 755 "$init"

for ipt in iptables ip6tables; do
  while sudo "$ipt" -t raw -D PREROUTING -i tailscale0 -p tcp --dport "$ORCA_PORT" -m comment --comment orca-tailnet -j DROP 2>/dev/null; do :; done
done
sudo ufw reload
echo "--- raw (one rule each):"; sudo iptables -t raw -S PREROUTING; sudo ip6tables -t raw -S PREROUTING
