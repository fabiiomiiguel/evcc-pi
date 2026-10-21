# sourced by the caddy-*.sh scripts
LIVE=/etc/caddy/Caddyfile
ENVF=/etc/caddy/cloudflare.env   # the service's environment; validate must load it
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
say() { echo "==> $*"; }
die() { echo "!! $*" >&2; exit 1; }

# the baseline Caddyfile for $1 (a domain)
baseline() { sed "s|@CADDY_DOMAIN@|$1|g" "$HERE/Caddyfile.template"; }

# caddy-security's global block: one identity store, the Everon portal (host-only cookie) and the previews'
# portal on login.preview.CADDY_DOMAIN (cookie for preview.CADDY_DOMAIN only, its own key, so a token a dev
# server sees is not valid on Everon). $PW is the identity's `bcrypt:<cost>:<hash>`.
security_block() {
  : "${EVERON_HOST:?set EVERON_HOST in .env}" "${EVERON_USER:?set EVERON_USER in .env}" "${CADDY_DOMAIN:?set CADDY_DOMAIN in .env}"
  cat <<EOF
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
		authentication portal previewportal {
			crypto default token lifetime 43200
			crypto key sign-verify {env.AUTHP_PREVIEW_KEY}
			cookie domain preview.$CADDY_DOMAIN
			enable identity store localdb
			trust login redirect uri domain suffix .preview.$CADDY_DOMAIN path prefix /
		}
		authorization policy previewpolicy {
			set auth url https://login.preview.$CADDY_DOMAIN/
			crypto key verify {env.AUTHP_PREVIEW_KEY}
			allow roles authp/admin
		}
	}
EOF
}

# $1 = where to copy the live Caddyfile; sets PW to its identity's hash (empty when it has none)
read_live() {
  sudo -v
  sudo grep -q '^AUTHP_PREVIEW_KEY=.' "$ENVF" || die "no AUTHP_PREVIEW_KEY in $ENVF: run ./caddy-install.sh"
  sudo cat "$LIVE" >"$1"
  PW=$(grep -oE 'password "bcrypt:[0-9]+:[^"]+"' "$1" | head -1 | cut -d'"' -f2 || true)
}

# $1 = the live Caddyfile as a file, $2 = the candidate: validates as the caddy user, backs up,
# installs, restarts and rolls back if Caddy does not come up. Both files are removed.
apply_caddyfile() {
  local old=$1 new=$2 cand=/etc/caddy/Caddyfile.candidate log bak
  [[ -s $new ]] || { rm -f "$old" "$new"; die "the new Caddyfile is empty; nothing was changed"; }
  caddy fmt --overwrite "$old" >/dev/null 2>&1 || true
  caddy fmt --overwrite "$new" >/dev/null 2>&1 || true
  if diff -q "$old" "$new" >/dev/null; then
    rm -f "$old" "$new"; say "the Caddyfile is already like this; nothing to change."; return 0
  fi
  echo "--- changes:"; diff "$old" "$new" | sed 's/bcrypt:[^"]*/bcrypt:<hash>/' || true; echo "---"

  say "validating as the caddy user, with the service's environment..."
  sudo install -m 640 -o root -g caddy "$new" "$cand"
  log=$(mktemp)
  if ! sudo bash -c "set -a; . '$ENVF'; HOME=/var/lib/caddy exec setpriv --reuid=caddy --regid=caddy --init-groups caddy validate --config $cand" >"$log" 2>&1; then
    tail -5 "$log"; rm -f "$log" "$old" "$new"; sudo rm -f "$cand"; die "invalid: nothing was changed"
  fi
  rm -f "$log"
  bak="$LIVE.bak"
  sudo cp -p "$LIVE" "$bak"; sudo mv "$cand" "$LIVE"; rm -f "$old" "$new"
  sudo systemctl restart caddy || true
  sleep 2
  if ! systemctl is-active --quiet caddy; then
    sudo cp -p "$bak" "$LIVE"; sudo systemctl restart caddy || true; die "caddy did not start; restored $bak"
  fi
  say "applied. undo: sudo cp -p $bak $LIVE && sudo systemctl restart caddy"
}
