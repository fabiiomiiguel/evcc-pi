#!/usr/bin/env bash
# Installs the Orca user unit for the current user and keeps it running without a login session.
set -euo pipefail
. "$(dirname "$0")/env.sh"
: "${ORCA_HOST:?set ORCA_HOST in .env}"
unit=$HOME/.config/systemd/user/orca.service
mkdir -p "$(dirname "$unit")"
sed -e "s|@ORCA_PORT@|$ORCA_PORT|g" -e "s|@ORCA_HOST@|$ORCA_HOST|g" "$(dirname "$0")/orca.service" >"$unit"
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now orca.service
systemctl --user --no-pager status orca.service | head -5
