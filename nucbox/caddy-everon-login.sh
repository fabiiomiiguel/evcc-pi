#!/usr/bin/env bash
# Puts caddy-security's login page in front of Everon's noVNC viewer (/run/everon/novnc.sock, and
# novnc-pc.sock for a PC keyboard) at EVERON_HOST, tailnet + LAN only. Edits only the global `security`
# block (both portals, Everon's and the previews', see caddy-lib.sh: needs CADDY_DOMAIN and AUTHP_PREVIEW_KEY)
# and the `@everon` site in the live Caddyfile; safe to run again. `--print` renders both and touches nothing.
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
  security_block | python3 "$HERE/caddy_edit.py" security "$1" "$mid" || { rm -f "$mid"; return 1; }
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
				// A page restored from the back-forward cache holds a dead socket and a stale session: reload so it goes through the login.
				addEventListener("pageshow",e=>{if(e.persisted)location.reload()});
				// A drop the user did not start: no session -> login; session valid -> reload the iframe to reconnect (3 tries).
				let own=0,tries=0;
				const retry=()=>{if(tries++<3)setTimeout(()=>{f.src=f.src},3000)};
				const dropped=()=>fetch("/vnc.html",{redirect:"manual",cache:"no-store"}).then(r=>r.type==="opaqueredirect"?location.replace("/"):retry(),retry);
				// Keeps noVNC's own Disconnecting... screen up until the login; if the navigation is blocked (e.g. unsubmitted
				// text in the address bar), shows a link there to finish by hand.
				f.addEventListener("load",()=>{const d=f.contentDocument,t=d.getElementById("noVNC_transition_text");const go=(href,msg,label)=>{setTimeout(()=>location.replace(href),300);setTimeout(()=>{t.textContent=msg+" ";const a=t.appendChild(d.createElement("a"));a.href=href;a.target="_top";a.textContent=label;a.style.color="#8cf"},2000)};d.getElementById("noVNC_disconnect_button")?.addEventListener("click",()=>{own=1;d.head.appendChild(d.createElement("style")).textContent="#noVNC_transition{opacity:1!important;visibility:visible!important}#noVNC_connect_dlg,#noVNC_control_bar_anchor,#noVNC_status{display:none!important}";t.textContent="Disconnecting...";fetch("/auth/logout",{redirect:"manual"}).then(r=>{if(r.type!=="opaqueredirect"&&!r.ok)throw 0;go("/","Sessão terminada.","Entrar novamente")}).catch(()=>go("/auth/logout","A sessão pode continuar aberta.","Terminar sessão"))});
				// noVNC's UI object is module-private, so its disconnect is read off the <html> state classes it sets.
				let armed=0;const c=d.documentElement.classList;
				new MutationObserver(()=>{if(c.contains("noVNC_connected")){armed=1;tries=0}else if(c.contains("noVNC_connecting"))armed=1;else if(armed&&!own&&!c.contains("noVNC_disconnecting")&&!c.contains("noVNC_reconnecting")){armed=0;dropped()}}).observe(d.documentElement,{attributes:true,attributeFilter:["class"]})});
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
  baseline "$CADDY_DOMAIN" >"$old"; render "$old" "$new"; cat "$new"; rm -f "$old" "$new"; exit 0
fi

read_live "$old"
if [[ -z $PW ]]; then
  say "new password for $EVERON_USER:"
  hash=$(caddy hash-password | tail -1)
  PW="bcrypt:$(cut -d'$' -f3 <<<"$hash"):$hash"
fi
render "$old" "$new" || { rm -f "$old" "$new"; exit 1; }
apply_caddyfile "$old" "$new"
say "https://$EVERON_HOST/ without a session redirects to the login; logout: https://$EVERON_HOST/auth/logout"
