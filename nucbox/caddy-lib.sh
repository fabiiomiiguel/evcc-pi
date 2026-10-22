# sourced by the caddy-*.sh scripts
LIVE=/etc/caddy/Caddyfile
ENVF=/etc/caddy/cloudflare.env   # the service's environment; validate must load it
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
say() { echo "==> $*"; }
die() { echo "!! $*" >&2; exit 1; }

# the baseline Caddyfile for $1 (a domain)
baseline() { sed "s|@CADDY_DOMAIN@|$1|g" "$HERE/Caddyfile.template"; }

# caddy-security's global block: one identity store, the Everon portal (host-only cookie) and the previews'
# portal on login.PREVIEW_DOMAIN (cookie for PREVIEW_DOMAIN only, its own key, so a token a dev server sees is
# not valid on Everon; 30 days, cookie included so it survives closing the browser; ./caddy-previews.sh --rotate-key
# ends every session sooner). $PW is the identity's `bcrypt:<cost>:<hash>`.
security_block() {
  : "${EVERON_HOST:?set EVERON_HOST in .env}" "${EVERON_USER:?set EVERON_USER in .env}" "${PREVIEW_DOMAIN:?set PREVIEW_DOMAIN in .env}"
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
			crypto default token lifetime 2592000
			crypto key sign-verify {env.AUTHP_PREVIEW_KEY}
			cookie domain $PREVIEW_DOMAIN
			cookie lifetime 2592000
			enable identity store localdb
			trust login redirect uri domain suffix .$PREVIEW_DOMAIN path prefix /
		}
		authorization policy previewpolicy {
			set auth url https://login.$PREVIEW_DOMAIN/
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

  sudo install -m 640 -o root -g caddy "$new" "$cand"
  validate_as_caddy "$cand" "$ENVF" || { rm -f "$old" "$new"; sudo rm -f "$cand"; die "invalid: nothing was changed"; }
  bak="$LIVE.bak"
  sudo cp -p "$LIVE" "$bak"; sudo mv "$cand" "$LIVE"; rm -f "$old" "$new"
  restart_or_restore "$bak" "$LIVE"
  say "applied. undo: sudo cp -p $bak $LIVE && sudo systemctl restart caddy"
}

# $1 = a Caddyfile, $2 = an environment file: validates as the caddy user with that environment (a plain
# `caddy validate` as root misses both); prints the tail of the log when invalid
validate_as_caddy() {
  local log
  say "validating as the caddy user, with the service's environment..."
  log=$(mktemp)
  if ! sudo bash -c "set -a; . '$2'; HOME=/var/lib/caddy exec setpriv --reuid=caddy --regid=caddy --init-groups caddy validate --config '$1'" >"$log" 2>&1; then
    tail -5 "$log"; rm -f "$log"; return 1
  fi
  rm -f "$log"
}

# restarts Caddy; if it does not come up, copies $1 (a backup) over $2 and restarts again
restart_or_restore() {
  sudo systemctl restart caddy || true
  sleep 2
  systemctl is-active --quiet caddy && return 0
  sudo cp -p "$1" "$2"; sudo systemctl restart caddy || true; die "caddy did not start; restored $1"
}

# prints a new random 64-hex key; refuses anything else (a failed openssl must never become an empty key)
new_key() {
  local k
  k=$(openssl rand -hex 32) || true
  [[ $k =~ ^[0-9a-f]{64}$ ]] || die "openssl did not give a 64-hex key"
  echo "$k"
}

# $1 = an environment file, $2 = where to write it with a new random AUTHP_PREVIEW_KEY (every other line kept).
# The key goes through the environment, never argv or stdout.
rotate_preview_key() {
  grep -q '^AUTHP_PREVIEW_KEY=' "$1" || die "no AUTHP_PREVIEW_KEY in $1"
  local k; k=$(new_key) || return 1
  K=$k awk '/^AUTHP_PREVIEW_KEY=/ { print "AUTHP_PREVIEW_KEY=" ENVIRON["K"]; next } 1' "$1" >"$2"
}
