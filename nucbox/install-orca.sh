#!/usr/bin/env bash
# [orca.deb] Installs orca-ide from a downloaded .deb when missing (the extracted app fails: its
# chrome-sandbox is not setuid), then the Orca user unit, and keeps it running without a login session.
set -euo pipefail
. "$(dirname "$0")/env.sh"
: "${ORCA_HOST:?set ORCA_HOST in .env}"
if ! command -v orca-ide >/dev/null; then
  [[ -f ${1:-} ]] || { echo "orca-ide is not installed: ./install-orca.sh path/to/orca.deb" >&2; exit 1; }
  sudo apt-get install -y "$(readlink -f "$1")"
fi
unit=$HOME/.config/systemd/user/orca.service
mkdir -p "$(dirname "$unit")"
sed -e "s|@ORCA_PORT@|$ORCA_PORT|g" -e "s|@ORCA_HOST@|$ORCA_HOST|g" "$(dirname "$0")/orca.service" >"$unit"
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now orca.service
systemctl --user --no-pager status orca.service | head -5
