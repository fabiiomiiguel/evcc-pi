#!/usr/bin/env bash
# Puts any local dev server on 127.0.0.1:<port> (or [::1]:<port>) at https://<port>.PREVIEW_DOMAIN, tailnet only and
# without a login. Ports 3000-9999 minus DENY; anything else gets 404. Edits only the `*.PREVIEW_DOMAIN` site in the
# live Caddyfile; safe to run again. `--print [Caddyfile]` renders over that file (default: the baseline) and
# touches nothing. Names resolve through Pi-hole (pihole-dev-dns.sh) and Tailscale split DNS.
set -euo pipefail
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/caddy-lib.sh"
: "${CADDY_DOMAIN:?set CADDY_DOMAIN in .env}"
: "${PREVIEW_DOMAIN:?set PREVIEW_DOMAIN in .env}"

# Never a dev server: what listens on the box or is installed there, and well-known service ports (README table).
DENY="3000 3306 5252 5900 6379 6768 7070 8080 8123 8443 8887 9090"

# $1 = current Caddyfile, $2 = where to write the result
render() {
  local d=$PREVIEW_DOMAIN re
  re="^([3-9][0-9]{3})\.${d//./\\.}(:[0-9]+)?$"
  python3 "$HERE/caddy_edit.py" top "$1" "$2" "*.$d" <<EOF
*.$d {
	import common
	@outsiders not remote_ip $TAILNET_CIDR
	@refused not header_regexp Host $re
	@denied header_regexp Host ^(${DENY// /|})\.
	@port header_regexp port Host $re
	route {
		respond @outsiders 403
		respond @refused "Unknown service" 404
		respond @denied "Unknown service" 404
		reverse_proxy @port 127.0.0.1:{re.port.1} {
			header_up Host localhost:{re.port.1}
		}
	}
	# Only a request the route proxied gets Caddy's own 502: nothing on 127.0.0.1, so try a server bound to [::1] only.
	handle_errors 502 {
		reverse_proxy @port [::1]:{re.port.1} {
			header_up Host localhost:{re.port.1}
		}
	}
}
EOF
}

old=$(mktemp); new=$(mktemp)
if [[ ${1:-} == --print ]]; then
  if [[ -n ${2:-} ]]; then cp "$2" "$old"; else baseline "$CADDY_DOMAIN" >"$old"; fi
  render "$old" "$new"; cat "$new"; rm -f "$old" "$new"; exit 0
fi

read_live "$old"
render "$old" "$new" || { rm -f "$old" "$new"; exit 1; }
apply_caddyfile "$old" "$new"
say "https://<port>.$PREVIEW_DOMAIN -> 127.0.0.1:<port> (or [::1]), from the tailnet only"
