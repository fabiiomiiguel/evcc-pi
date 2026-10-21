#!/usr/bin/env bash
# Copies this folder to ~/nucbox on the NucBox, with only the variables it needs from .env.
# Run from the Mac, then run the other scripts there.
set -euo pipefail
. "$(dirname "$0")/env.sh"
: "${ORCA_HOST:?set ORCA_HOST in .env}"
: "${LAN_CIDR:?set LAN_CIDR in .env}"
: "${NUCBOX:?set NUCBOX in .env}"
here=$(cd "$(dirname "$0")" && pwd)
ssh "$NUCBOX" 'mkdir -p ~/nucbox'
files=(); for f in "$here"/*; do [[ -f $f ]] && files+=("$f"); done
scp -q "${files[@]}" "$NUCBOX:nucbox/"
for n in ORCA_HOST ORCA_PORT LAN_CIDR TAILNET_CIDR CADDY_DOMAIN PREVIEW_DOMAIN EVERON_HOST EVERON_USER; do
  [[ -z ${!n:-} ]] || printf '%s=%q\n' "$n" "${!n}"
done |
  ssh "$NUCBOX" 'umask 077; cat > ~/nucbox/.env'
