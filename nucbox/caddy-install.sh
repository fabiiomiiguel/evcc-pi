#!/usr/bin/env bash
# Prepares Caddy for the sites in this folder: the Cloudflare DNS and caddy-security modules, the
# service's environment file, the store directory, and a baseline wildcard Caddyfile for CADDY_DOMAIN
# when the live one has none, written only over the package default (refused otherwise). Safe to run
# again. The Cloudflare token is put in by you (sudoedit).
set -euo pipefail
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/caddy-lib.sh"
: "${CADDY_DOMAIN:?set CADDY_DOMAIN in .env}"
STORE=/var/lib/caddy/authcrunch

sudo -v
mods=$(caddy list-modules)
if ! grep -qx security <<<"$mods" || ! grep -qx dns.providers.cloudflare <<<"$mods"; then
  # the package owns /usr/bin/caddy: divert it, so an apt upgrade replaces caddy.default, not the custom build
  if [[ $(dpkg-divert --truename /usr/bin/caddy) != /usr/bin/caddy.default ]]; then
    sudo dpkg-divert --local --rename --divert /usr/bin/caddy.default --add /usr/bin/caddy
    sudo update-alternatives --install /usr/bin/caddy caddy /usr/bin/caddy.default 10
  fi
  # add-package rewrites the file /usr/bin/caddy resolves to, so that must be the copy
  [[ -e /usr/bin/caddy.custom ]] || sudo cp /usr/bin/caddy.default /usr/bin/caddy.custom
  sudo update-alternatives --install /usr/bin/caddy caddy /usr/bin/caddy.custom 50
  [[ $(readlink -f /usr/bin/caddy) == /usr/bin/caddy.custom ]] ||
    die "/usr/bin/caddy does not resolve to caddy.custom (update-alternatives --display caddy)"
  say "adding the modules to /usr/bin/caddy.custom..."
  sudo caddy add-package github.com/caddy-dns/cloudflare github.com/greenpau/caddy-security
fi

if ! sudo test -f "$ENVF"; then sudo install -m 600 -o root -g root "$HERE/cloudflare.env.example" "$ENVF"; fi
for k in AUTHP_SHARED_KEY AUTHP_PREVIEW_KEY; do
  sudo grep -q "^$k=" "$ENVF" || { v=$(new_key) && echo "$k=$v" | sudo tee -a "$ENVF" >/dev/null; }
done
sudo grep -q '^CLOUDFLARE_API_TOKEN=.' "$ENVF" || say "put the token in: sudoedit $ENVF"

sudo install -d /etc/systemd/system/caddy.service.d
sudo install -m 644 "$HERE/caddy-cloudflare.conf" /etc/systemd/system/caddy.service.d/cloudflare.conf
sudo systemctl daemon-reload

# root-owned files in the store stop the service (measured: lstat permission denied)
sudo install -d -o caddy -g caddy -m 700 "$STORE"
sudo chown -R caddy:caddy "$STORE"

if sudo grep -qE "^\*\.${CADDY_DOMAIN//./\\.} \{" "$LIVE"; then
  say "the Caddyfile already has *.$CADDY_DOMAIN; add sites with the other caddy-*.sh scripts."
elif ! sudo grep -q 'root \* /usr/share/caddy' "$LIVE"; then
  die "the live Caddyfile is not the package default; add the *.$CADDY_DOMAIN site from Caddyfile.template by hand"
else
  old=$(mktemp); new=$(mktemp)
  sudo cat "$LIVE" >"$old"; baseline "$CADDY_DOMAIN" >"$new"
  apply_caddyfile "$old" "$new"
fi
