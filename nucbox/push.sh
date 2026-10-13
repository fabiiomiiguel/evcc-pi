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
scp -q "$here"/*.sh "$here"/orca.service "$NUCBOX:nucbox/"
printf '%s=%q\n' ORCA_HOST "$ORCA_HOST" ORCA_PORT "$ORCA_PORT" LAN_CIDR "$LAN_CIDR" TAILNET_CIDR "$TAILNET_CIDR" |
  ssh "$NUCBOX" 'umask 077; cat > ~/nucbox/.env'
