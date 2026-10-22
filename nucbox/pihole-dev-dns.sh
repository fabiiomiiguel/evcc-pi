#!/usr/bin/env bash
# Pi-hole on the NucBox answers PREVIEW_DOMAIN (*.dev...) with the box's LAN address, like CADDY_DOMAIN: LAN clients
# use it directly, tailnet clients through split DNS PREVIEW_DOMAIN -> this Pi-hole and the box's subnet route.
set -euo pipefail
. "$(dirname "$0")/env.sh"
: "${PREVIEW_DOMAIN:?set PREVIEW_DOMAIN in .env}"
ip=$(ip -4 -o route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
[[ -n $ip ]] || { echo "no LAN address (no default route?)" >&2; exit 1; }
exec "$(dirname "$0")/pihole-dns.sh" "$PREVIEW_DOMAIN" "$ip"
