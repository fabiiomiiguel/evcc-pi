#!/usr/bin/env bash
# Puts workstation.CADDY_DOMAIN (tailnet + LAN only) in front of the ffv0 work dashboard on 127.0.0.1:8090
# (~/Projects/ffv0/work, APP_BIND=127.0.0.1 in its .env; it keeps its own AUTH_PASSWORD login). Edits only the `@workstation`
# matcher and its handle in the live Caddyfile; safe to run again. `--print` renders the block and touches nothing.
set -euo pipefail
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/caddy-lib.sh"
: "${CADDY_DOMAIN:?set CADDY_DOMAIN in .env}"
: "${LAN_CIDR:?set LAN_CIDR in .env}"

# $1 = current Caddyfile, $2 = where to write the result
render() {
  python3 "$HERE/caddy_edit.py" site "$1" "$2" workstation <<EOT
	@workstation host workstation.$CADDY_DOMAIN
	handle @workstation {
		@outsiders not remote_ip $TAILNET_CIDR $LAN_CIDR
		respond @outsiders 403
		reverse_proxy 127.0.0.1:8090
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
say "https://workstation.$CADDY_DOMAIN -> 127.0.0.1:8090"
