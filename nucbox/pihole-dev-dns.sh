#!/usr/bin/env bash
# Pi-hole on the NucBox answers PREVIEW_DOMAIN (*.dev...) with the box's tailnet address, so previews open only
# over Tailscale (split DNS PREVIEW_DOMAIN -> this Pi-hole); a LAN client gets an address it cannot reach.
set -euo pipefail
. "$(dirname "$0")/env.sh"
: "${PREVIEW_DOMAIN:?set PREVIEW_DOMAIN in .env}"
exec "$(dirname "$0")/pihole-dns.sh" "$PREVIEW_DOMAIN" "$(tailscale ip -4)"
