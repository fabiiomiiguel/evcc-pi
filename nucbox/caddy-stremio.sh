#!/usr/bin/env bash
# Puts stremio.CADDY_DOMAIN (tailnet + LAN only) in front of the Stremio server on 127.0.0.1:11470
# (stremio-server.container), so the iPad/web app gets the HTTPS it needs. Edits only the `@stremio`
# matcher and its handle in the live Caddyfile; safe to run again. `--print` renders the block and touches nothing.
set -euo pipefail
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/caddy-lib.sh"
: "${CADDY_DOMAIN:?set CADDY_DOMAIN in .env}"
: "${LAN_CIDR:?set LAN_CIDR in .env}"

# $1 = current Caddyfile, $2 = where to write the result
render() {
  python3 "$HERE/caddy_edit.py" site "$1" "$2" stremio <<EOT
	@stremio host stremio.$CADDY_DOMAIN
	handle @stremio {
		@outsiders not remote_ip $TAILNET_CIDR $LAN_CIDR
		respond @outsiders 403
		reverse_proxy 127.0.0.1:11470
	}
EOT
}

old=$(mktemp); new=$(mktemp)
if [[ ${1:-} == --print ]]; then
  baseline example.com >"$old"; render "$old" "$new"; cat "$new"; rm -f "$old" "$new"; exit 0
fi

sudo -v
sudo cat "$LIVE" >"$old"
render "$old" "$new" || { rm -f "$old" "$new"; exit 1; }
apply_caddyfile "$old" "$new"
say "https://stremio.$CADDY_DOMAIN -> 127.0.0.1:11470"
