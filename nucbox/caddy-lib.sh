# sourced by caddy-install.sh, caddy-orca.sh and caddy-everon-login.sh
LIVE=/etc/caddy/Caddyfile
ENVF=/etc/caddy/cloudflare.env   # the service's environment; validate must load it
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
say() { echo "==> $*"; }
die() { echo "!! $*" >&2; exit 1; }

# the baseline Caddyfile for $1 (a domain)
baseline() { sed "s|@CADDY_DOMAIN@|$1|g" "$HERE/Caddyfile.template"; }

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
  sudo cp "$LIVE" "$bak"; sudo mv "$cand" "$LIVE"; rm -f "$old" "$new"
  sudo systemctl restart caddy || true
  sleep 2
  if ! systemctl is-active --quiet caddy; then
    sudo cp "$bak" "$LIVE"; sudo systemctl restart caddy || true; die "caddy did not start; restored $bak"
  fi
  say "applied. undo: sudo cp $bak $LIVE && sudo systemctl restart caddy"
}
