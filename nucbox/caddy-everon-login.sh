#!/usr/bin/env bash
# Puts caddy-security's login page in front of Everon's noVNC viewer (/run/everon/novnc.sock, and
# novnc-pc.sock for a PC keyboard) at EVERON_HOST, tailnet + LAN only. Edits only the global `security`
# block and the `@everon` site in the live Caddyfile; safe to run again. `--print` renders both and touches nothing.
# The login's password is asked once (caddy hash-password) and then kept as it is in the Caddyfile.
set -euo pipefail
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/caddy-lib.sh"
: "${EVERON_HOST:?set EVERON_HOST in .env}"
: "${EVERON_USER:?set EVERON_USER in .env}"
: "${LAN_CIDR:?set LAN_CIDR in .env}"

# $1 = current Caddyfile, $2 = where to write the result; $PW is the identity's `bcrypt:<cost>:<hash>`
render() {
  local mid; mid=$(mktemp)
  python3 "$HERE/caddy_edit.py" security "$1" "$mid" <<EOF || { rm -f "$mid"; return 1; }
	security {
		local identity store localdb {
			realm local
			path /var/lib/caddy/authcrunch/users.json
			user $EVERON_USER {
				name "$EVERON_USER"
				email $EVERON_USER@${EVERON_HOST#*.}
				password "$PW"
				roles authp/admin
			}
		}
		authentication portal everonportal {
			crypto default token lifetime 43200
			crypto key sign-verify {env.AUTHP_SHARED_KEY}
			enable identity store localdb
			trust login redirect uri domain exact $EVERON_HOST path prefix /
		}
		authorization policy everonpolicy {
			set auth url /auth/
			crypto key verify {env.AUTHP_SHARED_KEY}
			allow roles authp/admin
		}
	}
EOF
  python3 "$HERE/caddy_edit.py" site "$mid" "$2" everon <<EOF || { rm -f "$mid"; return 1; }
	@everon host $EVERON_HOST
	handle @everon {
		@outsiders not remote_ip $TAILNET_CIDR $LAN_CIDR
		route {
			respond @outsiders 403
			redir /auth /auth/ 308
			redir /auth/portal / 302
			authenticate /auth/* with everonportal
			authorize with everonpolicy
			header / Content-Type "text/html; charset=utf-8"
			respond / <<HTML
				<!doctype html><html><head><meta charset="utf-8"><title>Everon</title><style>html,body{margin:0;height:100%;background:#282828}iframe{border:0;width:100%;height:100%;display:block}</style></head>
				<body><iframe title="Everon"></iframe><script>
				const f=document.querySelector("iframe");
				f.addEventListener("load",()=>f.contentDocument.getElementById("noVNC_disconnect_button")?.addEventListener("click",()=>location.href="/auth/logout"));
				const mac=/mac|iphone|ipad/i.test(navigator.userAgentData?.platform||navigator.platform);
				f.src="/vnc.html?autoconnect=1&resize=scale&path=websockify"+(mac?"":"-pc");
				</script></body></html>
				HTML 200
			reverse_proxy /websockify-pc unix//run/everon/novnc-pc.sock
			reverse_proxy unix//run/everon/novnc.sock
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

sudo -v
sudo cat "$LIVE" >"$old"
PW=$(grep -oE 'password "bcrypt:[0-9]+:[^"]+"' "$old" | head -1 | cut -d'"' -f2 || true)
if [[ -z $PW ]]; then
  say "new password for $EVERON_USER:"
  hash=$(caddy hash-password | tail -1)
  PW="bcrypt:$(cut -d'$' -f3 <<<"$hash"):$hash"
fi
render "$old" "$new" || { rm -f "$old" "$new"; exit 1; }
apply_caddyfile "$old" "$new"
say "https://$EVERON_HOST/ without a session redirects to the login; logout: https://$EVERON_HOST/auth/logout"
