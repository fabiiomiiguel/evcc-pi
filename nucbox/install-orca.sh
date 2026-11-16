#!/usr/bin/env bash
# Installs the Orca server tarball (orca-update.sh --install), then the Orca user unit, the daily update timer and
# the update unit, and keeps it all running without a login session. Safe to run again: it only re-renders the units and
# enables them (a running orca.service is not restarted; do that yourself to pick up a changed unit).
set -euo pipefail
. "$(dirname "$0")/env.sh"
: "${ORCA_HOST:?set ORCA_HOST in .env}"
here=$(cd "$(dirname "$0")" && pwd)
"$here/orca-update.sh" --install
units=$HOME/.config/systemd/user
mkdir -p "$units"
for u in orca.service orca-update.service orca-update.timer; do
  sed -e "s|@ORCA_PORT@|$ORCA_PORT|g" -e "s|@ORCA_HOST@|$ORCA_HOST|g" -e "s|@NUCBOX_DIR@|$here|g" "$here/$u" >"$units/$u"
done
loginctl show-user "$USER" -p Linger --value | grep -qx yes || sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now orca-update.timer
systemctl --user enable --now orca.service
systemctl --user --no-pager status orca.service | head -5 || true  # informational: status may exit non-zero or SIGPIPE under pipefail
