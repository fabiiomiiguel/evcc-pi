#!/usr/bin/env bash
# Puts any local dev server on 127.0.0.1:<port> at https://<port>.preview.CADDY_DOMAIN, tailnet + LAN only, behind
# the login (portal at login.preview.CADDY_DOMAIN, one session for every preview). Ports 3000-9999 minus DENY;
# anything else gets 404 before the login. Edits only the global `security` block and the
# `*.preview.CADDY_DOMAIN` site in the live Caddyfile; safe to run again. `--print` renders and touches nothing.
set -euo pipefail
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/caddy-lib.sh"
: "${CADDY_DOMAIN:?set CADDY_DOMAIN in .env}"
: "${LAN_CIDR:?set LAN_CIDR in .env}"

# Never a dev server: what listens on the box or is installed there, and well-known service ports (README table).
DENY="3000 3306 5252 5900 6379 6768 7070 8080 8123 8443 8887 9090"

# $1 = current Caddyfile, $2 = where to write the result
render() {
  local mid d=preview.$CADDY_DOMAIN re
  re="^([3-9][0-9]{3})\.${d//./\\.}(:[0-9]+)?$"
  mid=$(mktemp)
  security_block | python3 "$HERE/caddy_edit.py" security "$1" "$mid" || { rm -f "$mid"; return 1; }
  python3 "$HERE/caddy_edit.py" top "$mid" "$2" "*.$d" <<EOF || { rm -f "$mid"; return 1; }
*.$d {
	import common
	@outsiders not remote_ip $TAILNET_CIDR $LAN_CIDR
	@login host login.$d
	@refused not header_regexp Host $re
	@denied header_regexp Host ^(${DENY// /|})\.
	@port header_regexp port Host $re
	route {
		respond @outsiders 403
		authenticate @login with previewportal
		respond @refused "Unknown service" 404
		respond @denied "Unknown service" 404
		authorize with previewpolicy
		reverse_proxy @port 127.0.0.1:{re.port.1} {
			header_up Host localhost:{re.port.1}
		}
	}
}
EOF
  rm -f "$mid"
}

old=$(mktemp); new=$(mktemp)
if [[ ${1:-} == --print ]]; then
  PW='bcrypt:14:<hash from caddy hash-password>'
  baseline example.com >"$old"; render "$old" "$new"; cat "$new"; rm -f "$old" "$new"; exit 0
fi

read_live "$old"
[[ -n $PW ]] || { rm -f "$old" "$new"; die "no login user in the Caddyfile yet: run ./caddy-everon-login.sh first"; }
render "$old" "$new" || { rm -f "$old" "$new"; exit 1; }
apply_caddyfile "$old" "$new"
say "https://<port>.preview.$CADDY_DOMAIN -> 127.0.0.1:<port> after the login at https://login.preview.$CADDY_DOMAIN/"
