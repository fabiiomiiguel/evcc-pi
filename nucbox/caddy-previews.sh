#!/usr/bin/env bash
# Puts any local dev server on 127.0.0.1:<port> (or [::1]:<port>) at https://<port>.PREVIEW_DOMAIN, tailnet + LAN
# only, behind the shared login (portal at login.PREVIEW_DOMAIN, one session for every preview). Ports 3000-9999
# minus DENY; anything else gets 404 before the login. Edits only the global `security` block and the
# `*.PREVIEW_DOMAIN` site in the live Caddyfile; safe to run again. `--print [Caddyfile]` renders over that file
# (default: the baseline) and touches nothing. `--rotate-key` writes a new AUTHP_PREVIEW_KEY into the service's
# environment and restarts Caddy: every preview session ends, Everon's stay. Names resolve through Pi-hole (pihole-dev-dns.sh).
set -euo pipefail
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/caddy-lib.sh"
: "${CADDY_DOMAIN:?set CADDY_DOMAIN in .env}"
: "${PREVIEW_DOMAIN:?set PREVIEW_DOMAIN in .env}"
: "${LAN_CIDR:?set LAN_CIDR in .env}"

# Never a dev server: listening now, installed but off, or a well-known service port (README table).
DENY_PORTS=(
  3000 # stellantis-worker, listening now
  3306 # MySQL of dogchef dev, inside the LXD dev container
  5252 # Tailscale web client, off; `tailscale set --webclient` would open it
  5900 # VNC/SPICE autoport if the haos VM gets a graphical display (now -display none)
  6379 # Redis of dogchef dev, inside the LXD dev container
  6768 # Orca, listening now
  7070 # evcc well-known UI port, lives in the VM or on the Pi
  8080 # Pi-hole admin, listening now
  8123 # Home Assistant well-known port (the VM serves on 80)
  8443 # Pi-hole HTTPS admin, configured but off
  8887 # OCPP from the wallbox, well-known, lives in the VM or on the Pi
  9090 # Cockpit, listening now
)
DENY="${DENY_PORTS[*]}"

# $1 = current Caddyfile, $2 = where to write the result
render() {
  local mid d=$PREVIEW_DOMAIN re
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
	# Only a request the route proxied gets Caddy's own 502: nothing on 127.0.0.1, so try a server bound to [::1] only.
	handle_errors 502 {
		reverse_proxy @port [::1]:{re.port.1} {
			header_up Host localhost:{re.port.1}
		}
	}
}
EOF
  rm -f "$mid"
}

old=$(mktemp); new=$(mktemp)
if [[ ${1:-} == --rotate-key ]]; then
  sudo -v
  sudo grep -q '^AUTHP_PREVIEW_KEY=.' "$ENVF" || { rm -f "$old" "$new"; die "no AUTHP_PREVIEW_KEY in $ENVF: run ./caddy-install.sh"; }
  sudo cat "$ENVF" >"$old"
  rotate_preview_key "$old" "$new" || { rm -f "$old" "$new"; exit 1; }
  validate_as_caddy "$LIVE" "$new" || { rm -f "$old" "$new"; die "invalid with the new key: nothing was changed"; }
  sudo cp -p "$ENVF" "$ENVF.bak"
  sudo tee "$ENVF" <"$new" >/dev/null # keeps the file's owner and mode
  rm -f "$old" "$new"
  restart_or_restore "$ENVF.bak" "$ENVF"
  say "new previews key: every preview session ended (Everon's stay); log in again at https://login.$PREVIEW_DOMAIN/"
  say "the old key is in $ENVF.bak (root, 0600); restoring it would revive the old sessions"
  exit 0
fi
if [[ ${1:-} == --print ]]; then
  PW='bcrypt:14:<hash from caddy hash-password>'
  if [[ -n ${2:-} ]]; then cp "$2" "$old"; else baseline "$CADDY_DOMAIN" >"$old"; fi
  render "$old" "$new"; cat "$new"; rm -f "$old" "$new"; exit 0
fi

read_live "$old"
[[ -n $PW ]] || { rm -f "$old" "$new"; die "no login user in the Caddyfile yet: run ./caddy-everon-login.sh first"; }
render "$old" "$new" || { rm -f "$old" "$new"; exit 1; }
apply_caddyfile "$old" "$new"
say "https://<port>.$PREVIEW_DOMAIN -> 127.0.0.1:<port> (or [::1]) after the login at https://login.$PREVIEW_DOMAIN/"
