#!/usr/bin/env bash
# Puts ORCA_HOST (tailnet + LAN only) in front of Orca's runtime on 127.0.0.1:$ORCA_PORT.
# Edits only the `@orca` matcher and its handle in the live Caddyfile, before the catch-all
# `handle {`; safe to run again. `--print` renders the block and touches nothing.
set -euo pipefail
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/caddy-lib.sh"
: "${ORCA_HOST:?set ORCA_HOST in .env}"
: "${LAN_CIDR:?set LAN_CIDR in .env}"

# $1 = current Caddyfile, $2 = where to write the result
render() {
  python3 "$HERE/caddy_edit.py" site "$1" "$2" orca <<EOF
	@orca host $ORCA_HOST
	handle @orca {
		@outsiders not remote_ip $TAILNET_CIDR $LAN_CIDR
		respond @outsiders 403
		reverse_proxy 127.0.0.1:$ORCA_PORT
	}
EOF
}

old=$(mktemp); new=$(mktemp)
if [[ ${1:-} == --print ]]; then
  baseline example.com >"$old"; render "$old" "$new"; cat "$new"; rm -f "$old" "$new"; exit 0
fi

sudo -v
sudo cat "$LIVE" >"$old"
render "$old" "$new" || { rm -f "$old" "$new"; exit 1; }
apply_caddyfile "$old" "$new"
say "https://$ORCA_HOST -> 127.0.0.1:$ORCA_PORT"
