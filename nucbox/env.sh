# sourced by the nucbox scripts: loads .env (next to them, or in the repo root) and fills defaults.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for f in "$here/.env" "$here/../.env"; do
  if [[ -f $f ]]; then set -a; . "$f"; set +a; break; fi
done
: "${ORCA_PORT:=6768}"
: "${TAILNET_CIDR:=100.64.0.0/10}"
